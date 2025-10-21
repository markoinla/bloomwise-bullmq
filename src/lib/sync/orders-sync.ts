/**
 * Shopify Orders Sync using GraphQL
 *
 * Fetches orders from Shopify and syncs to shopify_orders table
 */

import { getDatabaseForEnvironment } from '../../config/database';
import { shopifyOrders, syncJobs } from '../../db/schema';
import { sql, eq } from 'drizzle-orm';
import { logger, createJobLogger } from '../utils/logger';
import { executeGraphQLQuery } from '../shopify/client';
import { ORDERS_QUERY, type ShopifyOrder } from '../shopify/graphql-queries';
import { syncOrdersToInternal } from './sync-orders-to-internal';
import type { Job } from 'bullmq';

export interface OrdersSyncOptions {
  organizationId: string;
  syncJobId: string;
  shopDomain: string;
  accessToken: string;
  fetchAll?: boolean;
  cursor?: string;
  updatedAtMin?: Date;
  environment?: 'staging' | 'production';
  job?: Job; // Optional job for progress tracking and logging
}

export interface OrdersSyncResult {
  success: boolean;
  totalItems: number;
  processedItems: number;
  successCount: number;
  errorCount: number;
  skipCount: number;
  hasNextPage: boolean;
  endCursor?: string;
}

/**
 * Sync Shopify orders using GraphQL API
 */
