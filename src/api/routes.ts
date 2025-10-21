/**
 * API Routes for enqueueing sync jobs
 */

import express, { Request, Response } from 'express';
import { Queue } from 'bullmq';
import { createId } from '@paralleldrive/cuid2';
import { redisConnection } from '../config/redis';
import { db, getDatabaseForEnvironment } from '../config/database';
import { syncJobs, shopifyIntegrations } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '../lib/utils/logger';

const router = express.Router();

// Create queues
const shopifyProductsQueue = new Queue('shopify-products', {
  connection: redisConnection,
});

const shopifyOrdersQueue = new Queue('shopify-orders', {
  connection: redisConnection,
});

const shopifyWebhooksQueue = new Queue('shopify-webhooks', {
  connection: redisConnection,
});

const shopifyCustomersQueue = new Queue('shopify-customers', {
  connection: redisConnection,
});

/**
 * POST /api/sync/products
 * Enqueue a Shopify products sync job
 */
router.post('/sync/products', async (req: Request, res: Response) => {
  try {
    const { organizationId, fetchAll = false, integrationId } = req.body;
    const environment = req.environment || 'production';

    if (!organizationId) {
      return res.status(400).json({
        error: 'Missing required field: organizationId',
      });
    }

    // Debug logging
    console.log('[PRODUCTS SYNC API]', {
      origin: req.get('origin'),
      referer: req.get('referer'),
      host: req.get('host'),
      detectedEnv: environment,
      organizationId,
    });

    logger.info({ organizationId, fetchAll, environment }, 'API: Enqueue products sync request');

    // Get environment-specific database connection
    const envDb = getDatabaseForEnvironment(environment);

    // Find Shopify integration
    let integration;
    if (integrationId) {
      [integration] = await envDb
        .select()
        .from(shopifyIntegrations)
        .where(eq(shopifyIntegrations.id, integrationId))
        .limit(1);
    } else {
      [integration] = await envDb
        .select()
        .from(shopifyIntegrations)
        .where(
          and(
            eq(shopifyIntegrations.organizationId, organizationId),
            eq(shopifyIntegrations.isActive, true)
          )
        )
        .limit(1);
    }

    if (!integration) {
      return res.status(404).json({
        error: 'No active Shopify integration found for this organization',
      });
    }

    // Create sync job record
    const syncJobId = createId();
    const now = new Date();

    await envDb.insert(syncJobs).values({
      id: syncJobId,
      organizationId,
      type: fetchAll ? 'shopify_products' : 'shopify_products_incremental',
      status: 'pending',
      config: {
        fetchAll,
        source: 'api',
      },
      createdAt: now,
      updatedAt: now,
    });

    // Enqueue to BullMQ
    const job = await shopifyProductsQueue.add('sync-products', {
      syncJobId,
      organizationId,
      integrationId: integration.id,
      type: fetchAll ? 'full' : 'incremental',
      environment,
    });

    logger.info(
      {
        jobId: job.id,
        syncJobId,
        organizationId,
        integrationId: integration.id,
      },
      'API: Products sync job enqueued'
    );

    return res.status(200).json({
      success: true,
      jobId: job.id,
      syncJobId,
      organizationId,
      integrationId: integration.id,
      shopDomain: integration.shopDomain,
      type: fetchAll ? 'full' : 'incremental',
      message: 'Sync job enqueued successfully',
      dashboardUrl: `https://jobs.bloomwise.co`,
    });
  } catch (error) {
    logger.error({ error }, 'API: Failed to enqueue products sync');
    return res.status(500).json({
      error: 'Failed to enqueue sync job',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/sync/orders
 * Enqueue a Shopify orders sync job
 */
router.post('/sync/orders', async (req: Request, res: Response) => {
  try {
    const { organizationId, integrationId, fetchAll = false } = req.body;
    const environment = req.environment || 'production';

    if (!organizationId) {
      return res.status(400).json({
        error: 'Missing required field: organizationId',
      });
    }

    // Debug logging
    console.log('[ORDERS SYNC API]', {
      origin: req.get('origin'),
      referer: req.get('referer'),
      host: req.get('host'),
      detectedEnv: environment,
      organizationId,
    });

    logger.info({ organizationId, fetchAll, environment }, 'API: Enqueue orders sync request');

    // Find Shopify integration
    let integration;
    if (integrationId) {
      [integration] = await getDatabaseForEnvironment(environment)
        .select()
        .from(shopifyIntegrations)
        .where(eq(shopifyIntegrations.id, integrationId))
        .limit(1);
    } else {
      [integration] = await getDatabaseForEnvironment(environment)
        .select()
        .from(shopifyIntegrations)
        .where(
          and(
            eq(shopifyIntegrations.organizationId, organizationId),
            eq(shopifyIntegrations.isActive, true)
          )
        )
        .limit(1);
    }

    if (!integration) {
      return res.status(404).json({
        error: 'No active Shopify integration found for this organization',
      });
    }

    // Create sync job record
    const syncJobId = createId();
    const now = new Date();

    await getDatabaseForEnvironment(environment).insert(syncJobs).values({
      id: syncJobId,
      organizationId,
      type: fetchAll ? 'shopify_orders_initial' : 'shopify_orders_incremental',
      status: 'pending',
      config: {
        fetchAll,
        source: 'api',
      },
      createdAt: now,
      updatedAt: now,
    });

    // Enqueue to BullMQ
    const job = await shopifyOrdersQueue.add('sync-orders', {
      syncJobId,
      organizationId,
      integrationId: integration.id,
      fetchAll,
      environment,
    });

    logger.info(
      {
        jobId: job.id,
        syncJobId,
        organizationId,
        integrationId: integration.id,
      },
      'API: Orders sync job enqueued'
    );

    return res.status(200).json({
      success: true,
      jobId: job.id,
      syncJobId,
      organizationId,
      integrationId: integration.id,
      shopDomain: integration.shopDomain,
      type: fetchAll ? 'full' : 'incremental',
      message: 'Sync job enqueued successfully',
      dashboardUrl: `https://jobs.bloomwise.co`,
    });
  } catch (error) {
    logger.error({ error }, 'API: Failed to enqueue orders sync');
    return res.status(500).json({
      error: 'Failed to enqueue sync job',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/sync/status/:syncJobId
 * Get sync job status
 */
router.get('/sync/status/:syncJobId', async (req: Request, res: Response) => {
  try {
    const { syncJobId } = req.params;

    const [job] = await db
      .select()
      .from(syncJobs)
      .where(eq(syncJobs.id, syncJobId))
      .limit(1);

    if (!job) {
      return res.status(404).json({
        error: 'Sync job not found',
      });
    }

    return res.status(200).json({
      syncJobId: job.id,
      organizationId: job.organizationId,
      type: job.type,
      status: job.status,
      processedItems: job.processedItems,
      totalItems: job.totalItems,
      successCount: job.successCount,
      errorCount: job.errorCount,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      errorMessage: job.errorMessage,
    });
  } catch (error) {
    logger.error({ error }, 'API: Failed to get sync status');
    return res.status(500).json({
      error: 'Failed to get sync status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/sync/orders/internal
 * Sync orders from shopify_orders table to internal orders (no Shopify API calls)
 * This is useful for re-processing existing data without hitting Shopify rate limits
 */
router.post('/sync/orders/internal', async (req: Request, res: Response) => {
  try {
    const { organizationId, shopifyOrderIds } = req.body;
    const environment = req.environment || 'production';

    if (!organizationId) {
      return res.status(400).json({
        error: 'Missing required field: organizationId',
      });
    }

    logger.info(
      {
        organizationId,
        orderCount: shopifyOrderIds?.length || 'all',
        environment
      },
      'API: Enqueue internal orders sync request'
    );

    const envDb = getDatabaseForEnvironment(environment);

    // Create sync job record
    const syncJobId = createId();

    await envDb.insert(syncJobs).values({
      id: syncJobId,
      organizationId,
      type: 'shopify_orders_incremental',
      status: 'pending',
      config: {
        source: 'api',
        syncToInternal: true,
        filters: {
          internalOnly: true, // Flag to indicate this is internal-only sync (no Shopify API calls)
          shopifyOrderIds: shopifyOrderIds || null,
        },
      },
    });

    // Import the sync function and run it directly (no BullMQ queue needed)
    const { syncOrdersToInternal } = await import('../lib/sync/sync-orders-to-internal.js');

    // Run sync in background but return immediately
    syncOrdersToInternal({
      organizationId,
      syncJobId,
      shopifyOrderIds: shopifyOrderIds || undefined,
      environment,
    })
      .then(result => {
        logger.info(
          {
            syncJobId,
            organizationId,
            ordersProcessed: result.ordersProcessed,
            orderItemsCreated: result.orderItemsCreated,
          },
          'Internal orders sync completed'
        );
      })
      .catch(error => {
        logger.error({ error, syncJobId, organizationId }, 'Internal orders sync failed');
      });

    logger.info({ syncJobId, organizationId }, 'API: Internal orders sync started');

    return res.status(200).json({
      success: true,
      syncJobId,
      organizationId,
      type: 'internal',
      orderCount: shopifyOrderIds?.length || 'all',
      message: 'Internal orders sync started (syncing from shopify_orders table)',
      statusUrl: `/api/sync/status/${syncJobId}`,
    });
  } catch (error) {
    logger.error({ error }, 'API: Failed to start internal orders sync');
    return res.status(500).json({
      error: 'Failed to start internal orders sync',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/sync/customers
 * Enqueue a Shopify customers sync job
 */
router.post('/sync/customers', async (req: Request, res: Response) => {
  try {
    const { organizationId, integrationId, fetchAll = false } = req.body;
    const environment = req.environment || 'production';

    if (!organizationId) {
      return res.status(400).json({
        error: 'Missing required field: organizationId',
      });
    }

    // Debug logging
    console.log('[CUSTOMERS SYNC API]', {
      origin: req.get('origin'),
      referer: req.get('referer'),
      host: req.get('host'),
      detectedEnv: environment,
      organizationId,
    });

    logger.info({ organizationId, fetchAll, environment }, 'API: Enqueue customers sync request');

    // Get environment-specific database connection
    const envDb = getDatabaseForEnvironment(environment);

    // Find Shopify integration
    let integration;
    if (integrationId) {
      [integration] = await envDb
        .select()
        .from(shopifyIntegrations)
        .where(eq(shopifyIntegrations.id, integrationId))
        .limit(1);
    } else {
      [integration] = await envDb
        .select()
        .from(shopifyIntegrations)
        .where(
          and(
            eq(shopifyIntegrations.organizationId, organizationId),
            eq(shopifyIntegrations.isActive, true)
          )
        )
        .limit(1);
    }

    if (!integration) {
      return res.status(404).json({
        error: 'No active Shopify integration found for this organization',
      });
    }

    // Create sync job record
    const syncJobId = createId();
    const now = new Date();

    await envDb.insert(syncJobs).values({
      id: syncJobId,
      organizationId,
      type: 'shopify_customers',
      status: 'pending',
      config: {
        fetchAll,
        source: 'api',
      },
      createdAt: now,
      updatedAt: now,
    });

    // Enqueue to BullMQ
    const job = await shopifyCustomersQueue.add('sync-customers', {
      syncJobId,
      organizationId,
      integrationId: integration.id,
      fetchAll,
      environment,
    });

    logger.info(
      {
        jobId: job.id,
        syncJobId,
        organizationId,
        integrationId: integration.id,
      },
      'API: Customers sync job enqueued'
    );

    return res.status(200).json({
      success: true,
      jobId: job.id,
      syncJobId,
      organizationId,
      integrationId: integration.id,
      shopDomain: integration.shopDomain,
      type: fetchAll ? 'full' : 'incremental',
      message: 'Sync job enqueued successfully',
      dashboardUrl: `https://jobs.bloomwise.co`,
    });
  } catch (error) {
    logger.error({ error }, 'API: Failed to enqueue customers sync');
    return res.status(500).json({
      error: 'Failed to enqueue sync job',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * DELETE /api/sync/job/:jobId
 * Cancel/remove a running job
 */
router.delete('/sync/job/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const { queue } = req.query;

    if (!queue) {
      return res.status(400).json({
        error: 'Missing required query parameter: queue',
      });
    }

    logger.info({ jobId, queue }, 'API: Remove job request');

    // Get the appropriate queue
    const queueInstance = queue === 'shopify-customers'
      ? shopifyCustomersQueue
      : queue === 'shopify-orders'
      ? shopifyOrdersQueue
      : queue === 'shopify-products'
      ? shopifyProductsQueue
      : null;

    if (!queueInstance) {
      return res.status(400).json({
        error: 'Invalid queue name',
      });
    }

    // Get the job and remove it
    const job = await queueInstance.getJob(jobId);
    if (!job) {
      return res.status(404).json({
        error: 'Job not found',
      });
    }

    await job.remove();

    logger.info({ jobId, queue }, 'API: Job removed successfully');

    return res.status(200).json({
      success: true,
      message: 'Job removed successfully',
      jobId,
    });
  } catch (error) {
    logger.error({ error }, 'API: Failed to remove job');
    return res.status(500).json({
      error: 'Failed to remove job',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/webhook/shopify/order
 * Process a single Shopify order webhook event
 */
router.post('/webhook/shopify/order', async (req: Request, res: Response) => {
  try {
    const { shopifyOrderId, organizationId, action } = req.body;
    const environment = req.environment || 'production';

    // Validate required fields
    if (!shopifyOrderId || !organizationId || !action) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: shopifyOrderId, organizationId, action',
      });
    }

    // Validate action
    if (!['create', 'update', 'cancel'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid action. Must be: create, update, or cancel',
      });
    }

    logger.info(
      { shopifyOrderId, organizationId, action, environment },
      'API: Enqueue order webhook job'
    );

    // Add job to queue
    const job = await shopifyWebhooksQueue.add('process-order-webhook', {
      shopifyOrderId,
      organizationId,
      action,
      timestamp: new Date().toISOString(),
      environment,
    });

    logger.info(
      { jobId: job.id, shopifyOrderId, organizationId, action },
      'API: Order webhook job enqueued'
    );

    return res.status(200).json({
      success: true,
      jobId: job.id,
      message: `Webhook job enqueued for ${action} action`,
    });
  } catch (error) {
    logger.error({ error }, 'API: Failed to enqueue webhook job');
    return res.status(500).json({
      success: false,
      error: 'Failed to enqueue webhook job',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/webhook/shopify/product
 * Process a single Shopify product webhook event
 */
router.post('/webhook/shopify/product', async (req: Request, res: Response) => {
  try {
    const { shopifyProductId, organizationId, action } = req.body;
    const environment = req.environment || 'production';

    // Validate required fields
    if (!shopifyProductId || !organizationId || !action) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: shopifyProductId, organizationId, action',
      });
    }

    // Validate action
    if (!['create', 'update', 'delete'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid action. Must be: create, update, or delete',
      });
    }

    logger.info(
      { shopifyProductId, organizationId, action, environment },
      'API: Enqueue product webhook job'
    );

    // Add job to queue
    const job = await shopifyWebhooksQueue.add('process-product-webhook', {
      shopifyProductId,
      organizationId,
      action,
      timestamp: new Date().toISOString(),
      environment,
    });

    logger.info(
      { jobId: job.id, shopifyProductId, organizationId, action },
      'API: Product webhook job enqueued'
    );

    return res.status(200).json({
      success: true,
      jobId: job.id,
      message: `Webhook job enqueued for ${action} action`,
    });
  } catch (error) {
    logger.error({ error }, 'API: Failed to enqueue product webhook job');
    return res.status(500).json({
      success: false,
      error: 'Failed to enqueue product webhook job',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/webhook/shopify/customer
 * Process a single Shopify customer webhook event
 */
router.post('/webhook/shopify/customer', async (req: Request, res: Response) => {
  try {
    const { shopifyCustomerId, organizationId, action } = req.body;
    const environment = req.environment || 'production';

    // Validate required fields
    if (!shopifyCustomerId || !organizationId || !action) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: shopifyCustomerId, organizationId, action',
      });
    }

    // Validate action
    if (!['create', 'update', 'delete'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid action. Must be: create, update, or delete',
      });
    }

    logger.info(
      { shopifyCustomerId, organizationId, action, environment },
      'API: Enqueue customer webhook job'
    );

    // Add job to queue
    const job = await shopifyWebhooksQueue.add('process-customer-webhook', {
      shopifyCustomerId,
      organizationId,
      action,
      timestamp: new Date().toISOString(),
      environment,
    });

    logger.info(
      { jobId: job.id, shopifyCustomerId, organizationId, action },
      'API: Customer webhook job enqueued'
    );

    return res.status(200).json({
      success: true,
      jobId: job.id,
      message: `Webhook job enqueued for ${action} action`,
    });
  } catch (error) {
    logger.error({ error }, 'API: Failed to enqueue customer webhook job');
    return res.status(500).json({
      success: false,
      error: 'Failed to enqueue customer webhook job',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
