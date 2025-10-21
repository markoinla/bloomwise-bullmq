/**
 * Shopify Webhooks Queue Worker
 *
 * Processes individual Shopify webhook events (orders/products)
 */

import { Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis';
import { logger, createJobLogger } from '../lib/utils/logger';
import { getDatabaseForEnvironment } from '../config/database';
import { shopifyOrders, orders, shopifyProducts, shopifyVariants, shopifyCustomers, shopifyIntegrations } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { executeGraphQLQuery } from '../lib/shopify/client';
import { PRODUCT_BY_ID_QUERY, CUSTOMER_BY_ID_QUERY } from '../lib/shopify/graphql-queries';
import { transformProductToDbRecords } from '../lib/sync/transform-product';
import { transformCustomerToDbRecord } from '../lib/sync/transform-customer';
import { sql } from 'drizzle-orm';

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

export interface CustomerWebhookData {
  shopifyCustomerId: string;
  organizationId: string;
  action: 'create' | 'update' | 'delete';
  timestamp: string;
  environment?: 'staging' | 'production';
}

type WebhookData = OrderWebhookData | ProductWebhookData | CustomerWebhookData;

/**
 * Process an order webhook event
 * The raw order data is already saved to shopifyOrders table by the webhook handler
 * This function creates/updates the internal orders table
 */
async function processOrderWebhook(
  job: Job<OrderWebhookData>
): Promise<void> {
  const { shopifyOrderId, organizationId, action, environment = 'production' } = job.data;
  const jobLogger = createJobLogger(job.id!, organizationId);
  const db = getDatabaseForEnvironment(environment);

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
        await createInternalOrder(shopifyOrder, organizationId, jobLogger, db);
        break;

      case 'update':
        await updateInternalOrder(shopifyOrder, organizationId, jobLogger, db);
        break;

      case 'cancel':
        await cancelInternalOrder(shopifyOrder, organizationId, jobLogger, db);
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
  jobLogger: any,
  db: any
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
  let fulfillmentType: string = 'not available'; // Default to "not available" instead of shipping

  // Check for pickup location
  if (shopifyOrder.pickupLocation) {
    fulfillmentType = 'pickup';
    jobLogger.info('Detected pickup order from pickupLocation');
  }
  // Check shipping lines for delivery or shipping
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
  // Check tags for delivery indicators
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
    } else if (tagsLower.some((tag: string) => tag.includes('pickup'))) {
      fulfillmentType = 'pickup';
      jobLogger.info({ tags: tagsArray }, 'Detected pickup from tags');
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
  jobLogger: any,
  db: any
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
    await createInternalOrder(shopifyOrder, organizationId, jobLogger, db);
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
  jobLogger: any,
  db: any
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
  const { shopifyProductId, organizationId, action, environment = 'production' } = job.data;
  const jobLogger = createJobLogger(job.id!, organizationId);
  const db = getDatabaseForEnvironment(environment);

  jobLogger.info(
    { shopifyProductId, action },
    `Processing product webhook: ${action}`
  );

  try {
    if (action === 'delete') {
      // Mark product as inactive/deleted in database
      jobLogger.info({ shopifyProductId }, 'Product deleted - marking as inactive');

      await db
        .update(shopifyProducts)
        .set({
          isActive: false,
          status: 'deleted',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(shopifyProducts.shopifyProductId, shopifyProductId),
            eq(shopifyProducts.organizationId, organizationId)
          )
        );

      await db
        .update(shopifyVariants)
        .set({
          isActive: false,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(shopifyVariants.shopifyProductId, shopifyProductId),
            eq(shopifyVariants.organizationId, organizationId)
          )
        );

      jobLogger.info({ shopifyProductId }, '✓ Product marked as deleted');
    } else {
      // Fetch single product from Shopify and upsert
      jobLogger.info({ shopifyProductId }, 'Fetching product from Shopify...');

      // Get Shopify integration credentials
      const [integration] = await db
        .select()
        .from(shopifyIntegrations)
        .where(eq(shopifyIntegrations.organizationId, organizationId))
        .limit(1);

      if (!integration || !integration.accessToken) {
        throw new Error(`No Shopify integration found for organization ${organizationId}`);
      }

      // Build GraphQL product ID
      const graphqlId = `gid://shopify/Product/${shopifyProductId}`;

      // Fetch product from Shopify
      const response = await executeGraphQLQuery<{ product: any }>(
        {
          shopDomain: integration.shopDomain,
          accessToken: integration.accessToken,
        },
        PRODUCT_BY_ID_QUERY,
        { id: graphqlId }
      );

      if (response.errors) {
        throw new Error(`GraphQL errors: ${response.errors.map(e => e.message).join(', ')}`);
      }

      if (!response.data?.product) {
        throw new Error(`Product ${shopifyProductId} not found in Shopify`);
      }

      const product = response.data.product;

      // Transform to database records
      const { productRecord, variantRecords } = transformProductToDbRecords(product, organizationId);

      // Upsert product
      await db
        .insert(shopifyProducts)
        .values(productRecord)
        .onConflictDoUpdate({
          target: [shopifyProducts.organizationId, shopifyProducts.shopifyProductId],
          set: {
            title: sql`excluded.title`,
            bodyHtml: sql`excluded.body_html`,
            vendor: sql`excluded.vendor`,
            productType: sql`excluded.product_type`,
            handle: sql`excluded.handle`,
            status: sql`excluded.status`,
            publishedAt: sql`excluded.published_at`,
            featuredImage: sql`excluded.featured_image`,
            allImages: sql`excluded.all_images`,
            tags: sql`excluded.tags`,
            shopifyUpdatedAt: sql`excluded.shopify_updated_at`,
            rawProductData: sql`excluded.raw_product_data`,
            syncedAt: sql`excluded.synced_at`,
            isActive: sql`excluded.is_active`,
            updatedAt: new Date(),
          },
        });

      // Upsert variants
      if (variantRecords.length > 0) {
        await db
          .insert(shopifyVariants)
          .values(variantRecords)
          .onConflictDoUpdate({
            target: [shopifyVariants.organizationId, shopifyVariants.shopifyVariantId],
            set: {
              title: sql`excluded.title`,
              variantTitle: sql`excluded.variant_title`,
              sku: sql`excluded.sku`,
              barcode: sql`excluded.barcode`,
              price: sql`excluded.price`,
              compareAtPrice: sql`excluded.compare_at_price`,
              inventoryQuantity: sql`excluded.inventory_quantity`,
              inventoryPolicy: sql`excluded.inventory_policy`,
              inventoryManagement: sql`excluded.inventory_management`,
              weight: sql`excluded.weight`,
              weightUnit: sql`excluded.weight_unit`,
              grams: sql`excluded.grams`,
              position: sql`excluded.position`,
              imageSrc: sql`excluded.image_src`,
              isActive: sql`excluded.is_active`,
              availableForSale: sql`excluded.available_for_sale`,
              shopifyUpdatedAt: sql`excluded.shopify_updated_at`,
              rawData: sql`excluded.raw_data`,
              syncedAt: sql`excluded.synced_at`,
              updatedAt: new Date(),
            },
          });
      }

      jobLogger.info(
        { shopifyProductId, variantCount: variantRecords.length },
        '✓ Product and variants synced'
      );
    }
  } catch (error) {
    jobLogger.error({ error, shopifyProductId }, 'Failed to process product webhook');
    throw error;
  }
}

/**
 * Process a customer webhook event
 * Fetches the customer from Shopify and syncs it to the database
 */
async function processCustomerWebhook(
  job: Job<CustomerWebhookData>
): Promise<void> {
  const { shopifyCustomerId, organizationId, action, environment = 'production' } = job.data;
  const jobLogger = createJobLogger(job.id!, organizationId);
  const db = getDatabaseForEnvironment(environment);

  jobLogger.info(
    { shopifyCustomerId, action },
    `Processing customer webhook: ${action}`
  );

  try {
    if (action === 'delete') {
      // Mark customer as deleted in database
      jobLogger.info({ shopifyCustomerId }, 'Customer deleted - marking as inactive');

      await db
        .update(shopifyCustomers)
        .set({
          state: 'deleted',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(shopifyCustomers.shopifyCustomerId, shopifyCustomerId),
            eq(shopifyCustomers.organizationId, organizationId)
          )
        );

      jobLogger.info({ shopifyCustomerId }, '✓ Customer marked as deleted');
    } else {
      // Fetch single customer from Shopify and upsert
      jobLogger.info({ shopifyCustomerId }, 'Fetching customer from Shopify...');

      // Get Shopify integration credentials
      const [integration] = await db
        .select()
        .from(shopifyIntegrations)
        .where(eq(shopifyIntegrations.organizationId, organizationId))
        .limit(1);

      if (!integration || !integration.accessToken) {
        throw new Error(`No Shopify integration found for organization ${organizationId}`);
      }

      // Build GraphQL customer ID
      const graphqlId = `gid://shopify/Customer/${shopifyCustomerId}`;

      // Fetch customer from Shopify
      const response = await executeGraphQLQuery<{ customer: any }>(
        {
          shopDomain: integration.shopDomain,
          accessToken: integration.accessToken,
        },
        CUSTOMER_BY_ID_QUERY,
        { id: graphqlId }
      );

      if (response.errors) {
        throw new Error(`GraphQL errors: ${response.errors.map(e => e.message).join(', ')}`);
      }

      if (!response.data?.customer) {
        throw new Error(`Customer ${shopifyCustomerId} not found in Shopify`);
      }

      const customer = response.data.customer;

      // Transform to database record
      const customerRecord = transformCustomerToDbRecord(customer, organizationId, integration.id);

      // Upsert customer
      await db
        .insert(shopifyCustomers)
        .values(customerRecord)
        .onConflictDoUpdate({
          target: [shopifyCustomers.organizationId, shopifyCustomers.shopifyCustomerId],
          set: {
            email: sql`excluded.email`,
            firstName: sql`excluded.first_name`,
            lastName: sql`excluded.last_name`,
            phone: sql`excluded.phone`,
            state: sql`excluded.state`,
            verifiedEmail: sql`excluded.verified_email`,
            acceptsMarketing: sql`excluded.accepts_marketing`,
            marketingOptInLevel: sql`excluded.marketing_opt_in_level`,
            emailMarketingConsent: sql`excluded.email_marketing_consent`,
            smsMarketingConsent: sql`excluded.sms_marketing_consent`,
            defaultAddressId: sql`excluded.default_address_id`,
            addresses: sql`excluded.addresses`,
            ordersCount: sql`excluded.orders_count`,
            totalSpent: sql`excluded.total_spent`,
            currency: sql`excluded.currency`,
            tags: sql`excluded.tags`,
            note: sql`excluded.note`,
            shopifyUpdatedAt: sql`excluded.shopify_updated_at`,
            rawJson: sql`excluded.raw_json`,
            lastSyncedAt: sql`excluded.last_synced_at`,
            updatedAt: new Date(),
          },
        });

      jobLogger.info({ shopifyCustomerId }, '✓ Customer synced');
    }
  } catch (error) {
    jobLogger.error({ error, shopifyCustomerId }, 'Failed to process customer webhook');
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
  } else if (job.name === 'process-customer-webhook') {
    await processCustomerWebhook(job as Job<CustomerWebhookData>);
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
  logger.info(
    {
      jobId: job.id,
      jobName: job.name,
      organizationId: job.data.organizationId,
      action: job.data.action,
      returnValue: job.returnvalue,
    },
    'Webhook job completed'
  );
});

shopifyWebhooksWorker.on('failed', (job, err) => {
  logger.error(
    {
      jobId: job?.id,
      jobName: job?.name,
      organizationId: job?.data?.organizationId,
      action: job?.data?.action,
      error: err.message,
      stack: err.stack,
      attemptsMade: job?.attemptsMade,
      attemptsMax: job?.opts?.attempts,
    },
    'Webhook job failed'
  );
});

shopifyWebhooksWorker.on('error', (err) => {
  logger.error({ error: err.message, stack: err.stack }, 'Webhook worker error');
});

shopifyWebhooksWorker.on('active', (job) => {
  logger.info(
    {
      jobId: job.id,
      jobName: job.name,
      organizationId: job.data.organizationId,
      action: job.data.action,
    },
    'Webhook job started'
  );
});

shopifyWebhooksWorker.on('stalled', (jobId) => {
  logger.warn({ jobId }, 'Webhook job stalled');
});
