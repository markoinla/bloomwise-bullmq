# Job Schedulers Implementation Guide

This document explains how to implement and use BullMQ Job Schedulers for recurring sync jobs in the Bloomwise system.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Worker Service Setup](#worker-service-setup)
- [Main App Integration](#main-app-integration)
- [Tenant Management](#tenant-management)
- [Monitoring](#monitoring)
- [Best Practices](#best-practices)

---

## Overview

Job Schedulers enable automatic, recurring sync jobs for multi-tenant scenarios. Each tenant can have their own schedule based on subscription tier, preferences, or business rules.

**Use Cases:**
- Automatic Shopify products sync (hourly, daily, etc.)
- Automatic Shopify orders sync (every 30 min, hourly, etc.)
- Automatic customer data sync
- Tier-based sync frequencies (Premium = more frequent)

**Key Concepts:**
- **JobScheduler**: BullMQ component that manages repeatable jobs (runs in worker service)
- **Repeatable Job**: A job that executes on a schedule (cron pattern)
- **Job Name**: Unique identifier per tenant (e.g., `sync-products-{organizationId}`)
- **Job ID**: Prevents duplicate schedules (e.g., `scheduled-products-{organizationId}`)

---

## Architecture

### Multi-Tenant Pattern: One Repeatable Job Per Tenant

Each tenant gets their own scheduled job with a unique identifier:

```
Tenant A → sync-products-tenant-a (every 1 hour)
Tenant B → sync-products-tenant-b (every 6 hours)
Tenant C → sync-products-tenant-c (daily at 2 AM)
```

**Benefits:**
- Different schedules per tenant/tier
- Easy to pause/remove individual schedules
- Clear monitoring per tenant
- Tenant-specific job data from start

### Component Responsibilities

**Worker Service (this repo):**
- Runs `JobScheduler` instances continuously
- Processes jobs (workers unchanged)
- No schedule management logic

**Main Bloomwise App:**
- Creates/updates repeatable jobs
- Stores tenant sync preferences
- Manages schedule lifecycle (onboarding, upgrades, churn)
- Calls queue methods to add/remove schedules

**Redis:**
- Stores schedule state (which jobs, when they run)
- Persists across restarts

---

## Worker Service Setup

### Step 1: Import JobScheduler ✅ COMPLETED

In [src/index.ts](../src/index.ts), add:

```typescript
import { JobScheduler } from 'bullmq';
import { redisConnection } from './config/redis';
```

**Status:** ✅ Implemented in [src/index.ts:2,9](../src/index.ts#L2)

### Step 2: Create Scheduler Instances ✅ COMPLETED

Add after the dashboard starts, before the shutdown handler:

```typescript
async function main() {
  // ... existing code (validate env, start dashboard) ...

  // Initialize job schedulers for repeatable jobs
  logger.info('Initializing job schedulers...');
  const schedulers = {
    products: new JobScheduler('shopify-products', {
      connection: redisConnection,
    }),
    orders: new JobScheduler('shopify-orders', {
      connection: redisConnection,
    }),
    customers: new JobScheduler('shopify-customers', {
      connection: redisConnection,
    }),
  };

  logger.info('Job schedulers initialized:');
  logger.info('  - shopify-products scheduler (active)');
  logger.info('  - shopify-orders scheduler (active)');
  logger.info('  - shopify-customers scheduler (active)');

  // Workers are already initialized and listening
  logger.info('Workers initialized:');
  // ... rest of existing code ...
}
```

**Status:** ✅ Implemented in [src/index.ts:29-46](../src/index.ts#L29-L46)

### Step 3: Update Graceful Shutdown ✅ COMPLETED

Update the shutdown handler to close schedulers:

```typescript
const shutdown = async () => {
  logger.info('Shutting down worker service...');

  // Close schedulers first
  logger.info('Closing job schedulers...');
  await Promise.all([
    schedulers.products.close(),
    schedulers.orders.close(),
    schedulers.customers.close(),
  ]);
  logger.info('Job schedulers closed');

  // Then close workers
  await Promise.all([
    shopifyProductsWorker.close(),
    shopifyOrdersWorker.close(),
    shopifyCustomersWorker.close(),
    shopifyWebhooksWorker.close(),
  ]);
  logger.info('Workers closed');

  process.exit(0);
};
```

**Status:** ✅ Implemented in [src/index.ts:57-79](../src/index.ts#L57-L79)

### Step 4: Health Monitoring ✅ COMPLETED

Add scheduler health check to [src/dashboard.ts](../src/dashboard.ts):

```typescript
app.get('/health', (req, res) => {
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
```

**Status:** ✅ Implemented in [src/dashboard.ts:61-78](../src/dashboard.ts#L61-L78)

---

**✅ Worker service setup is complete!** No changes to worker processors needed. The schedulers are now running and ready to handle repeatable jobs.

---

## Schedule Management API Endpoints ✅ COMPLETED

The worker service now exposes REST API endpoints for managing repeatable job schedules. These can be called from your main Bloomwise app or any other service.

### Base URL
- Development: `http://localhost:3001/api/schedules`
- Production: `https://jobs.bloomwise.co/api/schedules`

### GET /api/schedules/list

List all repeatable job schedules across queues.

**Query Parameters:**
- `organizationId` (optional) - Filter by organization
- `queue` (optional) - Filter by specific queue (`shopify-products`, `shopify-orders`, `shopify-customers`)

**Example Request:**
```bash
curl "https://jobs.bloomwise.co/api/schedules/list?organizationId=tenant-a"
```

**Example Response:**
```json
{
  "success": true,
  "schedules": [
    {
      "queue": "shopify-products",
      "name": "sync-products-tenant-a",
      "id": "scheduled-products-tenant-a",
      "key": "scheduled-products-tenant-a",
      "pattern": "0 */6 * * *",
      "next": 1698765432000,
      "organizationId": "tenant-a"
    }
  ],
  "count": 1
}
```

### POST /api/schedules/add

Create a new repeatable job schedule.

**Request Body:**
```json
{
  "organizationId": "tenant-a",
  "integrationId": "integration-123",
  "queue": "shopify-products",
  "pattern": "0 */6 * * *",
  "type": "incremental",
  "environment": "production"
}
```

**Required Fields:**
- `organizationId` - Tenant identifier
- `integrationId` - Shopify integration ID
- `queue` - Queue name (`shopify-products`, `shopify-orders`, `shopify-customers`)
- `pattern` - Cron pattern (e.g., `"0 */6 * * *"`)

**Optional Fields:**
- `type` - Sync type (`"incremental"` or `"full"`, default: `"incremental"`)
- `environment` - Environment (`"production"` or `"staging"`, default: `"production"`)

**Example Request:**
```bash
curl -X POST https://jobs.bloomwise.co/api/schedules/add \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": "tenant-a",
    "integrationId": "integration-123",
    "queue": "shopify-products",
    "pattern": "0 */6 * * *"
  }'
```

**Example Response:**
```json
{
  "success": true,
  "message": "Schedule added successfully",
  "schedule": {
    "jobId": "scheduled-products-tenant-a",
    "jobName": "sync-products-tenant-a",
    "organizationId": "tenant-a",
    "integrationId": "integration-123",
    "queue": "shopify-products",
    "pattern": "0 */6 * * *",
    "type": "incremental"
  }
}
```

### POST /api/schedules/remove

Remove an existing repeatable job schedule.

**Request Body:**
```json
{
  "organizationId": "tenant-a",
  "queue": "shopify-products"
}
```

**Example Request:**
```bash
curl -X POST https://jobs.bloomwise.co/api/schedules/remove \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": "tenant-a",
    "queue": "shopify-products"
  }'
```

**Example Response:**
```json
{
  "success": true,
  "message": "Schedule removed successfully",
  "removed": {
    "jobName": "sync-products-tenant-a",
    "jobKey": "repeat:shopify-products:sync-products-tenant-a:...",
    "organizationId": "tenant-a",
    "queue": "shopify-products"
  }
}
```

**Error Responses:**
- `400` - Missing required fields or invalid queue name
- `404` - Schedule not found (no repeatable job exists for this organizationId + queue)
- `500` - Server error or removal failed

**Implementation Notes:**
The remove endpoint finds the repeatable job by matching the job name (`sync-{resource}-{organizationId}`) and uses the actual Redis key for removal. This ensures reliable deletion even if the key format changes.

**Status:** ✅ Implemented in [src/api/schedules.ts](../src/api/schedules.ts) (Fixed: Now correctly finds and removes schedules)

---

## Main App Integration

### Overview

Your main Bloomwise app will create/manage repeatable jobs using the existing Queue instances.

**When to create schedules:**
- Tenant completes Shopify integration onboarding
- Tenant upgrades/downgrades subscription tier
- Tenant changes sync preferences in settings

**When to remove schedules:**
- Tenant disconnects Shopify integration
- Tenant pauses syncs
- Payment failure (temporarily pause)
- Tenant churns

### Step 1: Define Sync Schedules

Create a helper file in your main app (e.g., `lib/sync/schedules.ts`):

```typescript
export interface SyncSchedule {
  products: string; // Cron pattern
  orders: string;
  customers: string;
}

export function getScheduleForTier(tier: 'free' | 'standard' | 'premium'): SyncSchedule {
  switch (tier) {
    case 'premium':
      return {
        products: '0 * * * *',      // Every hour
        orders: '*/30 * * * *',     // Every 30 minutes
        customers: '0 */6 * * *',   // Every 6 hours
      };

    case 'standard':
      return {
        products: '0 */6 * * *',    // Every 6 hours
        orders: '0 */2 * * *',      // Every 2 hours
        customers: '0 2 * * *',     // Daily at 2 AM
      };

    case 'free':
    default:
      return {
        products: '0 2 * * *',      // Daily at 2 AM
        orders: '0 */12 * * *',     // Every 12 hours
        customers: '0 3 * * 0',     // Weekly on Sunday at 3 AM
      };
  }
}

// Helper to get tenant's tier (from your database)
export async function getTenantTier(organizationId: string): Promise<'free' | 'standard' | 'premium'> {
  // Query your subscriptions/plans table
  const subscription = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.organizationId, organizationId),
  });

  return subscription?.tier || 'free';
}
```

### Step 2: Setup Schedules on Integration Creation

When a tenant connects their Shopify store, use the API endpoints to create schedules:

```typescript
import { getScheduleForTier, getTenantTier } from './lib/sync/schedules';

const WORKER_API_URL = process.env.WORKER_API_URL || 'https://jobs.bloomwise.co/api';

async function onShopifyIntegrationCreated(
  organizationId: string,
  integrationId: string,
  shopDomain: string,
  accessToken: string
) {
  // 1. Save integration to database
  await db.insert(shopifyIntegrations).values({
    id: integrationId,
    organizationId,
    shopDomain,
    accessToken: encryptToken(accessToken),
    isActive: true,
    createdAt: new Date(),
  });

  // 2. Get tenant's subscription tier
  const tier = await getTenantTier(organizationId);
  const schedule = getScheduleForTier(tier);

  // 3. Schedule recurring products sync
  await fetch(`${WORKER_API_URL}/schedules/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organizationId,
      integrationId,
      queue: 'shopify-products',
      pattern: schedule.products,
      type: 'incremental',
      environment: 'production',
    }),
  });

  // 4. Schedule recurring orders sync
  await fetch(`${WORKER_API_URL}/schedules/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organizationId,
      integrationId,
      queue: 'shopify-orders',
      pattern: schedule.orders,
      type: 'incremental',
      environment: 'production',
    }),
  });

  // 5. Schedule recurring customers sync
  await fetch(`${WORKER_API_URL}/schedules/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organizationId,
      integrationId,
      queue: 'shopify-customers',
      pattern: schedule.customers,
      type: 'incremental',
      environment: 'production',
    }),
  });

  console.log(`Scheduled syncs for ${organizationId} with tier: ${tier}`);
}
```

### Step 3: Update Schedules on Tier Change

When a tenant upgrades/downgrades, remove old schedules and create new ones:

```typescript
async function onSubscriptionTierChanged(
  organizationId: string,
  integrationId: string,
  newTier: 'free' | 'standard' | 'premium'
) {
  const schedule = getScheduleForTier(newTier);

  // Remove old schedules
  await Promise.all([
    fetch(`${WORKER_API_URL}/schedules/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organizationId,
        queue: 'shopify-products',
      }),
    }),
    fetch(`${WORKER_API_URL}/schedules/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organizationId,
        queue: 'shopify-orders',
      }),
    }),
    fetch(`${WORKER_API_URL}/schedules/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organizationId,
        queue: 'shopify-customers',
      }),
    }),
  ]);

  // Add new schedules with updated frequency
  await fetch(`${WORKER_API_URL}/schedules/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organizationId,
      integrationId,
      queue: 'shopify-products',
      pattern: schedule.products,
      type: 'incremental',
    }),
  });

  await fetch(`${WORKER_API_URL}/schedules/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organizationId,
      integrationId,
      queue: 'shopify-orders',
      pattern: schedule.orders,
      type: 'incremental',
    }),
  });

  await fetch(`${WORKER_API_URL}/schedules/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organizationId,
      integrationId,
      queue: 'shopify-customers',
      pattern: schedule.customers,
      type: 'incremental',
    }
  );

  console.log(`Updated schedules for ${organizationId} to tier: ${newTier}`);
}
```

### Step 4: Remove Schedules on Integration Disconnect

When a tenant disconnects Shopify:

```typescript
async function onShopifyIntegrationDisconnected(organizationId: string) {
  // Remove all scheduled syncs
  await Promise.all([
    fetch(`${WORKER_API_URL}/schedules/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId, queue: 'shopify-products' }),
    }),
    fetch(`${WORKER_API_URL}/schedules/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId, queue: 'shopify-orders' }),
    }),
    fetch(`${WORKER_API_URL}/schedules/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId, queue: 'shopify-customers' }),
    }),
  ]);

  // Update database
  await db
    .update(shopifyIntegrations)
    .set({ isActive: false })
    .where(eq(shopifyIntegrations.organizationId, organizationId));

  console.log(`Removed schedules for ${organizationId}`);
}
```

### Step 5: Pause/Resume Schedules

For temporary pauses (payment issues, user request):

```typescript
// Pause syncs
async function pauseTenantSyncs(organizationId: string) {
  await Promise.all([
    fetch(`${WORKER_API_URL}/schedules/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId, queue: 'shopify-products' }),
    }),
    fetch(`${WORKER_API_URL}/schedules/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId, queue: 'shopify-orders' }),
    }),
    fetch(`${WORKER_API_URL}/schedules/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId, queue: 'shopify-customers' }),
    }),
  ]);
}

