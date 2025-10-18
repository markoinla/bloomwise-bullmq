import { db } from "@/db/drizzle";
import {
  shopifyIntegrations,
  shopifyProducts,
  shopifyVariants,
  syncJobs,
  userActivityLogs,
} from "@/db/schema";
import { eq, and, not, inArray, desc, sql } from "drizzle-orm";

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
}

export async function processProductsSync(params: ProductsSyncParams): Promise<ProductsSyncResult> {
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

    const { createShopifyClient } = await import("@/lib/shopify/client");
    const shopifyClient = await createShopifyClient(organizationId);
    if (!shopifyClient) {
      throw new Error("Shopify integration not found");
    }

    // For initial sync (fetchAll), don't use a since date
    const since = updatedAfter
      ? new Date(updatedAfter)
      : fetchAll
      ? null  // Don't filter by date for initial sync
      : await getLastProductUpdatedAt(organizationId);

    console.log(`[PRODUCT SYNC] Starting sync for org ${organizationId}`);
    console.log(`[PRODUCT SYNC] Since date:`, since);
    console.log(`[PRODUCT SYNC] fetchAll:`, fetchAll);

    let nextPageInfo: string | null = null;
    let page = 0;
    const seenProductIds = new Set<string>();

    do {
      page++;

      const queryParams: Record<string, string> = {
        limit: "250",
        order: "updated_at asc",
      };

      if (nextPageInfo) {
        queryParams.page_info = nextPageInfo;
      } else if (since) {
        const buffered = new Date(since.getTime() - 2 * 60 * 1000);
        queryParams.updated_at_min = buffered.toISOString();
        console.log(`[PRODUCT SYNC] Using updated_at_min:`, queryParams.updated_at_min);
      }

      if (!fetchAll && page > 1) {
        break;
      }

      console.log(`[PRODUCT SYNC] Fetching products with params:`, queryParams);

      const response = await shopifyClient.rest.get({
        path: "products",
        query: queryParams,
      });

      const products = response.body.products || [];
      console.log(`[PRODUCT SYNC] Found ${products.length} products for org ${organizationId}`);
      result.total += products.length;

      await db
        .update(syncJobs)
        .set({
          currentPage: page,
          processedItems: result.total,
          lastActivityAt: new Date(),
        })
        .where(eq(syncJobs.id, jobId));

      const linkHeader = response.headers?.Link || response.headers?.link;
      if (linkHeader) {
        const nextMatch = linkHeader.match(/<([^>]+)>; rel="next"/);
        nextPageInfo = nextMatch
          ? new URL(nextMatch[1]).searchParams.get("page_info")
          : null;
      } else {
        nextPageInfo = null;
      }

      // Process products in batch
      const validProducts = products.filter((product: any) => {
        const shopifyProductId = product.id?.toString();
        if (!shopifyProductId || seenProductIds.has(shopifyProductId)) return false;
        seenProductIds.add(shopifyProductId);
        return true;
      });

      if (validProducts.length > 0) {
        try {
          await upsertProductsBatch({
            products: validProducts,
            organizationId,
            includeVariants,
          });
          result.synced += validProducts.length;
        } catch (error) {
          console.error(`[PRODUCT SYNC] Batch upsert failed, falling back to individual upserts:`, error);
          // Fallback to individual upserts if batch fails
          for (const product of validProducts) {
            try {
              await upsertProduct({
                product,
                organizationId,
                includeVariants,
              });
              result.synced++;
            } catch (individualError) {
              result.failed++;
              result.errors.push({
                productId: product.id?.toString() || "unknown",
                error: individualError instanceof Error ? individualError.message : "Unknown error",
              });
            }
          }
        }
      }
    } while (nextPageInfo && (fetchAll || page === 1));

    if (fetchAll && seenProductIds.size > 0) {
      await pruneMissingProducts(organizationId, Array.from(seenProductIds));
    }

    await db
      .update(syncJobs)
      .set({
        processedItems: result.total,
        successCount: result.synced,
        errorCount: result.failed,
        metadata: {
          summary: {
            processed: result.total,
            synced: result.synced,
            failed: result.failed,
          },
          updatedAfter: since?.toISOString() || null,
        },
        lastActivityAt: new Date(),
      })
      .where(eq(syncJobs.id, jobId));

    if (result.synced > 0 || fetchAll) {
      await db
        .update(shopifyIntegrations)
        .set({ updatedAt: new Date() })
        .where(eq(shopifyIntegrations.organizationId, organizationId));
    }

    // Log sync activity
    if (result.total > 0) {
      await db.insert(userActivityLogs).values({
        organizationId,
        userId: null, // System action
        action: "synced",
        resource: "shopify_products",
        description: `Synced ${result.synced} products from Shopify (${result.total} total processed)`,
        metadata: {
          source: "Shopify Sync",
          jobId,
          total: result.total,
          synced: result.synced,
          failed: result.failed,
          fetchAll: fetchAll || false,
          includeVariants: includeVariants || false,
        },
      });
    }

    return result;
  } catch (error) {
    console.error("Products sync error:", error);

    await db
      .update(syncJobs)
      .set({
        status: "failed",
        lastError: error instanceof Error ? error.message : "Unknown error",
        lastActivityAt: new Date(),
      })
      .where(eq(syncJobs.id, jobId));

    result.success = false;
    result.errors.push({
      productId: "general",
      error: error instanceof Error ? error.message : "Unknown error",
    });

    return result;
  }
}