export async function syncShopifyOrders(
  options: OrdersSyncOptions
): Promise<OrdersSyncResult> {
  const {
    organizationId,
    syncJobId,
    shopDomain,
    accessToken,
    fetchAll = false,
    cursor,
    updatedAtMin,
    environment = 'production',
    job,
  } = options;

  const db = getDatabaseForEnvironment(environment);

  // Create job-specific logger if job is provided, otherwise use base logger
  const syncLogger = job ? createJobLogger(job.id!, organizationId) : logger.child({ organizationId, syncJobId });

  const result: OrdersSyncResult = {
    success: true,
    totalItems: 0,
    processedItems: 0,
    successCount: 0,
    errorCount: 0,
    skipCount: 0,
    hasNextPage: false,
  };

  syncLogger.info(
    { organizationId, syncJobId, shopDomain, fetchAll, environment },
    'Starting Shopify orders sync'
  );

  try {
    // Build GraphQL query filter
    let graphqlQuery = '';
    if (!fetchAll && updatedAtMin) {
      // Add 2-minute buffer for API timing differences
      const bufferedDate = new Date(updatedAtMin.getTime() - 2 * 60 * 1000);
      graphqlQuery = `updated_at:>='${bufferedDate.toISOString()}'`;
    }

    let batchNumber = 0;
    let currentCursor = cursor;
    let hasMore = true;

    while (hasMore) {
      batchNumber++;
      syncLogger.info(
        { batchNumber, cursor: currentCursor, syncJobId },
        'Fetching orders batch from Shopify'
      );

      // Fetch orders using GraphQL
      const response = await executeGraphQLQuery<{
        orders: {
          edges: Array<{ node: ShopifyOrder; cursor: string }>;
          pageInfo: {
            hasNextPage: boolean;
            hasPreviousPage: boolean;
            startCursor: string;
            endCursor: string;
          };
        };
      }>(
        { shopDomain, accessToken },
        ORDERS_QUERY,
        {
          first: 250, // Maximum batch size allowed by Shopify API
          after: currentCursor,
          query: graphqlQuery,
          sortKey: 'UPDATED_AT',
          reverse: true, // Newest first
        }
      );

      if (response.errors) {
        throw new Error(`GraphQL errors: ${response.errors.map(e => e.message).join(', ')}`);
      }

      if (!response.data?.orders) {
        throw new Error('No orders data in GraphQL response');
      }

      const orders = response.data.orders.edges.map(edge => edge.node);
      const pageInfo = response.data.orders.pageInfo;

      syncLogger.info({ count: orders.length, batchNumber }, 'Received orders from Shopify');

      if (orders.length === 0) {
        break;
      }

      // Transform and batch upsert orders
      const ordersToUpsert = orders.map(order => transformGraphQLOrder(order, organizationId));

      if (ordersToUpsert.length > 0) {
        await db
          .insert(shopifyOrders)
          .values(ordersToUpsert)
          .onConflictDoUpdate({
            target: [shopifyOrders.organizationId, shopifyOrders.shopifyOrderId],
            set: {
              shopifyOrderNumber: sql`excluded.shopify_order_number`,
              name: sql`excluded.name`,
              shopifyCreatedAt: sql`excluded.shopify_created_at`,
              shopifyUpdatedAt: sql`excluded.shopify_updated_at`,
              shopifyCancelledAt: sql`excluded.shopify_cancelled_at`,
              customerEmail: sql`excluded.customer_email`,
              customerPhone: sql`excluded.customer_phone`,
              customerName: sql`excluded.customer_name`,
              shopifyCustomerId: sql`excluded.shopify_customer_id`,
              financialStatus: sql`excluded.financial_status`,
              fulfillmentStatus: sql`excluded.fulfillment_status`,
              cancelReason: sql`excluded.cancel_reason`,
              currency: sql`excluded.currency`,
              totalPrice: sql`excluded.total_price`,
              subtotalPrice: sql`excluded.subtotal_price`,
              totalTax: sql`excluded.total_tax`,
              totalDiscounts: sql`excluded.total_discounts`,
              tags: sql`excluded.tags`,
              note: sql`excluded.note`,
              test: sql`excluded.test`,
              pickupDate: sql`excluded.pickup_date`,
              pickupLocation: sql`excluded.pickup_location`,
              rawData: sql`excluded.raw_data`,
              apiVersion: sql`excluded.api_version`,
              syncedAt: sql`excluded.synced_at`,
              updatedAt: new Date(),
            },
          });

        syncLogger.info({ count: ordersToUpsert.length }, 'Batch upserted orders');
      }

      result.processedItems += orders.length;
      result.successCount += orders.length;
      result.totalItems += orders.length;

      // Update sync job progress in database (batch every 3 iterations to reduce DB load)
      if (batchNumber % 3 === 0 || !hasMore) {
        await db
          .update(syncJobs)
          .set({
            processedItems: result.processedItems,
            totalItems: result.totalItems,
            successCount: result.successCount,
            errorCount: result.errorCount,
            updatedAt: new Date(),
          })
          .where(eq(syncJobs.id, syncJobId));

        // Update job progress if available
        if (job) {
          const progress = Math.round((result.processedItems / (result.totalItems || 1)) * 100);
          await job.updateProgress(progress);
        }
      }

      // Sync this batch to internal tables immediately
      syncLogger.info(
        { batchNumber, syncJobId, orderCount: orders.length },
        'Syncing batch to internal orders and order_items tables'
      );

      try {
        // Extract shopify_order_ids from this batch to limit internal sync scope
        const batchShopifyOrderIds = orders.map(order => order.legacyResourceId);

        const internalSyncResult = await syncOrdersToInternal({
          organizationId,
          syncJobId,
          shopifyOrderIds: batchShopifyOrderIds, // Only sync this batch's orders
          environment,
        });

        syncLogger.info(
          {
            batchNumber,
            ordersProcessed: internalSyncResult.ordersProcessed,
            orderItemsCreated: internalSyncResult.orderItemsCreated,
          },
          'Batch synced to internal tables'
        );
      } catch (error) {
        syncLogger.error(
          { error, batchNumber, syncJobId },
          'Failed to sync batch to internal tables (continuing with next batch)'
        );
        // Don't throw - continue with Shopify sync even if internal sync fails
      }

      // Check if we should continue
      if (fetchAll) {
        // For full sync, continue while there are more pages
        hasMore = pageInfo.hasNextPage;
      } else {
        // For incremental, only process first page
        hasMore = false;
      }

      currentCursor = pageInfo.endCursor;
      result.hasNextPage = pageInfo.hasNextPage;
      result.endCursor = currentCursor;

      // Add delay between pages to respect rate limits (only for large full syncs)
      // For incremental syncs or first few batches, no delay needed
      if (hasMore && fetchAll && batchNumber >= 3) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    syncLogger.info(
      {
        syncJobId,
        totalProcessed: result.processedItems,
        successCount: result.successCount,
        errorCount: result.errorCount,
      },
      'Shopify orders sync completed'
    );

    return result;
  } catch (error) {
    syncLogger.error({ error, syncJobId, organizationId }, 'Shopify orders sync failed');
    result.success = false;
    result.errorCount = result.totalItems - result.successCount;
    throw error;
  }
}

/**
 * Transform GraphQL order to database format
 */
function transformGraphQLOrder(order: ShopifyOrder, organizationId: string) {
  const shopifyOrderId = order.legacyResourceId;

  // Extract customer name
  const customerName = order.customer
    ? `${order.customer.firstName || ''} ${order.customer.lastName || ''}`.trim() || null
    : null;

  // Parse Zapiet data from line items custom attributes
  let zapietData: { method?: string; date?: string; location?: string } = {};
  const lineItems = order.lineItems?.edges || [];
  for (const edge of lineItems) {
    const customAttrs = edge.node.customAttributes || [];
    const zapietAttr = customAttrs.find((attr: any) => attr.key === '_ZapietId');
    if (zapietAttr) {
      // Parse format: "M=D&L=112097&D=2025-10-20T00:00:00Z"
      const parts = zapietAttr.value.split('&');
      for (const part of parts) {
        const [key, value] = part.split('=');
        if (key === 'M') zapietData.method = value; // D=delivery, P=pickup
        if (key === 'D') zapietData.date = value;
        if (key === 'L') zapietData.location = value;
      }
      break; // Use first Zapiet attribute found
    }
  }

  // Determine delivery method from shipping lines or tags
  const shippingLines = order.shippingLines?.edges || [];
  const shippingLine = shippingLines[0]?.node;
  const shippingCode = shippingLine?.code || '';
  const shippingTitle = shippingLine?.title || '';
  const tags = order.tags.join(',').toLowerCase();

  let pickupDate: string | null = null;
  let pickupLocation: string | null = null;

  // Parse based on Zapiet method
  if (zapietData.method === 'P') {
    // Pickup
    if (zapietData.date) {
      pickupDate = zapietData.date.split('T')[0]; // Extract date portion (YYYY-MM-DD)
    }
    pickupLocation = shippingTitle || zapietData.location || null;
  } else if (zapietData.method === 'D' || tags.includes('local delivery') || shippingCode.includes('local-delivery')) {
    // Local delivery - store delivery date in pickup_date field
    if (zapietData.date) {
      pickupDate = zapietData.date.split('T')[0]; // Extract date portion (YYYY-MM-DD)
    }
    // Store delivery method indicator in pickup_location for now
    pickupLocation = `LOCAL_DELIVERY: ${shippingTitle}`;
  }

  return {
    organizationId,
    shopifyOrderId,
    shopifyOrderNumber: order.name.replace(/^#/, ''),
    name: order.name,
    shopifyCreatedAt: new Date(order.createdAt),
    shopifyUpdatedAt: new Date(order.updatedAt),
    shopifyCancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
    customerEmail: order.email || order.customer?.email || null,
    customerPhone: order.phone || order.customer?.phone || null,
    customerName,
    shopifyCustomerId: order.customer?.legacyResourceId || null,
    financialStatus: order.displayFinancialStatus.toLowerCase(),
    fulfillmentStatus: order.displayFulfillmentStatus.toLowerCase(),
    cancelReason: order.cancelReason || null,
    currency: order.totalPriceSet.shopMoney.currencyCode,
    totalPrice: order.totalPriceSet.shopMoney.amount,
    subtotalPrice: order.subtotalPriceSet.shopMoney.amount,
    totalTax: order.totalTaxSet.shopMoney.amount,
    totalDiscounts: order.totalDiscountsSet.shopMoney.amount,
    tags: order.tags.join(','),
    note: order.note || null,
    test: false, // GraphQL doesn't expose test field
    pickupDate,
    pickupLocation,
    rawData: order,
    apiVersion: '2024-10', // Shopify API version
    syncedAt: new Date(),
    updatedAt: new Date(),
  };
}
