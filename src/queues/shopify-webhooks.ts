/**
 * Shopify Webhooks Queue Worker
 *
 * Processes individual Shopify webhook events (orders/products)
 */

import { Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis';
import { logger, createJobLogger } from '../lib/utils/logger';
import { db } from '../config/database';
import { shopifyOrders, orders } from '../db/schema';
import { eq, and } from 'drizzle-orm';

export interface OrderWebhookData {
  shopifyOrderId: string;
  organizationId: string;
  action: 'create' | 'update' | 'cancel';
  timestamp: string;
  environment?: 'staging' | 'production';
}

export interface ProductWebhookData {
  shopifyProductId: string;
  organizationId: string;
  action: 'create' | 'update' | 'delete';
  timestamp: string;
  environment?: 'staging' | 'production';
}

type WebhookData = OrderWebhookData | ProductWebhookData;

/**
 * Process an order webhook event
 * The raw order data is already saved to shopifyOrders table by the webhook handler
 * This function creates/updates the internal orders table
 */
async function processOrderWebhook(
  job: Job<OrderWebhookData>
): Promise<void> {
  const { shopifyOrderId, organizationId, action } = job.data;
  const jobLogger = createJobLogger(job.id!, organizationId);

  jobLogger.info(
    { shopifyOrderId, action },
    `Processing order webhook: ${action}`
  );

  try {
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
      throw new Error(
        `Shopify order ${shopifyOrderId} not found in database`
      );
    }

    // 2. Handle based on action
    switch (action) {
      case 'create':
        await createInternalOrder(shopifyOrder, organizationId, jobLogger);
        break;

      case 'update':
        await updateInternalOrder(shopifyOrder, organizationId, jobLogger);
        break;

      case 'cancel':
        await cancelInternalOrder(shopifyOrder, organizationId, jobLogger);
        break;
    }

    jobLogger.info(
      { shopifyOrderId, action },
      `✓ Completed order webhook: ${action}`
    );
  } catch (error) {
    jobLogger.error(
      { error, shopifyOrderId, action },
      `✗ Failed to process order webhook`
    );
    throw error;
  }
}

/**
 * Create an internal order from a Shopify order
 * This is where all the business logic lives: fulfillment type detection, address parsing, etc.
 */
async function createInternalOrder(
  shopifyOrder: any,
  organizationId: string,
  jobLogger: any
): Promise<void> {
  const rawData = shopifyOrder.rawData as any;

  // Extract customer info
  const customerEmail = rawData.customer?.email || rawData.email;
  const customerName = rawData.customer
    ? `${rawData.customer.first_name || ''} ${rawData.customer.last_name || ''}`.trim()
    : shopifyOrder.customerName || 'Unknown Customer';
  const customerPhone = rawData.customer?.phone || rawData.phone;

  // TODO: Find or create customer record when customers table is added to schema
  const customerId: string | null = null;

  // ============================================
  // FULFILLMENT TYPE DETECTION
  // ============================================
  let fulfillmentType: 'pickup' | 'delivery' | 'shipping' = 'shipping'; // Default

  // Check for pickup location
  if (shopifyOrder.pickupLocation) {
    fulfillmentType = 'pickup';
    jobLogger.info('Detected pickup order from pickupLocation');
  }
  // Check shipping lines for delivery
  else if (rawData.shipping_lines && rawData.shipping_lines.length > 0) {
    const shippingTitle = rawData.shipping_lines[0].title?.toLowerCase() || '';

    // Detect local delivery
    if (
      shippingTitle.includes('local') ||
      shippingTitle.includes('delivery')
    ) {
      fulfillmentType = 'delivery';
      jobLogger.info({ shippingTitle }, 'Detected delivery from shipping line');
    } else {
      fulfillmentType = 'shipping';
      jobLogger.info({ shippingTitle }, 'Detected shipping from shipping line');
    }
  }
  // Also check tags for delivery indicators
  else if (rawData.tags) {
    const tagsArray = Array.isArray(rawData.tags)
      ? rawData.tags
      : typeof rawData.tags === 'string'
      ? rawData.tags.split(',').map((t: string) => t.trim())
      : [];

    const tagsLower = tagsArray.map((t: string) => t.toLowerCase());
    if (
      tagsLower.some((tag: string) => tag.includes('local delivery') || tag === 'delivery')
    ) {
      fulfillmentType = 'delivery';
      jobLogger.info({ tags: tagsArray }, 'Detected delivery from tags');
    }
  }

  jobLogger.info({ fulfillmentType }, 'Final fulfillment type');

  // ============================================
  // DUE DATE EXTRACTION
  // ============================================
  let dueDate: Date;

  // Try to extract date from tags (e.g., "11-11-2025")
  const dateFromTags = extractDateFromTags(rawData.tags);
  if (dateFromTags) {
    dueDate = dateFromTags;
    jobLogger.info({ dueDate }, 'Due date from tags');
  }
  // Use pickup date if available
  else if (shopifyOrder.pickupDate) {
    dueDate = new Date(shopifyOrder.pickupDate);
    jobLogger.info({ dueDate }, 'Due date from pickupDate');
  }
  // Default: 3 days from order date
  else {
    dueDate = new Date(shopifyOrder.shopifyCreatedAt);
    dueDate.setDate(dueDate.getDate() + 3);
    jobLogger.info({ dueDate }, 'Due date defaulted to +3 days');
  }

  // ============================================
  // SHIPPING ADDRESS PARSING
  // ============================================
  const shippingAddress = rawData.shipping_address;
  const shippingName = shippingAddress
    ? `${shippingAddress.first_name || ''} ${shippingAddress.last_name || ''}`.trim()
    : null;

  const billingAddress = rawData.billing_address;
  const billingName = billingAddress
    ? `${billingAddress.first_name || ''} ${billingAddress.last_name || ''}`.trim()
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
      priority: 'normal',
      orderDate: new Date(shopifyOrder.shopifyCreatedAt),
      dueDate: formatDateOnly(dueDate),
      dueTime: shopifyOrder.pickupTime || null,
      fulfillmentType, // ← This is the key field!

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
      billingName,
      billingAddress1: billingAddress?.address1 || null,
      billingCity: billingAddress?.city || null,
      billingState: billingAddress?.province || null,
      billingZip: billingAddress?.zip || null,

      // Pricing
      subtotal: shopifyOrder.subtotalPrice?.toString() || '0',
      taxAmount: shopifyOrder.totalTax?.toString() || '0',
      discountAmount: shopifyOrder.totalDiscounts?.toString() || '0',
      total: shopifyOrder.totalPrice.toString(),

      // Payment
      paymentStatus: mapPaymentStatus(rawData.financial_status),

      // Shopify integration
      orderSource: 'shopify',
      externalOrderId: shopifyOrder.shopifyOrderId,
      shopifyOrderId: shopifyOrder.shopifyOrderId,
      shopifyOrderNumber: shopifyOrder.shopifyOrderNumber,
      shopifyFinancialStatus: rawData.financial_status,
      shopifyFulfillmentStatus: rawData.fulfillment_status,
      shopifyTags: Array.isArray(rawData.tags)
        ? rawData.tags.join(', ')
        : typeof rawData.tags === 'string'
        ? rawData.tags
        : null,

      internalNotes: rawData.note || null,
    })
    .returning();

  jobLogger.info({ internalOrderId: internalOrder.id }, '✓ Created internal order');

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

  const tagArray = Array.isArray(tags)
    ? tags
    : typeof tags === 'string'
    ? tags.split(',').map((t) => t.trim())
    : [];

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
 * Format date as YYYY-MM-DD (date type expects string in this format)
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
  if (fulfillmentStatus === 'fulfilled') return 'completed';
  if (financialStatus === 'refunded') return 'cancelled';
  if (financialStatus === 'paid') return 'confirmed';
  if (financialStatus === 'pending') return 'pending';
  return 'pending';
}

