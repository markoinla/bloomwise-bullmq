/**
 * Shopify Orders Queue Worker
 *
 * Processes Shopify orders sync jobs
 */

import { Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis';
import { logger, createJobLogger } from '../lib/utils/logger';
import { syncShopifyOrders } from '../lib/sync/orders-sync';
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

export interface ShopifyOrdersJobData {
  organizationId: string;
  integrationId: string;
  syncJobId: string;
  fetchAll?: boolean;
}

/**
 * Process Shopify orders sync job
 */
async function processShopifyOrdersSync(job: Job<ShopifyOrdersJobData>) {
  const { organizationId, integrationId, syncJobId, fetchAll = false } = job.data;
  const jobLogger = createJobLogger(job.id!, organizationId);

  jobLogger.info(
    { syncJobId, integrationId, fetchAll },
    'Starting Shopify orders sync'
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

    // 4. Execute orders sync
    jobLogger.info(
      {
        shopDomain: integration.shopDomain,
        fetchAll,
      },
      'Starting order sync with Shopify credentials'
    );

    const syncResult = await syncShopifyOrders({
      organizationId,
      syncJobId,
      shopDomain: integration.shopDomain,
      accessToken: integration.accessToken,
      fetchAll,
      updatedAtMin: fetchAll ? undefined : integration.lastOrderSyncAt || undefined,
    });

    // Note: Internal sync now happens incrementally during Shopify fetch (after each batch)
    // No need for a separate sync step at the end

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
        lastOrderSyncAt: new Date(),
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
      'Shopify orders sync completed successfully'
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
      'Shopify orders sync failed'
    );

    // Mark sync job as failed
    await markSyncJobFailed(syncJobId, errorMessage, error);

    // Re-throw to let BullMQ handle retries
    throw error;
  }
}

// Create and export the worker
export const shopifyOrdersWorker = new Worker(
  'shopify-orders',
  processShopifyOrdersSync,
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
shopifyOrdersWorker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'Job completed');
});

shopifyOrdersWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, error: err }, 'Job failed');
});

shopifyOrdersWorker.on('error', (err) => {
  logger.error({ error: err }, 'Worker error');
});
