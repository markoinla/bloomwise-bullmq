/**
 * Shopify Orders Queue Worker
 *
 * Processes Shopify orders sync jobs
 */

import { Worker, Job } from 'bullmq';
import { createId } from '@paralleldrive/cuid2';
import { redisConnection } from '../config/redis';
import { logger, createJobLogger } from '../lib/utils/logger';
import { syncShopifyOrders } from '../lib/sync/orders-sync';
import { getDatabaseForEnvironment } from '../config/database';
import { shopifyIntegrations, syncJobs } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface ShopifyOrdersJobData {
  organizationId: string;
  integrationId: string;
  syncJobId: string;
  fetchAll?: boolean;
  environment?: 'dev' | 'staging' | 'production';
}

/**
 * Process Shopify orders sync job
 */
async function processShopifyOrdersSync(job: Job<ShopifyOrdersJobData>) {
  let { organizationId, integrationId, syncJobId, fetchAll = false, environment = 'production' } = job.data;
  const jobLogger = createJobLogger(job.id!, organizationId);
  const db = getDatabaseForEnvironment(environment);

  jobLogger.info(
    { syncJobId, integrationId, fetchAll, environment },
    'Starting Shopify orders sync'
  );

  try {
    // 1. Verify sync job exists, create if needed (for scheduled jobs)
    let syncJob = null;

    if (syncJobId) {
      const [existingSyncJob] = await db
        .select()
        .from(syncJobs)
        .where(eq(syncJobs.id, syncJobId))
        .limit(1);
      syncJob = existingSyncJob;
    }

    // If no syncJob found (scheduled job with empty syncJobId), create one
    if (!syncJob) {
      syncJobId = createId();
      const now = new Date();

      await db.insert(syncJobs).values({
        id: syncJobId,
        organizationId,
        type: fetchAll ? 'shopify_orders_initial' : 'shopify_orders_incremental',
        status: 'pending',
        config: {
          fetchAll,
          source: 'scheduled',
        },
        createdAt: now,
        updatedAt: now,
      });

      jobLogger.info({ syncJobId, source: 'scheduled' }, 'Created sync job for scheduled task');

      // Fetch the newly created sync job
      const [newSyncJob] = await db
        .select()
        .from(syncJobs)
        .where(eq(syncJobs.id, syncJobId))
        .limit(1);
      syncJob = newSyncJob;
    }

    // 2. Fetch Shopify credentials
    jobLogger.info('Fetching Shopify credentials...');

    const [integration] = await db
      .select()
      .from(shopifyIntegrations)
      .where(eq(shopifyIntegrations.id, integrationId))
      .limit(1);

    if (!integration || !integration.accessToken || integration.organizationId !== organizationId) {
      throw new Error('Active Shopify integration not found or missing credentials');
    }

    // 3. Mark job as running
    await db
      .update(syncJobs)
      .set({
        status: 'running',
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(syncJobs.id, syncJobId));

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
      environment,
      job, // Pass job for progress tracking and logging
    });

    // Note: Internal sync now happens incrementally during Shopify fetch (after each batch)
    // No need for a separate sync step at the end

    // 5. Mark job as completed
    await db
      .update(syncJobs)
      .set({
        status: 'completed',
        completedAt: new Date(),
        updatedAt: new Date(),
        totalItems: syncResult.totalItems,
        processedItems: syncResult.processedItems,
        successCount: syncResult.successCount,
        errorCount: syncResult.errorCount,
        skipCount: syncResult.skipCount,
      })
      .where(eq(syncJobs.id, syncJobId));

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
    await db
      .update(syncJobs)
      .set({
        status: 'failed',
        completedAt: new Date(),
        updatedAt: new Date(),
        errorMessage,
        lastError: errorMessage,
      })
      .where(eq(syncJobs.id, syncJobId));

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
  logger.info(
    {
      jobId: job.id,
      organizationId: job.data.organizationId,
      syncJobId: job.data.syncJobId,
      integrationId: job.data.integrationId,
      fetchAll: job.data.fetchAll,
      returnValue: job.returnvalue,
    },
    'Orders sync job completed'
  );
});

shopifyOrdersWorker.on('failed', (job, err) => {
  logger.error(
    {
      jobId: job?.id,
      organizationId: job?.data?.organizationId,
      syncJobId: job?.data?.syncJobId,
      integrationId: job?.data?.integrationId,
      error: err.message,
      stack: err.stack,
      attemptsMade: job?.attemptsMade,
      attemptsMax: job?.opts?.attempts,
    },
    'Orders sync job failed'
  );
});

shopifyOrdersWorker.on('error', (err) => {
  logger.error({ error: err.message, stack: err.stack }, 'Orders worker error');
});

shopifyOrdersWorker.on('active', (job) => {
  logger.info(
    {
      jobId: job.id,
      organizationId: job.data.organizationId,
      syncJobId: job.data.syncJobId,
      integrationId: job.data.integrationId,
      fetchAll: job.data.fetchAll,
    },
    'Orders sync job started'
  );
});

shopifyOrdersWorker.on('progress', (job, progress) => {
  logger.debug(
    {
      jobId: job.id,
      organizationId: job.data.organizationId,
      syncJobId: job.data.syncJobId,
      progress,
    },
    'Orders sync progress update'
  );
});

shopifyOrdersWorker.on('stalled', (jobId) => {
  logger.warn({ jobId }, 'Orders sync job stalled');
});
