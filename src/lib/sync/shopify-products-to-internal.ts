/**
 * Sync Shopify Products to Internal Products
 *
 * Similar to how we sync shopifyOrders → orders,
 * this syncs shopifyProducts → products and shopifyVariants → productVariants
 */

import { db } from "@/db/drizzle";
import {
  shopifyProducts,
  shopifyVariants,
  products,
  productVariants,
  shopifyProductMappings,
  recipes,
} from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { processProductTags } from "./process-product-tags";

interface SyncProductToInternalResult {
  success: boolean;
  productId?: string;
  variantIds?: string[];
  error?: string;
}

/**
 * Sync a Shopify product to the internal products table
 * Creates or updates the product and its variants
 */
export async function syncShopifyProductToInternal(
  organizationId: string,
  shopifyProductId: string
): Promise<SyncProductToInternalResult> {
  try {
    // 1. Fetch the Shopify product
    const [shopifyProduct] = await db
      .select()
      .from(shopifyProducts)
      .where(
        and(
          eq(shopifyProducts.organizationId, organizationId),
          eq(shopifyProducts.shopifyProductId, shopifyProductId)
        )
      )
      .limit(1);

    if (!shopifyProduct) {
      return {
        success: false,
        error: `Shopify product ${shopifyProductId} not found`,
      };
    }

    // 2. Check if we already have a mapping to a recipe
    const [existingMapping] = await db
      .select()
      .from(shopifyProductMappings)
      .where(
        and(
          eq(shopifyProductMappings.organizationId, organizationId),
          eq(shopifyProductMappings.shopifyProductId, shopifyProductId)
        )
      )
      .limit(1);

    let recipeId: string | null = null;
    if (existingMapping?.recipeId) {
      // Verify the recipe still exists
      const [recipe] = await db
        .select({ id: recipes.id })
        .from(recipes)
        .where(eq(recipes.id, existingMapping.recipeId))
        .limit(1);

      if (recipe) {
        recipeId = recipe.id;
      }
    }

    // 3. Create or update the internal product
    const productData = {
      organizationId,
      // Use Shopify's product_type as our type (flexible per organization)
      type: shopifyProduct.productType || 'custom',
      recipeId: recipeId || undefined,
      name: shopifyProduct.title,
      description: shopifyProduct.bodyHtml || undefined,
      sku: null, // Will be set from first variant
      price: "0", // Will be updated from first variant
      shopifyProductId: shopifyProductId,
      primaryImageUrl: shopifyProduct.featuredImage || undefined,
      imageUrls: shopifyProduct.allImages || undefined,
      handle: shopifyProduct.handle || undefined,
      category: undefined, // Reserved for internal categorization if needed
      tags: shopifyProduct.tags?.split(",").map(t => t.trim()).filter(Boolean) || [],
      isActive: shopifyProduct.status === 'active',
      isPublished: shopifyProduct.publishedAt != null,
      publishedAt: shopifyProduct.publishedAt || undefined,
      requiresShipping: true, // Default for physical products
      isPhysicalProduct: true,
      isTaxable: true,
      isSubscriptionEligible: true, // Can be updated manually
      subscriptionIntervals: ['weekly', 'biweekly', 'monthly'] as string[],
      externalProductId: shopifyProductId,
      externalPlatform: 'shopify' as const,
    };

    // Check if product already exists
    const [existingProduct] = await db
      .select()
      .from(products)
      .where(
        and(
          eq(products.organizationId, organizationId),
          eq(products.shopifyProductId, shopifyProductId)
        )
      )
      .limit(1);

    let internalProduct;

    if (existingProduct) {
      // Update existing product
      [internalProduct] = await db
        .update(products)
        .set({
          ...productData,
          updatedAt: new Date(),
        })
        .where(eq(products.id, existingProduct.id))
        .returning();

      console.log(`Updated internal product ${internalProduct.id} from Shopify product ${shopifyProductId}`);
    } else {
      // Create new product
      [internalProduct] = await db
        .insert(products)
        .values({
          ...productData,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      console.log(`Created internal product ${internalProduct.id} from Shopify product ${shopifyProductId}`);
    }

    // 4. Update shopifyProductMappings
    await db
      .insert(shopifyProductMappings)
      .values({
        organizationId,
        shopifyProductId,
        shopifyVariantId: null, // Product-level mapping, no variant
        productId: internalProduct.id,
        recipeId: recipeId || undefined,
        productTitle: shopifyProduct.title,
        lastSyncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          shopifyProductMappings.organizationId,
          shopifyProductMappings.shopifyProductId,
          shopifyProductMappings.shopifyVariantId,
        ],
        set: {
          productId: internalProduct.id,
          productTitle: shopifyProduct.title,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        },
      });

    // 5. Sync variants
    const variantIds = await syncShopifyVariantsToInternal(
      organizationId,
      shopifyProductId,
      internalProduct.id
    );

    // 6. Process tags (convert Shopify tags to polymorphic tags)
    if (shopifyProduct.tags) {
      await processProductTags(organizationId, [
        {
          productId: internalProduct.id,
          shopifyTags: shopifyProduct.tags,
        },
      ]);
    }

    return {
      success: true,
      productId: internalProduct.id,
      variantIds,
    };
  } catch (error) {
    console.error(`Error syncing Shopify product ${shopifyProductId} to internal:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Sync Shopify variants to internal product variants
 */
async function syncShopifyVariantsToInternal(
  organizationId: string,
  shopifyProductId: string,
  internalProductId: string
): Promise<string[]> {
  // Fetch all Shopify variants for this product
  const variants = await db
    .select()
    .from(shopifyVariants)
    .where(
      and(
        eq(shopifyVariants.organizationId, organizationId),
        eq(shopifyVariants.shopifyProductId, shopifyProductId)
      )
    );

  if (variants.length === 0) {
    console.log(`No variants found for Shopify product ${shopifyProductId}`);
    return [];
  }

  const createdVariantIds: string[] = [];

  for (const variant of variants) {
    try {
      // Check if this variant is already mapped to an internal product variant
      const [existingVariant] = await db
        .select()
        .from(productVariants)
        .where(
          and(
            eq(productVariants.organizationId, organizationId),
            eq(productVariants.shopifyVariantId, variant.shopifyVariantId)
          )
        )
        .limit(1);

      const variantData = {
        organizationId,
        productId: internalProductId,
        name: variant.title || "Default",
        sku: variant.sku || undefined,
        barcode: variant.barcode || undefined,
        imageUrl: variant.imageSrc || undefined,
        option1Name: variant.option1 ? "Option 1" : undefined,
        option1Value: variant.option1 || undefined,
        option2Name: variant.option2 ? "Option 2" : undefined,
        option2Value: variant.option2 || undefined,
        option3Name: variant.option3 ? "Option 3" : undefined,
        option3Value: variant.option3 || undefined,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice || undefined,
        weight: variant.weight ? parseFloat(variant.weight.toString()) : undefined,
        weightUnit: variant.weightUnit || 'kg',
        shopifyVariantId: variant.shopifyVariantId,
        externalVariantId: variant.shopifyVariantId,
        trackInventory: !!variant.inventoryManagement,
        inventoryQuantity: variant.inventoryQuantity || 0,
        allowBackorder: variant.inventoryPolicy === 'continue',
        sortOrder: variant.position || 0,
        isDefault: variant.position === 1, // First variant is default
        isActive: true,
        isAvailable: (variant.inventoryQuantity || 0) > 0 || variant.inventoryPolicy === 'continue',
      };

      let internalVariant;

      if (existingVariant) {
        // Update existing variant
        [internalVariant] = await db
          .update(productVariants)
          .set({
            ...variantData,
            updatedAt: new Date(),
          })
          .where(eq(productVariants.id, existingVariant.id))
          .returning();

        console.log(`  Updated product variant ${internalVariant.id} from Shopify variant ${variant.shopifyVariantId}`);
      } else {
        // Create new variant
        [internalVariant] = await db
          .insert(productVariants)
          .values({
            ...variantData,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .returning();

        console.log(`  Created product variant ${internalVariant.id} from Shopify variant ${variant.shopifyVariantId}`);
      }

      // Create or update shopifyProductMappings entry for this variant
      await db
        .insert(shopifyProductMappings)
        .values({
          organizationId,
          shopifyProductId,
          shopifyVariantId: variant.shopifyVariantId,
          productId: internalProductId,
          productVariantId: internalVariant.id,
          productTitle: variant.displayName || variant.title,
          variantTitle: variant.title,
          lastSyncedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            shopifyProductMappings.organizationId,
            shopifyProductMappings.shopifyProductId,
            shopifyProductMappings.shopifyVariantId,
          ],
          set: {
            productVariantId: internalVariant.id,
            variantTitle: variant.title,
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
          },
        });

      createdVariantIds.push(internalVariant.id);
    } catch (error) {
      console.error(`  Error syncing variant ${variant.shopifyVariantId}:`, error);
    }
  }

  // Update the first variant's price on the product
  if (variants.length > 0 && variants[0].price) {
    await db
      .update(products)
      .set({
        price: variants[0].price,
        sku: variants[0].sku || undefined,
      })
      .where(eq(products.id, internalProductId));
  }

  console.log(`Synced ${createdVariantIds.length} variants for product ${internalProductId}`);
  return createdVariantIds;
}

/**
 * Batch sync multiple Shopify products to internal products
 */
export async function syncShopifyProductsToInternalBatch(
  organizationId: string,
  shopifyProductIds: string[]
): Promise<{
  success: number;
  failed: number;
  errors: Array<{ productId: string; error: string }>;
}> {
  const results = {
    success: 0,
    failed: 0,
    errors: [] as Array<{ productId: string; error: string }>,
  };

  // Note: This function processes products sequentially.
  // Tag processing is handled within syncShopifyProductToInternal for each product.
  for (const shopifyProductId of shopifyProductIds) {
    const result = await syncShopifyProductToInternal(organizationId, shopifyProductId);

    if (result.success) {
      results.success++;
    } else {
      results.failed++;
      results.errors.push({
        productId: shopifyProductId,
        error: result.error || "Unknown error",
      });
    }
  }

  return results;
}