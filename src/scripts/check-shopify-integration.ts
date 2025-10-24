/**
 * Diagnostic script to check Shopify integration credentials
 *
 * Usage:
 *   npx tsx src/scripts/check-shopify-integration.ts [organizationId]
 */

import 'dotenv/config';
import { getDatabaseForEnvironment } from '../config/database';
import { shopifyIntegrations } from '../db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '../lib/utils/logger';

async function checkIntegration() {
  const organizationId = process.argv[2];

  if (!organizationId) {
    console.error('Usage: npx tsx src/scripts/check-shopify-integration.ts <organizationId>');
    process.exit(1);
  }

  const environment = (process.env.ENVIRONMENT as 'dev' | 'staging' | 'production') || 'production';
  const db = getDatabaseForEnvironment(environment);

  logger.info({ organizationId, environment }, 'Checking Shopify integration');

  try {
    const integrations = await db
      .select()
      .from(shopifyIntegrations)
      .where(eq(shopifyIntegrations.organizationId, organizationId));

    if (integrations.length === 0) {
      console.log('\n❌ No Shopify integration found for this organization');
      process.exit(1);
    }

    console.log(`\n✅ Found ${integrations.length} integration(s):\n`);

    for (const integration of integrations) {
      console.log('─'.repeat(60));
      console.log('Integration ID:', integration.id);
      console.log('Shop Domain:', integration.shopDomain);
      console.log('Is Active:', integration.isActive);
      console.log('Access Token (first 10 chars):', integration.accessToken?.substring(0, 10) + '...');
      console.log('Access Token Length:', integration.accessToken?.length || 0);
      console.log('Scope:', integration.scope);
      console.log('Installed At:', integration.installedAt);
      console.log('Uninstalled At:', integration.uninstalledAt);
      console.log('Last Order Sync:', integration.lastOrderSyncAt);
      console.log('Auto Sync Orders:', integration.autoSyncOrders);
      console.log('Auto Sync Products:', integration.autoSyncProducts);
      console.log('Sync Frequency:', integration.syncFrequency);
      console.log('Created At:', integration.createdAt);
      console.log('Updated At:', integration.updatedAt);
      console.log('─'.repeat(60));

      // Test the access token with a simple query
      console.log('\nTesting access token with Shopify API...\n');

      try {
        const testQuery = `
          query {
            shop {
              name
              email
              currencyCode
            }
          }
        `;

        const response = await fetch(
          `https://${integration.shopDomain}/admin/api/2024-10/graphql.json`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Access-Token': integration.accessToken,
            },
            body: JSON.stringify({ query: testQuery }),
          }
        );

        console.log('Response Status:', response.status, response.statusText);

        if (!response.ok) {
          console.log('\n❌ API Request Failed!');
          console.log('Status:', response.status);
          console.log('Status Text:', response.statusText);

          const text = await response.text();
          console.log('Response Body:', text);

          if (response.status === 401) {
            console.log('\n🔐 401 Unauthorized - Possible causes:');
            console.log('   1. Access token is invalid or expired');
            console.log('   2. Shopify app was uninstalled');
            console.log('   3. Access token was revoked');
            console.log('   4. Shop domain is incorrect');
            console.log('\n💡 Solution: Reinstall the Shopify app to get a new access token');
          }
        } else {
          const result = await response.json() as any;

          if (result.errors) {
            console.log('\n❌ GraphQL Errors:');
            console.log(JSON.stringify(result.errors, null, 2));
          } else if (result.data?.shop) {
            console.log('\n✅ Access token is valid!');
            console.log('Shop Name:', result.data.shop.name);
            console.log('Shop Email:', result.data.shop.email);
            console.log('Currency:', result.data.shop.currencyCode);
          }
        }
      } catch (testError) {
        console.log('\n❌ Error testing access token:', testError);
      }
    }

    process.exit(0);
  } catch (error) {
    logger.error({ error, organizationId }, 'Failed to check integration');
    console.error('\n❌ Error:', error);
    process.exit(1);
  }
}

checkIntegration();
