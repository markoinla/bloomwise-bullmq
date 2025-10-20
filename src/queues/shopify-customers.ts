/**
 * Shopify Customers Queue Worker
 *
 * Processes Shopify customers sync jobs
 */

import { Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis';
import { logger, createJobLogger } from '../lib/utils/logger';
import { syncShopifyCustomers } from '../lib/sync/customers-sync';
import {
  getShopifyIntegration,
  getSyncJob,
  markSyncJobRunning,
  markSyncJobCompleted,
  markSyncJobFailed,
} from '../db/queries';
import { db } from '../config/database';
import { shopifyIntegrations } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface ShopifyCustomersJobData {
  organizationId: string;
  integrationId: string;
  syncJobId: string;
  fetchAll?: boolean;
}

/**
 * Process Shopify customers sync job
 */
async function processShopifyCustomersSync(job: Job<ShopifyCustomersJobData>) {
  const { organizationId, integrationId, syncJobId, fetchAll = false } = job.data;
  const jobLogger = createJobLogger(job.id!, organizationId);

  jobLogger.info(
    { syncJobId, integrationId, fetchAll },
    'Starting Shopify customers sync'
  );

  try {
    // 1. Verify sync job exists
    const syncJob = await getSyncJob(syncJobId);
    if (!syncJob) {
      throw new Error(`Sync job ${syncJobId} not found`);
    }

    // 2. Fetch Shopify credentials
    jobLogger.info('Fetching Shopify credentials...');

    const integration = await getShopifyIntegration(integrationId);
    if (!integration || !integration.accessToken || integration.organizationId !== organizationId) {
      throw new Error('Active Shopify integration not found or missing credentials');
    }

    // 3. Mark job as running
    await markSyncJobRunning(syncJobId);
    jobLogger.info({ syncJobId, status: 'running' }, 'Updated sync job status');

    // 4. Execute customers sync
    jobLogger.info(
      {
        shopDomain: integration.shopDomain,
        fetchAll,
      },
      'Starting customers sync with Shopify credentials'
    );

    const syncResult = await syncShopifyCustomers({
      organizationId,
      syncJobId,
      shopDomain: integration.shopDomain,
      accessToken: integration.accessToken,
      integrationId,
      fetchAll,
      updatedAfter: fetchAll ? undefined : integration.lastOrderSyncAt?.toISOString(),
      job,
    });

    // 5. Mark job as completed
    await markSyncJobCompleted(syncJobId, {
      totalItems: syncResult.totalItems,
      processedItems: syncResult.processedItems,
      successCount: syncResult.successCount,
      errorCount: syncResult.errorCount,
      skipCount: syncResult.skipCount,
    });

    // 6. Update integration last sync timestamp
    await db
      .update(shopifyIntegrations)
      .set({
        // Note: lastCustomerSyncAt doesn't exist in schema yet, will add later
        updatedAt: new Date(),
      })
      .where(eq(shopifyIntegrations.id, integrationId));

    jobLogger.info(
      {
        syncJobId,
        result: {
          success: syncResult.successCount,
          total: syncResult.totalItems,
          errors: syncResult.errorCount,
        },
      },
      'Shopify customers sync completed successfully'
    );

    return syncResult;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorDetails = error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
    } : error;

    jobLogger.error(
      { error: errorDetails, syncJobId, organizationId },
      'Shopify customers sync failed'
    );

    // Mark sync job as failed
    await markSyncJobFailed(syncJobId, errorMessage, error);

    // Re-throw to let BullMQ handle retries
    throw error;
  }
}

// Create and export the worker
export const shopifyCustomersWorker = new Worker(
  'shopify-customers',
  processShopifyCustomersSync,
  {
    connection: redisConnection,
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5'),
    limiter: {
      max: 10, // Max 10 jobs per second
      duration: 1000,
    },
  }
);

// Event handlers
shopifyCustomersWorker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'Job completed');
});

shopifyCustomersWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, error: err }, 'Job failed');
});

shopifyCustomersWorker.on('error', (err) => {
  logger.error({ error: err }, 'Worker error');
});
