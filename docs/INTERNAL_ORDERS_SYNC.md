# Internal Orders Sync

## Overview

The **Internal Orders Sync** endpoint allows you to sync orders from your existing `shopify_orders` table to the internal `orders` and `order_items` tables **without making any Shopify API calls**.

This is useful for:
- Re-processing existing orders after schema changes
- Fixing data issues by re-syncing from cached Shopify data
- Bulk syncing historical orders without hitting Shopify rate limits
- Testing order transformation logic on real data

## Endpoint

```
POST /api/sync/orders/internal
```

## Request Body

```json
{
  "organizationId": "string (required)",
  "shopifyOrderIds": ["string"] (optional)
}
```

**Parameters:**
- `organizationId` (required): The organization UUID to sync orders for
- `shopifyOrderIds` (optional): Array of Shopify order IDs to sync. If omitted, syncs ALL orders for the organization.

## Response

```json
{
  "success": true,
  "syncJobId": "abc123",
  "organizationId": "dbe20573-5df8-4996-a8e8-29fe6aed35b4",
  "type": "internal",
  "orderCount": 150,
  "message": "Internal orders sync started (syncing from shopify_orders table)",
  "statusUrl": "/api/sync/status/abc123"
}
```

## How It Works

### Data Flow

```
shopify_orders (DB) → orders + order_items (DB)
         ↓
   (No Shopify API calls)
```

Unlike the regular `/api/sync/orders` endpoint which fetches from Shopify's API:

1. **Regular sync**: `Shopify API → shopify_orders → orders + order_items`
2. **Internal sync**: `shopify_orders → orders + order_items` (this endpoint)

### What Gets Synced

The internal sync performs the same transformations as a regular sync:

1. **Orders table**:
   - Fulfillment type detection (pickup/delivery/shipping)
   - Due date extraction from tags or pickup date
   - Address parsing (shipping/billing)
   - Status mapping
   - Payment status
   - Shopify tags

2. **Order Items table**:
   - Line items with quantities and prices
   - **Product linking** (links to `products` and `product_variants` tables)
   - Display order preservation
   - Shopify variant/product ID references

3. **Notes table**:
   - Order-level notes
   - Custom attributes (gift notes, delivery instructions)
   - Line item properties (handwritten cards, etc.)

4. **Tags table**:
   - Creates tags if they don't exist
   - Links tags to orders via `taggables` table
   - Updates usage counts

## Use Cases

### 1. Re-sync All Orders After Product Linking Fix

```bash
curl -X POST http://localhost:3001/api/sync/orders/internal \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": "dbe20573-5df8-4996-a8e8-29fe6aed35b4"
  }'
```

This will re-process ALL orders for the organization, fixing any product linking issues.

### 2. Re-sync Specific Orders

```bash
curl -X POST http://localhost:3001/api/sync/orders/internal \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": "dbe20573-5df8-4996-a8e8-29fe6aed35b4",
    "shopifyOrderIds": ["6886828671148", "6884822253740"]
  }'
```

This will only sync the specified orders.

### 3. Fix Order Items Without Product Links

If you notice orders have `productId: null` in `order_items`, you can:

1. First, ensure products are synced: `POST /api/sync/products`
2. Then, re-sync orders internally: `POST /api/sync/orders/internal`

The internal sync will re-link order items to products based on `shopifyProductId` and `shopifyVariantId`.

## Monitoring

### Check Sync Status

```bash
curl http://localhost:3001/api/sync/status/{syncJobId}
```

Response:
```json
{
  "syncJobId": "abc123",
  "organizationId": "dbe20573-5df8-4996-a8e8-29fe6aed35b4",
  "type": "shopify_orders_incremental",
  "status": "completed",
  "processedItems": 150,
  "totalItems": 150,
  "successCount": 150,
  "errorCount": 0,
  "startedAt": "2025-01-20T10:00:00Z",
  "completedAt": "2025-01-20T10:05:00Z"
}
```

### Logs

Watch the application logs for detailed progress:

```bash
# Development
npm run dev

# Production (Dokploy)
# Check logs in Dokploy dashboard
```

Look for logs like:
```json
{
  "level": "info",
  "syncJobId": "abc123",
  "organizationId": "...",
  "ordersProcessed": 150,
  "orderItemsCreated": 450,
  "msg": "Internal orders sync completed"
}
```

## Performance

**Speed**: Much faster than regular sync because:
- No Shopify API calls (no rate limits)
- No network latency
- All data already in database

**Typical Performance**:
- ~100 orders/second (depends on order complexity)
- 1000 orders = ~10 seconds
- 10,000 orders = ~2 minutes

**Concurrency**: Runs directly in the API server (not queued via BullMQ) to minimize overhead.

## Important Notes

⚠️ **Prerequisites**:
- Orders must already exist in `shopify_orders` table (via previous `/api/sync/orders` call)
- Products should be synced first for proper product linking

⚠️ **Overwrites**:
- Existing orders in `orders` table will be **updated**
- Existing order items will be **deleted and recreated**
- Notes and tags are **deleted and recreated**

⚠️ **No Shopify API Calls**:
- This endpoint does NOT fetch fresh data from Shopify
- Use regular `/api/sync/orders` to get latest data from Shopify first

## Workflow Example

```bash
# Step 1: Fetch latest orders from Shopify (creates/updates shopify_orders table)
curl -X POST http://localhost:3001/api/sync/orders \
  -H "Content-Type: application/json" \
  -d '{"organizationId": "...", "fetchAll": true}'

# Step 2: Ensure products are synced (for product linking)
curl -X POST http://localhost:3001/api/sync/products \
  -H "Content-Type: application/json" \
  -d '{"organizationId": "...", "fetchAll": true}'

# Step 3: Re-sync orders internally (uses cached data, links products)
curl -X POST http://localhost:3001/api/sync/orders/internal \
  -H "Content-Type: application/json" \
  -d '{"organizationId": "..."}'
```

## Testing

Use the included test script:

```bash
./test-internal-sync.sh
```

Or test manually:

```bash
# Development
curl -X POST http://localhost:3001/api/sync/orders/internal \
  -H "Content-Type: application/json" \
  -d '{"organizationId": "YOUR_ORG_ID"}'

# Production
curl -X POST https://jobs.bloomwise.co/api/sync/orders/internal \
  -H "Content-Type: application/json" \
  -d '{"organizationId": "YOUR_ORG_ID"}'
```
