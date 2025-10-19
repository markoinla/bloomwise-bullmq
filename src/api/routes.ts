/**
 * API Routes for enqueueing sync jobs
 */

import express, { Request, Response } from 'express';
import { Queue } from 'bullmq';
import { createId } from '@paralleldrive/cuid2';
import { redisConnection } from '../config/redis';
import { db } from '../config/database';
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

/**
 * POST /api/sync/products
 * Enqueue a Shopify products sync job
 */
router.post('/sync/products', async (req: Request, res: Response) => {
  try {
    const { organizationId, fetchAll = false, integrationId } = req.body;

    if (!organizationId) {
      return res.status(400).json({
        error: 'Missing required field: organizationId',
      });
    }

    logger.info({ organizationId, fetchAll }, 'API: Enqueue products sync request');

    // Find Shopify integration
    let integration;
    if (integrationId) {
      [integration] = await db
        .select()
        .from(shopifyIntegrations)
        .where(eq(shopifyIntegrations.id, integrationId))
        .limit(1);
    } else {
      [integration] = await db
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

    await db.insert(syncJobs).values({
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

    if (!organizationId) {
      return res.status(400).json({
        error: 'Missing required field: organizationId',
      });
    }

    logger.info({ organizationId, fetchAll }, 'API: Enqueue orders sync request');

    // Find Shopify integration
    let integration;
    if (integrationId) {
      [integration] = await db
        .select()
        .from(shopifyIntegrations)
        .where(eq(shopifyIntegrations.id, integrationId))
        .limit(1);
    } else {
      [integration] = await db
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

    await db.insert(syncJobs).values({
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

export default router;
