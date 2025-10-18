/**
 * Test Script - Enqueue a Shopify Products Sync Job
 *
 * This script creates a sync job and enqueues it to BullMQ for testing
 *
 * Usage:
 *   npm run test:enqueue -- --org=<organizationId> --integration=<integrationId>
 */

import 'dotenv/config';
import { Queue } from 'bullmq';
import { createId } from '@paralleldrive/cuid2';
import { redisConnection } from '../config/redis';
import { db } from '../config/database';
import { syncJobs, shopifyIntegrations } from '../db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '../lib/utils/logger';

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (name: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : null;
};

const organizationId = getArg('org');
const integrationId = getArg('integration');
const fetchAll = args.includes('--fetchAll');

async function enqueueTestJob() {
  try {
    logger.info('Starting test job enqueue script...');

    // Validate required arguments
    if (!organizationId) {
      throw new Error('Missing required argument: --org=<organizationId>');
    }

    // If integration ID not provided, try to find one
    let integration;
    if (integrationId) {
      logger.info({ integrationId }, 'Looking up integration by ID');
      [integration] = await db
        .select()
        .from(shopifyIntegrations)
        .where(eq(shopifyIntegrations.id, integrationId))
        .limit(1);
    } else {
      logger.info({ organizationId }, 'Looking up integration by organization');
      [integration] = await db
        .select()
        .from(shopifyIntegrations)
        .where(eq(shopifyIntegrations.organizationId, organizationId))
        .limit(1);
    }

    if (!integration) {
      throw new Error(`No Shopify integration found for organization ${organizationId}`);
    }

    logger.info(
      {
        integrationId: integration.id,
        shopDomain: integration.shopDomain,
        isActive: integration.isActive,
      },
      'Found Shopify integration'
    );

    if (!integration.isActive) {
      throw new Error('Shopify integration is not active');
    }

    // Create sync job record
    const syncJobId = createId();
    const now = new Date();

    logger.info({ syncJobId }, 'Creating sync job record...');

    await db.insert(syncJobs).values({
      id: syncJobId,
      organizationId,
      type: fetchAll ? 'shopify_products' : 'shopify_products_incremental',
      status: 'pending',
      config: {
        fetchAll,
        source: 'test-script',
      },
      createdAt: now,
      updatedAt: now,
    });

    logger.info({ syncJobId }, 'Sync job record created');

    // Create BullMQ queue
    const queue = new Queue('shopify-products', {
      connection: redisConnection,
    });

    // Enqueue job
    logger.info({ syncJobId }, 'Enqueueing job to BullMQ...');

    const job = await queue.add('sync-products', {
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
        shopDomain: integration.shopDomain,
        fetchAll,
      },
      '✅ Job enqueued successfully!'
    );

    console.log('\n===========================================');
    console.log('✅ Test job enqueued successfully!');
    console.log('===========================================');
    console.log(`Job ID:          ${job.id}`);
    console.log(`Sync Job ID:     ${syncJobId}`);
    console.log(`Organization:    ${organizationId}`);
    console.log(`Integration:     ${integration.id}`);
    console.log(`Shop Domain:     ${integration.shopDomain}`);
    console.log(`Fetch All:       ${fetchAll}`);
    console.log('===========================================');
    console.log('\nMonitor the job at: https://jobs.bloomwise.co');
    console.log('Queue: shopify-products');
    console.log(`Job ID: ${job.id}`);
    console.log('===========================================\n');

    await queue.close();
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Failed to enqueue test job');
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

enqueueTestJob();
