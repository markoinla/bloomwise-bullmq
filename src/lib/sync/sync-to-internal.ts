/**
 * Sync Shopify products to internal products/productVariants tables
 * Simplified batch version - just copies data with field name mapping
 */

import { db } from '../../config/database';
import { shopifyProducts, shopifyVariants, products, productVariants } from '../../db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { logger } from '../utils/logger';

const BATCH_SIZE = 200;

interface InternalSyncResult {
  productsCreated: number;
  productsUpdated: number;
  variantsCreated: number;
  variantsUpdated: number;
}

/**
 * Sync Shopify products to internal products and productVariants tables
 * Uses batch operations for performance
 */
export async function syncShopifyProductsToInternal(
  organizationId: string,
  shopifyProductIds: string[]
): Promise<InternalSyncResult> {
  const result: InternalSyncResult = {
    productsCreated: 0,
    productsUpdated: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
  };

  logger.info({ count: shopifyProductIds.length }, 'Starting internal products sync');

  // Process in batches
  for (let i = 0; i < shopifyProductIds.length; i += BATCH_SIZE) {
    const batchIds = shopifyProductIds.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;

    try {
      // 1. Fetch Shopify products for this batch
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
        continue;
      }

      // 2. Fetch Shopify variants for these products
      const shopifyVariantsBatch = await db
        .select()
        .from(shopifyVariants)
        .where(
          and(
            eq(shopifyVariants.organizationId, organizationId),
            inArray(shopifyVariants.shopifyProductId, batchIds)
          )
        );

      // 3. Prepare products for batch upsert
      const productsToUpsert = shopifyProductsBatch.map(sp => {
        // Get variants for this product
        const productVariants = shopifyVariantsBatch.filter(
          v => v.shopifyProductId === sp.shopifyProductId
        );

        // Get min price from variants
        const variantPrices = productVariants
          .map(v => parseFloat(v.price || "0"))
          .filter(p => !isNaN(p) && p > 0);
        const minPrice = variantPrices.length > 0 ? Math.min(...variantPrices) : 0;

        // Get images from raw data
        const rawData = sp.rawProductData as any;
        const images = rawData?.images?.edges?.map((e: any) => e.node) ||
                       rawData?.images || [];
        const primaryImage = images.length > 0 ? (images[0]?.url || images[0]?.src) : null;
        const allImageUrls = images.map((img: any) => img.url || img.src).filter(Boolean);

        // Get tags
        const tags = sp.tags ? sp.tags.split(",").map((t: string) => t.trim()) : [];

        // Get variant IDs
        const shopifyVariantIds = productVariants.map(v => v.shopifyVariantId);

        return {
          organization_id: organizationId,
          shopify_product_id: sp.shopifyProductId,
          shopify_variant_ids: shopifyVariantIds,
          type: 'recipe', // Default type for all products
          name: sp.title,
          description: sp.bodyHtml,
          sku: sp.handle, // Use handle as SKU
          handle: sp.handle,
          price: minPrice,
          requires_shipping: true,
          is_physical_product: true,
          is_taxable: true,
          primary_image_url: primaryImage,
          image_urls: allImageUrls,
          category: sp.productType,
          tags,
          is_active: sp.status === 'active',
          is_published: sp.status === 'active' && sp.publishedAt !== null,
          published_at: sp.publishedAt,
          track_inventory: false,
          inventory_quantity: 0,
          allow_backorder: false,
        };
      });

      // 4. Batch upsert products using Drizzle
      if (productsToUpsert.length > 0) {
        try {
          // Map to Drizzle insert format (camelCase)
          const productsForDrizzle = productsToUpsert.map(p => ({
            organizationId: p.organization_id,
            shopifyProductId: p.shopify_product_id,
            shopifyVariantIds: p.shopify_variant_ids,
            type: p.type,
            name: p.name,
            description: p.description,
            sku: p.sku,
            handle: p.handle,
            price: p.price.toString(),
            requiresShipping: p.requires_shipping,
            isPhysicalProduct: p.is_physical_product,
            isTaxable: p.is_taxable,
            primaryImageUrl: p.primary_image_url,
            imageUrls: p.image_urls,
            category: p.category,
            tags: p.tags,
            isActive: p.is_active,
            isPublished: p.is_published,
            publishedAt: p.published_at,
            trackInventory: p.track_inventory,
            inventoryQuantity: p.inventory_quantity,
            allowBackorder: p.allow_backorder,
          }));

          await db
            .insert(products)
            .values(productsForDrizzle)
            .onConflictDoUpdate({
              target: [products.organizationId, products.shopifyProductId],
              set: {
                name: productsForDrizzle[0].name, // Drizzle will use excluded.name
                description: productsForDrizzle[0].description,
                price: productsForDrizzle[0].price,
                primaryImageUrl: productsForDrizzle[0].primaryImageUrl,
                imageUrls: productsForDrizzle[0].imageUrls,
                tags: productsForDrizzle[0].tags,
                isActive: productsForDrizzle[0].isActive,
                isPublished: productsForDrizzle[0].isPublished,
                publishedAt: productsForDrizzle[0].publishedAt,
                updatedAt: new Date(),
              },
            });

          result.productsCreated += productsToUpsert.length;
          logger.info({ batch: batchNumber, count: productsToUpsert.length }, 'Batch upserted products to internal');
        } catch (error) {
          logger.error({
            error,
            sampleProduct: productsToUpsert[0],
          }, 'Failed to insert products to internal');
          throw error;
        }
      }

      // 5. Fetch internal product IDs we just created/updated
      const internalProducts = await db
        .select({
          id: products.id,
          shopifyProductId: products.shopifyProductId,
        })
        .from(products)
        .where(
          and(
            eq(products.organizationId, organizationId),
            inArray(products.shopifyProductId, batchIds)
          )
        );

      const productIdMap = new Map(
        internalProducts.map(p => [p.shopifyProductId, p.id])
      );

      // 6. Prepare variants for batch upsert
      const variantsToUpsert = shopifyVariantsBatch
        .map(sv => {
          const productId = productIdMap.get(sv.shopifyProductId);
          if (!productId) return null;

          return {
            organization_id: organizationId,
            product_id: productId,
            shopify_variant_id: sv.shopifyVariantId,
            name: sv.variantTitle || sv.title || 'Default',
            sku: sv.sku,
            barcode: sv.barcode,
            price: parseFloat(sv.price || "0"),
            compare_at_price: sv.compareAtPrice ? parseFloat(sv.compareAtPrice) : null,
            weight: sv.weight ? parseFloat(sv.weight) : null,
            weight_unit: sv.weightUnit || 'lb',
            option1_name: sv.option1Name,
            option1_value: sv.option1Value,
            option2_name: sv.option2Name,
            option2_value: sv.option2Value,
            option3_name: sv.option3Name,
            option3_value: sv.option3Value,
            image_url: sv.imageSrc,
            track_inventory: false,
            inventory_quantity: sv.inventoryQuantity || 0,
            allow_backorder: false,
            sort_order: sv.position || 0,
            is_default: sv.position === 1,
            is_active: true,
            is_available: (sv.inventoryQuantity || 0) > 0,
          };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);

      // 7. Batch upsert variants using Drizzle
      if (variantsToUpsert.length > 0) {
        try {
          // Map to Drizzle insert format (camelCase)
          const variantsForDrizzle = variantsToUpsert.map(v => ({
            organizationId: v.organization_id,
            productId: v.product_id,
            shopifyVariantId: v.shopify_variant_id,
            name: v.name,
            sku: v.sku,
            barcode: v.barcode,
            price: v.price.toString(),
            compareAtPrice: v.compare_at_price?.toString(),
            weight: v.weight?.toString(),
            weightUnit: v.weight_unit,
            option1Name: v.option1_name,
            option1Value: v.option1_value,
            option2Name: v.option2_name,
            option2Value: v.option2_value,
            option3Name: v.option3_name,
            option3Value: v.option3_value,
            imageUrl: v.image_url,
            trackInventory: v.track_inventory,
            inventoryQuantity: v.inventory_quantity,
            allowBackorder: v.allow_backorder,
            sortOrder: v.sort_order,
            isDefault: v.is_default,
            isActive: v.is_active,
            isAvailable: v.is_available,
          }));

          await db
            .insert(productVariants)
            .values(variantsForDrizzle)
            .onConflictDoUpdate({
              target: [productVariants.organizationId, productVariants.shopifyVariantId],
              set: {
                name: variantsForDrizzle[0].name,
                sku: variantsForDrizzle[0].sku,
                barcode: variantsForDrizzle[0].barcode,
                price: variantsForDrizzle[0].price,
                compareAtPrice: variantsForDrizzle[0].compareAtPrice,
                weight: variantsForDrizzle[0].weight,
                option1Value: variantsForDrizzle[0].option1Value,
                option2Value: variantsForDrizzle[0].option2Value,
                option3Value: variantsForDrizzle[0].option3Value,
                imageUrl: variantsForDrizzle[0].imageUrl,
                inventoryQuantity: variantsForDrizzle[0].inventoryQuantity,
                isAvailable: variantsForDrizzle[0].isAvailable,
                updatedAt: new Date(),
              },
            });

          result.variantsCreated += variantsToUpsert.length;
          logger.info({ batch: batchNumber, count: variantsToUpsert.length }, 'Batch upserted variants to internal');
        } catch (error) {
          logger.error({
            error,
            sampleVariant: variantsToUpsert[0],
          }, 'Failed to insert variants to internal');
          throw error;
        }
      }

    } catch (error) {
      logger.error({ error, batch: batchNumber }, 'Failed to sync batch to internal');
      throw error;
    }
  }

  logger.info(result, 'Internal products sync completed');
  return result;
}
