/**
 * Script to check orders sync status for an organization
 */

import { db } from '../config/database';
import { shopifyOrders, orders, orderItems, syncJobs } from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '../lib/utils/logger';

const organizationId = '47a111ea-56de-4354-8877-c9dc5dbac17e';

async function checkOrdersSync() {
  try {
    logger.info({ organizationId }, 'Checking orders sync status');

    // 1. Check shopify_orders
    const shopifyOrdersCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(shopifyOrders)
      .where(eq(shopifyOrders.organizationId, organizationId));

    logger.info(
      { count: shopifyOrdersCount[0]?.count },
      'Total shopify_orders for organization'
    );

    // 2. Check shopify_orders with internal_order_id
    const linkedOrdersCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(shopifyOrders)
      .where(
        and(
          eq(shopifyOrders.organizationId, organizationId),
          sql`${shopifyOrders.internalOrderId} IS NOT NULL`
        )
      );

    logger.info(
      { count: linkedOrdersCount[0]?.count },
      'Shopify orders with internal_order_id'
    );

    // 3. Check shopify_orders WITHOUT internal_order_id
    const unlinkedOrdersCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(shopifyOrders)
      .where(
        and(
          eq(shopifyOrders.organizationId, organizationId),
          sql`${shopifyOrders.internalOrderId} IS NULL`
        )
      );

    logger.info(
      { count: unlinkedOrdersCount[0]?.count },
      'Shopify orders WITHOUT internal_order_id (need sync)'
    );

    // 4. Check internal orders
    const internalOrdersCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(orders)
      .where(eq(orders.organizationId, organizationId));

    logger.info(
      { count: internalOrdersCount[0]?.count },
      'Total internal orders for organization'
    );

    // 5. Check internal orders from Shopify
    const shopifySourceOrdersCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(orders)
      .where(
        and(
          eq(orders.organizationId, organizationId),
          eq(orders.orderSource, 'shopify')
        )
      );

    logger.info(
      { count: shopifySourceOrdersCount[0]?.count },
      'Internal orders with order_source = shopify'
    );

    // 6. Check order items
    const orderItemsCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(orderItems)
      .where(eq(orderItems.organizationId, organizationId));

    logger.info(
      { count: orderItemsCount[0]?.count },
      'Total order_items for organization'
    );

    // 7. Get sample shopify_orders to inspect
    const sampleShopifyOrders = await db
      .select({
        id: shopifyOrders.id,
        shopifyOrderId: shopifyOrders.shopifyOrderId,
        shopifyOrderNumber: shopifyOrders.shopifyOrderNumber,
        internalOrderId: shopifyOrders.internalOrderId,
        customerName: shopifyOrders.customerName,
        totalPrice: shopifyOrders.totalPrice,
        syncedAt: shopifyOrders.syncedAt,
      })
      .from(shopifyOrders)
      .where(eq(shopifyOrders.organizationId, organizationId))
      .limit(5);

    logger.info({ orders: sampleShopifyOrders }, 'Sample shopify_orders');

    // 8. Check recent sync jobs
    const recentSyncJobs = await db
      .select({
        id: syncJobs.id,
        type: syncJobs.type,
        status: syncJobs.status,
        processedItems: syncJobs.processedItems,
        totalItems: syncJobs.totalItems,
        successCount: syncJobs.successCount,
        errorCount: syncJobs.errorCount,
        errorMessage: syncJobs.errorMessage,
        startedAt: syncJobs.startedAt,
        completedAt: syncJobs.completedAt,
      })
      .from(syncJobs)
      .where(
        and(
          eq(syncJobs.organizationId, organizationId),
          sql`${syncJobs.type} LIKE '%order%'`
        )
      )
      .orderBy(sql`${syncJobs.createdAt} DESC`)
      .limit(5);

    logger.info({ jobs: recentSyncJobs }, 'Recent order sync jobs');

    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Failed to check orders sync');
    process.exit(1);
  }
}

checkOrdersSync();
