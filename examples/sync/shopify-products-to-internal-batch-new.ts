/**
 * True batch processing for syncing Shopify products to internal products
 * Processes all products and variants in batches of 200 for optimal performance
 */

import { db } from "@/db/drizzle";
import {
  shopifyProducts,
  shopifyVariants,
  products,
  productVariants,
  shopifyProductMappings,
} from "@/db/schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import { processProductTags } from "./process-product-tags";

const BATCH_SIZE = 200;

interface BatchSyncResult {
  success: number;
  failed: number;
  errors: Array<{ productId: string; error: string }>;
}

/**
 * Map Shopify product type to internal product type
 * For the constrained 'type' field, we default to 'recipe' for florals
 */
function mapShopifyProductTypeToInternal(shopifyProductType: string | null): string {
  if (!shopifyProductType) {
    return 'recipe'; // Default to recipe for floral products
  }

  const type = shopifyProductType.toLowerCase();

  // Check for subscription indicators
  if (type.includes('subscription') || type.includes('weekly') || type.includes('monthly')) {
    return 'subscription';
  }

  // Check for bundle indicators
  if (type.includes('bundle') || type.includes('collection') || type.includes('set')) {
    return 'bundle';
  }

  // Check for add-ons
  if (type.includes('add-on') || type.includes('addon') || type.includes('extra') ||
      type.includes('card') || type.includes('vase') || type.includes('chocolate')) {
    return 'add_on';
  }

  // Check for non-floral products
  if (type.includes('plant') || type.includes('succulent') || type.includes('gift') ||
      type.includes('candle') || type.includes('pottery') || type.includes('container')) {
    return 'inventory_item';
  }

  // Everything else (flowers, bouquets, arrangements, etc.) maps to recipe
  return 'recipe';
}

/**
 * Truly batch sync multiple Shopify products to internal products
 * Processes everything in batches for maximum efficiency
 */
