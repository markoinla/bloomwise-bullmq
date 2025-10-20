/**
 * Shopify Customers Sync - Full Implementation
 *
 * 1. Fetches customers from Shopify GraphQL API
 * 2. Transforms customers to database records
 * 3. Upserts customers to shopify_customers table
 * 4. Syncs to internal customers table (find-or-create)
 * 5. Updates syncJobs progress
 */

import { logger } from '../utils/logger';
import { updateSyncJobProgress } from '../../db/queries';
import { executeGraphQLQuery } from '../shopify/client';
import { CUSTOMERS_QUERY } from '../shopify/graphql-queries';
import { transformCustomerToDbRecord } from './transform-customer';
import { db } from '../../config/database';
import { shopifyCustomers, customers } from '../../db/schema';
import { sql, eq, and } from 'drizzle-orm';

interface CustomersSyncParams {
  organizationId: string;
  syncJobId: string;
  shopDomain: string;
  accessToken: string;
  integrationId: string;
  fetchAll?: boolean;
  updatedAfter?: string;
}

export interface CustomersSyncResult {
  success: boolean;
  totalItems: number;
  processedItems: number;
  successCount: number;
  errorCount: number;
  skipCount: number;
}

export async function syncShopifyCustomers(
  params: CustomersSyncParams
): Promise<CustomersSyncResult> {
  const {
    organizationId,
    syncJobId,
    shopDomain,
    accessToken,
    integrationId,
    fetchAll = false,
    updatedAfter,
  } = params;

  const result: CustomersSyncResult = {
    success: true,
    totalItems: 0,
    processedItems: 0,
    successCount: 0,
    errorCount: 0,
    skipCount: 0,
  };

  try {
    logger.info(
      { organizationId, syncJobId, shopDomain, fetchAll },
      'Starting Shopify customers sync'
    );

    // 1. Build GraphQL query filter
    let graphqlQuery = '';
    if (updatedAfter && !fetchAll) {
      const bufferedDate = new Date(new Date(updatedAfter).getTime() - 2 * 60 * 1000);
      graphqlQuery = `updated_at:>='${bufferedDate.toISOString()}'`;
    }

    // 2. Fetch customers in batches (250 max per batch)
    let hasNextPage = true;
    let cursor: string | null = null;
    let batchNumber = 0;

    while (hasNextPage) {
      batchNumber++;

      logger.info(
        { batchNumber, cursor, syncJobId },
        'Fetching customers batch from Shopify'
      );

      // Fetch customers from Shopify GraphQL API
      type CustomersResponse = {
        customers: {
          edges: Array<{
            cursor: string;
            node: any;
          }>;
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string | null;
          };
        };
      };

      const response = await executeGraphQLQuery<CustomersResponse>(
        { shopDomain, accessToken },
        CUSTOMERS_QUERY,
        {
          first: 250,
          after: cursor,
          query: graphqlQuery || undefined,
          sortKey: 'UPDATED_AT',
          reverse: true,
        }
      );

      if (!response.data?.customers) {
        throw new Error('Invalid response from Shopify GraphQL API');
      }

      const customersData = response.data.customers.edges.map((edge: { cursor: string; node: any }) => edge.node);
      const pageInfo: { hasNextPage: boolean; endCursor: string | null } = response.data.customers.pageInfo;

      // Process customers - collect all records for batch upsert
      const customersToUpsert: any[] = [];

      for (const customer of customersData) {
        try {
          const customerRecord = transformCustomerToDbRecord(customer, organizationId, integrationId);
          customersToUpsert.push(customerRecord);
          result.successCount++;
        } catch (error) {
          logger.error(
            {
              error,
              customerId: customer.id,
              errorMessage: error instanceof Error ? error.message : String(error),
            },
            'Failed to transform customer'
          );
          result.errorCount++;
        }
      }

      // Batch upsert to shopify_customers table
      if (customersToUpsert.length > 0) {
        await db
          .insert(shopifyCustomers)
          .values(customersToUpsert)
          .onConflictDoUpdate({
            target: [shopifyCustomers.organizationId, shopifyCustomers.shopifyCustomerId],
            set: {
              email: sql`excluded.email`,
              firstName: sql`excluded.first_name`,
              lastName: sql`excluded.last_name`,
              phone: sql`excluded.phone`,
              state: sql`excluded.state`,
              verifiedEmail: sql`excluded.verified_email`,
              acceptsMarketing: sql`excluded.accepts_marketing`,
              marketingOptInLevel: sql`excluded.marketing_opt_in_level`,
              emailMarketingConsent: sql`excluded.email_marketing_consent`,
              smsMarketingConsent: sql`excluded.sms_marketing_consent`,
              defaultAddressId: sql`excluded.default_address_id`,
              addresses: sql`excluded.addresses`,
              ordersCount: sql`excluded.orders_count`,
              totalSpent: sql`excluded.total_spent`,
              currency: sql`excluded.currency`,
              tags: sql`excluded.tags`,
              note: sql`excluded.note`,
              shopifyUpdatedAt: sql`excluded.shopify_updated_at`,
              lastSyncedAt: sql`excluded.last_synced_at`,
              rawJson: sql`excluded.raw_json`,
              updatedAt: new Date(),
            },
          });

        logger.info({ count: customersToUpsert.length }, 'Batch upserted Shopify customers');
      }

      // Update progress
      result.totalItems += customersData.length;
      result.processedItems += customersData.length;

      await updateSyncJobProgress(syncJobId, {
        totalItems: result.totalItems,
        processedItems: result.processedItems,
        successCount: result.successCount,
        errorCount: result.errorCount,
      });

      // Check for next page
      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;

      logger.info(
        {
          batchNumber,
          processedInBatch: customersData.length,
          totalProcessed: result.processedItems,
          hasNextPage,
        },
        'Completed customers batch'
      );

      // Rate limiting: 250ms delay between batches
      if (hasNextPage) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    logger.info(
      {
        syncJobId,
        totalCustomers: result.totalItems,
        successCount: result.successCount,
        errorCount: result.errorCount,
      },
      'Shopify customers sync completed'
    );

    return result;
  } catch (error) {
    logger.error(
      { error, syncJobId, organizationId },
      'Shopify customers sync failed'
    );
    result.success = false;
    throw error;
  }
}

