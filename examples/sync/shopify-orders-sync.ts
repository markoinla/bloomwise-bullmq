import { db } from "@/db/drizzle";
import { shopifyIntegrations, shopifyOrders, userActivityLogs } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { batchSyncShopifyOrders } from "@/lib/shopify/order-sync-batch";
import { syncShopifyOrdersToInternalBatch } from "@/lib/shopify/sync-to-internal-batch";
import { rateLimitedFetch, shopifyRateLimiter, calculateDynamicBatchSize } from "@/lib/utils/rate-limiter";

export interface SyncBatchResult {
  processed: number;
  success: number;
  errors: number;
  skipped: number;
  hasMore: boolean;
  nextPageToken?: string | null;
  totalItems: number;
  stats?: {
    externalSynced: number;
    externalFailed: number;
    externalSkipped: number;
    internalCreated: number;
    internalUpdated: number;
    internalSkipped: number;
    internalErrors: number;
  };
}

/**
 * Sync a batch of Shopify orders
 */
export async function syncShopifyOrdersBatch(params: {
  organizationId: string;
  batchSize?: number;
  pageToken?: string;
  dateFrom?: string;
  dateTo?: string;
  syncToInternal?: boolean;
  forceUpdate?: boolean;
}): Promise<SyncBatchResult> {
  const {
    organizationId,
    batchSize = 250,
    pageToken,
    dateFrom,
    dateTo,
    syncToInternal = true,
    forceUpdate = false,
  } = params;

  // Calculate dynamic batch size based on current rate limit status
  const dynamicBatchSize = calculateDynamicBatchSize(shopifyRateLimiter, batchSize);

  console.log(`[ORDER SYNC] Using batch size: ${dynamicBatchSize} (requested: ${batchSize})`);

  // Get the Shopify integration
  const [integration] = await db
    .select()
    .from(shopifyIntegrations)
    .where(
      and(
        eq(shopifyIntegrations.organizationId, organizationId),
        eq(shopifyIntegrations.isActive, true)
      )
    )
    .limit(1);

  if (!integration || !integration.accessToken) {
    throw new Error("No active Shopify integration found");
  }

  const { shopDomain, accessToken } = integration;

  // Build Shopify API URL with parameters
  let shopifyUrl: string;

  if (pageToken) {
    // When using page_info, no other parameters are allowed
    const apiParams = new URLSearchParams({
      page_info: pageToken,
      limit: dynamicBatchSize.toString(),
    });
    shopifyUrl = `https://${shopDomain}/admin/api/2024-10/orders.json?${apiParams.toString()}`;
  } else {
    // First page - include all parameters
    const apiParams = new URLSearchParams({
      status: "any",
      limit: dynamicBatchSize.toString(),
      order: "updated_at desc", // Start with newest orders first
    });

    // Only apply date filtering if dateFrom is provided
    // For initial syncs, dateFrom should be null/undefined to fetch all orders
    if (dateFrom) {
      const baseFrom = new Date(dateFrom);
      const bufferedFrom = new Date(baseFrom.getTime() - 2 * 60 * 1000); // subtract 2 minutes to avoid gaps
      apiParams.append("updated_at_min", bufferedFrom.toISOString());
    }

    if (dateTo) {
      apiParams.append("updated_at_max", dateTo);
    }

    shopifyUrl = `https://${shopDomain}/admin/api/2024-10/orders.json?${apiParams.toString()}`;
  }

  console.log(`[ORDER SYNC] Fetching batch from Shopify: ${shopifyUrl}`);

  const response = await rateLimitedFetch(shopifyUrl, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Shopify API error: ${errorText}`);
  }

  const data = await response.json();
  const orders = data.orders || [];

  // Determine total count (first page only) using Shopify count endpoint
  let totalCount = 0;
  if (!pageToken) {
    try {
      const countParams = new URLSearchParams({ status: "any" });
      if (dateFrom) {
        const baseFrom = new Date(dateFrom);
        const bufferedFrom = new Date(baseFrom.getTime() - 2 * 60 * 1000);
        countParams.append("updated_at_min", bufferedFrom.toISOString());
      }
      if (dateTo) {
        countParams.append("updated_at_max", dateTo);
      }

      const countUrl = `https://${shopDomain}/admin/api/2024-10/orders/count.json?${countParams.toString()}`;
      const countResponse = await rateLimitedFetch(countUrl, {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      });

      if (countResponse.ok) {
        const countData = await countResponse.json();
        if (typeof countData.count === "number") {
          totalCount = countData.count;
        }
      }
    } catch (error) {
      console.warn("Failed to fetch Shopify order count:", error);
    }
  }

  // Extract pagination info from Link header
  const linkHeader = response.headers.get("link");
  let nextPageInfo = null;

  if (linkHeader) {
    const nextMatch = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>; rel="next"/);
    if (nextMatch) {
      nextPageInfo = nextMatch[1];
    }
  }

  // Get total count (estimate based on first page if not available)
  // Shopify doesn't provide total count in list API, so we estimate
  const totalItems = totalCount > 0 ? totalCount : 0;

  // Sync orders to shopify_orders table using batch processing
  const syncResults = await batchSyncShopifyOrders(orders, organizationId);

  // Optionally sync to internal orders using batch processing
  let internalResults = { created: 0, updated: 0, skipped: 0, errors: [] as string[] };
  if (syncToInternal && syncResults.success > 0) {
    try {
      internalResults = await syncShopifyOrdersToInternalBatch(organizationId, batchSize, forceUpdate);
      console.log("Internal sync results (batch):", internalResults);
    } catch (error) {
      console.error("Error syncing to internal orders:", error);
    }
  }

  // Update integration last sync timestamp
  if (syncResults.success > 0) {
    await db
      .update(shopifyIntegrations)
      .set({
        lastOrderSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(shopifyIntegrations.organizationId, organizationId));
  }

  // Log sync activity
  if (orders.length > 0) {
    await db.insert(userActivityLogs).values({
      organizationId,
      userId: null, // System action
      action: "synced",
      resource: "shopify_orders",
      description: `Synced ${syncResults.success} orders from Shopify${nextPageInfo ? ' (batch)' : ''}`,
      metadata: {
        source: "Shopify Sync",
        batchSize: orders.length,
        success: syncResults.success,
        failed: syncResults.failed,
        skipped: syncResults.skipped,
        internalCreated: internalResults.created,
        internalUpdated: internalResults.updated,
        hasMore: !!nextPageInfo,
      },
    });
  }

  return {
    processed: orders.length,
    success: syncResults.success,
    errors: syncResults.failed + internalResults.errors.length,
    skipped: syncResults.skipped + internalResults.skipped,
    hasMore: !!nextPageInfo,
    nextPageToken: nextPageInfo,
    totalItems,
    stats: {
      externalSynced: syncResults.success,
      externalFailed: syncResults.failed,
      externalSkipped: syncResults.skipped,
      internalCreated: internalResults.created,
      internalUpdated: internalResults.updated,
      internalSkipped: internalResults.skipped,
      internalErrors: internalResults.errors.length,
      batchSizeUsed: dynamicBatchSize,
      rateLimitStatus: shopifyRateLimiter.getStatus(),
    },
  };
}
