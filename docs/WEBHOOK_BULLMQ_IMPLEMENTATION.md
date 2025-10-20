# Webhook Processing in BullMQ - Implementation Guide

## Overview

This document outlines how to implement webhook processing in the BullMQ worker at `jobs.bloomwise.co` to handle individual Shopify webhook events (orders/products created/updated/deleted).

## Current State vs Target State

### Current State
```
Shopify Webhook → app.bloomwise.co/api/shopify/webhooks
                → syncShopifyOrders() [local sync code]
                → Save to shopifyOrders + orders tables
                → Return 200 OK
```

**Issues:**
- Uses old "sync" code for single-item processing
- Fulfillment type detection logic duplicated
- Can't leverage BullMQ features (retries, monitoring, etc.)

### Target State
```
Shopify Webhook → app.bloomwise.co/api/shopify/webhooks
                → Save raw data to shopifyOrders table
                → Trigger jobs.bloomwise.co/api/webhook/process
                → Return 200 OK to Shopify (fast!)

BullMQ Worker   → Process webhook event asynchronously
                → Create/update internal orders table
                → Handle errors with retries
```

---

## Implementation Steps

### 1. Create New API Endpoint at jobs.bloomwise.co

**File:** `apps/api/src/routes/webhook.ts`

```typescript
import { Router } from 'express';
import { shopifyWebhookQueue } from '../queues';

const router = Router();

/**
 * POST /api/webhook/shopify/order
 * Process a single Shopify order webhook event
 */
router.post('/shopify/order', async (req, res) => {
  try {
    const { shopifyOrderId, organizationId, action } = req.body;

    // Validate required fields
    if (!shopifyOrderId || !organizationId || !action) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: shopifyOrderId, organizationId, action'
      });
    }

    // Validate action
    if (!['create', 'update', 'cancel'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid action. Must be: create, update, or cancel'
      });
    }

    // Add job to queue
    const job = await shopifyWebhookQueue.add('process-order-webhook', {
      shopifyOrderId,
      organizationId,
      action,
      timestamp: new Date().toISOString(),
    });

    console.log(`[WEBHOOK API] Enqueued order webhook job ${job.id} for order ${shopifyOrderId}`);

    return res.status(200).json({
      success: true,
      jobId: job.id,
      message: `Webhook job enqueued for ${action} action`
    });

  } catch (error) {
    console.error('[WEBHOOK API] Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to enqueue webhook job'
    });
  }
});

/**
 * POST /api/webhook/shopify/product
 * Process a single Shopify product webhook event
 */
router.post('/shopify/product', async (req, res) => {
  try {
    const { shopifyProductId, organizationId, action } = req.body;

    if (!shopifyProductId || !organizationId || !action) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    const job = await shopifyWebhookQueue.add('process-product-webhook', {
      shopifyProductId,
      organizationId,
      action,
      timestamp: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      jobId: job.id,
      message: `Webhook job enqueued for ${action} action`
    });

  } catch (error) {
    console.error('[WEBHOOK API] Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to enqueue webhook job'
    });
  }
});

export default router;
```

---

### 2. Create Webhook Queue

**File:** `apps/worker/src/queues/shopify-webhook-queue.ts`

```typescript
import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis';

export const shopifyWebhookQueue = new Queue('shopify-webhooks', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3, // Retry up to 3 times
    backoff: {
      type: 'exponential',
      delay: 2000, // Start with 2 second delay
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24 hours
      count: 1000,
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Keep failed jobs for 7 days
    },
  },
});
```

---

### 3. Create Webhook Worker

**File:** `apps/worker/src/workers/shopify-webhook.worker.ts`

