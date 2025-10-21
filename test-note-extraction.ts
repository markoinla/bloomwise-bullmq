/**
 * Test note extraction for a specific order
 */

import { getDatabaseForEnvironment } from './src/config/database.js';
import { shopifyOrders } from './src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { extractAndInsertOrderNotes } from './src/lib/sync/extract-order-notes.js';

const ORGANIZATION_ID = 'cf27539c-2292-4cdb-9d3a-42bbc086637d';
const SHOPIFY_ORDER_ID = '6889483206828';
const INTERNAL_ORDER_ID = '31425e40-2734-4b5d-922a-b99bbc1b642c';

async function testNoteExtraction() {
  console.log('🧪 Testing note extraction for order:', SHOPIFY_ORDER_ID);

  const db = getDatabaseForEnvironment('production');

  // Fetch the shopify_order record
  const shopifyOrderRecords = await db
    .select()
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.organizationId, ORGANIZATION_ID),
        eq(shopifyOrders.shopifyOrderId, SHOPIFY_ORDER_ID),
        eq(shopifyOrders.internalOrderId, INTERNAL_ORDER_ID)
      )
    );

  if (shopifyOrderRecords.length === 0) {
    console.error('❌ No shopify_order record found');
    return;
  }

  const shopifyOrder = shopifyOrderRecords[0];
  console.log('✅ Found shopify_order record:', {
    id: shopifyOrder.id,
    shopifyOrderId: shopifyOrder.shopifyOrderId,
    internalOrderId: shopifyOrder.internalOrderId,
    hasRawData: !!shopifyOrder.rawData,
  });

  // Check raw data structure
  const rawData = shopifyOrder.rawData as any;
  console.log('📊 Raw data structure:', {
    hasLineItems: !!rawData?.lineItems,
    hasLineItemsEdges: !!rawData?.lineItems?.edges,
    lineItemsCount: rawData?.lineItems?.edges?.length || 0,
    firstLineItemHasCustomAttrs: !!rawData?.lineItems?.edges?.[0]?.node?.customAttributes,
    customAttrsCount: rawData?.lineItems?.edges?.[0]?.node?.customAttributes?.length || 0,
  });

  if (rawData?.lineItems?.edges?.[0]?.node?.customAttributes) {
    console.log('🔍 Custom attributes:',
      rawData.lineItems.edges[0].node.customAttributes.map((attr: any) => ({
        key: attr.key,
        valueLength: attr.value?.length || 0,
      }))
    );
  }

  // Run note extraction
  console.log('\n🚀 Running note extraction...');
  const result = await extractAndInsertOrderNotes({
    organizationId: ORGANIZATION_ID,
    orders: [{
      internalOrderId: INTERNAL_ORDER_ID,
      shopifyOrder,
      shopifyCreatedAt: shopifyOrder.shopifyCreatedAt,
    }],
    environment: 'production',
  });

  console.log('\n✨ Note extraction result:', result);

  if (!result.success) {
    console.error('❌ Errors:', result.errors);
  }

  process.exit(0);
}

testNoteExtraction().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
