/**
 * Update Shopify access token for an integration
 *
 * WARNING: Use this only if you have a valid access token from Shopify Partners dashboard
 * or after reinstalling the app. Normally, access tokens are updated via OAuth flow.
 *
 * Usage:
 *   npx tsx src/scripts/update-access-token.ts <integrationId> <newAccessToken>
 */

import 'dotenv/config';
import { getDatabaseForEnvironment } from '../config/database';
import { shopifyIntegrations } from '../db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '../lib/utils/logger';

async function updateAccessToken() {
  const integrationId = process.argv[2];
  const newAccessToken = process.argv[3];

  if (!integrationId || !newAccessToken) {
    console.error('Usage: npx tsx src/scripts/update-access-token.ts <integrationId> <newAccessToken>');
    console.error('Example: npx tsx src/scripts/update-access-token.ts 006c118c-7930-40d2-9ddd-7cf7a7a30226 shpca_xxxxx');
    process.exit(1);
  }

  if (!newAccessToken.startsWith('shpca_') && !newAccessToken.startsWith('shpat_')) {
    console.error('\n❌ Invalid access token format!');
    console.error('Shopify access tokens should start with "shpca_" (custom app) or "shpat_" (private app)');
    process.exit(1);
  }

  const environment = (process.env.ENVIRONMENT as 'dev' | 'staging' | 'production') || 'production';
  const db = getDatabaseForEnvironment(environment);

  logger.info({ integrationId, environment }, 'Updating access token');

  try {
    // Check if integration exists
    const [integration] = await db
      .select()
      .from(shopifyIntegrations)
      .where(eq(shopifyIntegrations.id, integrationId))
      .limit(1);

    if (!integration) {
      console.error(`\n❌ Integration ${integrationId} not found`);
      process.exit(1);
    }

    console.log('\n📋 Current Integration:');
    console.log('   Organization ID:', integration.organizationId);
    console.log('   Shop Domain:', integration.shopDomain);
    console.log('   Current Token (first 10):', integration.accessToken.substring(0, 10) + '...');
    console.log('   New Token (first 10):', newAccessToken.substring(0, 10) + '...');

    // Test the new token first
    console.log('\n🔍 Testing new access token...');

    const testQuery = `
      query {
        shop {
          name
          email
        }
      }
    `;

    const response = await fetch(
      `https://${integration.shopDomain}/admin/api/2024-10/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': newAccessToken,
        },
        body: JSON.stringify({ query: testQuery }),
      }
    );

    if (!response.ok) {
      console.log('\n❌ New access token is INVALID!');
      console.log('Status:', response.status, response.statusText);
      const text = await response.text();
      console.log('Response:', text);
      process.exit(1);
    }

    const result = await response.json() as any;

    if (result.errors) {
      console.log('\n❌ New access token has GraphQL errors:');
      console.log(JSON.stringify(result.errors, null, 2));
      process.exit(1);
    }

    console.log('\n✅ New access token is VALID!');
    console.log('   Shop Name:', result.data.shop.name);
    console.log('   Shop Email:', result.data.shop.email);

    // Update the database
    console.log('\n💾 Updating database...');

    await db
      .update(shopifyIntegrations)
      .set({
        accessToken: newAccessToken,
        updatedAt: new Date(),
      })
      .where(eq(shopifyIntegrations.id, integrationId));

    console.log('\n✅ Access token updated successfully!');
    console.log('\nYou can now trigger sync jobs for organization:', integration.organizationId);

    process.exit(0);
  } catch (error) {
    logger.error({ error, integrationId }, 'Failed to update access token');
    console.error('\n❌ Error:', error);
    process.exit(1);
  }
}

updateAccessToken();