// Resume syncs
async function resumeTenantSyncs(
  organizationId: string,
  integrationId: string
) {
  // Fetch existing schedules or re-create based on tier
  const tier = await getTenantTier(organizationId);
  await onShopifyIntegrationCreated(organizationId, integrationId, '', '');
}
```

---

## Tenant Management

### Best Practices

**1. Always use consistent naming:**
```typescript
// Job Name Pattern
`sync-{resource}-{organizationId}`

// Job ID Pattern
`scheduled-{resource}-{organizationId}`
```

**2. Handle syncJobId creation:**
```typescript
// Option A: Create syncJob before adding to queue
const syncJob = await createSyncJob({
  organizationId,
  syncType: 'incremental',
  triggeredBy: 'scheduled',
});

await queue.add(jobName, {
  syncJobId: syncJob.id,
  // ... other data
});

// Option B: Create syncJob in worker processor (current pattern)
// Worker checks if syncJobId is empty and creates it
```

**3. Track schedule changes in database:**
```typescript
// Add to shopifyIntegrations table
interface ShopifyIntegration {
  // ... existing fields
  scheduledSyncsEnabled: boolean;
  lastScheduleUpdate: Date;
  syncFrequency: 'free' | 'standard' | 'premium';
}
```

**4. Audit log for schedule changes:**
```typescript
await db.insert(auditLogs).values({
  organizationId,
  action: 'schedule_updated',
  resourceType: 'shopify_integration',
  metadata: {
    oldTier: 'free',
    newTier: 'premium',
    schedules: schedule,
  },
});
```

---

## Monitoring

### Bull Board Dashboard

View all repeatable jobs at: `https://jobs.bloomwise.co/admin/queues`

