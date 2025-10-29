import 'dotenv/config';
import { JobScheduler } from 'bullmq';
import { logger } from './lib/utils/logger';
import { startDashboard } from './dashboard';
import { shopifyProductsWorker } from './queues/shopify-products';
import { shopifyOrdersWorker } from './queues/shopify-orders';
import { shopifyWebhooksWorker } from './queues/shopify-webhooks';
import { shopifyCustomersWorker } from './queues/shopify-customers';
import { redisConnection } from './config/redis';

async function main() {
  logger.info('Starting Bloomwise BullMQ Worker Service...');

  // Validate required environment variables
  const requiredEnvVars = ['REDIS_URL'];
  const missingEnvVars = requiredEnvVars.filter((varName) => !process.env[varName]);

  if (missingEnvVars.length > 0) {
    logger.error(
      { missingEnvVars },
      'Missing required environment variables'
    );
    process.exit(1);
  }

  // Validate at least one database URL is configured
  const hasDevDb = !!process.env.DEV_DATABASE_URL;
  const hasStagingDb = !!process.env.STAGING_DATABASE_URL;
  const hasProductionDb = !!process.env.PRODUCTION_DATABASE_URL;
  const hasFallbackDb = !!process.env.DATABASE_URL;

  if (!hasDevDb && !hasStagingDb && !hasProductionDb && !hasFallbackDb) {
    logger.error(
      'No database connection configured. Set at least one of: DEV_DATABASE_URL, STAGING_DATABASE_URL, PRODUCTION_DATABASE_URL, or DATABASE_URL'
    );
    process.exit(1);
  }

  // Log configured database environments
  const configuredDbs = [];
  if (hasDevDb) configuredDbs.push('dev');
  if (hasStagingDb) configuredDbs.push('staging');
  if (hasProductionDb) configuredDbs.push('production');
  if (hasFallbackDb) configuredDbs.push('fallback');
  logger.info({ configuredDatabases: configuredDbs }, 'Database connections configured');

  // Start Bull Board dashboard (includes health check)
  startDashboard();

  // Initialize job schedulers for repeatable jobs
  logger.info('Initializing job schedulers...');
  const schedulers = {
    products: new JobScheduler('shopify-products', {
      connection: redisConnection,
    }),
    orders: new JobScheduler('shopify-orders', {
      connection: redisConnection,
    }),
    customers: new JobScheduler('shopify-customers', {
      connection: redisConnection,
    }),
  };

  logger.info('Job schedulers initialized:');
  logger.info('  - shopify-products scheduler (active)');
  logger.info('  - shopify-orders scheduler (active)');
  logger.info('  - shopify-customers scheduler (active)');

  // Workers are already initialized and listening
  logger.info('Workers initialized:');
  logger.info('  - shopify-products (listening)');
  logger.info('  - shopify-orders (listening)');
  logger.info('  - shopify-customers (listening)');
  logger.info('  - shopify-webhooks (listening)');
  logger.info('Worker service is ready to process jobs');

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down worker service...');

    // Close schedulers first
    logger.info('Closing job schedulers...');
    await Promise.all([
      schedulers.products.close(),
      schedulers.orders.close(),
      schedulers.customers.close(),
    ]);
    logger.info('Job schedulers closed');

    // Then close workers
    await Promise.all([
      shopifyProductsWorker.close(),
      shopifyOrdersWorker.close(),
      shopifyCustomersWorker.close(),
      shopifyWebhooksWorker.close(),
    ]);
    logger.info('Workers closed');

    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  logger.error({ error }, 'Failed to start worker service');
  process.exit(1);
});
