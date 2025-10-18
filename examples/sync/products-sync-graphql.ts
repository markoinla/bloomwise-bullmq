/**
 * GraphQL-based products sync - replaces REST API implementation
 *
 * CRITICAL: Products endpoints must migrate to GraphQL by Feb 1, 2025
 * This implementation uses Shopify GraphQL Admin API instead of REST
 */

import { db } from "@/db/drizzle";
import {
  shopifyIntegrations,
  shopifyProducts,
  shopifyVariants,
  syncJobs,
  userActivityLogs,
} from "@/db/schema";
import { eq, and, not, inArray, desc, sql } from "drizzle-orm";
import {
  fetchProductsGraphQL,
  convertGraphQLProductToREST
} from "../shopify/graphql-client";
import { syncShopifyProductsToInternalBatch } from "./shopify-products-to-internal";
import { syncShopifyProductsToInternalBatchOptimized } from "./shopify-products-to-internal-batch-new";

interface ProductsSyncParams {
  organizationId: string;
  jobId: string;
  fetchAll?: boolean;
  includeVariants?: boolean;
  productIds?: string[];
  collectionIds?: string[];
  updatedAfter?: string;
}

interface ProductsSyncResult {
  success: boolean;
  total: number;
  synced: number;
  failed: number;
  errors: Array<{ productId: string; error: string }>;
  internalProductsSynced?: number;
  internalProductsFailed?: number;
}