**Features:**
- See all scheduled jobs per queue
- View next scheduled run time
- Manually trigger or remove schedules
- View execution history

### Database Tracking

Each scheduled job execution creates a `syncJobs` record:

```typescript
{
  id: 'uuid',
  organizationId: 'tenant-a',
  syncType: 'incremental',
  status: 'completed',
  triggeredBy: 'scheduled', // vs 'manual' or 'webhook'
  createdAt: timestamp,
  completedAt: timestamp,
}
```

**Query scheduled sync history:**
```sql
SELECT
  organization_id,
  sync_type,
  COUNT(*) as execution_count,
  AVG(synced_records_count) as avg_records,
  MAX(completed_at) as last_execution
FROM sync_jobs
WHERE triggered_by = 'scheduled'
  AND created_at >= NOW() - INTERVAL '7 days'
GROUP BY organization_id, sync_type
ORDER BY organization_id;
```

### Health Checks

Add monitoring for scheduler health:

```typescript
// Check if schedulers are running
async function checkSchedulerHealth() {
  const repeatableJobs = await Promise.all([
    shopifyProductsQueue.getRepeatableJobs(),
    shopifyOrdersQueue.getRepeatableJobs(),
    shopifyCustomersQueue.getRepeatableJobs(),
  ]);

  return {
    productsScheduleCount: repeatableJobs[0].length,
    ordersScheduleCount: repeatableJobs[1].length,
    customersScheduleCount: repeatableJobs[2].length,
  };
}
```

