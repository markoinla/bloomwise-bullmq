import http from 'http';
import { checkRedisConnection } from './config/redis';
import { checkDatabaseConnection } from './config/database';
import { logger } from './lib/utils/logger';

const PORT = parseInt(process.env.HEALTH_CHECK_PORT || '3001');

interface HealthStatus {
  status: 'ok' | 'error';
  redis: 'connected' | 'disconnected';
  database: 'connected' | 'disconnected';
  timestamp: string;
}

async function getHealthStatus(): Promise<HealthStatus> {
  const [redisOk, dbOk] = await Promise.all([
    checkRedisConnection(),
    checkDatabaseConnection(),
  ]);

  return {
    status: redisOk && dbOk ? 'ok' : 'error',
    redis: redisOk ? 'connected' : 'disconnected',
    database: dbOk ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  };
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    try {
      const health = await getHealthStatus();
      const statusCode = health.status === 'ok' ? 200 : 503;

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health, null, 2));
    } catch (error) {
      logger.error({ error }, 'Health check error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: 'Health check failed' }));
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

export function startHealthCheckServer() {
  server.listen(PORT, () => {
    logger.info(`Health check server listening on port ${PORT}`);
  });
}

export function stopHealthCheckServer() {
  server.close(() => {
    logger.info('Health check server stopped');
  });
}
