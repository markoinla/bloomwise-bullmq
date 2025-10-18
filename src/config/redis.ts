import Redis from 'ioredis';
import { logger } from '../lib/utils/logger';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export const redisConnection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError(err) {
    logger.error({ err }, 'Redis connection error');
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
});

redisConnection.on('connect', () => {
  logger.info('Redis connected');
});

redisConnection.on('error', (err) => {
  logger.error({ err }, 'Redis error');
});

redisConnection.on('close', () => {
  logger.warn('Redis connection closed');
});

export async function checkRedisConnection(): Promise<boolean> {
  try {
    await redisConnection.ping();
    return true;
  } catch (error) {
    logger.error({ error }, 'Redis health check failed');
    return false;
  }
}