---

## Best Practices

### 1. Cron Pattern Examples

```typescript
// Common patterns
'*/30 * * * *'   // Every 30 minutes
'0 * * * *'      // Every hour (on the hour)
'0 */2 * * *'    // Every 2 hours
'0 */6 * * *'    // Every 6 hours
'0 2 * * *'      // Daily at 2 AM
'0 2 * * 0'      // Weekly on Sunday at 2 AM
'0 2 1 * *'      // Monthly on 1st at 2 AM

// Test cron patterns at: https://crontab.guru/
```

### 2. Avoid Schedule Conflicts

**Don't schedule too frequently:**
- Consider Shopify API rate limits (2 req/sec)
- Products sync can take 5-10 minutes for large catalogs
- Leave buffer time between runs

**Stagger schedules:**
```typescript
// Bad: All tenants sync at same time
products: '0 2 * * *'  // All hit at 2 AM

// Good: Distribute load
const offset = hashCode(organizationId) % 60; // 0-59
products: `${offset} */6 * * *` // Each tenant gets different minute
```

### 3. Handle Missing syncJobId

Your workers should create `syncJob` records if not provided:

```typescript
// In worker processor
async function processJob(job: Job<ShopifyProductsSyncJob>) {
  let { syncJobId, organizationId, integrationId } = job.data;

  // Create syncJob if not provided (scheduled jobs)
  if (!syncJobId) {
    const syncJob = await createSyncJob({
      organizationId,
      syncType: 'incremental',
      triggeredBy: 'scheduled',
    });
    syncJobId = syncJob.id;
  }

  // ... rest of processing
}
```

