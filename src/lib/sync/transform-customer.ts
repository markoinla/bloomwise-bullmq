/**
 * Transform Shopify customer GraphQL response to database record
 */

import type { ShopifyCustomerInsert } from '../../db/schema';

interface ShopifyCustomerNode {
  id: string;
  legacyResourceId: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  state?: string | null;
  verifiedEmail?: boolean | null;
  acceptsMarketing?: boolean | null;
  marketingOptInLevel?: string | null;
  emailMarketingConsent?: {
    consentUpdatedAt?: string | null;
    marketingOptInLevel?: string | null;
    marketingState?: string | null;
  } | null;
  smsMarketingConsent?: {
    consentCollectedFrom?: string | null;
    consentUpdatedAt?: string | null;
    marketingOptInLevel?: string | null;
    marketingState?: string | null;
  } | null;
  defaultAddress?: {
    id?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    country?: string | null;
    zip?: string | null;
    phone?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
  } | null;
  addresses?: Array<{
    id?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    country?: string | null;
    zip?: string | null;
    phone?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
  }>;
  ordersCount?: number | null;
  amountSpent?: {
    amount: string;
    currencyCode: string;
  } | null;
  tags?: string[] | null;
  note?: string | null;
  createdAt: string;
  updatedAt: string;
}

export function transformCustomerToDbRecord(
  customer: ShopifyCustomerNode,
  organizationId: string,
  integrationId: string
): Omit<ShopifyCustomerInsert, 'id' | 'createdAt' | 'updatedAt'> {
  const shopifyCustomerId = customer.legacyResourceId || customer.id.split('/').pop()!;

  return {
    organizationId,
    shopifyCustomerId,
    shopifyIntegrationId: integrationId,

    // Customer info
    email: customer.email || null,
    firstName: customer.firstName || null,
    lastName: customer.lastName || null,
    phone: customer.phone || null,
    state: customer.state || null,

    // Marketing preferences
    verifiedEmail: customer.verifiedEmail || false,
    acceptsMarketing: customer.acceptsMarketing || false,
    marketingOptInLevel: customer.marketingOptInLevel || null,
    emailMarketingConsent: customer.emailMarketingConsent || null,
    smsMarketingConsent: customer.smsMarketingConsent || null,

    // Address info
    defaultAddressId: customer.defaultAddress?.id || null,
    addresses: customer.addresses || null,

    // Stats
    ordersCount: customer.ordersCount || 0,
    totalSpent: customer.amountSpent?.amount || null,
    currency: customer.amountSpent?.currencyCode || null,

    // Metadata
    tags: customer.tags?.join(', ') || null,
    note: customer.note || null,
    metafields: null, // Can be extended later if needed

    // Shopify timestamps
    shopifyCreatedAt: new Date(customer.createdAt),
    shopifyUpdatedAt: new Date(customer.updatedAt),

    // Internal mapping (will be set during sync)
    internalCustomerId: null,

    // Sync metadata
    lastSyncedAt: new Date(),

    // Raw data from Shopify
    rawJson: customer,
  };
}
