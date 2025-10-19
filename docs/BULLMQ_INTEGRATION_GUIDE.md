# Integration Guide: Products & Orders Sync

This guide shows how to integrate the Bloomwise BullMQ worker's products and orders sync into your application.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Products Sync](#products-sync)
- [Orders Sync](#orders-sync)
- [Monitoring & Status](#monitoring--status)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## Overview

The BullMQ worker provides two main sync operations:

1. **Products Sync**: Shopify products → `shopify_products` → `products` + `product_variants`
2. **Orders Sync**: Shopify orders → `shopify_orders` → `orders` + `order_items`

### Architecture

```
┌─────────────┐
│  Your App   │
└──────┬──────┘
       │ POST /api/sync/products or /api/sync/orders
       ↓
┌─────────────────────────────────────────┐
│        BullMQ Worker (jobs.bloomwise.co) │
├─────────────────────────────────────────┤
│  1. Fetch from Shopify GraphQL API      │
│  2. Store in shopify_* tables (raw)     │
│  3. Transform to internal tables         │
└──────┬──────────────────────────────────┘
       ↓
┌─────────────────────────┐
│    Neon Database        │
│  - shopify_products     │
│  - products             │
│  - product_variants     │
│  - shopify_orders       │
│  - orders               │
│  - order_items          │
└─────────────────────────┘
```

---

## Quick Start

### 1. Trigger a Sync

```typescript
// Products sync
const response = await fetch('https://jobs.bloomwise.co/api/sync/products', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    organizationId: 'your-org-id',
    fetchAll: true, // or false for incremental
  }),
});

const { jobId, syncJobId } = await response.json();
```

```typescript
// Orders sync
const response = await fetch('https://jobs.bloomwise.co/api/sync/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    organizationId: 'your-org-id',
    fetchAll: true,
  }),
});

const { jobId, syncJobId } = await response.json();
```

### 2. Check Sync Status

```typescript
const status = await fetch(
  `https://jobs.bloomwise.co/api/sync/status/${syncJobId}`
);

const data = await status.json();
console.log(data.status); // 'pending', 'running', 'completed', 'failed'
console.log(data.processedItems, '/', data.totalItems);
```

---

## Products Sync

### API Endpoint

```
POST https://jobs.bloomwise.co/api/sync/products
```

### Request Body

```typescript
interface ProductsSyncRequest {
  organizationId: string; // Required
  integrationId?: string; // Optional - auto-detected if not provided
  fetchAll?: boolean; // Default: false (incremental sync)
}
```

### Response

```typescript
interface ProductsSyncResponse {
  success: boolean;
  jobId: string; // BullMQ job ID
  syncJobId: string; // Database sync_jobs.id for tracking
  organizationId: string;
  integrationId: string;
  shopDomain: string;
  type: 'full' | 'incremental';
  message: string;
  dashboardUrl: string; // Bull Board dashboard URL
}
```

### Full vs Incremental Sync

**Full Sync (`fetchAll: true`)**
- Fetches ALL products from Shopify
- Use for initial sync or complete refresh
- Duration: ~2-3 minutes for 1,000 products

**Incremental Sync (`fetchAll: false`)**
- Fetches only products updated since last sync
- Uses `lastProductSyncAt` from `shopify_integrations` table
- Duration: ~10-30 seconds depending on changes
- Recommended for regular syncs (hourly/daily)

### What Gets Synced

1. **Shopify Products Table** (`shopify_products`)
   - Raw Shopify product data via GraphQL
   - Fields: title, vendor, product_type, status, tags, images, etc.
   - Stored as-is from Shopify

2. **Internal Products Table** (`products`)
   - Normalized product records
   - Linked to recipes/inventory items (if configured)
   - Fields: name, description, price, SKU, images, etc.

3. **Product Variants Table** (`product_variants`)
   - Individual variants with options (size, color, etc.)
   - Pricing, inventory, SKU per variant
   - Linked to Shopify variants via `shopify_variant_ids`

### Example: Full Products Sync

```typescript
async function syncAllProducts(organizationId: string) {
  // 1. Trigger sync
  const response = await fetch('https://jobs.bloomwise.co/api/sync/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organizationId,
      fetchAll: true,
    }),
  });

  const { syncJobId } = await response.json();

  // 2. Poll for completion
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s

    const status = await fetch(
      `https://jobs.bloomwise.co/api/sync/status/${syncJobId}`
    );
    const data = await status.json();

    console.log(
      `Products sync: ${data.status} - ${data.processedItems}/${data.totalItems}`
    );

    if (data.status === 'completed') {
      console.log('✅ Products synced successfully!');
      break;
    }

    if (data.status === 'failed') {
      console.error('❌ Sync failed:', data.errorMessage);
      throw new Error(data.errorMessage);
    }
  }

  // 3. Query synced products
  const products = await db
    .select()
    .from(products)
    .where(eq(products.organizationId, organizationId))
    .limit(10);

  console.log(`Found ${products.length} products`);
}
```

---

## Orders Sync

### API Endpoint

```
POST https://jobs.bloomwise.co/api/sync/orders
```

### Request Body

```typescript
interface OrdersSyncRequest {
  organizationId: string; // Required
  integrationId?: string; // Optional - auto-detected if not provided
  fetchAll?: boolean; // Default: false (incremental sync)
}
```

### Response

Same structure as Products Sync response.

### Performance

- **Full Sync**: ~3.5 minutes for 5,000 orders
- **Incremental Sync**: ~10-30 seconds
- **Throughput**: ~23 orders/second

### What Gets Synced

1. **Shopify Orders Table** (`shopify_orders`)
   - Raw Shopify order data via GraphQL
   - Fields: order number, customer, totals, status, line items (in rawData)
   - Complete order history

2. **Internal Orders Table** (`orders`)
   - Normalized order records
   - Customer info, shipping/billing addresses
   - Order status, payment status, fulfillment
   - Financial totals (subtotal, tax, discounts, total)
   - Links to `shopify_orders` via `shopify_order_id`

3. **Order Items Table** (`order_items`)
   - Individual line items per order
   - Product/variant references (Shopify IDs)
   - Quantity, pricing, customizations
   - Can be linked to internal products (if configured)

### Example: Incremental Orders Sync

```typescript
async function syncRecentOrders(organizationId: string) {
  // Incremental sync - only fetch orders updated since last sync
  const response = await fetch('https://jobs.bloomwise.co/api/sync/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organizationId,
      fetchAll: false, // Incremental
    }),
  });

  const { syncJobId } = await response.json();

  // Poll for completion (simplified)
  const checkStatus = async () => {
    const status = await fetch(
      `https://jobs.bloomwise.co/api/sync/status/${syncJobId}`
    );
    return status.json();
  };

  let result = await checkStatus();
  while (result.status === 'pending' || result.status === 'running') {
    await new Promise(resolve => setTimeout(resolve, 3000));
    result = await checkStatus();
  }

  if (result.status === 'completed') {
    console.log(`✅ Synced ${result.processedItems} orders`);
    return result;
  } else {
    throw new Error(`Sync failed: ${result.errorMessage}`);
  }
}
```

---

## Monitoring & Status

### Sync Job Status

The `sync_jobs` table tracks all sync operations:

```sql
SELECT
  id,
  type,
  status,
  processed_items,
  total_items,
  started_at,
  completed_at,
  error_message
