/**
 * Shopify Products Sync - Full Implementation
 *
 * 1. Fetches products from Shopify GraphQL API
 * 2. Transforms products to database records
 * 3. Upserts products and variants to database
 * 4. Updates syncJobs progress
 */

import { logger } from '../utils/logger';
import { updateSyncJobProgress } from '../../db/queries';
import { executeGraphQLQuery } from '../shopify/client';
import { PRODUCTS_QUERY } from '../shopify/graphql-queries';
import { transformProductToDbRecords } from './transform-product.js';
import { db } from '../../config/database';
import { shopifyProducts, shopifyVariants } from '../../db/schema';
import { sql } from 'drizzle-orm';

interface ProductsSyncParams {
  organizationId: string;
  syncJobId: string;
  shopDomain: string;
  accessToken: string;
  fetchAll?: boolean;
  updatedAfter?: string;
}

interface ProductsSyncResult {
  success: boolean;
  totalItems: number;
  processedItems: number;
  successCount: number;
  errorCount: number;
  skipCount: number;
}

export async function syncShopifyProducts(
  params: ProductsSyncParams
): Promise<ProductsSyncResult> {
  const {
    organizationId,
    syncJobId,
    shopDomain,
    accessToken,
    fetchAll = false,
    updatedAfter,
  } = params;

  const result: ProductsSyncResult = {
    success: true,
    totalItems: 0,
    processedItems: 0,
    successCount: 0,
    errorCount: 0,
    skipCount: 0,
  };

  try {
    logger.info(
      { organizationId, syncJobId, shopDomain, fetchAll },
      'Starting Shopify products sync'
    );

    // TODO: Implement actual GraphQL product fetching
    // This is a placeholder that shows the structure

    // 1. Build GraphQL query filter
    let graphqlQuery = '';
    if (updatedAfter && !fetchAll) {
      const bufferedDate = new Date(new Date(updatedAfter).getTime() - 2 * 60 * 1000);
      graphqlQuery = `updated_at:>='${bufferedDate.toISOString()}'`;
    }

    // 2. Fetch products in batches (250 max per batch)
    let hasNextPage = true;
    let cursor: string | null = null;
    let batchNumber = 0;

    while (hasNextPage) {
      batchNumber++;

      logger.info(
        { batchNumber, cursor, syncJobId },
        'Fetching products batch from Shopify'
      );

      // Fetch products from Shopify GraphQL API
      type ProductsResponse = {
        products: {
          edges: Array<{
            cursor: string;
            node: any;
          }>;
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string | null;
          };
        };
      };

      const response = await executeGraphQLQuery<ProductsResponse>(
        { shopDomain, accessToken },
        PRODUCTS_QUERY,
        {
          first: 250,
          after: cursor,
          query: graphqlQuery || undefined,
          sortKey: 'UPDATED_AT',
          reverse: true,
        }
      );

      if (!response.data?.products) {
        throw new Error('Invalid response from Shopify GraphQL API');
      }

      const products = response.data.products.edges.map((edge: { cursor: string; node: any }) => edge.node);
      const pageInfo: { hasNextPage: boolean; endCursor: string | null } = response.data.products.pageInfo;

      // Process products - collect all records for batch upsert
      const productsToUpsert: any[] = [];
      const variantsToUpsert: any[] = [];

      for (const product of products) {
        try {
          const { productRecord, variantRecords } = transformProductToDbRecords(product, organizationId);
          productsToUpsert.push(productRecord);
          variantsToUpsert.push(...variantRecords);
          result.successCount++;
        } catch (error) {
          logger.error(
            {
              error,
              productId: product.id,
              errorMessage: error instanceof Error ? error.message : String(error),
            },
            'Failed to transform product'
          );
          result.errorCount++;
        }
      }

      // Batch upsert products
      if (productsToUpsert.length > 0) {
        await db
          .insert(shopifyProducts)
          .values(productsToUpsert)
          .onConflictDoUpdate({
            target: [shopifyProducts.organizationId, shopifyProducts.shopifyProductId],
            set: {
              title: sql`excluded.title`,
              bodyHtml: sql`excluded.body_html`,
              vendor: sql`excluded.vendor`,
              productType: sql`excluded.product_type`,
              handle: sql`excluded.handle`,
              shopifyUpdatedAt: sql`excluded.shopify_updated_at`,
              publishedAt: sql`excluded.published_at`,
              publishedScope: sql`excluded.published_scope`,
              tags: sql`excluded.tags`,
              status: sql`excluded.status`,
              featuredImage: sql`excluded.featured_image`,
              allImages: sql`excluded.all_images`,
              rawProductData: sql`excluded.raw_product_data`,
              syncedAt: sql`excluded.synced_at`,
              updatedAt: new Date(),
            },
          });

        logger.info({ count: productsToUpsert.length }, 'Batch upserted products');
      }

      // Batch upsert variants
      if (variantsToUpsert.length > 0) {
        await db
          .insert(shopifyVariants)
          .values(variantsToUpsert)
          .onConflictDoUpdate({
            target: [shopifyVariants.organizationId, shopifyVariants.shopifyVariantId],
            set: {
              title: sql`excluded.title`,
              price: sql`excluded.price`,
              sku: sql`excluded.sku`,
              imageSrc: sql`excluded.image_src`,
              position: sql`excluded.position`,
              inventoryPolicy: sql`excluded.inventory_policy`,
              compareAtPrice: sql`excluded.compare_at_price`,
              fulfillmentService: sql`excluded.fulfillment_service`,
              inventoryManagement: sql`excluded.inventory_management`,
              option1Value: sql`excluded.option1_value`,
              option2Value: sql`excluded.option2_value`,
              option3Value: sql`excluded.option3_value`,
              shopifyUpdatedAt: sql`excluded.shopify_updated_at`,
              taxable: sql`excluded.taxable`,
              barcode: sql`excluded.barcode`,
              grams: sql`excluded.grams`,
              inventoryQuantity: sql`excluded.inventory_quantity`,
              weight: sql`excluded.weight`,
              weightUnit: sql`excluded.weight_unit`,
              requiresShipping: sql`excluded.requires_shipping`,
              rawData: sql`excluded.raw_data`,
              syncedAt: sql`excluded.synced_at`,
              updatedAt: new Date(),
            },
          });

        logger.info({ count: variantsToUpsert.length }, 'Batch upserted variants');
      }

      // Update progress
      result.processedItems += products.length;

      await updateSyncJobProgress(syncJobId, {
        processedItems: result.processedItems,
        successCount: result.successCount,
        errorCount: result.errorCount,
      });

      logger.info(
        {
          batch: batchNumber,
          productsInBatch: products.length,
          totalProcessed: result.processedItems,
          saved: result.successCount,
          errors: result.errorCount,
          syncJobId,
        },
        'Batch processed and saved to database'
      );

      // Log sample product for debugging
      if (products.length > 0) {
        logger.debug(
          {
            sampleProduct: {
              id: products[0].id,
              title: products[0].title,
              variantCount: products[0].variants?.edges?.length || 0,
            },
          },
          'Sample product from batch'
        );
      }

      // Update pagination
      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;

      // Rate limiting delay (250ms between batches)
      if (hasNextPage) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    result.totalItems = result.processedItems;
    result.success = true;

    logger.info(
      {
        syncJobId,
        totalProcessed: result.processedItems,
        successCount: result.successCount,
        errorCount: result.errorCount
      },
      'Shopify products sync completed'
    );

    return result;
  } catch (error) {
    logger.error(
      { error, syncJobId, organizationId },
      'Shopify products sync failed'
    );

    result.success = false;
    result.errorCount++;

    throw error;
  }
}
