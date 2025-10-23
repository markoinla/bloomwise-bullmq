/**
 * Sync Shopify products to internal products/productVariants tables
 * Simplified batch version - just copies data with field name mapping
 */

import { getDatabaseForEnvironment } from '../../config/database';
import { shopifyProducts, shopifyVariants, products } from '../../db/schema';
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
  shopifyProductIds: string[],
  environment: 'dev' | 'staging' | 'production' = 'production'
): Promise<InternalSyncResult> {
  const db = getDatabaseForEnvironment(environment);
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

        // Map Shopify productType to internal type
        const productType = sp.productType?.toLowerCase() || 'recipe';

        return {
          organization_id: organizationId,
          shopify_product_id: sp.shopifyProductId,
          shopify_variant_ids: shopifyVariantIds,
          type: productType,
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
          is_active: sp.status?.toLowerCase() === 'active',
          is_published: sp.status?.toLowerCase() === 'active' && sp.publishedAt !== null,
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
                type: sql`excluded.type`,
                name: sql`excluded.name`,
                description: sql`excluded.description`,
                price: sql`excluded.price`,
                category: sql`excluded.category`,
                primaryImageUrl: sql`excluded.primary_image_url`,
                imageUrls: sql`excluded.image_urls`,
                tags: sql`excluded.tags`,
                isActive: sql`excluded.is_active`,
                isPublished: sql`excluded.is_published`,
                publishedAt: sql`excluded.published_at`,
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

      // 7. Batch upsert variants using optimized approach
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

          // De-duplicate by (product_id, name) within the batch to avoid constraint violations
          // Keep the first occurrence of each (product_id, name) combo
          const seenProductNames = new Set<string>();
          const deduplicatedVariants = variantsForDrizzle.filter(v => {
            const key = `${v.productId}:${v.name}`;
            if (seenProductNames.has(key)) {
              logger.warn({ productId: v.productId, name: v.name }, 'Skipping duplicate variant name within batch');
              return false;
            }
            seenProductNames.add(key);
            return true;
          });

          // Use raw SQL with INSERT ... ON CONFLICT that can handle the (product_id, name) constraint
          // by first deleting old variants with same (product_id, name) before inserting
          const variantsJson = JSON.stringify(deduplicatedVariants).replace(/'/g, "''");

          // Step 1: Delete any existing variants that would conflict on (product_id, name)
          await db.execute(sql.raw(`
            DELETE FROM product_variants
            WHERE (product_id, name) IN (
              SELECT
                (v->>'productId')::uuid,
                v->>'name'
              FROM jsonb_array_elements('${variantsJson}'::jsonb) AS v
            )
            AND organization_id = '${organizationId}'
            AND shopify_variant_id NOT IN (
              SELECT v->>'shopifyVariantId'
              FROM jsonb_array_elements('${variantsJson}'::jsonb) AS v
            )
          `));

          // Step 2: Insert with conflict resolution on shopify_variant_id
          await db.execute(sql.raw(`
            INSERT INTO product_variants (
              organization_id, product_id, shopify_variant_id, name, sku, barcode,
              price, compare_at_price, weight, weight_unit,
              option1_name, option1_value, option2_name, option2_value, option3_name, option3_value,
              image_url, track_inventory, inventory_quantity, allow_backorder,
              sort_order, is_default, is_active, is_available
            )
            SELECT
              (v->>'organizationId')::uuid,
              (v->>'productId')::uuid,
              v->>'shopifyVariantId',
              v->>'name',
              v->>'sku',
              v->>'barcode',
              (v->>'price')::numeric,
              (v->>'compareAtPrice')::numeric,
              (v->>'weight')::numeric,
              v->>'weightUnit',
              v->>'option1Name',
              v->>'option1Value',
              v->>'option2Name',
              v->>'option2Value',
              v->>'option3Name',
              v->>'option3Value',
              v->>'imageUrl',
              (v->>'trackInventory')::boolean,
              (v->>'inventoryQuantity')::integer,
              (v->>'allowBackorder')::boolean,
              (v->>'sortOrder')::integer,
              (v->>'isDefault')::boolean,
              (v->>'isActive')::boolean,
              (v->>'isAvailable')::boolean
            FROM jsonb_array_elements('${variantsJson}'::jsonb) AS v
            ON CONFLICT (organization_id, shopify_variant_id)
            DO UPDATE SET
              product_id = EXCLUDED.product_id,
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
          `));

          result.variantsCreated += deduplicatedVariants.length;
          logger.info({
            batch: batchNumber,
            count: deduplicatedVariants.length,
            skipped: variantsToUpsert.length - deduplicatedVariants.length
          }, 'Batch upserted variants to internal');
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