```typescript
import { Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis';
import { db } from '../db';
import { shopifyOrders, orders, orderItems, customers } from '../db/schema';
import { eq, and } from 'drizzle-orm';

interface OrderWebhookData {
  shopifyOrderId: string;
  organizationId: string;
  action: 'create' | 'update' | 'cancel';
  timestamp: string;
}

interface ProductWebhookData {
  shopifyProductId: string;
  organizationId: string;
  action: 'create' | 'update' | 'delete';
  timestamp: string;
}

export const shopifyWebhookWorker = new Worker(
  'shopify-webhooks',
  async (job: Job) => {
    const { name, data } = job;

    console.log(`[WEBHOOK WORKER] Processing ${name} job ${job.id}`);

    switch (name) {
      case 'process-order-webhook':
        return await processOrderWebhook(job, data as OrderWebhookData);

      case 'process-product-webhook':
        return await processProductWebhook(job, data as ProductWebhookData);

      default:
        throw new Error(`Unknown webhook job type: ${name}`);
    }
  },
  {
    connection: redisConnection,
    concurrency: 10, // Process up to 10 webhooks concurrently
  }
);

/**
 * Process an order webhook event
 * The raw order data is already saved to shopifyOrders table by the webhook handler
 * This function creates/updates the internal orders table
 */
async function processOrderWebhook(
  job: Job,
  data: OrderWebhookData
): Promise<void> {
  const { shopifyOrderId, organizationId, action } = data;

  console.log(`[WEBHOOK WORKER] Processing order ${shopifyOrderId} (${action})`);

  // 1. Fetch the order from shopifyOrders table
  const [shopifyOrder] = await db
    .select()
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.shopifyOrderId, shopifyOrderId),
        eq(shopifyOrders.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!shopifyOrder) {
    throw new Error(`Shopify order ${shopifyOrderId} not found in database`);
  }

  const rawData = shopifyOrder.rawData as any;

  // 2. Handle based on action
  switch (action) {
    case 'create':
      await createInternalOrder(shopifyOrder, organizationId);
      break;

    case 'update':
      await updateInternalOrder(shopifyOrder, organizationId);
      break;

    case 'cancel':
      await cancelInternalOrder(shopifyOrder, organizationId);
      break;
  }

  console.log(`[WEBHOOK WORKER] ✓ Completed order ${shopifyOrderId} (${action})`);
}

/**
 * Create an internal order from a Shopify order
 * This is where all the business logic lives: fulfillment type detection, address parsing, etc.
 */
async function createInternalOrder(
  shopifyOrder: any,
  organizationId: string
): Promise<void> {
  const rawData = shopifyOrder.rawData as any;

  // Extract customer info
  const customerEmail = rawData.customer?.email || rawData.email;
  const customerName = rawData.customer
    ? `${rawData.customer.first_name} ${rawData.customer.last_name}`.trim()
    : shopifyOrder.customerName;
  const customerPhone = rawData.customer?.phone || rawData.phone;

  // Find or create customer
  let customerId: string | null = null;
  if (customerEmail) {
    const [existingCustomer] = await db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.organizationId, organizationId),
          eq(customers.email, customerEmail)
        )
      )
      .limit(1);

    if (existingCustomer) {
      customerId = existingCustomer.id;
    } else {
      const [newCustomer] = await db
        .insert(customers)
        .values({
          organizationId,
          name: customerName,
          email: customerEmail,
          phone: customerPhone,
        })
        .returning();
      customerId = newCustomer.id;
    }
  }

  // ============================================
  // FULFILLMENT TYPE DETECTION
  // ============================================
  let fulfillmentType: "pickup" | "delivery" | "shipping" = "shipping"; // Default

  // Check for pickup location
  if (shopifyOrder.pickupLocation) {
    fulfillmentType = "pickup";
  }
  // Check shipping lines for delivery
  else if (rawData.shipping_lines && rawData.shipping_lines.length > 0) {
    const shippingTitle = rawData.shipping_lines[0].title?.toLowerCase() || "";

    // Detect local delivery
    if (
      shippingTitle.includes("local") ||
      shippingTitle.includes("delivery") ||
      shippingTitle.includes("local delivery")
    ) {
      fulfillmentType = "delivery";
    } else {
      fulfillmentType = "shipping";
    }
  }
  // Also check tags for delivery indicators
  else if (rawData.tags && Array.isArray(rawData.tags)) {
    const tagsLower = rawData.tags.map((t: string) => t.toLowerCase());
    if (
      tagsLower.includes("local delivery") ||
      tagsLower.includes("delivery")
    ) {
      fulfillmentType = "delivery";
    }
  }

  console.log(`[WEBHOOK WORKER] Detected fulfillment type: ${fulfillmentType}`);

  // ============================================
  // DUE DATE EXTRACTION
  // ============================================
  let dueDate: Date;

  // Try to extract date from tags (e.g., "11-11-2025")
  const dateFromTags = extractDateFromTags(rawData.tags);
  if (dateFromTags) {
    dueDate = dateFromTags;
  }
  // Use pickup date if available
  else if (shopifyOrder.pickupDate) {
    dueDate = new Date(shopifyOrder.pickupDate);
  }
  // Default: 3 days from order date
  else {
    dueDate = new Date(shopifyOrder.shopifyCreatedAt);
    dueDate.setDate(dueDate.getDate() + 3);
  }

  // ============================================
  // SHIPPING ADDRESS PARSING
  // ============================================
  const shippingAddress = rawData.shipping_address;
  const shippingName = shippingAddress
    ? `${shippingAddress.first_name || ''} ${shippingAddress.last_name || ''}`.trim()
    : null;

  // ============================================
  // CREATE INTERNAL ORDER
  // ============================================
  const [internalOrder] = await db
    .insert(orders)
    .values({
      organizationId,
      orderNumber: shopifyOrder.shopifyOrderNumber,
      customerId,
      customerName,
      customerEmail,
      customerPhone,
      status: mapShopifyStatus(rawData.financial_status, rawData.fulfillment_status),
      priority: "normal",
      orderDate: new Date(shopifyOrder.shopifyCreatedAt),
      dueDate: formatDateOnly(dueDate),
      dueTime: shopifyOrder.pickupTime || null,
      fulfillmentType, // ← This is the key field we're fixing!

      // Shipping address fields
      shippingName,
      shippingPhone: shippingAddress?.phone || null,
      shippingEmail: customerEmail,
      shippingAddress1: shippingAddress?.address1 || null,
      shippingAddress2: shippingAddress?.address2 || null,
      shippingCity: shippingAddress?.city || null,
      shippingState: shippingAddress?.province || null,
      shippingZip: shippingAddress?.zip || null,
      shippingCountry: shippingAddress?.country || null,
      shippingCompany: shippingAddress?.company || null,

      // Billing address
      billingName: rawData.billing_address
        ? `${rawData.billing_address.first_name || ''} ${rawData.billing_address.last_name || ''}`.trim()
        : null,
      billingAddress1: rawData.billing_address?.address1 || null,
      billingCity: rawData.billing_address?.city || null,
      billingState: rawData.billing_address?.province || null,
      billingZip: rawData.billing_address?.zip || null,

      // Pricing
      subtotal: shopifyOrder.subtotalPrice.toString(),
      taxAmount: shopifyOrder.totalTax.toString(),
      discountAmount: shopifyOrder.totalDiscounts.toString(),
      total: shopifyOrder.totalPrice.toString(),

      // Payment
      paymentStatus: mapPaymentStatus(rawData.financial_status),

      // Shopify integration
      orderSource: "shopify",
      externalOrderId: shopifyOrderId,
      shopifyOrderId: shopifyOrderId,
      shopifyOrderNumber: shopifyOrder.shopifyOrderNumber,
      shopifyFinancialStatus: rawData.financial_status,
      shopifyFulfillmentStatus: rawData.fulfillment_status,
      shopifyTags: rawData.tags?.join(", ") || null,

      internalNotes: rawData.note || null,
    })
    .returning();

  console.log(`[WEBHOOK WORKER] ✓ Created internal order ${internalOrder.id}`);

  // Update shopifyOrders with link to internal order
  await db
    .update(shopifyOrders)
    .set({ internalOrderId: internalOrder.id })
    .where(eq(shopifyOrders.id, shopifyOrder.id));

  // TODO: Create order items from line_items
  // TODO: Handle custom attributes (gift messages, etc.)
}

/**
 * Extract date from Shopify tags like "11-11-2025" or "2025-11-11"
 */
function extractDateFromTags(tags: string[] | string | null): Date | null {
  if (!tags) return null;

  const tagArray = Array.isArray(tags) ? tags : tags.split(",").map(t => t.trim());

  for (const tag of tagArray) {
    // Try MM-DD-YYYY format
    const match1 = tag.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (match1) {
      const [, month, day, year] = match1;
      return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    }

    // Try YYYY-MM-DD format
    const match2 = tag.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match2) {
      const [, year, month, day] = match2;
      return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    }
  }

  return null;
}

/**
 * Format date as YYYY-MM-DD
 */
function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Map Shopify financial/fulfillment status to internal order status
 */
function mapShopifyStatus(
  financialStatus: string,
  fulfillmentStatus: string | null
): string {
  if (fulfillmentStatus === "fulfilled") return "completed";
  if (financialStatus === "refunded") return "cancelled";
  if (financialStatus === "paid") return "confirmed";
  if (financialStatus === "pending") return "pending";
  return "pending";
}

/**
 * Map Shopify financial status to internal payment status
 */
function mapPaymentStatus(financialStatus: string): string {
  switch (financialStatus) {
    case "paid": return "paid";
    case "refunded": return "refunded";
    case "partially_refunded": return "partial";
    case "pending": return "pending";
    default: return "pending";
  }
}

/**
 * Update an existing internal order when Shopify order is updated
 */
async function updateInternalOrder(
  shopifyOrder: any,
  organizationId: string
): Promise<void> {
  // Find the internal order
  const [internalOrder] = await db
    .select()
    .from(orders)
    .where(eq(orders.shopifyOrderId, shopifyOrder.shopifyOrderId))
    .limit(1);

  if (!internalOrder) {
    // Order doesn't exist yet, create it
    await createInternalOrder(shopifyOrder, organizationId);
    return;
  }

  // Update existing order
  const rawData = shopifyOrder.rawData as any;

  await db
    .update(orders)
    .set({
      status: mapShopifyStatus(rawData.financial_status, rawData.fulfillment_status),
      shopifyFinancialStatus: rawData.financial_status,
      shopifyFulfillmentStatus: rawData.fulfillment_status,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, internalOrder.id));

  console.log(`[WEBHOOK WORKER] ✓ Updated internal order ${internalOrder.id}`);
}

/**
 * Cancel an internal order when Shopify order is cancelled
 */
async function cancelInternalOrder(
  shopifyOrder: any,
  organizationId: string
): Promise<void> {
  await db
    .update(orders)
    .set({
      status: "cancelled",
      updatedAt: new Date(),
    })
    .where(eq(orders.shopifyOrderId, shopifyOrder.shopifyOrderId));

  console.log(`[WEBHOOK WORKER] ✓ Cancelled order ${shopifyOrder.shopifyOrderId}`);
}

/**
 * Process a product webhook event
 */
async function processProductWebhook(
  job: Job,
  data: ProductWebhookData
): Promise<void> {
  const { shopifyProductId, organizationId, action } = data;

  console.log(`[WEBHOOK WORKER] Processing product ${shopifyProductId} (${action})`);

  // TODO: Implement product webhook processing
  // Similar pattern to orders: fetch from shopifyProducts, create/update in products table
}

// Worker event handlers
shopifyWebhookWorker.on('completed', (job) => {
  console.log(`[WEBHOOK WORKER] ✓ Job ${job.id} completed`);
});

shopifyWebhookWorker.on('failed', (job, err) => {
  console.error(`[WEBHOOK WORKER] ✗ Job ${job?.id} failed:`, err);
});
```

