import { Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis';
import { ShopifyProductsSyncJob } from '../config/queues';
import { logger, createJobLogger } from '../lib/utils/logger';

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '5');

async function processShopifyProductsSync(job: Job<ShopifyProductsSyncJob>) {
  const { syncJobId, organizationId, integrationId, type } = job.data;
  const jobLogger = createJobLogger(job.id!, organizationId);

  jobLogger.info({ syncJobId, integrationId, type }, 'Starting Shopify products sync');

  try {
    // TODO: Implement actual sync logic
    // 1. Fetch credentials from database using integrationId
    // 2. Update syncJobs status to 'in_progress'
    // 3. Call sync function (import from bloomwise codebase)
    // 4. Update progress periodically
    // 5. Update syncJobs status to 'completed' or 'failed'

    // Placeholder implementation
    await job.updateProgress(0);

    jobLogger.info('Fetching Shopify credentials...');
    // const credentials = await fetchShopifyCredentials(integrationId);

    jobLogger.info('Syncing products...');
    // const result = await syncProducts(credentials, type, productId);

    await job.updateProgress(100);

    jobLogger.info({ syncJobId }, 'Shopify products sync completed successfully');

    return {
      success: true,
      itemsProcessed: 0, // Update with actual count
    };
  } catch (error) {
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
