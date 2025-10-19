import 'dotenv/config';
import { logger } from './lib/utils/logger';
import { startDashboard } from './dashboard';
import { shopifyProductsWorker } from './queues/shopify-products';
import { shopifyOrdersWorker } from './queues/shopify-orders';

async function main() {
  logger.info('Starting Bloomwise BullMQ Worker Service...');

  // Validate required environment variables
  const requiredEnvVars = ['DATABASE_URL', 'REDIS_URL'];
  const missingEnvVars = requiredEnvVars.filter((varName) => !process.env[varName]);

  if (missingEnvVars.length > 0) {
    logger.error(
      { missingEnvVars },
      'Missing required environment variables'
    );
    process.exit(1);
  }

  // Start Bull Board dashboard (includes health check)
  startDashboard();

  // Workers are already initialized and listening
  logger.info('Workers initialized:');
  logger.info('  - shopify-products (listening)');
  logger.info('  - shopify-orders (listening)');
  logger.info('Worker service is ready to process jobs');

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down worker service...');

    await Promise.all([
      shopifyProductsWorker.close(),
      shopifyOrdersWorker.close(),
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