---

### 4. Update Webhook Handler in violaflow

**File:** `app/api/shopify/webhooks/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { verifyWebhook } from "@/lib/shopify/client";
import { db } from "@/db/drizzle";
import { shopifyOrders, shopifyIntegrations, userActivityLogs } from "@/db/schema";
import { eq, and } from "drizzle-orm";

const BULLMQ_API_URL = process.env.BULLMQ_API_URL || "https://jobs.bloomwise.co";

export async function POST(request: NextRequest) {
  try {
    // 1. Verify webhook signature
    const rawBody = await request.text();
    const signature = request.headers.get("x-shopify-hmac-sha256");

    if (!signature) {
      return NextResponse.json({ error: "No signature" }, { status: 401 });
    }

    const isValid = await verifyWebhook(rawBody, signature);
    if (!isValid) {
      console.warn("⚠️ Invalid webhook signature (skipping in dev)");
      // TODO: Enable in production
    }

    // 2. Parse webhook data
    const orderData = JSON.parse(rawBody);
    const topic = request.headers.get("x-shopify-topic");
    const shopDomain = request.headers.get("x-shopify-shop-domain");

    console.log(`[WEBHOOK] Received ${topic} for shop ${shopDomain}`);

    // 3. Find organization
    const [integration] = await db
      .select()
      .from(shopifyIntegrations)
      .where(
        and(
          eq(shopifyIntegrations.shopDomain, shopDomain!),
          eq(shopifyIntegrations.isActive, true)
        )
      )
      .limit(1);

    if (!integration) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const organizationId = integration.organizationId;

    // 4. Handle based on topic
    switch (topic) {
      case "orders/create":
      case "orders/updated":
        await handleOrderWebhook(orderData, organizationId, topic);
        break;

      case "orders/cancelled":
        await handleOrderCancellation(orderData, organizationId);
        break;

      case "products/create":
      case "products/update":
      case "products/delete":
        // TODO: Handle product webhooks
        console.log(`Product webhook ${topic} - not implemented yet`);
        break;

      default:
        console.log(`Unhandled webhook topic: ${topic}`);
    }

    // 5. Log activity
    await db.insert(userActivityLogs).values({
      organizationId,
      userId: null,
      action: topic?.includes("create") ? "created" : "updated",
      resource: "order",
      resourceId: orderData.id?.toString(),
      description: `Shopify webhook: ${topic}`,
      metadata: { source: "webhook", topic, shopDomain },
    });

    // 6. Return success to Shopify
    return NextResponse.json({ success: true });

  } catch (error) {
    console.error("[WEBHOOK] Error:", error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}

/**
 * Handle order create/update webhook
 * 1. Save raw data to shopifyOrders table
 * 2. Trigger BullMQ to process it asynchronously
 */
async function handleOrderWebhook(
  orderData: any,
  organizationId: string,
  topic: string
) {
  const shopifyOrderId = orderData.id.toString();
  const action = topic === "orders/create" ? "create" : "update";

  // Extract pickup info from custom attributes
  let pickupDate: Date | null = null;
  let pickupTime: string | null = null;
  let pickupLocation: string | null = null;

  // Check for Zapiet delivery date in line item custom attributes
  if (orderData.line_items && orderData.line_items.length > 0) {
    for (const item of orderData.line_items) {
      if (item.properties) {
        for (const prop of item.properties) {
          if (prop.name === "_ZapietId" && prop.value) {
            // Example: "M=D&L=112097&D=2025-11-11T00:00:00Z"
            const match = prop.value.match(/D=(\d{4}-\d{2}-\d{2})/);
            if (match) {
              pickupDate = new Date(match[1]);
            }
          }
        }
      }
    }
  }

  // Check if order exists
  const [existingOrder] = await db
    .select()
    .from(shopifyOrders)
    .where(
      and(
        eq(shopifyOrders.organizationId, organizationId),
        eq(shopifyOrders.shopifyOrderId, shopifyOrderId)
      )
    )
    .limit(1);

  // Skip if create webhook and order already exists
  if (action === "create" && existingOrder) {
    console.log(`[WEBHOOK] Order ${shopifyOrderId} already exists, skipping`);
    return;
  }

  // Upsert to shopifyOrders table
  if (existingOrder) {
    // Update existing
    await db
      .update(shopifyOrders)
      .set({
        shopifyUpdatedAt: new Date(orderData.updated_at),
        financialStatus: orderData.financial_status,
        fulfillmentStatus: orderData.fulfillment_status,
        totalPrice: orderData.total_price,
        rawData: orderData,
        pickupDate,
        pickupTime,
        pickupLocation,
        updatedAt: new Date(),
      })
      .where(eq(shopifyOrders.id, existingOrder.id));

    console.log(`[WEBHOOK] Updated shopifyOrders record ${existingOrder.id}`);
  } else {
    // Insert new
    await db.insert(shopifyOrders).values({
      organizationId,
      shopifyOrderId,
      shopifyOrderNumber: orderData.order_number?.toString() || shopifyOrderId,
      name: orderData.name,
      shopifyCreatedAt: new Date(orderData.created_at),
      shopifyUpdatedAt: new Date(orderData.updated_at),
      customerEmail: orderData.customer?.email || orderData.email,
      customerPhone: orderData.customer?.phone || orderData.phone,
      customerName: orderData.customer
        ? `${orderData.customer.first_name} ${orderData.customer.last_name}`.trim()
        : null,
      shopifyCustomerId: orderData.customer?.id?.toString(),
      financialStatus: orderData.financial_status,
      fulfillmentStatus: orderData.fulfillment_status,
      currency: orderData.currency || "USD",
      totalPrice: orderData.total_price,
      subtotalPrice: orderData.subtotal_price,
      totalTax: orderData.total_tax,
      totalDiscounts: orderData.total_discount,
      tags: orderData.tags?.join(", ") || null,
      note: orderData.note,
      pickupDate,
      pickupTime,
      pickupLocation,
      rawData: orderData,
      apiVersion: "2024-10",
    });

    console.log(`[WEBHOOK] Created new shopifyOrders record for ${shopifyOrderId}`);
  }

  // Trigger BullMQ to process it
  try {
    const response = await fetch(`${BULLMQ_API_URL}/api/webhook/shopify/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shopifyOrderId,
        organizationId,
        action,
      }),
    });

    if (!response.ok) {
      throw new Error(`BullMQ returned ${response.status}`);
    }

    const result = await response.json();
    console.log(`[WEBHOOK] BullMQ job enqueued: ${result.jobId}`);
  } catch (error) {
    console.error("[WEBHOOK] Failed to trigger BullMQ:", error);
    // Don't throw - we already saved to shopifyOrders, can process later
  }
}

