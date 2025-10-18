/**
 * Shopify Products Sync - Simplified for BullMQ Worker
 *
 * This is a streamlined version focused on:
 * 1. Fetching products from Shopify GraphQL API
 * 2. Updating syncJobs progress
 * 3. Returning results to the worker
 *
 * Note: Full implementation with database upserts will be added in next iteration
 */

import { logger } from '../utils/logger';
import { updateSyncJobProgress } from '../../db/queries';
import { executeGraphQLQuery } from '../shopify/client';
import { PRODUCTS_QUERY } from '../shopify/graphql-queries';

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

      // Update progress
      result.processedItems += products.length;
      result.successCount += products.length;

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
          syncJobId,
        },
        'Batch processed'
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
