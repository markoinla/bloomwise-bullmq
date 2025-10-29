/**
 * Shopify Customers Queue Worker
 *
 * Processes Shopify customers sync jobs
 */

import { Worker, Job } from 'bullmq';
import { createId } from '@paralleldrive/cuid2';
import { redisConnection } from '../config/redis';
import { logger, createJobLogger } from '../lib/utils/logger';
import { syncShopifyCustomers } from '../lib/sync/customers-sync';
import { getDatabaseForEnvironment } from '../config/database';
import { shopifyIntegrations, syncJobs } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface ShopifyCustomersJobData {
  organizationId: string;
  integrationId: string;
  syncJobId: string;
  fetchAll?: boolean;
  environment?: 'dev' | 'staging' | 'production';
}

/**
 * Process Shopify customers sync job
 */
async function processShopifyCustomersSync(job: Job<ShopifyCustomersJobData>) {
  let { organizationId, integrationId, syncJobId, fetchAll = false, environment = 'production' } = job.data;
  const jobLogger = createJobLogger(job.id!, organizationId);
  const db = getDatabaseForEnvironment(environment);

  jobLogger.info(
    { syncJobId, integrationId, fetchAll, environment },
    'Starting Shopify customers sync'
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
        type: 'shopify_customers',
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
      environment,
    });

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
