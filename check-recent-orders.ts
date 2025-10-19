import 'dotenv/config';
import { db } from './src/config/database';
import { sql } from 'drizzle-orm';

async function checkRecentOrders() {
  const orgId = '2e549254-5321-48ba-a4f2-b754a02cc1e2';

  try {
    // Check when orders were created
    const recentOrders = await db.execute(sql`
      SELECT
        order_number,
        customer_name,
        total,
        status,
        shopify_order_id,
        created_at,
        updated_at,
        shopify_synced_at
      FROM orders
      WHERE organization_id = ${orgId}
        AND order_source = 'shopify'
      ORDER BY created_at DESC
      LIMIT 10
    `);

    // Check shopify_orders that don't have internal_order_id
    const unlinked = await db.execute(sql`
      SELECT COUNT(*) as count
      FROM shopify_orders
      WHERE organization_id = ${orgId}
        AND internal_order_id IS NULL
    `);

    // Check when shopify_orders were synced
    const recentShopifyOrders = await db.execute(sql`
      SELECT
        shopify_order_id,
        shopify_order_number,
        customer_name,
        total_price,
        synced_at,
        internal_order_id
      FROM shopify_orders
      WHERE organization_id = ${orgId}
      ORDER BY synced_at DESC
      LIMIT 5
    `);

    const ordersRows = recentOrders.rows || recentOrders;
    const unlinkedRows = unlinked.rows || unlinked;
    const shopifyRows = recentShopifyOrders.rows || recentShopifyOrders;

    console.log('\n📅 Most Recently Created Internal Orders:');
    ordersRows.forEach((order: any, i: number) => {
      console.log(`\n${i + 1}. Order #${order.order_number}`);
      console.log(`   Customer: ${order.customer_name}`);
      console.log(`   Total: $${order.total}`);
      console.log(`   Status: ${order.status}`);
      console.log(`   Created: ${order.created_at}`);
      console.log(`   Updated: ${order.updated_at}`);
      console.log(`   Shopify Synced: ${order.shopify_synced_at}`);
    });

    console.log(`\n\n🔗 Unlinked Shopify Orders: ${(unlinkedRows as any)[0].count}`);

    console.log('\n\n📦 Most Recently Synced Shopify Orders:');
    shopifyRows.forEach((order: any, i: number) => {
      console.log(`\n${i + 1}. Shopify #${order.shopify_order_number}`);
      console.log(`   Customer: ${order.customer_name}`);
      console.log(`   Total: $${order.total_price}`);
      console.log(`   Synced At: ${order.synced_at}`);
      console.log(`   Internal Order ID: ${order.internal_order_id || 'NOT LINKED'}`);
    });

  } catch (error) {
    console.error('Error:', error);
  }
  process.exit(0);
}

checkRecentOrders();
