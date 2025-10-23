/**
 * Shopify Customers Sync - Full Implementation
 *
 * 1. Fetches customers from Shopify GraphQL API
 * 2. Transforms customers to database records
 * 3. Upserts customers to shopify_customers table
 * 4. Syncs to internal customers table (find-or-create)
 * 5. Updates syncJobs progress
 */

import { Job } from 'bullmq';
import { logger, createJobLogger } from '../utils/logger';
import { executeGraphQLQuery } from '../shopify/client';
import { CUSTOMERS_QUERY } from '../shopify/graphql-queries';
import { transformCustomerToDbRecord } from './transform-customer';
import { getDatabaseForEnvironment } from '../../config/database';
import { shopifyCustomers, syncJobs } from '../../db/schema';
import { sql, eq } from 'drizzle-orm';

interface CustomersSyncParams {
  organizationId: string;
  syncJobId: string;
  shopDomain: string;
  accessToken: string;
  integrationId: string;
  fetchAll?: boolean;
  updatedAfter?: string;
  job?: Job;
  environment?: 'dev' | 'staging' | 'production';
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
    job,
    environment = 'production',
  } = params;

  const db = getDatabaseForEnvironment(environment);

  // Create job-specific logger if job is provided, otherwise use base logger
  const syncLogger = job ? createJobLogger(job.id!, organizationId) : logger.child({ organizationId, syncJobId });

  const result: CustomersSyncResult = {
    success: true,
    totalItems: 0,
    processedItems: 0,
    successCount: 0,
    errorCount: 0,
    skipCount: 0,
  };

  try {
    syncLogger.info(
      { organizationId, syncJobId, shopDomain, fetchAll },
      'Starting Shopify customers sync'
    );
    await job?.log(`🚀 Starting ${fetchAll ? 'full' : 'incremental'} customer sync from ${shopDomain}`);

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

      syncLogger.info(
        { batchNumber, cursor, syncJobId },
        'Fetching customers batch from Shopify'
      );
      await job?.log(`📦 Fetching batch ${batchNumber} from Shopify...`);

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
          syncLogger.error(
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

        syncLogger.info({ count: customersToUpsert.length }, 'Batch upserted Shopify customers');
        await job?.log(`✅ Batch ${batchNumber}: Upserted ${customersToUpsert.length} customers to database`);
      }

      // Update progress
      result.totalItems += customersData.length;
      result.processedItems += customersData.length;

      await db
        .update(syncJobs)
        .set({
          totalItems: result.totalItems,
          processedItems: result.processedItems,
          successCount: result.successCount,
          errorCount: result.errorCount,
          lastActivityAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(syncJobs.id, syncJobId));

      // Sync this batch to internal customers table
      try {
        const { syncCustomersToInternal } = await import('./sync-customers-to-internal.js');
        const customerIds = customersData.map(c => c.legacyResourceId);

        const internalSyncResult = await syncCustomersToInternal({
          organizationId,
          syncJobId,
          shopifyCustomerIds: customerIds,
          environment,
        });

        syncLogger.info(
          {
            batchNumber,
            customersCreated: internalSyncResult.customersCreated,
            customersUpdated: internalSyncResult.customersUpdated,
          },
          'Synced batch to internal customers'
        );
        await job?.log(`✅ Batch ${batchNumber}: Synced ${internalSyncResult.customersProcessed} customers to internal table (${internalSyncResult.customersCreated} created, ${internalSyncResult.customersUpdated} updated)`);
      } catch (error) {
        syncLogger.error({ error, batchNumber }, 'Failed to sync batch to internal customers (non-fatal)');
        await job?.log(`⚠️ Batch ${batchNumber}: Failed to sync to internal table (Shopify sync succeeded)`);
        // Don't throw - Shopify sync already succeeded
      }

      // Check for next page
      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;

      syncLogger.info(
        {
          batchNumber,
          processedInBatch: customersData.length,
          totalProcessed: result.processedItems,
          hasNextPage,
        },
        'Completed customers batch'
      );
      await job?.log(`📊 Progress: ${result.processedItems} customers processed${hasNextPage ? ' (more batches remaining)' : ''}`);

      // Rate limiting: 250ms delay between batches
      if (hasNextPage) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    syncLogger.info(
      {
        syncJobId,
        totalCustomers: result.totalItems,
        successCount: result.successCount,
        errorCount: result.errorCount,
      },
      'Shopify customers sync completed'
    );
    await job?.log(`🎉 Sync completed! Total: ${result.totalItems} customers | Success: ${result.successCount} | Errors: ${result.errorCount}`);

    return result;
  } catch (error) {
    syncLogger.error(
      { error, syncJobId, organizationId },
      'Shopify customers sync failed'
    );
    result.success = false;
    throw error;
  }
}

