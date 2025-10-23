/**
 * API Routes for managing repeatable job schedules
 */

import express, { Request, Response } from 'express';
import { shopifyProductsQueue, shopifyOrdersQueue, shopifyCustomersQueue } from '../config/queues';
import { logger } from '../lib/utils/logger';

const router = express.Router();

/**
 * GET /api/schedules/list
 * List all repeatable jobs across all queues
 */
router.get('/list', async (req: Request, res: Response) => {
  try {
    const { organizationId, queue } = req.query;

    logger.info({ organizationId, queue }, 'API: List schedules request');

    // Get repeatable jobs from requested queues
    const queues = queue
      ? [queue]
      : ['shopify-products', 'shopify-orders', 'shopify-customers'];

    const schedules = [];

    for (const queueName of queues) {
      const queueInstance =
        queueName === 'shopify-products'
          ? shopifyProductsQueue
          : queueName === 'shopify-orders'
          ? shopifyOrdersQueue
          : queueName === 'shopify-customers'
          ? shopifyCustomersQueue
          : null;

      if (!queueInstance) {
        continue;
      }

      const repeatableJobs = await queueInstance.getRepeatableJobs();

      for (const job of repeatableJobs) {
        // Parse job name to extract organizationId
        // Expected format: sync-{resource}-{organizationId}
        const match = job.name.match(/^sync-\w+-(.+)$/);
        const jobOrgId = match ? match[1] : null;

        // Filter by organizationId if provided
        if (organizationId && jobOrgId !== organizationId) {
          continue;
        }

        schedules.push({
          queue: queueName,
          name: job.name,
          id: job.id,
          key: job.key,
          pattern: job.pattern,
          next: job.next,
          organizationId: jobOrgId,
        });
      }
    }

    logger.info(
      { count: schedules.length, organizationId, queue },
      'API: Schedules listed successfully'
    );

    return res.status(200).json({
      success: true,
      schedules,
      count: schedules.length,
    });
  } catch (error) {
    logger.error({ error }, 'API: Failed to list schedules');
    return res.status(500).json({
      success: false,
      error: 'Failed to list schedules',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/schedules/add
 * Add a new repeatable job schedule
 */
router.post('/add', async (req: Request, res: Response) => {
  try {
    const {
      organizationId,
      integrationId,
      queue,
      pattern,
      type = 'incremental',
      environment = 'production',
    } = req.body;

    // Validate required fields
    if (!organizationId || !integrationId || !queue || !pattern) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: organizationId, integrationId, queue, pattern',
      });
    }

    // Validate queue name
    const validQueues = ['shopify-products', 'shopify-orders', 'shopify-customers'];
    if (!validQueues.includes(queue)) {
      return res.status(400).json({
        success: false,
        error: `Invalid queue. Must be one of: ${validQueues.join(', ')}`,
      });
    }

    // Validate cron pattern (basic check)
    const cronRegex = /^(\*|([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])|\*\/([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])) (\*|([0-9]|1[0-9]|2[0-3])|\*\/([0-9]|1[0-9]|2[0-3])) (\*|([1-9]|1[0-9]|2[0-9]|3[0-1])|\*\/([1-9]|1[0-9]|2[0-9]|3[0-1])) (\*|([1-9]|1[0-2])|\*\/([1-9]|1[0-2])) (\*|([0-6])|\*\/([0-6]))$/;
    if (!cronRegex.test(pattern)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid cron pattern. Format: "minute hour day month weekday"',
      });
    }

    logger.info(
      { organizationId, integrationId, queue, pattern, type },
      'API: Add schedule request'
    );

    // Get the appropriate queue
    const queueInstance =
      queue === 'shopify-products'
        ? shopifyProductsQueue
        : queue === 'shopify-orders'
        ? shopifyOrdersQueue
        : shopifyCustomersQueue;

    // Determine resource type from queue name
    const resource = queue.replace('shopify-', '');
    const jobName = `sync-${resource}-${organizationId}`;
    const jobId = `scheduled-${resource}-${organizationId}`;

    // Check if schedule already exists
    const existingJobs = await queueInstance.getRepeatableJobs();
    const exists = existingJobs.some((job) => job.name === jobName || job.id === jobId);

    if (exists) {
      return res.status(409).json({
        success: false,
        error: 'Schedule already exists for this organization and resource',
        message: 'Remove existing schedule first or use a different organizationId',
      });
    }

    // Add repeatable job
    const job = await queueInstance.add(
      jobName,
      {
        syncJobId: '', // Will be created by worker
        organizationId,
        integrationId,
        type,
        fetchAll: type === 'full',
        environment,
      },
      {
        repeat: {
          pattern,
        },
        jobId,
      }
    );

    logger.info(
      {
        jobId: job.id,
        jobName,
        organizationId,
        integrationId,
        queue,
        pattern,
      },
      'API: Schedule added successfully'
    );

    return res.status(200).json({
      success: true,
      message: 'Schedule added successfully',
      schedule: {
        jobId: job.id,
        jobName,
        organizationId,
        integrationId,
        queue,
        pattern,
        type,
      },
    });
  } catch (error) {
    logger.error({ error }, 'API: Failed to add schedule');
    return res.status(500).json({
      success: false,
      error: 'Failed to add schedule',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/schedules/remove
 * Remove a repeatable job schedule
 */
router.post('/remove', async (req: Request, res: Response) => {
  try {
    const { organizationId, queue } = req.body;

    // Validate required fields
    if (!organizationId || !queue) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: organizationId, queue',
      });
    }

    // Validate queue name
    const validQueues = ['shopify-products', 'shopify-orders', 'shopify-customers'];
    if (!validQueues.includes(queue)) {
      return res.status(400).json({
        success: false,
        error: `Invalid queue. Must be one of: ${validQueues.join(', ')}`,
      });
    }

    logger.info({ organizationId, queue }, 'API: Remove schedule request');

    // Get the appropriate queue
    const queueInstance =
      queue === 'shopify-products'
        ? shopifyProductsQueue
        : queue === 'shopify-orders'
        ? shopifyOrdersQueue
        : shopifyCustomersQueue;

    // Determine resource type from queue name
    const resource = queue.replace('shopify-', '');
    const expectedJobName = `sync-${resource}-${organizationId}`;

    // Get all repeatable jobs and find the one matching this organizationId
    const repeatableJobs = await queueInstance.getRepeatableJobs();
    const targetJob = repeatableJobs.find((job) => job.name === expectedJobName);

    if (!targetJob) {
      logger.warn(
        { organizationId, queue, expectedJobName, foundJobs: repeatableJobs.length },
        'API: Schedule not found'
      );
      return res.status(404).json({
        success: false,
        error: 'Schedule not found',
        message: `No schedule found for organizationId: ${organizationId} in queue: ${queue}`,
      });
    }

    // Remove using the actual Redis key
    const removed = await queueInstance.removeRepeatableByKey(targetJob.key);

    if (!removed) {
      logger.error(
        { organizationId, queue, jobKey: targetJob.key },
        'API: Failed to remove schedule (removeRepeatableByKey returned false)'
      );
      return res.status(500).json({
        success: false,
        error: 'Failed to remove schedule',
        message: 'Schedule found but removal failed',
      });
    }

    logger.info(
      { jobName: targetJob.name, jobKey: targetJob.key, organizationId, queue },
      'API: Schedule removed successfully'
    );

    return res.status(200).json({
      success: true,
      message: 'Schedule removed successfully',
      removed: {
        jobName: targetJob.name,
        jobKey: targetJob.key,
        organizationId,
        queue,
      },
    });
  } catch (error) {
    logger.error({ error }, 'API: Failed to remove schedule');
    return res.status(500).json({
      success: false,
      error: 'Failed to remove schedule',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
