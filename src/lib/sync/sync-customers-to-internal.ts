/**
 * Sync shopify_customers to internal customers table
 */

import { getDatabaseForEnvironment } from '../../config/database';
import { shopifyCustomers, customers } from '../../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '../utils/logger';

interface CustomerSyncOptions {
  organizationId: string;
  syncJobId?: string;
  shopifyCustomerIds?: string[]; // Limit sync to specific shopify_customer IDs (for batch processing)
  environment?: 'dev' | 'staging' | 'production';
}

export async function syncCustomersToInternal(options: CustomerSyncOptions): Promise<{
  success: boolean;
  customersProcessed: number;
  customersCreated: number;
  customersUpdated: number;
  errors: number;
}> {
  const { organizationId, syncJobId, shopifyCustomerIds, environment = 'production' } = options;
  const db = getDatabaseForEnvironment(environment);

  logger.info(
    { organizationId, syncJobId, limitToIds: shopifyCustomerIds?.length },
    'Starting internal customers sync'
  );

  const result = {
    success: true,
    customersProcessed: 0,
    customersCreated: 0,
    customersUpdated: 0,
    errors: 0,
  };

  try {
    // Fetch Shopify customers for this organization
    const conditions = [
      eq(shopifyCustomers.organizationId, organizationId),
    ];

    // If specific shopify_customer IDs provided, only sync those
    if (shopifyCustomerIds && shopifyCustomerIds.length > 0) {
      conditions.push(sql`${shopifyCustomers.shopifyCustomerId} = ANY(ARRAY[${sql.join(shopifyCustomerIds.map(id => sql`${id}`), sql`, `)}])`);
    }

    const shopifyCustomersToSync = await db
      .select()
      .from(shopifyCustomers)
      .where(and(...conditions));

    logger.info(
      { count: shopifyCustomersToSync.length },
      'Found Shopify customers to sync'
    );

    if (shopifyCustomersToSync.length === 0) {
      return result;
    }

    // Separate customers into those already linked vs not linked
    const unlinkedCustomers = shopifyCustomersToSync.filter(c => !c.internalCustomerId);
    const linkedCustomers = shopifyCustomersToSync.filter(c => c.internalCustomerId);

    logger.info(
      { unlinked: unlinkedCustomers.length, linked: linkedCustomers.length },
      'Customers breakdown: linked vs unlinked'
    );

    // Get all existing customers with shopify_customer_id for this org (for matching unlinked customers)
    const unlinkedShopifyCustomerIds = unlinkedCustomers.map(c => c.shopifyCustomerId);
    let existingCustomersMap = new Map();

    if (unlinkedShopifyCustomerIds.length > 0) {
      const existingCustomers = await db
        .select()
        .from(customers)
        .where(
          and(
            eq(customers.organizationId, organizationId),
            sql`${customers.shopifyCustomerId} = ANY(ARRAY[${sql.join(unlinkedShopifyCustomerIds.map(id => sql`${id}`), sql`, `)}])`
          )
        );

      existingCustomersMap = new Map(
        existingCustomers.map(c => [c.shopifyCustomerId, c])
      );
    }

    // Separate into new customers and updates (for UNLINKED customers)
    const customersToCreate: any[] = [];
    const customersToLinkExisting: Array<{ shopifyCustomer: any; existingCustomer: any }> = [];
    const shopifyCustomersToLink: Array<{ shopifyCustomerId: string; internalCustomerId: string }> = [];

    for (const shopifyCustomer of unlinkedCustomers) {
      const existingCustomer = existingCustomersMap.get(shopifyCustomer.shopifyCustomerId);
      if (existingCustomer) {
        // Customer already exists, just link them
        customersToLinkExisting.push({ shopifyCustomer, existingCustomer });
        shopifyCustomersToLink.push({
          shopifyCustomerId: shopifyCustomer.shopifyCustomerId,
          internalCustomerId: existingCustomer.id,
        });
      } else {
        // New customer, prepare for creation
        customersToCreate.push(transformShopifyCustomerToInternal(shopifyCustomer, organizationId));
      }
    }

    // Create new internal customers
    if (customersToCreate.length > 0) {
      const createdCustomers = await db
        .insert(customers)
        .values(customersToCreate)
        .returning();

      result.customersCreated += createdCustomers.length;

      // Link shopify_customers to newly created internal customers
      for (let i = 0; i < createdCustomers.length; i++) {
        const shopifyCustomer = unlinkedCustomers.filter(c => !existingCustomersMap.has(c.shopifyCustomerId))[i];
        if (shopifyCustomer) {
          shopifyCustomersToLink.push({
            shopifyCustomerId: shopifyCustomer.shopifyCustomerId,
            internalCustomerId: createdCustomers[i].id,
          });
        }
      }

      logger.info({ count: createdCustomers.length }, 'Created new internal customers');
    }

    // Update shopify_customers with links to internal customers
    if (shopifyCustomersToLink.length > 0) {
      for (const link of shopifyCustomersToLink) {
        await db
          .update(shopifyCustomers)
          .set({ internalCustomerId: link.internalCustomerId })
          .where(
            and(
              eq(shopifyCustomers.organizationId, organizationId),
              eq(shopifyCustomers.shopifyCustomerId, link.shopifyCustomerId)
            )
          );
      }

      logger.info({ count: shopifyCustomersToLink.length }, 'Linked shopify_customers to internal customers');
    }

    // Update already-linked internal customers with latest data from Shopify
    if (linkedCustomers.length > 0) {
      for (const shopifyCustomer of linkedCustomers) {
        const internalCustomerData = transformShopifyCustomerToInternal(shopifyCustomer, organizationId);

        await db
          .update(customers)
          .set({
            firstName: internalCustomerData.firstName,
            lastName: internalCustomerData.lastName,
            email: internalCustomerData.email,
            phone: internalCustomerData.phone,
            shopifyTags: internalCustomerData.shopifyTags,
            totalSpent: internalCustomerData.totalSpent,
            ordersCount: internalCustomerData.ordersCount,
            acceptsMarketing: internalCustomerData.acceptsMarketing,
            updatedAt: new Date(),
          })
          .where(eq(customers.id, shopifyCustomer.internalCustomerId!));
      }

      result.customersUpdated += linkedCustomers.length;
      logger.info({ count: linkedCustomers.length }, 'Updated existing internal customers');
    }

    result.customersProcessed = shopifyCustomersToSync.length;
    logger.info(result, 'Internal customers sync completed');

    return result;
  } catch (error) {
    logger.error({ error, organizationId, syncJobId }, 'Failed to sync customers to internal table');
    result.success = false;
    result.errors = 1;
    return result;
  }
}

/**
 * Transform Shopify customer to internal customer format
 */
function transformShopifyCustomerToInternal(shopifyCustomer: any, organizationId: string) {
  return {
    organizationId,
    shopifyCustomerId: shopifyCustomer.shopifyCustomerId,
    firstName: shopifyCustomer.firstName,
    lastName: shopifyCustomer.lastName,
    email: shopifyCustomer.email,
    phone: shopifyCustomer.phone,
    shopifyTags: shopifyCustomer.tags,
    totalSpent: shopifyCustomer.totalSpent,
    ordersCount: shopifyCustomer.ordersCount || 0,
    acceptsMarketing: shopifyCustomer.acceptsMarketing || false,
    source: 'shopify',
    tags: shopifyCustomer.tags ? [shopifyCustomer.tags] : [],
    notes: shopifyCustomer.note,
  };
}
