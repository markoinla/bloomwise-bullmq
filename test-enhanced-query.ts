import { executeGraphQLQuery } from './src/lib/shopify/client';
import { getDatabaseForEnvironment } from './src/config/database';
import { shopifyIntegrations } from './src/db/schema';
import { eq } from 'drizzle-orm';
import { ENHANCED_ORDERS_QUERY } from './src/lib/shopify/enhanced-orders-query';

async function testEnhancedQuery() {
  const db = getDatabaseForEnvironment('production');
  
  const integration = await db
    .select()
    .from(shopifyIntegrations)
    .where(eq(shopifyIntegrations.organizationId, 'cf27539c-2292-4cdb-9d3a-42bbc086637d'))
    .limit(1);

  if (!integration[0]) {
    throw new Error('No Shopify integration found');
  }

  const config = {
    shopDomain: integration[0].shopDomain,
    accessToken: integration[0].accessToken,
  };

  console.log('Testing enhanced query - fetching 1 order...');
  
  const result = await executeGraphQLQuery<{ orders: any }>(
    config, 
    ENHANCED_ORDERS_QUERY, 
    { 
      first: 1,
      query: 'name:#6011'
    }
  );
  
  if (result.errors) {
    console.error('\n❌ GraphQL Errors:');
    result.errors.forEach(err => {
      console.error(`  - ${err.message}`);
      if (err.path) console.error(`    Path: ${err.path.join('.')}`);
    });
    return;
  }
  
  const order = result.data?.orders?.edges[0]?.node;
  
  if (!order) {
    console.error('No order found');
    return;
  }
  
  console.log('\n✅ Query successful!');
  console.log(`\nOrder: ${order.name}`);
  console.log(`Fields fetched: ${Object.keys(order).length}`);
  
  console.log('\n=== NEW FIELDS CAPTURED ===');
  console.log(`Edited: ${order.edited}`);
  console.log(`Test Order: ${order.test}`);
  console.log(`Risk Level: ${order.riskLevel}`);
  console.log(`Client IP: ${order.clientIp}`);
  console.log(`Customer Locale: ${order.customerLocale}`);
  console.log(`Source: ${order.sourceName}`);
  console.log(`PO Number: ${order.poNumber}`);
  console.log(`Total Tip: ${order.totalTipReceivedSet?.shopMoney?.amount || '0'}`);
  console.log(`Channel: ${order.channelInformation?.channelDefinition?.channelName || 'N/A'}`);
  
  console.log(`\n=== CUSTOM ATTRIBUTES ===`);
  console.log(JSON.stringify(order.customAttributes, null, 2));
  
  console.log(`\n=== TRANSACTIONS (${order.transactions?.length || 0}) ===`);
  order.transactions?.forEach((t: any, i: number) => {
    console.log(`${i + 1}. ${t.kind} - ${t.status} - ${t.gateway} - $${t.amountSet.shopMoney.amount}`);
  });
  
  console.log(`\n=== REFUNDS (${order.refunds?.length || 0}) ===`);
  order.refunds?.forEach((r: any, i: number) => {
    console.log(`${i + 1}. $${r.totalRefundedSet.shopMoney.amount} - ${r.note || 'No note'}`);
  });
  
  console.log('\n=== GraphQL Cost ===');
  if (result.extensions?.cost) {
    console.log(`Requested: ${result.extensions.cost.requestedQueryCost}`);
    console.log(`Actual: ${result.extensions.cost.actualQueryCost}`);
    console.log(`Available: ${result.extensions.cost.throttleStatus.currentlyAvailable}/${result.extensions.cost.throttleStatus.maximumAvailable}`);
  }
  
  // Uncomment to see full JSON
  // console.log('\n=== FULL ORDER DATA ===');
  // console.log(JSON.stringify(order, null, 2));
}

testEnhancedQuery().catch(console.error);
