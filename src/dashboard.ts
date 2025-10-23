import express from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { queues } from './config/queues';
import { logger } from './lib/utils/logger';
import apiRoutes from './api/routes';
import schedulesRoutes from './api/schedules';
import { detectEnvironment } from './middleware/environment';

const PORT = parseInt(process.env.BULL_BOARD_PORT || '3001');
const USERNAME = process.env.BULL_BOARD_USERNAME || 'admin';
const PASSWORD = process.env.BULL_BOARD_PASSWORD || 'admin';

// Create Express adapter for Bull Board
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

// Create Bull Board with all queues
createBullBoard({
  queues: [
    new BullMQAdapter(queues['shopify-products']) as any,
    new BullMQAdapter(queues['shopify-orders']) as any,
    new BullMQAdapter(queues['shopify-customers']) as any,
    new BullMQAdapter(queues['seal-subscriptions']) as any,
    new BullMQAdapter(queues['shopify-webhooks']) as any,
  ],
  serverAdapter,
});

const app = express();

// CORS middleware - allow *.bloomwise.co domains
app.use((req, res, next) => {
  const origin = req.headers.origin;

  // Allow requests from *.bloomwise.co or localhost for development
  if (origin && (origin.endsWith('.bloomwise.co') || origin.includes('localhost'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  next();
});

// Parse JSON body
app.use(express.json());

// Environment detection middleware (applies to all routes)
app.use(detectEnvironment);

// Health check endpoint (no auth)
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'bloomwise-bullmq-worker',
    timestamp: new Date().toISOString(),
    workers: {
      products: 'active',
      orders: 'active',
      customers: 'active',
      webhooks: 'active',
    },
    schedulers: {
      products: 'active',
      orders: 'active',
      customers: 'active',
    },
  });
});

// API routes (no auth required for API)
app.use('/api', apiRoutes);
app.use('/api/schedules', schedulesRoutes);

// Basic authentication middleware (only for admin routes)
const basicAuth = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = _req.headers.authorization;

  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board"');
    res.status(401).send('Authentication required');
    return;
  }

  const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  const user = auth[0];
  const pass = auth[1];

  if (user === USERNAME && pass === PASSWORD) {
    next();
    return;
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board"');
    res.status(401).send('Invalid credentials');
    return;
  }
};

// Mount Bull Board (auth protected)
app.use('/admin/queues', basicAuth, serverAdapter.getRouter());

// Root redirect to Bull Board
app.get('/', (_req, res) => {
  res.redirect('/admin/queues');
});

export function startDashboard() {
  app.listen(PORT, () => {
    logger.info(`Bull Board dashboard running on port ${PORT}`);
    logger.info(`Access at: http://localhost:${PORT}`);
    logger.info(`Credentials: ${USERNAME} / ${PASSWORD}`);
  });
}
