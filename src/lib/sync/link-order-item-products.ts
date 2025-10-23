/**
 * Link order items to internal products and product variants
 *
 * This handles batch linking of order items to the internal products system
 * based on Shopify product/variant IDs stored during order sync.
 */

import { getDatabaseForEnvironment } from '../../config/database';
import { orderItems, products, productVariants } from '../../db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { logger } from '../utils/logger';

interface LinkingResult {
  totalItems: number;
  linkedProducts: number;
  linkedVariants: number;
  notFound: number;
}

/**
 * Link order items to products and product variants
 *
 * @param orderIds - Array of internal order IDs to process
 * @param organizationId - Organization ID for filtering
 * @param environment - Database environment (staging/production)
 */
export async function linkOrderItemsToProducts(
  orderIds: string[],
  organizationId: string,
  environment: 'dev' | 'staging' | 'production' = 'production'
): Promise<LinkingResult> {
  const db = getDatabaseForEnvironment(environment);

  const result: LinkingResult = {
    totalItems: 0,
    linkedProducts: 0,
    linkedVariants: 0,
    notFound: 0,
  };

  if (orderIds.length === 0) {
    return result;
  }

  logger.info({ orderCount: orderIds.length }, 'Starting order items product linking');

  try {
    // 1. Fetch all order items for these orders
    const items = await db
      .select()
      .from(orderItems)
      .where(
        and(
          eq(orderItems.organizationId, organizationId),
          inArray(orderItems.orderId, orderIds)
        )
      );

    result.totalItems = items.length;

    if (items.length === 0) {
      logger.info('No order items found for linking');
      return result;
    }

    // 2. Get unique Shopify product and variant IDs
    const shopifyProductIds = [...new Set(
      items
        .map(item => item.shopifyProductId)
        .filter((id): id is string => id !== null)
    )];

    const shopifyVariantIds = [...new Set(
      items
        .map(item => item.shopifyVariantId)
        .filter((id): id is string => id !== null)
    )];

    logger.info({
      uniqueProducts: shopifyProductIds.length,
      uniqueVariants: shopifyVariantIds.length,
    }, 'Found unique Shopify IDs to link');

    // 3. Fetch matching products from internal products table
    const productMap = new Map<string, { id: string; type: string; recipeId: string | null }>();

    if (shopifyProductIds.length > 0) {
      const matchedProducts = await db
        .select({
          id: products.id,
          shopifyProductId: products.shopifyProductId,
          type: products.type,
          recipeId: products.recipeId,
        })
        .from(products)
        .where(
          and(
            eq(products.organizationId, organizationId),
            inArray(products.shopifyProductId, shopifyProductIds)
          )
        );

      matchedProducts.forEach(p => {
        if (p.shopifyProductId) {
          productMap.set(p.shopifyProductId, {
            id: p.id,
            type: p.type,
            recipeId: p.recipeId,
          });
        }
      });

      logger.info({ matchedProducts: matchedProducts.length }, 'Matched products from internal table');
    }

    // 4. Fetch matching product variants from internal product_variants table
    const variantMap = new Map<string, { id: string; productId: string }>();

    if (shopifyVariantIds.length > 0) {
      const matchedVariants = await db
        .select({
          id: productVariants.id,
          shopifyVariantId: productVariants.shopifyVariantId,
          productId: productVariants.productId,
        })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.organizationId, organizationId),
            inArray(productVariants.shopifyVariantId, shopifyVariantIds)
          )
        );

      matchedVariants.forEach(v => {
        if (v.shopifyVariantId) {
          variantMap.set(v.shopifyVariantId, {
            id: v.id,
            productId: v.productId,
          });
        }
      });

      logger.info({ matchedVariants: matchedVariants.length }, 'Matched variants from internal table');
    }

    // 5. Prepare batch updates
    const itemsToUpdate: Array<{
      id: string;
      productId: string | null;
      productVariantId: string | null;
      itemType: string;
      recipeId: string | null;
    }> = [];

    for (const item of items) {
      let productId: string | null = null;
      let productVariantId: string | null = null;
      let itemType: string = 'custom';
      let recipeId: string | null = null;

      // Try to match by variant first (most specific)
      if (item.shopifyVariantId) {
        const variant = variantMap.get(item.shopifyVariantId);
        if (variant) {
          productVariantId = variant.id;
          productId = variant.productId;

          // Get product details for type and recipe
          const productIdStr = item.shopifyProductId;
          if (productIdStr) {
            const product = productMap.get(productIdStr);
            if (product) {
              itemType = product.type;
              recipeId = product.recipeId;
            }
          }

          result.linkedVariants++;
        }
      }

      // If no variant match, try product-level match
      if (!productId && item.shopifyProductId) {
        const product = productMap.get(item.shopifyProductId);
        if (product) {
          productId = product.id;
          itemType = product.type;
          recipeId = product.recipeId;
          result.linkedProducts++;
        }
      }

      // Track items that couldn't be linked
      if (!productId && !productVariantId) {
        result.notFound++;
      }

      // Only update if we found something to link
      if (productId || productVariantId) {
        itemsToUpdate.push({
          id: item.id,
          productId,
          productVariantId,
          itemType,
          recipeId,
        });
      }
    }

    // 6. Batch update order items with SQL for performance
    if (itemsToUpdate.length > 0) {
      // Create a VALUES clause for bulk update
      const values = itemsToUpdate.map(item =>
        sql`(${item.id}::uuid, ${item.productId}::uuid, ${item.productVariantId}::uuid, ${item.itemType}, ${item.recipeId}::uuid)`
      );

      await db.execute(sql`
        UPDATE ${orderItems}
        SET
          product_id = v.product_id,
          product_variant_id = v.product_variant_id,
          item_type = v.item_type,
          recipe_id = v.recipe_id,
          updated_at = NOW()
        FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, product_id, product_variant_id, item_type, recipe_id)
        WHERE ${orderItems.id} = v.id::uuid
      `);

      logger.info({
        updated: itemsToUpdate.length,
        linkedProducts: result.linkedProducts,
        linkedVariants: result.linkedVariants,
        notFound: result.notFound,
      }, 'Batch updated order items with product links');
    } else {
      logger.warn('No order items could be linked to products');
    }

    return result;
  } catch (error) {
    logger.error({ error, organizationId }, 'Failed to link order items to products');
    throw error;
  }
}
