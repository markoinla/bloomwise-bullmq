import 'dotenv/config';
import { db } from './src/config/database';
import { sql } from 'drizzle-orm';

async function verifySync() {
  const orgId = '2e549254-5321-48ba-a4f2-b754a02cc1e2';

  try {
    // Check shopify_orders
    const shopifyOrdersCount = await db.execute(sql`
      SELECT COUNT(*) as count
      FROM shopify_orders
      WHERE organization_id = ${orgId}
    `);

    // Check orders
    const ordersCount = await db.execute(sql`
      SELECT COUNT(*) as count
      FROM orders
      WHERE organization_id = ${orgId}
        AND order_source = 'shopify'
    `);

    // Check order_items
    const orderItemsCount = await db.execute(sql`
      SELECT COUNT(*) as count
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.organization_id = ${orgId}
        AND o.order_source = 'shopify'
    `);

    // Check linked orders
    const linkedOrdersCount = await db.execute(sql`
      SELECT COUNT(*) as count
      FROM shopify_orders
      WHERE organization_id = ${orgId}
        AND internal_order_id IS NOT NULL
    `);

    // Get sample order with items
    const sampleOrder = await db.execute(sql`
      SELECT
        o.id,
        o.order_number,
        o.customer_name,
        o.status,
        o.payment_status,
        o.total,
        o.shopify_order_id,
        COUNT(oi.id) as item_count
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.organization_id = ${orgId}
        AND o.order_source = 'shopify'
      GROUP BY o.id
      LIMIT 1
    `);

    const shopifyRows = shopifyOrdersCount.rows || shopifyOrdersCount;
    const ordersRows = ordersCount.rows || ordersCount;
    const itemsRows = orderItemsCount.rows || orderItemsCount;
    const linkedRows = linkedOrdersCount.rows || linkedOrdersCount;
    const sampleRows = sampleOrder.rows || sampleOrder;

    console.log('\n✅ Orders Sync Verification\n');
    console.log(`Shopify Orders:           ${(shopifyRows as any)[0].count}`);
    console.log(`Internal Orders:          ${(ordersRows as any)[0].count}`);
    console.log(`Order Items:              ${(itemsRows as any)[0].count}`);
    console.log(`Linked Orders:            ${(linkedRows as any)[0].count}`);

    if (sampleRows.length > 0) {
      const sample = sampleRows[0] as any;
      console.log('\n📦 Sample Order:');
      console.log(`  Order Number:   ${sample.order_number}`);
      console.log(`  Customer:       ${sample.customer_name}`);
      console.log(`  Status:         ${sample.status}`);
      console.log(`  Payment:        ${sample.payment_status}`);
      console.log(`  Total:          $${sample.total}`);
      console.log(`  Line Items:     ${sample.item_count}`);
      console.log(`  Shopify ID:     ${sample.shopify_order_id}`);
    }
  } catch (error) {
    console.error('Error:', error);
  }
  process.exit(0);
}

verifySync();
