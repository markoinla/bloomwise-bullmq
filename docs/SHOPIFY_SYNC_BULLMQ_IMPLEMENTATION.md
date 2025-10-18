# Shopify Sync Logic - BullMQ Implementation Guide

## Overview

This document outlines the complete Shopify sync architecture for implementing in BullMQ. The system uses **GraphQL Admin API** (mandatory as of Feb 2025) and follows a **dual storage pattern** where data is synced to both raw Shopify tables and normalized internal tables.

## Architecture

### Dual Storage Pattern (1:1 Mapping)

```
Shopify GraphQL API
    ↓
shopifyProducts → products (1:1 via shopifyProductId)
shopifyVariants → productVariants (1:1 via shopifyVariantId)
shopifyOrders → orders (1:1 via internalOrderId)
    ↓
shopifyProductMappings (tracking table)
```

### Key Database Tables

#### External Tables (Raw Shopify Data)
- `shopifyProducts` - Raw product data from Shopify
- `shopifyVariants` - Raw variant data from Shopify
- `shopifyOrders` - Raw order data from Shopify
- `shopifyIntegrations` - Per-organization Shopify connection config

#### Internal Tables (Normalized)
- `products` - Internal product catalog
- `productVariants` - Internal product variations
- `orders` - Internal order management
- `orderItems` - Line items for orders

#### Tracking/Mapping Tables
- `shopifyProductMappings` - Bidirectional mapping between Shopify and internal products/variants
- `syncJobs` - Job tracking and progress monitoring

## Sync Job Types

### 1. Products Sync (`shopify_products`)

**Entry Point**: `/api/cron/sync-shopify-products` or manual trigger

**Implementation**: `lib/sync/products-sync-graphql.ts`

**Flow**:

```typescript
1. Get active Shopify integration for organization
2. Build GraphQL query filter (e.g., updated_at filter)
3. Paginate through products:
   - Fetch up to 250 products per batch (GraphQL max)
   - Convert GraphQL format → REST format for compatibility
   - Upsert to shopifyProducts table
   - Upsert variants to shopifyVariants table
   - Sync to internal products table
   - Update shopifyProductMappings
   - Process tags (convert Shopify tags → polymorphic tags)
4. Update integration lastProductSyncAt timestamp
5. Log activity
```

**Key Parameters**:
- `organizationId` - Organization to sync for
- `jobId` - Sync job ID for progress tracking
- `fetchAll` - Whether to fetch all products (default: false, only updated)
- `includeVariants` - Whether to sync variants (default: true)
- `updatedAfter` - ISO date string to fetch products updated after this time

**Rate Limiting**:
- Shopify allows 2 requests/second for GraphQL
- Use 250ms delay between batches
- GraphQL has cost-based limiting (1000 points, restores at 50/second)

**BullMQ Job Structure**:
```typescript
{
  name: 'sync-shopify-products',
  data: {
    organizationId: string,
    jobId: string,
    config: {
      fetchAll?: boolean,
      includeVariants?: boolean,
      updatedAfter?: string // ISO date
    }
  }
}
```

### 2. Orders Sync (`shopify_orders_incremental`)

**Entry Point**: `/api/cron/sync-shopify-orders` or manual trigger

**Implementation**: `lib/sync/orders-sync-graphql.ts`

**Flow**:

```typescript
1. Get active Shopify integration
2. Build date filter query (e.g., updated_at >= lastSync - 2min buffer)
3. Paginate through orders:
   - Fetch up to 100 orders per batch (reduced from 250 to lower query cost)
   - Convert GraphQL → REST format
   - Batch upsert to shopifyOrders table
   - Sync to internal orders table (happens ONCE at end, not per batch)
   - Map line items to orderItems
   - Link products/variants via shopifyProductMappings
4. Update integration lastOrderSyncAt timestamp
5. Log activity
```

**Key Parameters**:
- `organizationId` - Organization to sync
- `jobId` - Job ID for tracking
- `batchSize` - Orders per batch (default: 100, max: 100)
- `cursor` - GraphQL pagination cursor
- `dateFrom` - ISO date for updated_at filter
- `dateTo` - Optional end date
- `syncToInternal` - Whether to sync to internal orders (default: true)
- `forceUpdate` - Force update even if order hasn't changed