### 4. Error Handling

Scheduled jobs should handle errors gracefully:

```typescript
// In worker processor
try {
  await syncProducts(...);
} catch (error) {
  // Log error but don't kill schedule
  logger.error({ error, organizationId }, 'Scheduled sync failed');

  // Optionally notify tenant
  await sendSyncFailureNotification(organizationId, error);

  throw error; // Let BullMQ retry logic handle it
}
```

### 5. Testing

Test schedule management:

```typescript
// Add test schedule
await shopifyProductsQueue.add(
  'test-sync-products',
  {
    syncJobId: '',
    organizationId: 'test-org',
    integrationId: 'test-integration',
    type: 'incremental',
  },
  {
    repeat: { pattern: '*/5 * * * *' }, // Every 5 minutes for testing
    jobId: 'test-scheduled-products',
  }
);

// List all repeatable jobs
const jobs = await shopifyProductsQueue.getRepeatableJobs();
console.log('Scheduled jobs:', jobs);

// Remove test schedule
await shopifyProductsQueue.removeRepeatableByKey('test-scheduled-products');
```

---

## Cron Pattern Reference

| Pattern | Description | Use Case |
|---------|-------------|----------|
| `*/30 * * * *` | Every 30 minutes | Real-time orders (Premium) |
| `0 * * * *` | Every hour | Frequent products sync (Premium) |
| `0 */2 * * *` | Every 2 hours | Standard orders sync |
| `0 */6 * * *` | Every 6 hours | Standard products sync |
| `0 2 * * *` | Daily at 2 AM | Free tier products sync |
| `0 */12 * * *` | Every 12 hours | Free tier orders sync |
| `0 3 * * 0` | Weekly Sunday 3 AM | Customer data sync |

