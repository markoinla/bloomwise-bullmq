import { db } from "@/db/drizzle";
import { shopifyOrders } from "@/db/schema";
import { eq, and, isNull, count } from "drizzle-orm";
import { syncShopifyOrdersToInternalBatch } from "@/lib/shopify/sync-to-internal-batch";

export interface ExistingOrdersSyncResult {
  processed: number;
  success: number;
  errors: number;
  skipped: number;
  hasMore: boolean;
  totalItems: number;
}

/**
 * Sync existing Shopify orders that are already in the shopify_orders table
 * but haven't been synced to the internal orders table yet
 */
export async function syncExistingShopifyOrders(params: {
  organizationId: string;
  batchSize?: number;
}): Promise<ExistingOrdersSyncResult> {
  const { organizationId, batchSize = 250 } = params;

  console.log(`Starting existing orders sync for organization ${organizationId}`);

  // First, get the total count of unsynced orders
  const [totalUnsynced] = await db
    .select({ count: count() })
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.organizationId, organizationId),
        isNull(shopifyOrders.internalOrderId)
      )
    );

  console.log(`Found ${totalUnsynced.count} unsynced Shopify orders`);

  if (totalUnsynced.count === 0) {
    return {
      processed: 0,
      success: 0,
      errors: 0,
      skipped: 0,
      hasMore: false,
      totalItems: 0,
    };
  }

  // Sync the existing unsynced orders to internal orders using batch processing
  try {
    const internalResults = await syncShopifyOrdersToInternalBatch(organizationId, batchSize);

    console.log("Internal sync results:", internalResults);

    // Check if there are still more to process
    const [remainingCount] = await db
      .select({ count: count() })
      .from(shopifyOrders)
      .where(
        and(
          eq(shopifyOrders.organizationId, organizationId),
          isNull(shopifyOrders.internalOrderId)
        )
      );

    const hasMore = remainingCount.count > 0;

    return {
      processed: internalResults.created + internalResults.updated + internalResults.skipped,
      success: internalResults.created + internalResults.updated,
      errors: internalResults.errors.length,
      skipped: internalResults.skipped,
      hasMore,
      totalItems: totalUnsynced.count,
    };
  } catch (error) {
    console.error("Error syncing existing orders:", error);
    return {
      processed: 0,
      success: 0,
      errors: 1,
      skipped: 0,
      hasMore: true,
      totalItems: totalUnsynced.count,
    };
  }
}