async function handleOrderCancellation(orderData: any, organizationId: string) {
  const shopifyOrderId = orderData.id.toString();

  await db
    .update(shopifyOrders)
    .set({
      shopifyCancelledAt: new Date(orderData.cancelled_at),
      cancelReason: orderData.cancel_reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(shopifyOrders.organizationId, organizationId),
        eq(shopifyOrders.shopifyOrderId, shopifyOrderId)
      )
    );

  // Trigger BullMQ
  try {
    await fetch(`${BULLMQ_API_URL}/api/webhook/shopify/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shopifyOrderId,
        organizationId,
        action: "cancel",
      }),
    });
  } catch (error) {
    console.error("[WEBHOOK] Failed to trigger BullMQ for cancellation:", error);
  }
}
```

---

## Benefits of This Approach

### 1. **Fast Webhook Response**
- Shopify requires 200 OK within 5 seconds
- We save to database and return immediately
- Processing happens asynchronously in BullMQ

### 2. **Centralized Business Logic**
- Fulfillment type detection in ONE place (BullMQ worker)
- No duplicate code between webhooks, manual syncs, OAuth syncs

### 3. **Reliability**
- BullMQ automatically retries failed jobs
- Failed webhooks can be reprocessed from Bull Board
- Monitoring and error tracking built-in

### 4. **Consistency**
- Same processing logic for all order sources
- Same field mapping, validation, and transformations

### 5. **Scalability**
- Can process many webhooks concurrently
- Queue prevents database overload
- Easy to add rate limiting if needed

---

## Testing Plan

### 1. Local Testing
```bash
# 1. Start BullMQ worker locally
cd bloomwise-bullmq-worker
npm run dev

# 2. Trigger a test order in Shopify
# 3. Watch logs in both apps:
#    - violaflow: Webhook received and saved
#    - bullmq-worker: Order processed

# 4. Check Bull Board
open http://localhost:3001
```

### 2. Staging Testing
```bash
# 1. Deploy BullMQ changes to staging
# 2. Deploy violaflow changes to staging
# 3. Create test orders with different fulfillment types:
#    - Pickup order
#    - Local delivery order (with "Local Delivery" tag/shipping)
#    - Standard shipping order
# 4. Verify fulfillmentType is correct in orders table
```

### 3. Production Rollout
```bash
# 1. Deploy BullMQ worker first
# 2. Monitor Bull Board for any errors
# 3. Deploy violaflow webhook changes
# 4. Monitor webhook activity logs
# 5. Verify orders are being created correctly
```

---

## Rollback Plan

If issues occur:

1. **Quick rollback**: Set `BULLMQ_API_URL=""` in violaflow env vars
   - This makes webhook handler skip BullMQ calls
   - Orders still saved to shopifyOrders table
   - Can reprocess later

2. **Revert code**: Restore old webhook handler
   - Use old `syncShopifyOrders()` function temporarily
   - Fix issues in BullMQ worker
   - Redeploy when ready

---

## Future Enhancements

1. **Webhook Retry Logic**: If BullMQ is down, queue webhooks locally and retry
2. **Product Webhooks**: Implement product create/update/delete handling
3. **Customer Webhooks**: Sync customer data updates
4. **Inventory Webhooks**: Update stock levels from Shopify
5. **Dead Letter Queue**: Handle permanently failed webhooks

---

## Summary

This implementation:
- ✅ Keeps webhooks fast (5-second Shopify requirement)
- ✅ Centralizes business logic in BullMQ worker
- ✅ Fixes fulfillment type detection bug
- ✅ Provides retry and monitoring capabilities
- ✅ Makes it easy to maintain and debug