FROM sync_jobs
WHERE organization_id = 'your-org-id'
ORDER BY created_at DESC
LIMIT 10;
```

### Status Values

- `pending`: Job queued, not started
- `running`: Currently processing
- `completed`: Successfully finished
- `failed`: Error occurred (check `error_message`)
- `cancelled`: Manually cancelled
- `paused`: Temporarily paused

### Bull Board Dashboard

Monitor jobs in real-time at:
```
https://jobs.bloomwise.co/
```

Features:
- View active, completed, and failed jobs
- See job progress and logs
- Retry failed jobs
- Clean old jobs

---

## Best Practices

### 1. Sync Scheduling

**Products:**
- Initial sync: Full (`fetchAll: true`)
- Regular syncs: Incremental every 4-6 hours
- Nightly full sync: Optional, for reconciliation

**Orders:**
- Initial sync: Full (`fetchAll: true`)
- Regular syncs: Incremental every 15-30 minutes
- After checkout: Trigger incremental sync

### 2. Error Handling

```typescript
async function syncWithRetry(
  endpoint: string,
  organizationId: string,
  maxRetries = 3
) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId, fetchAll: false }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();

      // Poll for completion
      const finalStatus = await pollSyncStatus(result.syncJobId);

      if (finalStatus.status === 'completed') {
        return finalStatus;
      }

      throw new Error(finalStatus.errorMessage || 'Sync failed');
    } catch (error) {
      console.error(`Sync attempt ${i + 1} failed:`, error);

      if (i === maxRetries - 1) {
        throw error; // Last attempt failed
      }

      // Exponential backoff
      await new Promise(resolve =>
        setTimeout(resolve, Math.pow(2, i) * 1000)
      );
    }
  }
}
```

### 3. Webhooks Integration

For real-time updates, combine syncs with Shopify webhooks:

```typescript
// On Shopify webhook: products/update
async function onProductUpdate(shopifyProductId: string, orgId: string) {
  // 1. Update specific product via API (future feature)
  // OR trigger incremental sync
  await fetch('https://jobs.bloomwise.co/api/sync/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organizationId: orgId,
      fetchAll: false, // Incremental will catch the change
    }),
  });
}
```

### 4. Data Access Patterns

**Get products with variants:**
```sql
SELECT
  p.id,
  p.name,
  p.price,
  json_agg(pv.*) as variants
FROM products p
LEFT JOIN product_variants pv ON pv.product_id = p.id
WHERE p.organization_id = 'your-org-id'
  AND p.is_active = true
GROUP BY p.id;
```

**Get orders with items:**
```sql
SELECT
  o.id,
  o.order_number,
  o.customer_name,
  o.total,
  json_agg(oi.*) as items
