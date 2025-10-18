import express from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { queues } from './config/queues';
import { logger } from './lib/utils/logger';

const PORT = parseInt(process.env.BULL_BOARD_PORT || '3001');
const USERNAME = process.env.BULL_BOARD_USERNAME || 'admin';
const PASSWORD = process.env.BULL_BOARD_PASSWORD || 'admin';

// Create Express adapter for Bull Board
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/');

// Create Bull Board with all queues
createBullBoard({
  queues: [
    new BullMQAdapter(queues['shopify-products']),
    new BullMQAdapter(queues['shopify-orders']),
    new BullMQAdapter(queues['seal-subscriptions']),
  ],
  serverAdapter,
});

const app = express();

// Basic authentication middleware
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board"');
    return res.status(401).send('Authentication required');
  }

  const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  const user = auth[0];
  const pass = auth[1];

  if (user === USERNAME && pass === PASSWORD) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board"');
    return res.status(401).send('Invalid credentials');
  }
});

// Mount Bull Board
app.use('/', serverAdapter.getRouter());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'bull-board' });
});

export function startDashboard() {
  app.listen(PORT, () => {
    logger.info(`Bull Board dashboard running on port ${PORT}`);
    logger.info(`Access at: http://localhost:${PORT}`);
    logger.info(`Credentials: ${USERNAME} / ${PASSWORD}`);
  });
}
