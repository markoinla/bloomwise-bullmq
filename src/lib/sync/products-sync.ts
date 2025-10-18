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

      // Process and save products to database
      for (const product of products) {
        try {
          const { productRecords, variantRecords } = transformProductToDbRecords(product, organizationId);

          // Upsert products (one record per variant)
          for (const productRecord of productRecords) {
            await db
              .insert(shopifyProducts)
              .values(productRecord)
              .onConflictDoUpdate({
                target: [shopifyProducts.organizationId, shopifyProducts.shopifyProductId],
                set: {
                  title: productRecord.title,
                  bodyHtml: productRecord.bodyHtml,
                  vendor: productRecord.vendor,
                  productType: productRecord.productType,
                  handle: productRecord.handle,
                  variantTitle: productRecord.variantTitle,
                  variantPrice: productRecord.variantPrice,
                  variantCompareAtPrice: productRecord.variantCompareAtPrice,
                  variantSku: productRecord.variantSku,
                  variantBarcode: productRecord.variantBarcode,
                  variantGrams: productRecord.variantGrams,
                  variantInventoryQuantity: productRecord.variantInventoryQuantity,
                  variantInventoryPolicy: productRecord.variantInventoryPolicy,
                  variantFulfillmentService: productRecord.variantFulfillmentService,
                  variantInventoryManagement: productRecord.variantInventoryManagement,
                  variantRequiresShipping: productRecord.variantRequiresShipping,
                  variantTaxable: productRecord.variantTaxable,
                  variantPosition: productRecord.variantPosition,
                  option1Value: productRecord.option1Value,
                  option2Value: productRecord.option2Value,
                  option3Value: productRecord.option3Value,
                  status: productRecord.status,
                  publishedAt: productRecord.publishedAt,
                  seoTitle: productRecord.seoTitle,
                  seoDescription: productRecord.seoDescription,
                  featuredImage: productRecord.featuredImage,
                  variantImage: productRecord.variantImage,
                  allImages: productRecord.allImages,
                  tags: productRecord.tags,
                  shopifyUpdatedAt: productRecord.shopifyUpdatedAt,
                  rawProductData: productRecord.rawProductData,
                  rawVariantData: productRecord.rawVariantData,
                  syncedAt: productRecord.syncedAt,
                  updatedAt: new Date(),
                },
              });
          }

          // Upsert variants
          for (const variantRecord of variantRecords) {
            await db
              .insert(shopifyVariants)
              .values(variantRecord)
              .onConflictDoUpdate({
                target: [shopifyVariants.organizationId, shopifyVariants.shopifyVariantId],
                set: {
                  ...variantRecord,
                  updatedAt: new Date(),
                },
              });
          }

          result.successCount++;
        } catch (error) {
          logger.error(
            { error, productId: product.id },
            'Failed to save product to database'
          );
          result.errorCount++;
        }
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
