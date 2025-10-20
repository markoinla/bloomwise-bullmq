import { Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis';
import { ShopifyProductsSyncJob } from '../config/queues';
import { logger, createJobLogger } from '../lib/utils/logger';
import { getDatabaseForEnvironment } from '../config/database';
import { shopifyIntegrations, syncJobs } from '../db/schema';
import { eq } from 'drizzle-orm';

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '5');

async function processShopifyProductsSync(job: Job<ShopifyProductsSyncJob>) {
  const { syncJobId, organizationId, integrationId, type, environment = 'production' } = job.data;
  const jobLogger = createJobLogger(job.id!, organizationId);
  const db = getDatabaseForEnvironment(environment);

  jobLogger.info({ syncJobId, integrationId, type, environment }, 'Starting Shopify products sync');

  try {
    // 1. Verify sync job exists
    const [syncJob] = await db
      .select()
      .from(syncJobs)
      .where(eq(syncJobs.id, syncJobId))
      .limit(1);

    if (!syncJob) {
      throw new Error(`Sync job ${syncJobId} not found in database`);
    }

    // 2. Fetch Shopify credentials
    jobLogger.info('Fetching Shopify credentials...');
    const [integration] = await db
      .select()
      .from(shopifyIntegrations)
      .where(eq(shopifyIntegrations.id, integrationId))
      .limit(1);

    if (!integration) {
      throw new Error(`Shopify integration ${integrationId} not found`);
    }

    if (!integration.isActive) {
      throw new Error(`Shopify integration ${integrationId} is not active`);
    }

    // 3. Mark sync job as running
    await db
      .update(syncJobs)
      .set({
        status: 'running',
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(syncJobs.id, syncJobId));

    await job.updateProgress(0);

    jobLogger.info(
      { shopDomain: integration.shopDomain, type },
      'Starting product sync with Shopify credentials'
    );

    // 4. Execute the sync
    const { syncShopifyProducts } = await import('../lib/sync/products-sync.js');

    const result = await syncShopifyProducts({
      organizationId,
      syncJobId,
      shopDomain: integration.shopDomain,
      accessToken: integration.accessToken,
      fetchAll: type === 'full',
      updatedAfter: syncJob.config?.dateFrom,
      job,
      environment,
    });

    // 5. Mark sync job as completed
    await db
      .update(syncJobs)
      .set({
        status: 'completed',
        completedAt: new Date(),
        updatedAt: new Date(),
        totalItems: result.totalItems,
        processedItems: result.processedItems,
        successCount: result.successCount,
        errorCount: result.errorCount,
        skipCount: result.skipCount,
      })
      .where(eq(syncJobs.id, syncJobId));

    await job.updateProgress(100);

    jobLogger.info({ syncJobId, result }, 'Shopify products sync completed successfully');

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Mark sync job as failed in database
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

    jobLogger.error({ error, syncJobId }, 'Shopify products sync failed');
    throw error; // Let BullMQ handle retries
  }
}

export const shopifyProductsWorker = new Worker<ShopifyProductsSyncJob>(
  'shopify-products',
  processShopifyProductsSync,
  {
    connection: redisConnection,
    concurrency: CONCURRENCY,
    limiter: {
      max: 10, // Max 10 jobs
      duration: 1000, // Per second (Shopify rate limiting)
    },
  }
);

shopifyProductsWorker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'Job completed');
});

shopifyProductsWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, error: err }, 'Job failed');
});

shopifyProductsWorker.on('error', (err) => {
  logger.error({ error: err }, 'Worker error');
});
