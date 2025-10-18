import { describe, it, expect, beforeAll } from 'vitest';
import { fetchProductsGraphQL, fetchOrdersGraphQL } from '../graphql-client';
import { db } from '@/db/drizzle';
import { shopifyIntegrations } from '@/db/schema';
import { eq } from 'drizzle-orm';

// Integration tests that hit the real Shopify API
// These require valid environment variables and database setup
describe('Shopify API Integration Tests', () => {
  let testOrganizationId: string;

  beforeAll(async () => {
    // Skip tests if no Shopify credentials are available
    if (!process.env.SHOPIFY_PARTNER_CLIENT_ID || !process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN) {
      console.log('Skipping integration tests - no Shopify credentials found');
      return;
    }

    // Find an organization with Shopify integration
    const integration = await db
      .select()
      .from(shopifyIntegrations)
      .where(eq(shopifyIntegrations.isActive, true))
      .limit(1);

    if (integration.length === 0) {
      console.log('Skipping integration tests - no active Shopify integration found');
      return;
    }

    testOrganizationId = integration[0].organizationId;
  });

  it('should fetch real products from Shopify GraphQL API', async () => {
    // Skip if no credentials or organization
    if (!process.env.SHOPIFY_PARTNER_CLIENT_ID || !testOrganizationId) {
      console.log('Skipping products test - missing credentials or organization');
      return;
    }

    const response = await fetchProductsGraphQL(testOrganizationId, {
      limit: 5, // Small limit for testing
    });

    expect(response).toHaveProperty('data');
    expect(Array.isArray(response.data)).toBe(true);
    expect(response).toHaveProperty('pageInfo');
    expect(response.pageInfo).toHaveProperty('hasNextPage');

    if (response.data.length > 0) {
      const product = response.data[0];
      expect(product).toHaveProperty('legacyResourceId');
      expect(product).toHaveProperty('title');
      expect(product).toHaveProperty('variants');
    }

    console.log(`✅ Fetched ${response.data.length} products from Shopify GraphQL API`);
  }, 10000); // 10 second timeout for API call

  it('should fetch real orders from Shopify GraphQL API', async () => {
    // Skip if no credentials or organization
    if (!process.env.SHOPIFY_PARTNER_CLIENT_ID || !testOrganizationId) {
      console.log('Skipping orders test - missing credentials or organization');
      return;
    }

    const response = await fetchOrdersGraphQL(testOrganizationId, {
      limit: 5, // Small limit for testing
    });

    expect(response).toHaveProperty('data');
    expect(Array.isArray(response.data)).toBe(true);
    expect(response).toHaveProperty('pageInfo');
    expect(response.pageInfo).toHaveProperty('hasNextPage');

    if (response.data.length > 0) {
      const order = response.data[0];
      expect(order).toHaveProperty('legacyResourceId');
      expect(order).toHaveProperty('name');
      expect(order).toHaveProperty('totalPriceSet');
    }

    console.log(`✅ Fetched ${response.data.length} orders from Shopify GraphQL API`);
  }, 10000); // 10 second timeout for API call

  it('should handle API errors gracefully', async () => {
    // Skip if no credentials
    if (!process.env.SHOPIFY_PARTNER_CLIENT_ID) {
      console.log('Skipping error test - missing credentials');
      return;
    }

    // Test with invalid organization ID to trigger error
    await expect(
      fetchProductsGraphQL('invalid-org-id', { limit: 1 })
    ).rejects.toThrow();

    console.log('✅ Error handling works correctly');
  }, 10000);
});