export async function processProductsSyncGraphQL(params: ProductsSyncParams): Promise<ProductsSyncResult> {
  const {
    organizationId,
    jobId,
    fetchAll = false,
    includeVariants = true,
    updatedAfter,
  } = params;

  const result: ProductsSyncResult = {
    success: true,
    total: 0,
    synced: 0,
    failed: 0,
    errors: [],
    internalProductsSynced: 0,
    internalProductsFailed: 0,
  };

  try {
    await db
      .update(syncJobs)
      .set({
        status: "running",
        startedAt: new Date(),
        lastActivityAt: new Date(),
      })
      .where(eq(syncJobs.id, jobId));

    console.log(`Starting GraphQL products sync for organization ${organizationId}`);

    // Get the Shopify integration
    const [integration] = await db
      .select()
      .from(shopifyIntegrations)
      .where(
        and(
          eq(shopifyIntegrations.organizationId, organizationId),
          eq(shopifyIntegrations.isActive, true)
        )
      )
      .limit(1);

    if (!integration) {
      throw new Error("No active Shopify integration found");
    }

    // Build GraphQL query filter if updatedAfter is provided
    let graphqlQuery = "";
    if (updatedAfter) {
      const updatedAfterDate = new Date(updatedAfter);
      // Add 2-minute buffer for API timing differences
      const bufferedDate = new Date(updatedAfterDate.getTime() - 2 * 60 * 1000);
      graphqlQuery = `updated_at:>='${bufferedDate.toISOString()}'`;
    }

    let hasNextPage = true;
    let cursor: string | undefined;
    let batchNumber = 0;
    let totalProcessed = 0;

    while (hasNextPage) {
      batchNumber++;
      console.log(`Processing GraphQL products batch ${batchNumber}`);

      try {
        // Fetch products using GraphQL
        const response = await fetchProductsGraphQL(organizationId, {
          limit: 250, // Maximum GraphQL batch size
          cursor,
          query: graphqlQuery,
          sortKey: 'UPDATED_AT',
          reverse: true, // Newest first
        });

        const products = response.data;
        hasNextPage = response.pageInfo.hasNextPage;
        cursor = response.pageInfo.endCursor;

        console.log(`Fetched ${products.length} products from GraphQL API`);

        if (products.length === 0) {
          break;
        }

        // Convert GraphQL products to REST format for compatibility
        const restProducts = products.map(convertGraphQLProductToREST);

        // Process all products in a single batch for efficiency
        try {
          const batchResult = await processProductsBatch(restProducts, organizationId, includeVariants);
          result.synced += restProducts.length;
          result.internalProductsSynced! += batchResult.internalSynced;
          result.internalProductsFailed! += batchResult.internalFailed;
        } catch (error) {
          console.error(`Error processing products batch:`, error);
          result.failed += restProducts.length;
          result.internalProductsFailed! += restProducts.length;

          restProducts.forEach(product => {
            result.errors.push({
              productId: product.id.toString(),
              error: error instanceof Error ? error.message : "Unknown error",
            });
          });
        }

        totalProcessed += products.length;
        result.total = totalProcessed;

        // Update job progress
        // Estimate total items based on batch processing
        const estimatedTotal = hasNextPage
          ? totalProcessed + (250 * 2) // Assume at least 2 more batches remain
          : totalProcessed; // We're done, total = processed

        const progress = estimatedTotal > 0
          ? Math.round((totalProcessed / estimatedTotal) * 100)
          : 0;

        await db
          .update(syncJobs)
          .set({
            totalItems: estimatedTotal,
            processedItems: totalProcessed,
            lastActivityAt: new Date(),
            metadata: {
              batchNumber,
              currentBatch: products.length,
              hasNextPage,
              progress: Math.round(progress),
              apiType: "graphql",
            },
          })
          .where(eq(syncJobs.id, jobId));

        // Add small delay between batches to respect rate limits
        // Shopify allows 2 requests per second, so 250ms keeps us safe
        if (hasNextPage) {
          await new Promise(resolve => setTimeout(resolve, 250));
        }

      } catch (error) {
        console.error(`Error in GraphQL products batch ${batchNumber}:`, error);

        // Record the error but continue with next batch
        await db
          .update(syncJobs)
          .set({
            lastError: error instanceof Error ? error.message : "Unknown error",
            lastActivityAt: new Date(),
          })
          .where(eq(syncJobs.id, jobId));

        result.failed += 250; // Assume full batch failed
        result.errors.push({
          productId: `batch_${batchNumber}`,
          error: error instanceof Error ? error.message : "Unknown error",
        });

        // Continue to next batch
        continue;
      }
    }

    // Update integration last sync timestamp
    await db
      .update(shopifyIntegrations)
      .set({
        lastProductSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(shopifyIntegrations.organizationId, organizationId));

    // Log activity
    await db.insert(userActivityLogs).values({
      organizationId,
      userId: null, // System action
      action: "synced",
      resource: "shopify_products",
      description: `Synced ${result.synced} Shopify products`,
      metadata: {
        source: "Shopify Sync",
        total: result.total,
        synced: result.synced,
        failed: result.failed,
        internalProductsSynced: result.internalProductsSynced,
        internalProductsFailed: result.internalProductsFailed,
        batches: batchNumber,
        apiType: "graphql",
      },
    });

    console.log(`GraphQL products sync completed: ${result.synced} Shopify products synced, ${result.internalProductsSynced} internal products created/updated`);

    return result;

  } catch (error) {
    console.error("Error in GraphQL products sync:", error);
    result.success = false;
    result.errors.push({
      productId: "sync_job",
      error: error instanceof Error ? error.message : "Unknown error",
    });

    throw error;
  }
}

/**
 * Process a batch of products and their variants
 * Now also syncs to internal products table
 */
async function processProductsBatch(
  products: any[],
  organizationId: string,
  includeVariants: boolean
): Promise<{ internalSynced: number; internalFailed: number }> {
  if (products.length === 0) return { internalSynced: 0, internalFailed: 0 };

  // Prepare product data for batch insert (handling GraphQL field names)
  const productsToUpsert = products.map(product => {
    // Extract images from product data
    const images = product.images?.edges?.map((edge: any) => edge.node) || product.images || [];
    const featuredImage = images.length > 0 ? images[0]?.url || images[0]?.src : null;
    const allImages = images.map((img: any) => img.url || img.src).filter(Boolean);

    return {
      organizationId,
      shopifyProductId: product.legacyResourceId?.toString() || product.id.toString(),
      title: product.title || "",
      bodyHtml: product.descriptionHtml || product.body_html || null,
      vendor: product.vendor || null,
      productType: product.productType || product.product_type || null,
      handle: product.handle || "",
      shopifyCreatedAt: product.createdAt ? new Date(product.createdAt) : new Date(product.created_at || Date.now()),
      shopifyUpdatedAt: product.updatedAt ? new Date(product.updatedAt) : new Date(product.updated_at || Date.now()),
      publishedAt: product.publishedAt ? new Date(product.publishedAt) : (product.published_at ? new Date(product.published_at) : null),
      templateSuffix: product.templateSuffix || product.template_suffix || null,
      publishedScope: product.publishedScope || product.published_scope || "web",
      tags: product.tags ? (Array.isArray(product.tags) ? product.tags.join(", ") : product.tags) : null,
      status: product.status || "draft",
      adminGraphqlApiId: product.id || product.admin_graphql_api_id || null,
      // Image fields
      featuredImage,
      allImages,
      rawProductData: product, // Changed from rawData to rawProductData
      apiVersion: "2024-10",
    };
  });

  // Batch upsert products
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
        templateSuffix: sql`excluded.template_suffix`,
        publishedScope: sql`excluded.published_scope`,
        tags: sql`excluded.tags`,
        status: sql`excluded.status`,
        adminGraphqlApiId: sql`excluded.admin_graphql_api_id`,
        // Update image fields
        featuredImage: sql`excluded.featured_image`,
        allImages: sql`excluded.all_images`,
        rawProductData: sql`excluded.raw_product_data`, // Changed from rawData to rawProductData
        updatedAt: new Date(),
      },
    });

  // Process variants if requested
  const variantsToUpsert: any[] = [];
  if (includeVariants) {

    products.forEach(product => {
      // Handle GraphQL format (variants.edges) and REST format (variants array)
      const variantsArray = product.variants?.edges
        ? product.variants.edges.map((edge: any) => edge.node)
        : (product.variants || []);

      if (Array.isArray(variantsArray) && variantsArray.length > 0) {
        variantsArray.forEach((variant: any) => {
          // Extract product ID (GraphQL or REST)
          const productId = product.legacyResourceId?.toString() || product.id.toString();
          // Extract variant ID (GraphQL or REST)
          const variantId = variant.legacyResourceId?.toString() || variant.id.toString();

          variantsToUpsert.push({
            organizationId,
            shopifyProductId: productId,
            shopifyVariantId: variantId,
            title: variant.title || "",
            price: variant.price?.amount || variant.price || "0.00",
            sku: variant.sku || null,
            imageSrc: variant.image?.url || variant.image?.src || null,
            position: variant.position || 1,
            inventoryPolicy: variant.inventoryPolicy || variant.inventory_policy || "deny",
            compareAtPrice: variant.compareAtPrice?.amount || variant.compare_at_price || null,
            fulfillmentService: variant.fulfillmentService || variant.fulfillment_service || "manual",
            inventoryManagement: variant.inventoryManagement || variant.inventory_management || null,
            option1: variant.selectedOptions?.[0]?.value || variant.option1 || null,
            option2: variant.selectedOptions?.[1]?.value || variant.option2 || null,
            option3: variant.selectedOptions?.[2]?.value || variant.option3 || null,
            shopifyCreatedAt: variant.createdAt ? new Date(variant.createdAt) : new Date(variant.created_at || product.createdAt || product.created_at || Date.now()),
            shopifyUpdatedAt: variant.updatedAt ? new Date(variant.updatedAt) : new Date(variant.updated_at || product.updatedAt || product.updated_at || Date.now()),
            taxable: variant.taxable ?? true,
            barcode: variant.barcode || null,
            grams: variant.weight?.value || variant.grams || 0,
            inventoryQuantity: variant.inventoryQuantity?.available || variant.inventory_quantity || 0,
            weight: variant.weight?.value || variant.weight || null,
            weightUnit: variant.weight?.unit || variant.weight_unit || "kg",
            inventoryItemId: variant.inventoryItem?.id?.toString() || variant.inventory_item_id?.toString() || null,
            oldInventoryQuantity: variant.old_inventory_quantity || 0,
            requiresShipping: variant.requiresShipping ?? variant.requires_shipping ?? true,
            adminGraphqlApiId: variant.admin_graphql_api_id || null,
            rawData: variant,
            apiVersion: "2024-10",
          });
        });
      }
    });

    if (variantsToUpsert.length > 0) {
      // Batch upsert variants
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
            option1: sql`excluded.option1`,
            option2: sql`excluded.option2`,
            option3: sql`excluded.option3`,
            shopifyUpdatedAt: sql`excluded.shopify_updated_at`,
            taxable: sql`excluded.taxable`,
            barcode: sql`excluded.barcode`,
            grams: sql`excluded.grams`,
            inventoryQuantity: sql`excluded.inventory_quantity`,
            weight: sql`excluded.weight`,
            weightUnit: sql`excluded.weight_unit`,
            inventoryItemId: sql`excluded.inventory_item_id`,
            oldInventoryQuantity: sql`excluded.old_inventory_quantity`,
            requiresShipping: sql`excluded.requires_shipping`,
            adminGraphqlApiId: sql`excluded.admin_graphql_api_id`,
            rawData: sql`excluded.raw_data`,
            updatedAt: new Date(),
          },
        });
    }
  }

  console.log(`Processed ${products.length} products with GraphQL API`);

  // Sync Shopify products to internal products table
  try {
    console.log(`Syncing ${products.length} Shopify products to internal products...`);
    const shopifyProductIds = products.map(p =>
      p.legacyResourceId?.toString() || p.id.toString()
    );

    // Use optimized batch sync for better performance
    const internalSyncResult = await syncShopifyProductsToInternalBatchOptimized(
      organizationId,
      shopifyProductIds
    );

    console.log(
      `Internal product sync complete: ${internalSyncResult.success} synced, ${internalSyncResult.failed} failed`
    );

    if (internalSyncResult.errors.length > 0) {
      console.error(`Internal product sync errors:`, internalSyncResult.errors);
    }

    return {
      internalSynced: internalSyncResult.success,
      internalFailed: internalSyncResult.failed,
    };
  } catch (error) {
    console.error(`Error syncing Shopify products to internal products:`, error);
    // Don't throw - we've already saved to shopifyProducts table
    // Internal sync failure shouldn't break the main sync
    return {
      internalSynced: 0,
      internalFailed: products.length,
    };
  }
}