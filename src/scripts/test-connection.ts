import 'dotenv/config';
import { checkRedisConnection } from '../config/redis';
import { checkDatabaseConnection } from '../config/database';
import { logger } from '../lib/utils/logger';

async function testConnections() {
  logger.info('Testing connections...');

  // Test Redis
  logger.info('Testing Redis connection...');
  const redisOk = await checkRedisConnection();
  if (redisOk) {
    logger.info('✓ Redis connection successful');
  } else {
    logger.error('✗ Redis connection failed');
  }

  // Test Database
  logger.info('Testing database connection...');
  const dbOk = await checkDatabaseConnection();
  if (dbOk) {
    logger.info('✓ Database connection successful');
  } else {
    logger.error('✗ Database connection failed');
  }

  // Summary
  if (redisOk && dbOk) {
    logger.info('All connections successful!');
    process.exit(0);
  } else {
    logger.error('Some connections failed');
    process.exit(1);
  }
}

testConnections();
