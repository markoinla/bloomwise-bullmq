/**
 * Sync Shopify products to internal products/productVariants tables
 * Simplified batch version - just copies data with field name mapping
 */

import { db } from '../../config/database';
import { shopifyProducts, shopifyVariants } from '../../db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
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
          organizationId,
          shopifyProductId: sp.shopifyProductId,
          shopifyVariantIds,
          type: 'recipe', // Default type for all products
          name: sp.title,
          description: sp.bodyHtml,
          sku: sp.handle, // Use handle as SKU
          handle: sp.handle,
          price: minPrice,
          requiresShipping: true,
          isPhysicalProduct: true,
          isTaxable: true,
          primaryImageUrl: primaryImage,
          imageUrls: allImageUrls,
          category: sp.productType,
          tags,
          isActive: sp.status === 'active',
          isPublished: sp.status === 'active' && sp.publishedAt !== null,
          publishedAt: sp.publishedAt,
          trackInventory: false,
          inventoryQuantity: 0,
          allowBackorder: false,
        };
      });

      // 4. Batch upsert products using raw SQL
      if (productsToUpsert.length > 0) {
        await db.execute(sql`
          INSERT INTO products (
            organization_id, shopify_product_id, shopify_variant_ids, type, name, description,
            sku, handle, price, requires_shipping, is_physical_product, is_taxable,
            primary_image_url, image_urls, category, tags,
            is_active, is_published, published_at, track_inventory, inventory_quantity, allow_backorder
          )
          SELECT *
          FROM json_populate_recordset(NULL::products, ${JSON.stringify(productsToUpsert)})
          ON CONFLICT (organization_id, shopify_product_id)
          DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            price = EXCLUDED.price,
            primary_image_url = EXCLUDED.primary_image_url,
            image_urls = EXCLUDED.image_urls,
            tags = EXCLUDED.tags,
            is_active = EXCLUDED.is_active,
            is_published = EXCLUDED.is_published,
            published_at = EXCLUDED.published_at,
            updated_at = NOW()
        `);

        result.productsCreated += productsToUpsert.length;
        logger.info({ batch: batchNumber, count: productsToUpsert.length }, 'Batch upserted products');
      }

      // 5. Fetch internal product IDs we just created/updated
      const internalProducts = await db.execute<{ id: string; shopify_product_id: string }>(sql`
        SELECT id, shopify_product_id
        FROM products
        WHERE organization_id = ${organizationId}
          AND shopify_product_id = ANY(${batchIds})
      `);

      const productIdMap = new Map(
        internalProducts.rows.map(p => [p.shopify_product_id, p.id])
      );

      // 6. Prepare variants for batch upsert
      const variantsToUpsert = shopifyVariantsBatch
        .map(sv => {
          const productId = productIdMap.get(sv.shopifyProductId);
          if (!productId) return null;

          return {
            organizationId,
            productId,
            shopifyVariantId: sv.shopifyVariantId,
            name: sv.variantTitle || sv.title || 'Default',
            sku: sv.sku,
            barcode: sv.barcode,
            price: parseFloat(sv.price || "0"),
            compareAtPrice: sv.compareAtPrice ? parseFloat(sv.compareAtPrice) : null,
            weight: sv.weight ? parseFloat(sv.weight) : null,
            weightUnit: sv.weightUnit || 'lb',
            option1Name: sv.option1Name,
            option1Value: sv.option1Value,
            option2Name: sv.option2Name,
            option2Value: sv.option2Value,
            option3Name: sv.option3Name,
            option3Value: sv.option3Value,
            imageUrl: sv.imageSrc,
            trackInventory: false,
            inventoryQuantity: sv.inventoryQuantity || 0,
            allowBackorder: false,
            sortOrder: sv.position || 0,
            isDefault: sv.position === 1,
            isActive: true,
            isAvailable: (sv.inventoryQuantity || 0) > 0,
          };
        })
        .filter(Boolean);

      // 7. Batch upsert variants using raw SQL
      if (variantsToUpsert.length > 0) {
        await db.execute(sql`
          INSERT INTO product_variants (
            organization_id, product_id, shopify_variant_id, name, sku, barcode,
            price, compare_at_price, weight, weight_unit,
            option1_name, option1_value, option2_name, option2_value, option3_name, option3_value,
            image_url, track_inventory, inventory_quantity, allow_backorder,
            sort_order, is_default, is_active, is_available
          )
          SELECT *
          FROM json_populate_recordset(NULL::product_variants, ${JSON.stringify(variantsToUpsert)})
          ON CONFLICT (organization_id, shopify_variant_id)
          DO UPDATE SET
            name = EXCLUDED.name,
            sku = EXCLUDED.sku,
            barcode = EXCLUDED.barcode,
            price = EXCLUDED.price,
            compare_at_price = EXCLUDED.compare_at_price,
            weight = EXCLUDED.weight,
            option1_value = EXCLUDED.option1_value,
            option2_value = EXCLUDED.option2_value,
            option3_value = EXCLUDED.option3_value,
            image_url = EXCLUDED.image_url,
            inventory_quantity = EXCLUDED.inventory_quantity,
            is_available = EXCLUDED.is_available,
            updated_at = NOW()
        `);

        result.variantsCreated += variantsToUpsert.length;
        logger.info({ batch: batchNumber, count: variantsToUpsert.length }, 'Batch upserted variants');
      }

    } catch (error) {
      logger.error({ error, batch: batchNumber }, 'Failed to sync batch to internal');
      throw error;
    }
  }

  logger.info(result, 'Internal products sync completed');
  return result;
}
