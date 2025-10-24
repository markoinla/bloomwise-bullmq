/**
 * Backfill script to create missing order_items for existing orders
 *
 * This script re-processes all shopify_orders that have internal_order_id
 * but may be missing order_items due to the REST/GraphQL format bug.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-order-items.ts [organizationId]
 */

import { getDatabaseForEnvironment } from '../../config/database';
import { shopifyOrders } from '../../db/schema';
import { eq, isNotNull, and } from 'drizzle-orm';
import { syncOrdersToInternal } from '../../lib/sync/sync-orders-to-internal';
import { logger } from '../../lib/utils/logger';

async function backfillOrderItems() {
  const organizationId = process.argv[2];

  if (!organizationId) {
    console.error('Usage: npx tsx src/scripts/backfill-order-items.ts <organizationId>');
    process.exit(1);
  }

  const environment = (process.env.ENVIRONMENT as 'dev' | 'staging' | 'production') || 'production';
  const db = getDatabaseForEnvironment(environment);

  logger.info(
    { organizationId, environment },
    'Starting order items backfill'
  );

  try {
    // Find all shopify_orders that are already linked to internal orders
    const linkedOrders = await db
      .select()
      .from(shopifyOrders)
      .where(
        and(
          eq(shopifyOrders.organizationId, organizationId),
          isNotNull(shopifyOrders.internalOrderId)
        )
      );

    logger.info({ count: linkedOrders.length }, 'Found linked shopify orders');

    if (linkedOrders.length === 0) {
      logger.info('No orders to backfill');
      return;
    }

    // Get the shopify_order_ids to process
    const shopifyOrderIds = linkedOrders.map(o => o.shopifyOrderId);

    logger.info(
      { orderCount: linkedOrders.length },
      'Re-processing orders to create order items'
    );

    // Re-sync these orders (this will delete existing items and recreate them)
    const result = await syncOrdersToInternal({
      organizationId,
      shopifyOrderIds,
      environment,
    });

    logger.info(
      {
        ordersProcessed: result.ordersProcessed,
        orderItemsCreated: result.orderItemsCreated,
        errors: result.errors,
      },
      'Backfill completed'
    );

    console.log('\n✅ Backfill Summary:');
    console.log(`   Orders processed: ${result.ordersProcessed}`);
    console.log(`   Order items created: ${result.orderItemsCreated}`);
    console.log(`   Errors: ${result.errors}`);

    process.exit(0);
  } catch (error) {
    logger.error({ error, organizationId }, 'Backfill failed');
    console.error('❌ Backfill failed:', error);
    process.exit(1);
  }
}

backfillOrderItems();
