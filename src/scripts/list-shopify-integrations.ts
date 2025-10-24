/**
 * List all Shopify integrations
 */

import 'dotenv/config';
import { getDatabaseForEnvironment } from '../config/database';
import { shopifyIntegrations } from '../db/schema';

async function listIntegrations() {
  const environment = (process.env.ENVIRONMENT as 'dev' | 'staging' | 'production') || 'production';
  const db = getDatabaseForEnvironment(environment);

  console.log(`\nEnvironment: ${environment}`);
  console.log('Fetching Shopify integrations...\n');

  const integrations = await db
    .select({
      id: shopifyIntegrations.id,
      organizationId: shopifyIntegrations.organizationId,
      shopDomain: shopifyIntegrations.shopDomain,
      isActive: shopifyIntegrations.isActive,
      installedAt: shopifyIntegrations.installedAt,
      uninstalledAt: shopifyIntegrations.uninstalledAt,
      lastOrderSyncAt: shopifyIntegrations.lastOrderSyncAt,
    })
    .from(shopifyIntegrations);

  if (integrations.length === 0) {
    console.log('❌ No Shopify integrations found\n');
    process.exit(0);
  }

  console.log(`Found ${integrations.length} integration(s):\n`);
  console.log('─'.repeat(120));

  for (const int of integrations) {
    console.log('Organization ID:', int.organizationId);
    console.log('Integration ID: ', int.id);
    console.log('Shop Domain:    ', int.shopDomain);
    console.log('Is Active:      ', int.isActive ? '✅ Yes' : '❌ No');
    console.log('Installed:      ', int.installedAt?.toISOString() || 'N/A');
    console.log('Uninstalled:    ', int.uninstalledAt?.toISOString() || 'Still Active');
    console.log('Last Order Sync:', int.lastOrderSyncAt?.toISOString() || 'Never');
    console.log('─'.repeat(120));
  }

  console.log('\nTo check a specific integration, run:');
  console.log('npx tsx src/scripts/check-shopify-integration.ts <organizationId>\n');

  process.exit(0);
}

listIntegrations().catch(console.error);