export async function syncShopifyProductsToInternalBatchOptimized(
  organizationId: string,
  shopifyProductIds: string[]
): Promise<BatchSyncResult> {
  const results: BatchSyncResult = {
    success: 0,
    failed: 0,
    errors: [],
  };

  console.log(`Starting optimized batch sync for ${shopifyProductIds.length} products`);

  // Process in batches of 200
  for (let i = 0; i < shopifyProductIds.length; i += BATCH_SIZE) {
    const batchIds = shopifyProductIds.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(shopifyProductIds.length / BATCH_SIZE);

    console.log(`Processing batch ${batchNumber}/${totalBatches} (${batchIds.length} products)`);

    try {
      // 1. Fetch all Shopify products for this batch
      const shopifyProductsBatch = await db
        .select()
        .from(shopifyProducts)
        .where(
          and(
            eq(shopifyProducts.organizationId, organizationId),
            inArray(shopifyProducts.shopifyProductId, batchIds)
          )
        );

      if (shopifyProductsBatch.length === 0) {
        console.log(`No Shopify products found for batch ${batchNumber}`);
        continue;
      }

      // 2. Fetch all Shopify variants for these products
      const shopifyVariantsBatch = await db
        .select()
        .from(shopifyVariants)
        .where(
          and(
            eq(shopifyVariants.organizationId, organizationId),
            inArray(shopifyVariants.shopifyProductId, batchIds)
          )
        );

      // 3. Check which products already exist internally
      const existingProducts = await db
        .select({
          id: products.id,
          shopifyProductId: products.shopifyProductId,
          name: products.name,
          description: products.description,
          sku: products.sku,
          tags: products.tags,
          publishedAt: products.publishedAt,
          primaryImageUrl: products.primaryImageUrl,
          imageUrls: products.imageUrls,
        })
        .from(products)
        .where(
          and(
            eq(products.organizationId, organizationId),
            inArray(products.shopifyProductId, batchIds)
          )
        );

      const existingProductMap = new Map(
        existingProducts.map(p => [p.shopifyProductId!, p])
      );

      // 4. Prepare products for insert/update
      const productsToInsert: any[] = [];
      const productsToUpdate: any[] = [];
      const productMappingsToUpsert: any[] = [];
      let skippedCount = 0;

      for (const shopifyProduct of shopifyProductsBatch) {
        const existingProduct = existingProductMap.get(shopifyProduct.shopifyProductId);

        // Prepare new data
        const newTags = shopifyProduct.tags ? shopifyProduct.tags.split(",").map(t => t.trim()) : [];

        // Map Shopify product type to internal type
        const internalProductType = mapShopifyProductTypeToInternal(shopifyProduct.productType);

        // Get price from variants
        const productVariants = shopifyVariantsBatch.filter(
          v => v.shopifyProductId === shopifyProduct.shopifyProductId
        );
        const variantPrices = productVariants
          .map(v => parseFloat(v.price || "0"))
          .filter(p => !isNaN(p) && p > 0);

        // Use min price if available, otherwise default to "0"
        const productPrice = variantPrices.length > 0
          ? Math.min(...variantPrices).toString()
          : "0";

        // Collect variant IDs for this product
        const shopifyVariantIds = productVariants.map(v => v.shopifyVariantId).filter(Boolean);

        // Get all images from Shopify product raw data
        const rawData = shopifyProduct.rawProductData as any;
        const shopifyImages = rawData?.images || [];
        const primaryImage = shopifyImages.length > 0 ? shopifyImages[0].src : null;
        const allImageUrls = shopifyImages.map((img: any) => img.src).filter(Boolean);

        // Extract additional product fields from rawData
        const vendor = rawData?.vendor || null;
        const handle = rawData?.handle || shopifyProduct.handle;
        const collections = rawData?.collections ? rawData.collections.map((c: any) => c.title || c.handle) : [];
        const seoTitle = rawData?.seo?.title || rawData?.metafields_global_title_tag || null;
        const seoDescription = rawData?.seo?.description || rawData?.metafields_global_description_tag || null;

        // Get variant-level fields (from first variant as defaults)
        const firstVariant = productVariants[0];
        const variantRawData = firstVariant ? (firstVariant as any).rawVariantData : null;
        const barcode = variantRawData?.barcode || rawData?.variants?.[0]?.barcode || null;
        const weight = variantRawData?.weight || rawData?.variants?.[0]?.weight || null;
        const weightUnit = variantRawData?.weight_unit || rawData?.variants?.[0]?.weight_unit || 'lb';
        const compareAtPrice = firstVariant?.variantCompareAtPrice ||
          (variantRawData?.compare_at_price ? parseFloat(variantRawData.compare_at_price) : null);

        // Determine if product is published
        const isPublished = shopifyProduct.status === "active" && shopifyProduct.publishedAt !== null;

        // Check if update is needed
        if (existingProduct) {
          const needsUpdate =
            existingProduct.name !== shopifyProduct.title ||
            existingProduct.description !== shopifyProduct.bodyHtml ||
            existingProduct.sku !== shopifyProduct.handle ||
            existingProduct.primaryImageUrl !== primaryImage ||
            JSON.stringify(existingProduct.imageUrls || []) !== JSON.stringify(allImageUrls) ||
            JSON.stringify(existingProduct.tags) !== JSON.stringify(newTags) ||
            // Handle null publishedAt comparison properly
            (existingProduct.publishedAt === null && shopifyProduct.publishedAt !== null) ||
            (existingProduct.publishedAt !== null && shopifyProduct.publishedAt === null) ||
            (existingProduct.publishedAt !== null && shopifyProduct.publishedAt !== null &&
             existingProduct.publishedAt.toISOString() !== new Date(shopifyProduct.publishedAt).toISOString());

          if (needsUpdate) {
            productsToUpdate.push({
              id: existingProduct.id,
              organizationId,
              shopifyProductId: shopifyProduct.shopifyProductId,
              shopifyVariantIds,
              type: internalProductType,
              category: shopifyProduct.productType, // Preserve original Shopify product type
              name: shopifyProduct.title,
              description: shopifyProduct.bodyHtml,
              sku: shopifyProduct.handle,
              handle,
              barcode,
              price: productPrice,
              compareAtPrice: compareAtPrice ? compareAtPrice.toString() : null,
              weight: weight ? weight.toString() : null,
              weightUnit,
              primaryImageUrl: primaryImage,
              imageUrls: allImageUrls,
              collections,
              metaTitle: seoTitle,
              metaDescription: seoDescription,
              requiresShipping: true,
              isPhysicalProduct: true,
              isTaxable: true,
              isSubscriptionEligible: false,
              tags: newTags,
              isActive: shopifyProduct.status === "active",
              isPublished,
              publishedAt: shopifyProduct.publishedAt,
              metadata: {
                shopifyHandle: shopifyProduct.handle,
                shopifyStatus: shopifyProduct.status,
                shopifyTags: shopifyProduct.tags,
                shopifyVendor: vendor,
              },
              updatedAt: new Date(),
            });
          } else {
            skippedCount++;
          }
        } else {
          // New product
          productsToInsert.push({
            organizationId,
            shopifyProductId: shopifyProduct.shopifyProductId,
            shopifyVariantIds,
            type: internalProductType,
            category: shopifyProduct.productType, // Preserve original Shopify product type
            name: shopifyProduct.title,
            description: shopifyProduct.bodyHtml,
            sku: shopifyProduct.handle,
            handle,
            barcode,
            price: productPrice,
            compareAtPrice: compareAtPrice ? compareAtPrice.toString() : null,
            weight: weight ? weight.toString() : null,
            weightUnit,
            primaryImageUrl: primaryImage,
            imageUrls: allImageUrls,
            collections,
            metaTitle: seoTitle,
            metaDescription: seoDescription,
            requiresShipping: true,
            isPhysicalProduct: true,
            isTaxable: true,
            isSubscriptionEligible: false,
            tags: newTags,
            isActive: shopifyProduct.status === "active",
            isPublished,
            publishedAt: shopifyProduct.publishedAt,
            metadata: {
              shopifyHandle: shopifyProduct.handle,
              shopifyStatus: shopifyProduct.status,
              shopifyTags: shopifyProduct.tags,
              shopifyVendor: vendor,
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }

      // 5. Batch insert new products
      let insertedProducts: any[] = [];
      if (productsToInsert.length > 0) {
        console.log(`  Inserting ${productsToInsert.length} new products`);
        insertedProducts = await db
          .insert(products)
          .values(productsToInsert)
          .returning({ id: products.id, shopifyProductId: products.shopifyProductId });
      }

      // 6. Batch update existing products that have changes
      if (productsToUpdate.length > 0) {
        console.log(`  Updating ${productsToUpdate.length} changed products`);
        // Update products one by one (Neon HTTP driver doesn't support transactions)
        for (const product of productsToUpdate) {
          await db
            .update(products)
            .set(product)
            .where(eq(products.id, product.id));
        }
      }

      if (skippedCount > 0) {
        console.log(`  Skipped ${skippedCount} unchanged products`);
      }

      // 7. Create complete product ID map (existing + new)
      const allProductIds = new Map<string, string>();
      for (const [shopifyId, existingProduct] of existingProductMap) {
        allProductIds.set(shopifyId, existingProduct.id);
      }
      for (const product of insertedProducts) {
        allProductIds.set(product.shopifyProductId, product.id);
      }

      // 8. Process variants in batch
      if (shopifyVariantsBatch.length > 0) {
        await syncVariantsBatch(
          organizationId,
          shopifyVariantsBatch,
          allProductIds,
          shopifyProductsBatch
        );
      }

      // 8.5. Process product tags - convert Shopify tags to polymorphic tags
      const productsWithTags: Array<{ productId: string; shopifyTags: string }> = [];
      for (const [shopifyProductId, productId] of allProductIds) {
        const shopifyProduct = shopifyProductsBatch.find(
          p => p.shopifyProductId === shopifyProductId
        );
        if (shopifyProduct?.tags) {
          productsWithTags.push({
            productId,
            shopifyTags: shopifyProduct.tags,
          });
        }
      }
      if (productsWithTags.length > 0) {
        await processProductTags(organizationId, productsWithTags);
      }

      // 9. Batch upsert product mappings
      for (const [shopifyProductId, productId] of allProductIds) {
        const shopifyProduct = shopifyProductsBatch.find(
          p => p.shopifyProductId === shopifyProductId
        );

        if (shopifyProduct) {
          productMappingsToUpsert.push({
            organizationId,
            shopifyProductId,
            shopifyVariantId: null,
            productId,
            productTitle: shopifyProduct.title,
            lastSyncedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }

      if (productMappingsToUpsert.length > 0) {
        console.log(`  Batch upserting ${productMappingsToUpsert.length} product mappings`);
        await db
          .insert(shopifyProductMappings)
          .values(productMappingsToUpsert)
          .onConflictDoUpdate({
            target: [
              shopifyProductMappings.organizationId,
              shopifyProductMappings.shopifyProductId,
              shopifyProductMappings.shopifyVariantId,
            ],
            set: {
              productId: sql`excluded.product_id`,
              productTitle: sql`excluded.product_title`,
              lastSyncedAt: sql`excluded.last_synced_at`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
      }

      results.success += shopifyProductsBatch.length;
      const actualChanges = productsToInsert.length + productsToUpdate.length;
      console.log(`  Batch ${batchNumber} complete: ${actualChanges} changes (${productsToInsert.length} new, ${productsToUpdate.length} updated, ${skippedCount} unchanged)`);

    } catch (error) {
      console.error(`Error processing batch ${batchNumber}:`, error);
      results.failed += batchIds.length;
      results.errors.push({
        productId: `batch_${batchNumber}`,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  console.log(
    `Optimized batch sync complete: ${results.success} succeeded, ${results.failed} failed`
  );
  return results;
}

/**
 * Batch sync variants for a set of products
 */
async function syncVariantsBatch(
  organizationId: string,
  variants: any[],
  productIdMap: Map<string, string>,
  shopifyProductsBatch: any[]
): Promise<void> {
  if (variants.length === 0) return;

  // Check existing variants - handle empty array case
  const variantIds = variants.map(v => v.shopifyVariantId).filter(id => id);

  let existingVariants: any[] = [];
  if (variantIds.length > 0) {
    existingVariants = await db
      .select({
        id: productVariants.id,
        shopifyVariantId: productVariants.shopifyVariantId,
        name: productVariants.name,
        sku: productVariants.sku,
        barcode: productVariants.barcode,
        price: productVariants.price,
        compareAtPrice: productVariants.compareAtPrice,
        option1Value: productVariants.option1Value,
        option2Value: productVariants.option2Value,
        option3Value: productVariants.option3Value,
        inventoryQuantity: productVariants.inventoryQuantity,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.organizationId, organizationId),
          inArray(productVariants.shopifyVariantId, variantIds)
        )
      );
  }

  const existingVariantMap = new Map(
    existingVariants.map(v => [v.shopifyVariantId!, v])
  );

  const variantsToInsert: any[] = [];
  const variantsToUpdate: any[] = [];
  const variantMappingsToUpsert: any[] = [];
  let skippedVariants = 0;

  for (const variant of variants) {
    const productId = productIdMap.get(variant.shopifyProductId);
    if (!productId) continue;

    const shopifyProduct = shopifyProductsBatch.find(
      p => p.shopifyProductId === variant.shopifyProductId
    );

    const existingVariant = existingVariantMap.get(variant.shopifyVariantId);
    let wasUpdated = false;

    // Check if update is needed
    if (existingVariant) {
      const needsUpdate =
        existingVariant.name !== (variant.title || "Default") ||
        existingVariant.sku !== variant.sku ||
        existingVariant.barcode !== variant.barcode ||
        existingVariant.price !== (variant.price || "0") ||
        existingVariant.compareAtPrice !== variant.compareAtPrice ||
        existingVariant.option1Value !== variant.option1 ||
        existingVariant.option2Value !== variant.option2 ||
        existingVariant.option3Value !== variant.option3 ||
        existingVariant.inventoryQuantity !== (variant.inventoryQuantity || 0);

      if (needsUpdate) {
        wasUpdated = true;
        variantsToUpdate.push({
          id: existingVariant.id,
          organizationId,
          productId,
          shopifyVariantId: variant.shopifyVariantId,
          name: variant.title || "Default",
          sku: variant.sku,
          barcode: variant.barcode,
          price: variant.price || "0",
          compareAtPrice: variant.compareAtPrice,
          costPerUnit: variant.inventoryItem?.cost,
          option1Name: "Size",
          option1Value: variant.option1,
          option2Name: variant.option2 ? "Color" : undefined,
          option2Value: variant.option2,
          option3Name: variant.option3 ? "Style" : undefined,
          option3Value: variant.option3,
          weight: variant.weight,
          weightUnit: variant.weightUnit,
          trackInventory: variant.inventoryItem?.tracked || false,
          inventoryQuantity: variant.inventoryQuantity || 0,
          sortOrder: variant.position || 0,
          isDefault: variant.position === 1,
          isActive: true,
          isAvailable: variant.inventoryQuantity > 0,
          metadata: {
            shopifyVariantId: variant.shopifyVariantId,
            shopifyProductId: variant.shopifyProductId,
          },
          updatedAt: new Date(),
        });
      } else {
        skippedVariants++;
      }
    } else {
      // New variant
      wasUpdated = true;
      variantsToInsert.push({
        organizationId,
        productId,
        shopifyVariantId: variant.shopifyVariantId,
        name: variant.title || "Default",
        sku: variant.sku,
        barcode: variant.barcode,
        price: variant.price || "0",
        compareAtPrice: variant.compareAtPrice,
        costPerUnit: variant.inventoryItem?.cost,
        option1Name: "Size",
        option1Value: variant.option1,
        option2Name: variant.option2 ? "Color" : undefined,
        option2Value: variant.option2,
        option3Name: variant.option3 ? "Style" : undefined,
        option3Value: variant.option3,
        weight: variant.weight,
        weightUnit: variant.weightUnit,
        trackInventory: variant.inventoryItem?.tracked || false,
        inventoryQuantity: variant.inventoryQuantity || 0,
        sortOrder: variant.position || 0,
        isDefault: variant.position === 1,
        isActive: true,
        isAvailable: variant.inventoryQuantity > 0,
        metadata: {
          shopifyVariantId: variant.shopifyVariantId,
          shopifyProductId: variant.shopifyProductId,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    // Only add mapping if variant was inserted or updated
    if (wasUpdated) {
      variantMappingsToUpsert.push({
        organizationId,
        shopifyProductId: variant.shopifyProductId,
        shopifyVariantId: variant.shopifyVariantId,
        productId,
        productVariantId: existingVariant?.id || null, // Will be updated after insert
        productTitle: shopifyProduct?.title || "",
        variantTitle: variant.title,
        lastSyncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }

  // Batch insert new variants using upsert to handle duplicates
  let insertedVariants: any[] = [];
  if (variantsToInsert.length > 0) {
    console.log(`    Inserting ${variantsToInsert.length} new variants`);
    // Process variants in smaller batches
    for (let i = 0; i < variantsToInsert.length; i += 50) {
      const batch = variantsToInsert.slice(i, i + 50);
      try {
        const inserted = await db
          .insert(productVariants)
          .values(batch)
          .onConflictDoUpdate({
            target: [productVariants.productId, productVariants.name],
            set: {
              shopifyVariantId: sql`excluded.shopify_variant_id`,
              sku: sql`excluded.sku`,
              barcode: sql`excluded.barcode`,
              price: sql`excluded.price`,
              compareAtPrice: sql`excluded.compare_at_price`,
              costPerUnit: sql`excluded.cost_per_unit`,
              option1Value: sql`excluded.option1_value`,
              option2Name: sql`excluded.option2_name`,
              option2Value: sql`excluded.option2_value`,
              option3Name: sql`excluded.option3_name`,
              option3Value: sql`excluded.option3_value`,
              weight: sql`excluded.weight`,
              weightUnit: sql`excluded.weight_unit`,
              trackInventory: sql`excluded.track_inventory`,
              inventoryQuantity: sql`excluded.inventory_quantity`,
              sortOrder: sql`excluded.sort_order`,
              isDefault: sql`excluded.is_default`,
              isActive: sql`excluded.is_active`,
              isAvailable: sql`excluded.is_available`,
              updatedAt: new Date(),
            },
          })
          .returning({
            id: productVariants.id,
            shopifyVariantId: productVariants.shopifyVariantId
          });
        insertedVariants.push(...inserted);
      } catch (error) {
        console.error(`Error inserting variant batch:`, error);
        // Continue with next batch even if one fails
      }
    }

    // Update mappings with new variant IDs
    for (const variant of insertedVariants) {
      const mapping = variantMappingsToUpsert.find(
        m => m.shopifyVariantId === variant.shopifyVariantId
      );
      if (mapping) {
        mapping.productVariantId = variant.id;
      }
    }
  }

  // Batch update changed variants
  if (variantsToUpdate.length > 0) {
    console.log(`    Updating ${variantsToUpdate.length} changed variants`);
    // Update variants one by one
    for (const variant of variantsToUpdate) {
      await db
        .update(productVariants)
        .set(variant)
        .where(eq(productVariants.id, variant.id));
    }
  }

  if (skippedVariants > 0) {
    console.log(`    Skipped ${skippedVariants} unchanged variants`);
  }

  // Batch upsert variant mappings
  if (variantMappingsToUpsert.length > 0) {
    console.log(`    Batch upserting ${variantMappingsToUpsert.length} variant mappings`);
    await db
      .insert(shopifyProductMappings)
      .values(variantMappingsToUpsert)
      .onConflictDoUpdate({
        target: [
          shopifyProductMappings.organizationId,
          shopifyProductMappings.shopifyProductId,
          shopifyProductMappings.shopifyVariantId,
        ],
        set: {
          productId: sql`excluded.product_id`,
          productVariantId: sql`excluded.product_variant_id`,
          productTitle: sql`excluded.product_title`,
          variantTitle: sql`excluded.variant_title`,
          lastSyncedAt: sql`excluded.last_synced_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  const totalVariantChanges = variantsToInsert.length + variantsToUpdate.length;
  console.log(
    `    Variants batch complete: ${totalVariantChanges} changes (${variantsToInsert.length} new, ${variantsToUpdate.length} updated, ${skippedVariants} unchanged)`
  );
}

/**
 * Process Shopify tags and link them to products via polymorphic tags system
 * This function handles get-or-create for tags and links them to products
 */
// Tag processing moved to shared utility: lib/sync/process-product-tags.ts