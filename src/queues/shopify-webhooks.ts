/**
 * Shopify Webhooks Queue Worker
 *
 * Processes individual Shopify webhook events (orders/products)
 */

import { Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis';
import { logger, createJobLogger } from '../lib/utils/logger';
import { getDatabaseForEnvironment } from '../config/database';
import { shopifyOrders, shopifyProducts, shopifyVariants, shopifyCustomers, shopifyIntegrations } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { executeGraphQLQuery } from '../lib/shopify/client';
import { PRODUCT_BY_ID_QUERY, CUSTOMER_BY_ID_QUERY } from '../lib/shopify/graphql-queries';
import { transformProductToDbRecords } from '../lib/sync/transform-product';
import { transformCustomerToDbRecord } from '../lib/sync/transform-customer';
import { sql } from 'drizzle-orm';
import { syncOrdersToInternal } from '../lib/sync/sync-orders-to-internal';
import { syncCustomersToInternal } from '../lib/sync/sync-customers-to-internal';
import { syncShopifyProductsToInternal } from '../lib/sync/sync-to-internal';

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
 * This function syncs the order to internal tables (orders + order_items + notes + tags)
 */
async function processOrderWebhook(
  job: Job<OrderWebhookData>
): Promise<{ success: boolean; ordersProcessed: number; orderItemsCreated: number; errors: number }> {
  const { shopifyOrderId, organizationId, action, environment = 'production' } = job.data;
  const jobLogger = createJobLogger(job.id!, organizationId);
  const db = getDatabaseForEnvironment(environment);

  jobLogger.info(
    { shopifyOrderId, action },
    `Processing order webhook: ${action}`
  );

  try {
    // Update job progress: Step 1 - Verifying order exists
    await job.updateProgress({ step: 1, message: 'Verifying order in database' });
    await job.log(`Verifying order ${shopifyOrderId} exists in shopify_orders table`);

    // Verify the order exists in shopify_orders table
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
      await job.log(`❌ Order ${shopifyOrderId} not found in database`);
      throw new Error(
        `Shopify order ${shopifyOrderId} not found in database. Webhook may have arrived before order was saved.`
      );
    }

    await job.log(`✓ Order found: ${shopifyOrder.name || shopifyOrderId}`);

    // Update job progress: Step 2 - Syncing to internal tables
    await job.updateProgress({ step: 2, message: 'Syncing to internal tables' });
    await job.log(`Syncing order to internal tables (orders, order_items, notes, tags)`);

    // Use the existing sync logic to handle create/update/cancel
    // This handles:
    // - Creating/updating orders table
    // - Creating order_items from line_items
    // - Extracting and inserting notes
    // - Extracting and inserting tags
    // - Linking order items to products
    const syncResult = await syncOrdersToInternal({
      organizationId,
      shopifyOrderIds: [shopifyOrderId], // Only sync this specific order
      environment,
    });

    // Update job progress: Step 3 - Complete
    await job.updateProgress({ step: 3, message: 'Completed successfully' });
    await job.log(
      `✓ Sync complete: ${syncResult.ordersProcessed} order(s), ${syncResult.orderItemsCreated} item(s)`
    );

    jobLogger.info(
      {
        shopifyOrderId,
        action,
        ordersProcessed: syncResult.ordersProcessed,
        orderItemsCreated: syncResult.orderItemsCreated,
      },
      `✓ Completed order webhook: ${action}`
    );

    return syncResult;
  } catch (error) {
    jobLogger.error(
      { error, shopifyOrderId, action },
      `✗ Failed to process order webhook`
    );
    throw error;
  }
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
      await job.updateProgress({ step: 1, message: 'Marking product as deleted' });
      await job.log(`Marking product ${shopifyProductId} as deleted`);
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

      await job.updateProgress({ step: 2, message: 'Completed' });
      await job.log(`✓ Product ${shopifyProductId} marked as deleted`);
      jobLogger.info({ shopifyProductId }, '✓ Product marked as deleted');
    } else {
      // Fetch single product from Shopify and upsert
      await job.updateProgress({ step: 1, message: 'Fetching product from Shopify' });
      await job.log(`Fetching product ${shopifyProductId} from Shopify API`);
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

      await job.log(`✓ Product fetched: ${product.title}`);

      // Transform to database records
      await job.updateProgress({ step: 2, message: 'Transforming and upserting product' });
      await job.log(`Transforming product data for database`);
      const { productRecord, variantRecords } = transformProductToDbRecords(product, organizationId);

      // Upsert product
      await job.updateProgress({ step: 3, message: 'Saving to database' });
      await job.log(`Upserting product and ${variantRecords.length} variant(s)`);
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

      await job.updateProgress({ step: 4, message: 'Syncing to internal products table' });
      await job.log(`Syncing to internal products and product_variants tables`);

      // Sync to internal products/productVariants tables
      const syncResult = await syncShopifyProductsToInternal(
        organizationId,
        [shopifyProductId],
        environment
      );

      await job.updateProgress({ step: 5, message: 'Completed' });
      await job.log(
        `✓ Product synced: ${productRecord.title} with ${variantRecords.length} variant(s) (${syncResult.productsCreated} created, ${syncResult.productsUpdated} updated, ${syncResult.variantsCreated} variants created)`
      );

      jobLogger.info(
        { shopifyProductId, variantCount: variantRecords.length, syncResult },
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
      await job.updateProgress({ step: 1, message: 'Marking customer as deleted' });
      await job.log(`Marking customer ${shopifyCustomerId} as deleted`);
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

      await job.updateProgress({ step: 2, message: 'Completed' });
      await job.log(`✓ Customer ${shopifyCustomerId} marked as deleted`);
      jobLogger.info({ shopifyCustomerId }, '✓ Customer marked as deleted');
    } else {
      // Fetch single customer from Shopify and upsert
      await job.updateProgress({ step: 1, message: 'Fetching customer from Shopify' });
      await job.log(`Fetching customer ${shopifyCustomerId} from Shopify API`);
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

      await job.log(`✓ Customer fetched: ${customer.email || customer.id}`);

      // Transform to database record
      await job.updateProgress({ step: 2, message: 'Transforming and upserting customer' });
      await job.log(`Transforming customer data for database`);
      const customerRecord = transformCustomerToDbRecord(customer, organizationId, integration.id);

      // Upsert customer
      await job.updateProgress({ step: 3, message: 'Saving to database' });
      await job.log(`Upserting customer record`);
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

      await job.updateProgress({ step: 4, message: 'Syncing to internal customers table' });
      await job.log(`Syncing to internal customers table`);

      // Sync to internal customers table
      const syncResult = await syncCustomersToInternal({
        organizationId,
        shopifyCustomerIds: [shopifyCustomerId],
        environment,
      });

      await job.updateProgress({ step: 5, message: 'Completed' });
      await job.log(
        `✓ Customer synced: ${customerRecord.email || shopifyCustomerId} (${syncResult.customersCreated} created, ${syncResult.customersUpdated} updated)`
      );

      jobLogger.info({ shopifyCustomerId, syncResult }, '✓ Customer synced');
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
