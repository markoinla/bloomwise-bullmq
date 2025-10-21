import { executeGraphQLQuery } from './src/lib/shopify/client';
import { getDatabaseForEnvironment } from './src/config/database';
import { shopifyIntegrations } from './src/db/schema';
import { eq } from 'drizzle-orm';

async function testOrderGraphQL() {
  const db = getDatabaseForEnvironment('production');
  
  // Get Shopify integration
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

  // Comprehensive order query with ALL possible fields
  const query = `
    query getOrder($id: ID!) {
      order(id: $id) {
        id
        legacyResourceId
        name
        email
        phone
        processedAt
        createdAt
        updatedAt
        cancelledAt
        cancelReason
        
        # Financial info
        totalPriceSet { shopMoney { amount currencyCode } }
        subtotalPriceSet { shopMoney { amount currencyCode } }
        totalTaxSet { shopMoney { amount currencyCode } }
        totalDiscountsSet { shopMoney { amount currencyCode } }
        
        # Status
        displayFulfillmentStatus
        displayFinancialStatus
        confirmed
        closed
        
        # Customer
        customer {
          id
          legacyResourceId
          firstName
          lastName
          email
          phone
        }
        
        # Addresses
        shippingAddress {
          firstName
          lastName
          company
          address1
          address2
          city
          province
          country
          zip
          phone
        }
        
        billingAddress {
          firstName
          lastName
          company
          address1
          address2
          city
          province
          country
          zip
          phone
        }
        
        # Line items
        lineItems(first: 50) {
          edges {
            node {
              id
              title
              quantity
              variant {
                id
                legacyResourceId
                title
                sku
                barcode
                product {
                  id
                  legacyResourceId
                  title
                }
              }
              customAttributes {
                key
                value
              }
              discountedTotalSet { shopMoney { amount currencyCode } }
              originalUnitPriceSet { shopMoney { amount currencyCode } }
              discountedUnitPriceSet { shopMoney { amount currencyCode } }
            }
          }
        }
        
        # Fulfillments
        fulfillments(first: 10) {
          id
          status
          createdAt
          updatedAt
          trackingInfo {
            company
            number
            url
          }
        }
        
        # Shipping lines
        shippingLines(first: 10) {
          edges {
            node {
              id
              title
              code
              originalPriceSet { shopMoney { amount currencyCode } }
            }
          }
        }
        
        # NOTE AND ATTRIBUTES - KEY FIELDS
        note
        customAttributes {
          key
          value
        }
        
        # Tags
        tags
        
        # Metafields
        metafields(first: 50) {
          edges {
            node {
              id
              namespace
              key
              value
              type
            }
          }
        }
      }
    }
  `;

  const orderId = 'gid://shopify/Order/6889983672492';
  console.log('Fetching order from Shopify:', orderId);
  
  const result = await executeGraphQLQuery<{ order: any }>(config, query, { id: orderId });
  
  if (result.errors) {
    console.error('GraphQL Errors:', JSON.stringify(result.errors, null, 2));
    return;
  }
  
  const order = result.data?.order;
  
  console.log('\n=== CUSTOM ATTRIBUTES (Order Level) ===');
  console.log(JSON.stringify(order.customAttributes, null, 2));
  
  console.log('\n=== NOTE ===');
  console.log(order.note);
  
  console.log('\n=== METAFIELDS ===');
  const metafields = order.metafields.edges.map((e: any) => e.node);
  console.log(JSON.stringify(metafields, null, 2));
  
  console.log('\n=== LINE ITEM CUSTOM ATTRIBUTES ===');
  order.lineItems.edges.forEach((edge: any, idx: number) => {
    console.log(`\nLine item ${idx}: ${edge.node.title}`);
    console.log('  customAttributes:', JSON.stringify(edge.node.customAttributes, null, 2));
  });
  
  console.log('\n=== TAGS ===');
  console.log(order.tags);
  
  console.log('\n✅ Query completed successfully!');
  console.log('\nTo see full JSON, uncomment the line below:');
  // console.log(JSON.stringify(order, null, 2));
}

testOrderGraphQL().catch(console.error);
