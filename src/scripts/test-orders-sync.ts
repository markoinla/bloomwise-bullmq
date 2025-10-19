/**
 * Test script to trigger a full orders sync for an organization
 */

import { db } from '../config/database';
import { syncJobs, shopifyIntegrations } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { logger } from '../lib/utils/logger';
import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis';

const organizationId = '47a111ea-56de-4354-8877-c9dc5dbac17e';

async function testOrdersSync() {
  try {
    logger.info({ organizationId }, 'Testing full orders sync');

    // 1. Find Shopify integration
    const [integration] = await db
      .select()
      .from(shopifyIntegrations)
      .where(
        and(
          eq(shopifyIntegrations.organizationId, organizationId),
          eq(shopifyIntegrations.isActive, true)
        )
      )
      .limit(1);

    if (!integration) {
      logger.error('No active Shopify integration found');
      process.exit(1);
    }

    logger.info(
      {
        integrationId: integration.id,
        shopDomain: integration.shopDomain,
      },
      'Found Shopify integration'
    );

    // 2. Create sync job record
    const syncJobId = createId();
    const now = new Date();

    await db.insert(syncJobs).values({
      id: syncJobId,
      organizationId,
      type: 'shopify_orders_initial',
      status: 'pending',
      config: {
        fetchAll: true,
        source: 'test-script',
      },
      createdAt: now,
      updatedAt: now,
    });

    logger.info({ syncJobId }, 'Created sync job record');

    // 3. Enqueue to BullMQ
    const shopifyOrdersQueue = new Queue('shopify-orders', {
      connection: redisConnection,
    });

    const job = await shopifyOrdersQueue.add('sync-orders', {
      syncJobId,
      organizationId,
      integrationId: integration.id,
      fetchAll: true,
    });

    logger.info(
      {
        jobId: job.id,
        syncJobId,
        organizationId,
        integrationId: integration.id,
      },
      'Orders sync job enqueued successfully'
    );

    logger.info(
      {
        dashboardUrl: 'https://jobs.bloomwise.co',
        localDashboard: 'http://localhost:3001/admin/queues',
      },
      'Monitor progress at dashboard'
    );

    // Close connections
    await shopifyOrdersQueue.close();
    await redisConnection.quit();

    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Failed to enqueue orders sync');
    process.exit(1);
  }
}

testOrdersSync();
