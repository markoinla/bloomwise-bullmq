/**
 * Script to sync existing shopify_orders backlog to internal orders/order_items
 * This processes orders that were fetched from Shopify but failed to sync internally
 */

import { db } from '../config/database';
import { shopifyOrders } from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '../lib/utils/logger';
import { syncOrdersToInternal } from '../lib/sync/sync-orders-to-internal';

const organizationId = '47a111ea-56de-4354-8877-c9dc5dbac17e';
const BATCH_SIZE = 200; // Process 200 orders at a time to match our new limit

async function syncBacklogOrders() {
  try {
    logger.info({ organizationId }, 'Starting backlog orders sync');

    // 1. Count total unsynced orders
    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(shopifyOrders)
      .where(
        and(
          eq(shopifyOrders.organizationId, organizationId),
          sql`${shopifyOrders.internalOrderId} IS NULL`
        )
      );

    const totalUnsynced = countResult?.count || 0;
    logger.info({ totalUnsynced }, 'Total unsynced shopify_orders found');

    if (totalUnsynced === 0) {
      logger.info('No unsynced orders to process');
      process.exit(0);
    }

    // 2. Process in batches of 200
    let offset = 0;
    let batchNumber = 0;
    let totalProcessed = 0;
    let totalOrdersCreated = 0;
    let totalOrderItemsCreated = 0;

    while (offset < totalUnsynced) {
      batchNumber++;

      logger.info(
        {
          batchNumber,
          offset,
          batchSize: BATCH_SIZE,
          progress: `${offset}/${totalUnsynced}`,
        },
        'Processing batch'
      );

      // Fetch batch of unsynced shopify_orders
      const batch = await db
        .select({
          shopifyOrderId: shopifyOrders.shopifyOrderId,
        })
        .from(shopifyOrders)
        .where(
          and(
            eq(shopifyOrders.organizationId, organizationId),
            sql`${shopifyOrders.internalOrderId} IS NULL`
          )
        )
        .limit(BATCH_SIZE)
        .offset(offset);

      if (batch.length === 0) {
        logger.info('No more orders to process');
        break;
      }

      const batchShopifyOrderIds = batch.map(o => o.shopifyOrderId);

      logger.info(
        { count: batchShopifyOrderIds.length },
        'Syncing batch to internal tables'
      );

      // Sync this batch to internal tables
      const result = await syncOrdersToInternal({
        organizationId,
        shopifyOrderIds: batchShopifyOrderIds,
      });

      totalOrdersCreated += result.ordersProcessed;
      totalOrderItemsCreated += result.orderItemsCreated;
      totalProcessed += batch.length;

      logger.info(
        {
          batchNumber,
          ordersProcessed: result.ordersProcessed,
          orderItemsCreated: result.orderItemsCreated,
          totalProgress: `${totalProcessed}/${totalUnsynced}`,
        },
        'Batch completed'
      );

      offset += BATCH_SIZE;

      // Small delay between batches to avoid overwhelming the database
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    logger.info(
      {
        totalOrders: totalOrdersCreated,
        totalOrderItems: totalOrderItemsCreated,
        totalProcessed,
      },
      'Backlog sync completed successfully'
    );

    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Failed to sync backlog orders');
    process.exit(1);
  }
}

syncBacklogOrders();