async function getLastProductUpdatedAt(organizationId: string): Promise<Date | null> {
  // Get the most recently updated product for this organization
  const [lastProduct] = await db
    .select({ shopifyUpdatedAt: shopifyProducts.shopifyUpdatedAt })
    .from(shopifyProducts)
    .where(eq(shopifyProducts.organizationId, organizationId))
    .orderBy(desc(shopifyProducts.shopifyUpdatedAt))
    .limit(1);

  return lastProduct?.shopifyUpdatedAt || null;
}

async function pruneMissingProducts(organizationId: string, keepIds: string[]) {
  if (!keepIds.length) return;

  await db
    .delete(shopifyProducts)
    .where(
      and(
        eq(shopifyProducts.organizationId, organizationId),
        not(inArray(shopifyProducts.shopifyProductId, keepIds))
      )
    );

  await db
    .delete(shopifyVariants)
    .where(
      and(
        eq(shopifyVariants.organizationId, organizationId),
        not(inArray(shopifyVariants.shopifyProductId, keepIds))
      )
    );
}

async function upsertProductsBatch({
  products,
  organizationId,
  includeVariants,
}: {
  products: any[];
  organizationId: string;
  includeVariants: boolean;
}) {
  // Prepare all product data
  const productValues = products.map(product => {
    const shopifyProductId = product.id.toString();
    const firstVariant = product.variants?.[0];

    const productData = {
      organizationId,
      shopifyProductId,
      title: product.title,
      bodyHtml: product.body_html,
      vendor: product.vendor,
      productType: product.product_type,
      handle: product.handle,
      status: product.status?.toLowerCase() || "active",
      publishedAt: product.published_at ? new Date(product.published_at) : null,
      tags: product.tags || "",
      featuredImage: product.image?.src || product.images?.[0]?.src,
      allImages: product.images?.map((img: any) => img.src) || [],
      shopifyCreatedAt: new Date(product.created_at),
      shopifyUpdatedAt: new Date(product.updated_at),
      rawProductData: product,
      syncedAt: new Date(),
      updatedAt: new Date(),
      // Variant snapshot fields
      variantTitle: firstVariant?.title || null,
      variantPrice: firstVariant?.price || null,
      variantCompareAtPrice: firstVariant?.compare_at_price || null,
      variantSku: firstVariant?.sku || null,
      variantBarcode: firstVariant?.barcode || null,
      variantGrams: firstVariant?.grams || null,
      variantInventoryQuantity: firstVariant?.inventory_quantity || null,
      variantInventoryPolicy: firstVariant?.inventory_policy || null,
      variantFulfillmentService: firstVariant?.fulfillment_service || null,
      variantInventoryManagement: firstVariant?.inventory_management || null,
      variantRequiresShipping: firstVariant?.requires_shipping || null,
      variantTaxable: firstVariant?.taxable || null,
      variantPosition: firstVariant?.position || null,
      variantImage: firstVariant?.image?.src || null,
      rawVariantData: product.variants || [],
    };

    return productData;
  });

  // Batch insert/update products
  if (productValues.length > 0) {
    await db
      .insert(shopifyProducts)
      .values(productValues)
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
          tags: sql`excluded.tags`,
          featuredImage: sql`excluded.featured_image`,
          allImages: sql`excluded.all_images`,
          shopifyCreatedAt: sql`excluded.shopify_created_at`,
          shopifyUpdatedAt: sql`excluded.shopify_updated_at`,
          rawProductData: sql`excluded.raw_product_data`,
          syncedAt: sql`excluded.synced_at`,
          updatedAt: sql`excluded.updated_at`,
          variantTitle: sql`excluded.variant_title`,
          variantPrice: sql`excluded.variant_price`,
          variantCompareAtPrice: sql`excluded.variant_compare_at_price`,
          variantSku: sql`excluded.variant_sku`,
          variantBarcode: sql`excluded.variant_barcode`,
          variantGrams: sql`excluded.variant_grams`,
          variantInventoryQuantity: sql`excluded.variant_inventory_quantity`,
          variantInventoryPolicy: sql`excluded.variant_inventory_policy`,
          variantFulfillmentService: sql`excluded.variant_fulfillment_service`,
          variantInventoryManagement: sql`excluded.variant_inventory_management`,
          variantRequiresShipping: sql`excluded.variant_requires_shipping`,
          variantTaxable: sql`excluded.variant_taxable`,
          variantPosition: sql`excluded.variant_position`,
          variantImage: sql`excluded.variant_image`,
          rawVariantData: sql`excluded.raw_variant_data`,
        },
      });
  }

  // Handle variants if needed
  if (includeVariants) {
    const allVariants: any[] = [];

    for (const product of products) {
      if (!Array.isArray(product.variants)) continue;

      for (const variant of product.variants) {
        if (!variant?.id) continue;

        allVariants.push({
          organizationId,
          shopifyProductId: product.id.toString(),
          shopifyVariantId: variant.id.toString(),
          title: variant.title || "",
          price: variant.price || "0",
          compareAtPrice: variant.compare_at_price,
          sku: variant.sku || "",
          barcode: variant.barcode || "",
          grams: variant.grams || 0,
          weight: variant.weight || 0,
          weightUnit: variant.weight_unit || "kg",
          inventoryItemId: variant.inventory_item_id?.toString(),
          inventoryQuantity: variant.inventory_quantity || 0,
          inventoryPolicy: variant.inventory_policy || "deny",
          fulfillmentService: variant.fulfillment_service || "manual",
          inventoryManagement: variant.inventory_management,
          requiresShipping: variant.requires_shipping || false,
          taxable: variant.taxable || false,
          position: variant.position || 1,
          option1: variant.option1,
          option2: variant.option2,
          option3: variant.option3,
          imageId: variant.image_id?.toString(),
          imageSrc: variant.image?.src,
          shopifyCreatedAt: new Date(variant.created_at),
          shopifyUpdatedAt: new Date(variant.updated_at),
          rawVariantData: variant,
          syncedAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }

    // Batch insert variants
    if (allVariants.length > 0) {
      await db
        .insert(shopifyVariants)
        .values(allVariants)
        .onConflictDoUpdate({
          target: [shopifyVariants.organizationId, shopifyVariants.shopifyVariantId],
          set: {
            shopifyProductId: sql`excluded.shopify_product_id`,
            title: sql`excluded.title`,
            price: sql`excluded.price`,
            compareAtPrice: sql`excluded.compare_at_price`,
            sku: sql`excluded.sku`,
            barcode: sql`excluded.barcode`,
            grams: sql`excluded.grams`,
            weight: sql`excluded.weight`,
            weightUnit: sql`excluded.weight_unit`,
            inventoryItemId: sql`excluded.inventory_item_id`,
            inventoryQuantity: sql`excluded.inventory_quantity`,
            inventoryPolicy: sql`excluded.inventory_policy`,
            fulfillmentService: sql`excluded.fulfillment_service`,
            inventoryManagement: sql`excluded.inventory_management`,
            requiresShipping: sql`excluded.requires_shipping`,
            taxable: sql`excluded.taxable`,
            position: sql`excluded.position`,
            option1: sql`excluded.option1`,
            option2: sql`excluded.option2`,
            option3: sql`excluded.option3`,
            imageId: sql`excluded.image_id`,
            imageSrc: sql`excluded.image_src`,
            shopifyCreatedAt: sql`excluded.shopify_created_at`,
            shopifyUpdatedAt: sql`excluded.shopify_updated_at`,
            rawVariantData: sql`excluded.raw_variant_data`,
            syncedAt: sql`excluded.synced_at`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
  }
}

async function upsertProduct({
  product,
  organizationId,
  includeVariants,
}: {
  product: any;
  organizationId: string;
  includeVariants: boolean;
}) {
  const shopifyProductId = product.id.toString();

  const productData = {
    organizationId,
    shopifyProductId,
    title: product.title,
    bodyHtml: product.body_html,
    vendor: product.vendor,
    productType: product.product_type,
    handle: product.handle,
    status: product.status?.toLowerCase() || "active",
    publishedAt: product.published_at ? new Date(product.published_at) : null,
    tags: product.tags || "",
    featuredImage: product.image?.src || product.images?.[0]?.src,
    allImages: product.images?.map((img: any) => img.src) || [],
    shopifyCreatedAt: new Date(product.created_at),
    shopifyUpdatedAt: new Date(product.updated_at),
    rawProductData: product,
    syncedAt: new Date(),
    updatedAt: new Date(),
  };

  const firstVariant = product.variants?.[0];
  const variantSnapshot = firstVariant
    ? {
        variantTitle: firstVariant.title,
        variantPrice: firstVariant.price,
        variantCompareAtPrice: firstVariant.compare_at_price,
        variantSku: firstVariant.sku,
        variantBarcode: firstVariant.barcode,
        variantGrams: firstVariant.grams,
        variantInventoryQuantity: firstVariant.inventory_quantity,
        variantInventoryPolicy: firstVariant.inventory_policy,
        variantFulfillmentService: firstVariant.fulfillment_service,
        variantInventoryManagement: firstVariant.inventory_management,
        variantRequiresShipping: firstVariant.requires_shipping,
        variantTaxable: firstVariant.taxable,
        variantPosition: firstVariant.position,
        variantImage: firstVariant.image?.src,
      }
    : {};

  await db
    .insert(shopifyProducts)
    .values({
      ...productData,
      ...variantSnapshot,
      rawVariantData: product.variants || [],
    })
    .onConflictDoUpdate({
      target: [shopifyProducts.organizationId, shopifyProducts.shopifyProductId],
      set: {
        ...productData,
        ...variantSnapshot,
        rawVariantData: product.variants || [],
      },
    });

  if (!includeVariants || !Array.isArray(product.variants)) {
    return;
  }

  const variantIds: string[] = [];

  for (const variant of product.variants) {
    if (!variant?.id) continue;
    const variantId = variant.id.toString();
    variantIds.push(variantId);

    await db
      .insert(shopifyVariants)
      .values({
        organizationId,
        shopifyProductId,
        shopifyVariantId: variantId,
        title: product.title,
        variantTitle: variant.title || null,
        sku: variant.sku || null,
        price: variant.price || null,
        compareAtPrice: variant.compare_at_price || null,
        barcode: variant.barcode || null,
        grams: variant.grams || null,
        weight: variant.weight || null,
        weightUnit: variant.weight_unit || null,
        inventoryQuantity: variant.inventory_quantity || null,
        inventoryPolicy: variant.inventory_policy || null,
        inventoryManagement: variant.inventory_management || null,
        fulfillmentService: variant.fulfillment_service || null,
        requiresShipping: variant.requires_shipping ?? true,
        taxable: variant.taxable ?? true,
        position: variant.position || null,
        createdAt: new Date(variant.created_at || product.created_at),
        updatedAt: new Date(variant.updated_at || product.updated_at),
        rawVariantData: variant,
      })
      .onConflictDoUpdate({
        target: [shopifyVariants.organizationId, shopifyVariants.shopifyVariantId],
        set: {
          title: product.title,
          variantTitle: variant.title || null,
          sku: variant.sku || null,
          price: variant.price || null,
          compareAtPrice: variant.compare_at_price || null,
          barcode: variant.barcode || null,
          grams: variant.grams || null,
          weight: variant.weight || null,
          weightUnit: variant.weight_unit || null,
          inventoryQuantity: variant.inventory_quantity || null,
          inventoryPolicy: variant.inventory_policy || null,
          inventoryManagement: variant.inventory_management || null,
          fulfillmentService: variant.fulfillment_service || null,
          requiresShipping: variant.requires_shipping ?? true,
          taxable: variant.taxable ?? true,
          position: variant.position || null,
          updatedAt: new Date(variant.updated_at || product.updated_at),
          rawVariantData: variant,
        },
      });
  }

  if (variantIds.length) {
    await db
      .delete(shopifyVariants)
      .where(
        and(
          eq(shopifyVariants.organizationId, organizationId),
          eq(shopifyVariants.shopifyProductId, shopifyProductId),
          not(inArray(shopifyVariants.shopifyVariantId, variantIds))
        )
      );
  }
}