**Format:** `minute hour day month weekday`

Test patterns at: [crontab.guru](https://crontab.guru/)

---

## Migration Checklist

### Worker Service (This Repo)

- [x] Import `JobScheduler` from `bullmq` ✅
- [x] Create scheduler instances in `src/index.ts` ✅
- [x] Update graceful shutdown to close schedulers ✅
- [x] Add scheduler health to `/health` endpoint ✅
- [ ] Deploy updated worker service

### Main Bloomwise App

- [ ] Create `lib/sync/schedules.ts` with tier-based schedules
- [ ] Implement schedule creation on integration setup
- [ ] Implement schedule updates on tier changes
- [ ] Implement schedule removal on disconnect
- [ ] Add pause/resume functionality
- [ ] Update database schema to track scheduled syncs
- [ ] Add audit logging for schedule changes
- [ ] Create admin UI to view/manage schedules
- [ ] Add monitoring/alerting for failed scheduled syncs

### Testing

- [ ] Test schedule creation for new tenant
- [ ] Test schedule updates on tier change
- [ ] Test schedule removal on disconnect
- [ ] Test pause/resume functionality
- [ ] Verify schedules persist across worker restarts
- [ ] Load test with multiple concurrent scheduled syncs
- [ ] Monitor Bull Board for scheduled job execution

---

## Troubleshooting

### Schedules not running

1. Check if schedulers are initialized in worker service
2. Verify Redis connection is stable
3. Check Bull Board for schedule status
4. Look for errors in worker logs

### Duplicate scheduled jobs

- Use consistent `jobId` pattern to prevent duplicates
- Always use `jobId: 'scheduled-{resource}-{organizationId}'`

### Schedules running too frequently

- Review cron patterns in `getScheduleForTier()`
- Check for multiple schedules with same organizationId
- Use Bull Board to audit all repeatable jobs

### Worker not processing scheduled jobs

- Schedulers don't process jobs - workers do
- Ensure workers are running and connected
- Check worker concurrency settings
- Review worker logs for errors

---

## Additional Resources

- [BullMQ Job Schedulers Documentation](https://docs.bullmq.io/guide/job-schedulers)
- [Cron Pattern Tester](https://crontab.guru/)
- [Bull Board Documentation](https://github.com/felixmosh/bull-board)
- [Main Bloomwise CLAUDE.md](../CLAUDE.md)