FROM orders o
LEFT JOIN order_items oi ON oi.order_id = o.id
WHERE o.organization_id = 'your-org-id'
  AND o.status != 'cancelled'
GROUP BY o.id
ORDER BY o.order_date DESC;
```

---

## Troubleshooting

### Common Issues

#### 1. Sync Stuck in "Running"

**Symptom:** Job shows `running` for > 10 minutes

**Solutions:**
- Check Bull Board dashboard for worker status
- Verify worker is running: `pm2 status` on server
- Check worker logs for errors
- Restart worker if needed: `pm2 restart bloomwise-worker`

#### 2. "No active Shopify integration found"

**Symptom:** API returns 404 error

**Solutions:**
```sql
-- Check if integration exists and is active
SELECT *
FROM shopify_integrations
WHERE organization_id = 'your-org-id'
  AND is_active = true;

-- Reactivate integration if needed
UPDATE shopify_integrations
SET is_active = true
WHERE id = 'integration-id';
```

#### 3. Duplicate Products/Orders

**Symptom:** Same product appears multiple times

**Solutions:**
- This shouldn't happen - syncs use upserts
- Check for unique constraint violations in logs
- Verify `shopify_product_id` / `shopify_order_id` are unique

#### 4. Slow Sync Performance

**Expected Times:**
- Products: ~1-2 minutes per 1,000 products
- Orders: ~3-4 minutes per 5,000 orders

**If slower:**
- Check database connection (Neon serverless can cold start)
- Verify Shopify API rate limits aren't being hit
- Check network latency to Shopify API

### Debug Tools

**1. Check last sync timestamp:**
```sql
SELECT
  shop_domain,
  last_product_sync_at,
  last_order_sync_at
FROM shopify_integrations
WHERE organization_id = 'your-org-id';
```

**2. View recent sync jobs:**
```sql
SELECT
  id,
  type,
  status,
  processed_items,
  total_items,
  error_message,
  started_at,
  completed_at
FROM sync_jobs
WHERE organization_id = 'your-org-id'
ORDER BY created_at DESC
LIMIT 5;
```

**3. Check synced data counts:**
```sql
-- Products
SELECT COUNT(*) FROM shopify_products WHERE organization_id = 'your-org-id';
SELECT COUNT(*) FROM products WHERE organization_id = 'your-org-id';

-- Orders
SELECT COUNT(*) FROM shopify_orders WHERE organization_id = 'your-org-id';
SELECT COUNT(*) FROM orders WHERE organization_id = 'your-org-id';
```

---

## Advanced Usage

### Custom Sync Scheduling (Node.js)

```typescript
import { CronJob } from 'cron';

// Incremental products sync every 4 hours
new CronJob('0 */4 * * *', async () => {
  console.log('Running scheduled products sync...');
  await syncWithRetry(
    'https://jobs.bloomwise.co/api/sync/products',
    organizationId
  );
}).start();

// Incremental orders sync every 30 minutes
new CronJob('*/30 * * * *', async () => {
  console.log('Running scheduled orders sync...');
  await syncWithRetry(
    'https://jobs.bloomwise.co/api/sync/orders',
    organizationId
  );
}).start();

// Full reconciliation sync nightly at 2 AM
new CronJob('0 2 * * *', async () => {
  console.log('Running nightly full sync...');
  await syncAllProducts(organizationId);
  await syncAllOrders(organizationId);
}).start();
```

### React Hook Example

```typescript
import { useState, useCallback } from 'react';

export function useSyncProducts(organizationId: string) {
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);

  const sync = useCallback(
    async (fetchAll = false) => {
      setSyncing(true);
      setError(null);

      try {
        const response = await fetch(
          'https://jobs.bloomwise.co/api/sync/products',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId, fetchAll }),
          }
        );

        const { syncJobId } = await response.json();

        // Poll for progress
        const interval = setInterval(async () => {
          const status = await fetch(
            `https://jobs.bloomwise.co/api/sync/status/${syncJobId}`
          );
          const data = await status.json();

          setProgress({
            current: data.processedItems,
            total: data.totalItems,
          });

          if (data.status === 'completed') {
            clearInterval(interval);
            setSyncing(false);
          } else if (data.status === 'failed') {
            clearInterval(interval);
            setError(data.errorMessage);
            setSyncing(false);
          }
        }, 3000);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sync failed');
        setSyncing(false);
      }
    },
    [organizationId]
  );

  return { sync, syncing, progress, error };
}
```

---

## Support

For issues or questions:
1. Check the [Troubleshooting](#troubleshooting) section
2. View logs in Bull Board dashboard
3. Check database `sync_jobs` table for error details
4. Review worker logs on the server

---

## Related Documentation

- [BullMQ Implementation Plan](./BULLMQ_WORKER_IMPLEMENTATION_PLAN.md)
- [Shopify Sync Implementation](./SHOPIFY_SYNC_BULLMQ_IMPLEMENTATION.md)
- [CLAUDE.md](../CLAUDE.md) - Architecture overview