**Rate Limiting**:
- Progressive delays: 500ms → 1000ms → 2000ms (increases after batches 3 and 5)
- Max 100 orders per request to keep query cost low

**Important Optimization**:
```typescript
// OLD: Sync to internal after EVERY batch (slow)
// NEW: Fetch all Shopify orders first, THEN sync to internal ONCE at the end
while (hasMore) {
  await fetchBatch({ syncToInternal: false }); // Don't sync yet
}
// After all batches complete:
await syncShopifyOrdersToInternalBatch(org, batchSize); // Sync once
```

**BullMQ Job Structure**:
```typescript
{
  name: 'sync-shopify-orders',
  data: {
    organizationId: string,
    jobId: string,
    config: {
      batchSize?: number,
      dateFrom?: string,
      dateTo?: string,
      syncToInternal?: boolean,
      forceUpdate?: boolean
    }
  }
}
```

## GraphQL API Integration

### Product Fetching

**Query**: `lib/shopify/graphql-client.ts::fetchProductsGraphQL`

```graphql
query GetProducts($limit: Int!, $cursor: String, $query: String) {
  products(first: $limit, after: $cursor, query: $query, sortKey: UPDATED_AT, reverse: true) {
    edges {
      node {
        id
        legacyResourceId
        title
        descriptionHtml
        handle
        vendor
        productType
        tags
        status
        createdAt
        updatedAt
        publishedAt
        images(first: 10) {
          edges {
            node {
              url
            }
          }
        }
        variants(first: 100) {
          edges {
            node {
              id
              legacyResourceId
              title
              price
              sku
              barcode
              inventoryQuantity
              # ... more fields
            }
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

### Order Fetching

**Query**: `lib/shopify/graphql-client.ts::fetchOrdersGraphQL`

```graphql
query GetOrders($limit: Int!, $cursor: String, $query: String) {
  orders(first: $limit, after: $cursor, query: $query, sortKey: UPDATED_AT, reverse: true) {
    edges {
      node {
        id
        legacyResourceId
        name
        email
        createdAt
        updatedAt
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        customer {
          id
          email
          firstName
          lastName
        }
        lineItems(first: 50) {
          edges {
            node {
              id
              title
              quantity
              variant {
                id
                legacyResourceId
              }
              # ... more fields
            }
          }
        }
        # ... billing, shipping addresses, etc.
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

## Internal Sync Process

### Products → Internal Products

**Implementation**: `lib/sync/shopify-products-to-internal.ts`

**Process**:

```typescript
1. For each Shopify product:
   a. Check if mapping exists in shopifyProductMappings
   b. Check if linked to a recipe
   c. Create/update in products table:
      - type: shopifyProduct.productType || 'custom'
      - recipeId: from mapping if exists
      - shopifyProductId: link back to external table
   d. Update shopifyProductMappings (bidirectional link)
   e. Sync variants:
      - Create/update in productVariants
      - Link via shopifyVariantId
      - Update shopifyProductMappings for each variant
   f. Process tags (convert to polymorphic tags system)
```

### Orders → Internal Orders

**Implementation**: `lib/shopify/sync-to-internal-batch.ts`

**Process**:

```typescript
1. Fetch unsynced shopifyOrders (where internalOrderId IS NULL)
2. For each Shopify order:
   a. Extract customer info → customers table
   b. Create/update order in orders table
   c. For each line item:
      - Look up product/variant via shopifyProductMappings
      - Create orderItem with:
        - productId (internal)
        - shopifyProductId (external)
        - recipeId (if product is linked to recipe)
   d. Update shopifyOrders.internalOrderId = new order.id
   e. Create order activity log entry
```

## Job Progress Tracking

### syncJobs Schema

```typescript
{
  id: uuid,
  organizationId: uuid,
  type: 'shopify_products' | 'shopify_orders_incremental' | 'shopify_orders_initial',
  status: 'pending' | 'running' | 'completed' | 'failed' | 'paused' | 'cancelled',

  // Progress tracking
  totalItems: number,        // Estimated total
  processedItems: number,    // Items processed so far
  successCount: number,      // Successfully synced
  errorCount: number,        // Errors encountered
  skipCount: number,         // Skipped items

  // Pagination
  currentPage: number,       // Current batch number
  pageSize: number,          // Batch size
  nextPageToken: string,     // GraphQL cursor for next batch

  // Timing
  startedAt: timestamp,
  completedAt: timestamp,
  estimatedCompletionAt: timestamp,
  lastActivityAt: timestamp,

  // Config & metadata
  config: jsonb,             // Job-specific config
  metadata: jsonb,           // Progress stats, batch info, etc.

  // Error tracking
  lastError: text,
  errors: jsonb[]            // Array of error objects
}
```

### Progress Updates

```typescript
// Update progress after each batch
await db.update(syncJobs).set({
  processedItems: totalProcessed,
  successCount: totalSuccess,
  errorCount: totalErrors,
  lastActivityAt: new Date(),
  estimatedCompletionAt: calculateETA(startTime, processed, estimated),
  metadata: {
    batchNumber,
    currentBatch: batchResults.length,
    hasNextPage,
    progress: Math.round((processed / estimated) * 100),
    apiType: 'graphql',
    stats: {
      externalSynced,
      internalCreated,
      internalUpdated,
      // ...
    }
  }
}).where(eq(syncJobs.id, jobId));
```

## Cron Job Implementation

### Products Cron

**Endpoint**: `/api/cron/sync-shopify-products`

**Schedule**: Every 6 hours (configurable)

**Logic**:
```typescript
1. Get all active integrations where autoSyncProducts = true
2. For each integration:
   a. Check lastProductSyncAt
   b. Calculate updatedAfter = lastProductSyncAt - 2min buffer
   c. Create sync job via createSyncJob()
   d. Job processes asynchronously
3. Return summary of jobs created
```

### Orders Cron

**Endpoint**: `/api/cron/sync-shopify-orders`

**Schedule**: Based on integration.syncFrequency ('15min' | 'hourly' | 'daily')

**Logic**:
```typescript
1. Get all active integrations where autoSyncOrders = true
2. For each integration:
   a. Check if enough time has passed since lastOrderSyncAt
   b. Calculate dateFrom = lastOrderSyncAt - 2min buffer
   c. Fetch orders in batches until no more pages
   d. Sync to internal orders ONCE at the end
3. Update lastOrderSyncAt timestamp
```

## BullMQ Queue Design

### Queue Structure

```typescript
// queues/shopify-sync.ts
export const SHOPIFY_SYNC_QUEUES = {
  PRODUCTS: 'shopify:products:sync',
  ORDERS: 'shopify:orders:sync',
  CUSTOMERS: 'shopify:customers:sync',
};

// Priority levels
export const PRIORITY = {
  URGENT: 1,      // Manual triggers, immediate sync
  HIGH: 5,        // Cron jobs
  NORMAL: 10,     // Background sync
  LOW: 20,        // Bulk operations
};
```

### Product Sync Queue

```typescript
// workers/shopify-products-worker.ts
import { Worker, Job } from 'bullmq';
import { processProductsSyncGraphQL } from '@/lib/sync/products-sync-graphql';

const worker = new Worker(
  SHOPIFY_SYNC_QUEUES.PRODUCTS,
  async (job: Job) => {
    const { organizationId, jobId, config } = job.data;

    try {
      // Update job status to running
      await db.update(syncJobs).set({
        status: 'running',
        startedAt: new Date()
      }).where(eq(syncJobs.id, jobId));

      // Process the sync
      const result = await processProductsSyncGraphQL({
        organizationId,
        jobId,
        fetchAll: config?.fetchAll || false,
        includeVariants: config?.includeVariants !== false,
        updatedAfter: config?.updatedAfter,
      });

      // Update job status to completed
      await db.update(syncJobs).set({
        status: 'completed',
        completedAt: new Date(),
        metadata: { ...result }
      }).where(eq(syncJobs.id, jobId));

      return result;
    } catch (error) {
      // Mark job as failed
      await db.update(syncJobs).set({
        status: 'failed',
        lastError: error.message,
        completedAt: new Date()
      }).where(eq(syncJobs.id, jobId));

      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 5, // Process 5 organizations in parallel
    limiter: {
      max: 10,      // Max 10 jobs per...
      duration: 1000 // ...1 second
    }
  }
);
```

### Order Sync Queue

```typescript
// workers/shopify-orders-worker.ts
import { Worker, Job } from 'bullmq';
import { processOrdersSyncJobGraphQL } from '@/lib/sync/orders-sync-graphql';

const worker = new Worker(
  SHOPIFY_SYNC_QUEUES.ORDERS,
  async (job: Job) => {
    const { organizationId, jobId, config } = job.data;

    try {
      // Fetch the sync job
      const [syncJob] = await db
        .select()
        .from(syncJobs)
        .where(eq(syncJobs.id, jobId))
        .limit(1);

      if (!syncJob) {
        throw new Error(`Sync job ${jobId} not found`);
      }

      // Process with pagination (handles multiple batches internally)
      await processOrdersSyncJobGraphQL(syncJob);

      return { success: true };
    } catch (error) {
      await db.update(syncJobs).set({
        status: 'failed',
        lastError: error.message,
        completedAt: new Date()
      }).where(eq(syncJobs.id, jobId));

      throw error;
    }
  },
  {
    connection: redis,
    concurrency: 3, // Lower concurrency for orders (higher API cost)
    limiter: {
      max: 5,
      duration: 1000
    }
  }
);
```

### Job Creation

```typescript
// services/shopify-sync-service.ts
import { Queue } from 'bullmq';
import { createSyncJob } from '@/lib/sync/job-processor';

const productsQueue = new Queue(SHOPIFY_SYNC_QUEUES.PRODUCTS, { connection: redis });
const ordersQueue = new Queue(SHOPIFY_SYNC_QUEUES.ORDERS, { connection: redis });

export async function queueProductsSync(
  organizationId: string,
  options: {
    fetchAll?: boolean,
    updatedAfter?: string,
    priority?: number
  } = {}
) {
  // Create database sync job record
  const syncJob = await createSyncJob({
    organizationId,
    type: 'shopify_products',
    config: {
      fetchAll: options.fetchAll,
      updatedAfter: options.updatedAfter
    }
  });

  // Add to BullMQ queue
  await productsQueue.add(
    'sync-products',
    {
      organizationId,
      jobId: syncJob.id,
      config: syncJob.config
    },
    {
      priority: options.priority || PRIORITY.NORMAL,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000 // Start with 5 second delay
      },
      removeOnComplete: {
        age: 24 * 3600, // Keep for 24 hours
        count: 100      // Keep last 100 completed jobs
      },
      removeOnFail: {
        age: 7 * 24 * 3600 // Keep failures for 7 days
      }
    }
  );

  return syncJob;
}

export async function queueOrdersSync(
  organizationId: string,
  options: {
    dateFrom?: string,
    dateTo?: string,
    syncToInternal?: boolean,
    priority?: number
  } = {}
) {
  const syncJob = await createSyncJob({
    organizationId,
    type: 'shopify_orders_incremental',
    config: {
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      syncToInternal: options.syncToInternal !== false
    }
  });

  await ordersQueue.add(
    'sync-orders',
    {
      organizationId,
      jobId: syncJob.id,
      config: syncJob.config
    },
    {
      priority: options.priority || PRIORITY.NORMAL,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 10000 // Longer delay for orders
      },
      removeOnComplete: {
        age: 24 * 3600,
        count: 100
      },
      removeOnFail: {
        age: 7 * 24 * 3600
      }
    }
  );

  return syncJob;
}
```

## Error Handling & Retries

### Retry Strategy

```typescript
// BullMQ job options
{
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000 // 5s, 25s, 125s
  }
}
```

### Error Recovery

```typescript
// In worker
worker.on('failed', async (job, error) => {
  console.error(`Job ${job.id} failed:`, error);

  // Log to Sentry
  shopifyLogger.syncBatchFailed(
    job.name.includes('products') ? 'products' : 'orders',
    error,
    job.data.jobId
  );

  // If final attempt, mark sync job as failed
  if (job.attemptsMade >= job.opts.attempts) {
    await db.update(syncJobs).set({
      status: 'failed',
      lastError: error.message,
      completedAt: new Date()
    }).where(eq(syncJobs.id, job.data.jobId));
  }
});
```

## Rate Limiting

### Shopify API Limits

**GraphQL**:
- Cost-based limiting: 1000 points max
- Restores at 50 points/second
- Query cost varies by complexity

**Strategy**:
```typescript
// Progressive delays between batches
const calculateDelay = (batchNumber: number) => {
  if (batchNumber <= 3) return 500;   // 500ms for first 3 batches
  if (batchNumber <= 5) return 1000;  // 1s for batches 4-5
  return 2000;                        // 2s for later batches
};
```

### BullMQ Rate Limiting

```typescript
{
  limiter: {
    max: 10,        // Max jobs
    duration: 1000, // Per 1 second
    groupKey: 'organizationId' // Per organization
  }
}
```

## Monitoring & Observability

### Metrics to Track

1. **Job Metrics**:
   - Jobs queued
   - Jobs processing
   - Jobs completed
   - Jobs failed
   - Average processing time
   - Queue depth

2. **Sync Metrics**:
   - Products synced (external + internal)
   - Orders synced (external + internal)
   - Sync errors
   - API call count
   - Rate limit hits

3. **Data Metrics**:
   - Shopify products count
   - Internal products count
   - Shopify orders count
   - Internal orders count
   - Unmapped products (in Shopify but not internal)

### Dashboard Integration

```typescript
// Expose metrics for Bull Board
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';

const serverAdapter = new ExpressAdapter();
createBullBoard({
  queues: [
    new BullMQAdapter(productsQueue),
    new BullMQAdapter(ordersQueue)
  ],
  serverAdapter
});

// Mount at /admin/queues
app.use('/admin/queues', serverAdapter.getRouter());
```

## Testing

### Unit Tests

```typescript
describe('Shopify Products Sync', () => {
  it('should sync products from Shopify to internal', async () => {
    const result = await processProductsSyncGraphQL({
      organizationId: 'test-org',
      jobId: 'test-job',
      fetchAll: false
    });

    expect(result.success).toBe(true);
    expect(result.synced).toBeGreaterThan(0);
  });
});
```

### Integration Tests

```typescript
describe('BullMQ Integration', () => {
  it('should queue and process product sync job', async () => {
    const syncJob = await queueProductsSync('test-org');

    // Wait for job to complete
    await waitForJobCompletion(syncJob.id);

    const [completedJob] = await db
      .select()
      .from(syncJobs)
      .where(eq(syncJobs.id, syncJob.id));

    expect(completedJob.status).toBe('completed');
  });
});
```

## Deployment Checklist

- [ ] Redis instance configured (for BullMQ)
- [ ] Environment variables set:
  - `REDIS_URL` - Redis connection string
  - `SHOPIFY_APP_KEY` - Shopify app credentials
  - `SHOPIFY_APP_SECRET`
  - `CRON_SECRET` - For cron endpoints
- [ ] Workers deployed and running
- [ ] Bull Board dashboard accessible
- [ ] Cron jobs configured (Vercel Cron or external)
- [ ] Sentry integration for error tracking
- [ ] Monitoring dashboards set up
- [ ] Rate limiting configured
- [ ] Backup/retry strategies tested

## Summary

This BullMQ implementation provides:

✅ **Scalable**: Parallel processing with configurable concurrency
✅ **Reliable**: Automatic retries with exponential backoff
✅ **Observable**: Real-time progress tracking and metrics
✅ **Rate-limited**: Respects Shopify API limits
✅ **Fault-tolerant**: Graceful error handling and recovery
✅ **Efficient**: Batch processing with pagination
✅ **Maintainable**: Clear separation of concerns

The key is maintaining the existing sync logic while wrapping it in BullMQ's job queue system for better reliability and scalability.