/**
 * Map Shopify financial status to internal payment status
 */
function mapPaymentStatus(financialStatus: string): string {
  switch (financialStatus) {
    case 'paid':
      return 'paid';
    case 'refunded':
      return 'refunded';
    case 'partially_refunded':
      return 'partial';
    case 'pending':
      return 'pending';
    default:
      return 'pending';
  }
}

/**
 * Update an existing internal order when Shopify order is updated
 */
async function updateInternalOrder(
  shopifyOrder: any,
  organizationId: string,
  jobLogger: any
): Promise<void> {
  // Find the internal order
  const [internalOrder] = await db
    .select()
    .from(orders)
    .where(eq(orders.shopifyOrderId, shopifyOrder.shopifyOrderId))
    .limit(1);

  if (!internalOrder) {
    // Order doesn't exist yet, create it
    jobLogger.info('Internal order not found, creating new order');
    await createInternalOrder(shopifyOrder, organizationId, jobLogger);
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

  jobLogger.info({ internalOrderId: internalOrder.id }, '✓ Updated internal order');
}

/**
 * Cancel an internal order when Shopify order is cancelled
 */
async function cancelInternalOrder(
  shopifyOrder: any,
  _organizationId: string,
  jobLogger: any
): Promise<void> {
  await db
    .update(orders)
    .set({
      status: 'cancelled',
      updatedAt: new Date(),
    })
    .where(eq(orders.shopifyOrderId, shopifyOrder.shopifyOrderId));

  jobLogger.info({ shopifyOrderId: shopifyOrder.shopifyOrderId }, '✓ Cancelled order');
}

/**
 * Process a product webhook event
 * Fetches the product from Shopify and syncs it to the database
 */
async function processProductWebhook(
  job: Job<ProductWebhookData>
): Promise<void> {
  const { shopifyProductId, organizationId, action } = job.data;
  const jobLogger = createJobLogger(job.id!, organizationId);

  jobLogger.info(
    { shopifyProductId, action },
    `Processing product webhook: ${action}`
  );

  try {
    // For now, just trigger a sync for this specific product
    // TODO: Implement single product fetch and sync
    jobLogger.info({ shopifyProductId, action }, `Product webhook processed: ${action}`);

    if (action === 'delete') {
      // Handle product deletion
      jobLogger.info({ shopifyProductId }, 'Product deleted - marking as inactive');
      // TODO: Mark product as deleted/inactive in database
    } else {
      // Handle create/update
      jobLogger.info({ shopifyProductId }, 'Product created/updated - sync needed');
      // TODO: Fetch single product from Shopify and upsert
    }
  } catch (error) {
    jobLogger.error({ error, shopifyProductId }, 'Failed to process product webhook');
    throw error;
  }
}

/**
 * Router function to determine which webhook handler to use
 */
async function processWebhook(job: Job<WebhookData>): Promise<void> {
  // Determine webhook type based on job name or data
  if (job.name === 'process-product-webhook') {
    await processProductWebhook(job as Job<ProductWebhookData>);
  } else {
    await processOrderWebhook(job as Job<OrderWebhookData>);
  }
}

// Create and export the worker
export const shopifyWebhooksWorker = new Worker(
  'shopify-webhooks',
  processWebhook,
  {
    connection: redisConnection,
    concurrency: 10, // Process up to 10 webhooks concurrently
  }
);

// Event handlers
shopifyWebhooksWorker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'Webhook job completed');
});

shopifyWebhooksWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, error: err }, 'Webhook job failed');
});

shopifyWebhooksWorker.on('error', (err) => {
  logger.error({ error: err }, 'Webhook worker error');
});
