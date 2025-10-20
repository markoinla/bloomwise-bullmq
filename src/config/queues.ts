import { Queue, QueueOptions } from 'bullmq';
import { redisConnection } from './redis';

const defaultQueueOptions: QueueOptions = {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: parseInt(process.env.WORKER_MAX_RETRIES || '3'),
    backoff: {
      type: 'exponential',
      delay: 10000, // Start with 10s delay
    },
    removeOnComplete: {
      count: 100, // Keep last 100 completed jobs
      age: 24 * 3600, // Keep for 24 hours
    },
    removeOnFail: {
      count: 500, // Keep last 500 failed jobs
      age: 7 * 24 * 3600, // Keep for 7 days
    },
  },
};

// Queue for Shopify product syncs
export const shopifyProductsQueue = new Queue('shopify-products', defaultQueueOptions);

// Queue for Shopify order syncs
export const shopifyOrdersQueue = new Queue('shopify-orders', defaultQueueOptions);

// Queue for Seal subscription syncs
export const sealSubscriptionsQueue = new Queue('seal-subscriptions', defaultQueueOptions);

// Queue for Shopify webhook processing (individual events)
export const shopifyWebhooksQueue = new Queue('shopify-webhooks', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000, // Start with 2s delay
    },
    removeOnComplete: {
      count: 1000, // Keep last 1000 completed jobs
      age: 24 * 3600, // Keep for 24 hours
    },
    removeOnFail: {
      count: 500, // Keep last 500 failed jobs
      age: 7 * 24 * 3600, // Keep for 7 days
    },
  },
});

// Queue for Shopify customers syncs
export const shopifyCustomersQueue = new Queue('shopify-customers', defaultQueueOptions);

// Export all queues for easy access
export const queues = {
  'shopify-products': shopifyProductsQueue,
  'shopify-orders': shopifyOrdersQueue,
  'seal-subscriptions': sealSubscriptionsQueue,
  'shopify-webhooks': shopifyWebhooksQueue,
  'shopify-customers': shopifyCustomersQueue,
};

export type QueueName = keyof typeof queues;

// Job data type definitions
export interface ShopifyProductsSyncJob {
  syncJobId: string;
  organizationId: string;
  integrationId: string;
  type: 'full' | 'incremental' | 'single';
  productId?: string;
  cursor?: string;
}

export interface ShopifyOrdersSyncJob {
  syncJobId: string;
  organizationId: string;
  integrationId: string;
  type: 'full' | 'incremental' | 'single';
  orderId?: string;
  cursor?: string;
}

export interface SealSubscriptionsSyncJob {
  syncJobId: string;
  organizationId: string;
  integrationId: string;
  type: 'subscriptions' | 'orders' | 'customers';
}

export interface ShopifyWebhookJob {
  shopifyOrderId: string;
  organizationId: string;
  action: 'create' | 'update' | 'cancel';
  timestamp: string;
}

export interface ShopifyCustomersSyncJob {
  syncJobId: string;
  organizationId: string;
  integrationId: string;
  fetchAll?: boolean;
}