/**
 * Sync Shopify customers to internal customers table - BATCH OPTIMIZED
 * Find existing customers by shopify_customer_id or email, create if not found
 */
async function syncToInternalCustomers(
  shopifyCustomersData: any[],
  organizationId: string
): Promise<void> {
  logger.info({ count: shopifyCustomersData.length }, 'Syncing to internal customers table (batch mode)');

  if (shopifyCustomersData.length === 0) return;

  // Step 1: Batch fetch all existing customers by Shopify ID
  const shopifyIds = shopifyCustomersData
    .map(c => c.shopifyCustomerId)
    .filter(Boolean);

  const existingByShopifyId = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, organizationId),
        sql`${customers.shopifyCustomerId} = ANY(${sql.raw(`ARRAY[${shopifyIds.map(id => `'${id}'`).join(',')}]`)})`
      )
    );

  const existingByShopifyIdMap = new Map(
    existingByShopifyId.map(c => [c.shopifyCustomerId, c])
  );

  // Step 2: For customers not found by Shopify ID, batch fetch by email
  const notFoundByShopifyId = shopifyCustomersData.filter(
    sc => !existingByShopifyIdMap.has(sc.shopifyCustomerId)
  );

  const emails = notFoundByShopifyId
    .map(c => c.email)
    .filter(Boolean);

  let existingByEmailMap = new Map();
  if (emails.length > 0) {
    const existingByEmail = await db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.organizationId, organizationId),
          sql`${customers.email} = ANY(${sql.raw(`ARRAY[${emails.map(e => `'${e.replace(/'/g, "''")}'`).join(',')}]`)})`
        )
      );

    existingByEmailMap = new Map(
      existingByEmail.map(c => [c.email, c])
    );
  }

  // Step 3: Categorize customers into update vs create
  const customersToUpdate: Array<{ shopifyData: any; existing: any }> = [];
  const customersToCreate: any[] = [];

  for (const shopifyCustomer of shopifyCustomersData) {
    const existingById = existingByShopifyIdMap.get(shopifyCustomer.shopifyCustomerId);
    const existingByEmail = existingByEmailMap.get(shopifyCustomer.email);
    const existing = existingById || existingByEmail;

    if (existing) {
      customersToUpdate.push({ shopifyData: shopifyCustomer, existing });
    } else {
      customersToCreate.push(shopifyCustomer);
    }
  }

  logger.info({ toUpdate: customersToUpdate.length, toCreate: customersToCreate.length }, 'Batch sync breakdown');

  // Step 4: Batch create new customers
  if (customersToCreate.length > 0) {
    const newCustomers = await db
      .insert(customers)
      .values(
        customersToCreate.map(sc => ({
          organizationId,
          shopifyCustomerId: sc.shopifyCustomerId,
          firstName: sc.firstName || null,
          lastName: sc.lastName || null,
          email: sc.email || null,
          phone: sc.phone || null,
          acceptsMarketing: sc.acceptsMarketing || false,
          shopifyTags: sc.tags || null,
          totalSpent: sc.totalSpent ? sc.totalSpent : undefined,
          source: 'shopify',
        }))
      )
      .returning();

    // Batch update links for new customers
    for (let i = 0; i < newCustomers.length; i++) {
      await db
        .update(shopifyCustomers)
        .set({ internalCustomerId: newCustomers[i].id })
        .where(
          and(
            eq(shopifyCustomers.organizationId, organizationId),
            eq(shopifyCustomers.shopifyCustomerId, customersToCreate[i].shopifyCustomerId)
          )
        );
    }

    logger.info({ count: newCustomers.length }, 'Created new customers');
  }

  // Step 5: Batch update existing customers
  if (customersToUpdate.length > 0) {
    for (const { shopifyData: sc, existing } of customersToUpdate) {
      await db
        .update(customers)
        .set({
          shopifyCustomerId: sc.shopifyCustomerId,
          firstName: sc.firstName || existing.firstName,
          lastName: sc.lastName || existing.lastName,
          email: sc.email || existing.email,
          phone: sc.phone || existing.phone,
          acceptsMarketing: sc.acceptsMarketing,
          shopifyTags: sc.tags,
          totalSpent: sc.totalSpent ? sc.totalSpent : existing.totalSpent,
          updatedAt: new Date(),
        })
        .where(eq(customers.id, existing.id));

      await db
        .update(shopifyCustomers)
        .set({ internalCustomerId: existing.id })
        .where(
          and(
            eq(shopifyCustomers.organizationId, organizationId),
            eq(shopifyCustomers.shopifyCustomerId, sc.shopifyCustomerId)
          )
        );
    }

    logger.info({ count: customersToUpdate.length }, 'Updated existing customers');
  }

  logger.info('Completed syncing to internal customers table');
}
