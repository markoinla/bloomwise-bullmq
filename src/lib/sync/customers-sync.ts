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

        // Sync to internal customers table
        await syncToInternalCustomers(customersToUpsert, organizationId);
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
 * Sync Shopify customers to internal customers table
 * Find existing customers by shopify_customer_id or email, create if not found
 */
async function syncToInternalCustomers(
  shopifyCustomersData: any[],
  organizationId: string
): Promise<void> {
  logger.info({ count: shopifyCustomersData.length }, 'Syncing to internal customers table');

  for (const shopifyCustomer of shopifyCustomersData) {
    try {
      const shopifyCustomerId = shopifyCustomer.shopifyCustomerId;
      const email = shopifyCustomer.email;

      // Find existing customer by shopify_customer_id or email
      let existingCustomer: any = null;

      if (shopifyCustomerId) {
        [existingCustomer] = await db
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.organizationId, organizationId),
              eq(customers.shopifyCustomerId, shopifyCustomerId)
            )
          )
          .limit(1);
      }

      // If not found by Shopify ID, try finding by email
      if (!existingCustomer && email) {
        [existingCustomer] = await db
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.organizationId, organizationId),
              eq(customers.email, email)
            )
          )
          .limit(1);
      }

      if (existingCustomer) {
        // Update existing customer
        await db
          .update(customers)
          .set({
            shopifyCustomerId,
            firstName: shopifyCustomer.firstName || existingCustomer.firstName,
            lastName: shopifyCustomer.lastName || existingCustomer.lastName,
            email: email || existingCustomer.email,
            phone: shopifyCustomer.phone || existingCustomer.phone,
            acceptsMarketing: shopifyCustomer.acceptsMarketing,
            shopifyTags: shopifyCustomer.tags,
            totalSpent: shopifyCustomer.totalSpent ? parseFloat(shopifyCustomer.totalSpent) : existingCustomer.totalSpent,
            ordersCount: shopifyCustomer.ordersCount || existingCustomer.ordersCount,
            updatedAt: new Date(),
          })
          .where(eq(customers.id, existingCustomer.id));

        // Link back to shopify_customers table
        await db
          .update(shopifyCustomers)
          .set({ internalCustomerId: existingCustomer.id })
          .where(
            and(
              eq(shopifyCustomers.organizationId, organizationId),
              eq(shopifyCustomers.shopifyCustomerId, shopifyCustomerId)
            )
          );

        logger.debug({ customerId: existingCustomer.id }, 'Updated existing customer');
      } else {
        // Create new customer
        const totalSpentValue = shopifyCustomer.totalSpent ? shopifyCustomer.totalSpent : undefined;

        const [newCustomer] = await db
          .insert(customers)
          .values({
            organizationId,
            shopifyCustomerId,
            firstName: shopifyCustomer.firstName || null,
            lastName: shopifyCustomer.lastName || null,
            email: email || null,
            phone: shopifyCustomer.phone || null,
            acceptsMarketing: shopifyCustomer.acceptsMarketing || false,
            shopifyTags: shopifyCustomer.tags || null,
            totalSpent: totalSpentValue,
            source: 'shopify',
          })
          .returning();

        // Link back to shopify_customers table
        await db
          .update(shopifyCustomers)
          .set({ internalCustomerId: newCustomer.id })
          .where(
            and(
              eq(shopifyCustomers.organizationId, organizationId),
              eq(shopifyCustomers.shopifyCustomerId, shopifyCustomerId)
            )
          );

        logger.debug({ customerId: newCustomer.id }, 'Created new customer');
      }
    } catch (error) {
      logger.error(
        {
          error,
          shopifyCustomerId: shopifyCustomer.shopifyCustomerId,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        'Failed to sync customer to internal table'
      );
    }
  }

  logger.info('Completed syncing to internal customers table');
}
