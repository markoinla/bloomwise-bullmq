/**
 * Shared utility for processing Shopify product tags
 * and converting them to polymorphic tags system
 */

import { db } from "@/db/drizzle";
import { tags, taggables } from "@/db/schema";
import { eq, and, inArray, sql } from "drizzle-orm";

interface ProductWithTags {
  productId: string;
  shopifyTags: string;
}

/**
 * Process Shopify tags for products and create polymorphic tag relationships
 * @param organizationId The organization ID
 * @param productsWithTags Array of products with their Shopify tags
 */
export async function processProductTags(
  organizationId: string,
  productsWithTags: ProductWithTags[]
): Promise<void> {
  if (productsWithTags.length === 0) {
    return;
  }

  // Parse and collect all unique tag names
  // Keep both original and normalized versions for proper lookup
  const tagNamesMap = new Map<string, string>(); // normalized -> original
  const productTagMap = new Map<string, string[]>(); // productId -> normalized tag names

  for (const { productId, shopifyTags } of productsWithTags) {
    if (!shopifyTags) continue;

    const tagNames = shopifyTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const normalizedTagNames = tagNames.map((name) => {
      const normalized = name.toLowerCase();
      // Store the original form for display (keep the first occurrence)
      if (!tagNamesMap.has(normalized)) {
        tagNamesMap.set(normalized, name);
      }
      return normalized;
    });

    if (normalizedTagNames.length > 0) {
      productTagMap.set(productId, normalizedTagNames);
    }
  }

  if (tagNamesMap.size === 0) {
    console.log("  No tags to process");
    return;
  }

  const allNormalizedTagNames = Array.from(tagNamesMap.keys());
  console.log(`  Processing ${allNormalizedTagNames.length} unique tags for ${productsWithTags.length} products`);

  // Fetch existing tags for this organization
  const existingTags = await db
    .select()
    .from(tags)
    .where(
      and(
        eq(tags.organizationId, organizationId),
        inArray(tags.name, allNormalizedTagNames)
      )
    );

  const existingTagMap = new Map(
    existingTags.map((tag) => [tag.name, tag.id])
  );

  // Create missing tags
  const missingNormalizedTagNames = allNormalizedTagNames.filter(
    (name) => !existingTagMap.has(name)
  );

  if (missingNormalizedTagNames.length > 0) {
    console.log(`  Creating ${missingNormalizedTagNames.length} new tags`);
    const newTags = await db
      .insert(tags)
      .values(
        missingNormalizedTagNames.map((normalizedName) => ({
          organizationId,
          name: normalizedName, // normalized lowercase
          displayName: tagNamesMap.get(normalizedName) || normalizedName, // original casing for display
          color: null,
          description: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }))
      )
      .returning();

    // Add newly created tags to the map
    newTags.forEach((tag) => {
      existingTagMap.set(tag.name, tag.id);
    });
  }

  // Prepare taggables (product-tag relationships)
  const taggablesToInsert: Array<{
    organizationId: string;
    tagId: string;
    taggableType: "product";
    taggableId: string;
  }> = [];

  for (const [productId, tagNames] of productTagMap.entries()) {
    for (const tagName of tagNames) {
      const tagId = existingTagMap.get(tagName);
      if (tagId) {
        taggablesToInsert.push({
          organizationId,
          tagId,
          taggableType: "product",
          taggableId: productId,
        });
      }
    }
  }

  if (taggablesToInsert.length === 0) {
    console.log("  No taggables to insert");
    return;
  }

  console.log(`  Linking ${taggablesToInsert.length} product-tag relationships`);

  // Insert taggables with conflict handling
  await db
    .insert(taggables)
    .values(taggablesToInsert)
    .onConflictDoNothing();

  // Update usage counts for all affected tags
  const affectedTagIds = Array.from(
    new Set(taggablesToInsert.map((t) => t.tagId))
  );

  console.log(`  Updating usage counts for ${affectedTagIds.length} tags`);

  for (const tagId of affectedTagIds) {
    await db
      .update(tags)
      .set({
        usageCount: sql`(
          SELECT COUNT(*)
          FROM ${taggables}
          WHERE ${taggables.tagId} = ${tagId}
        )`,
        updatedAt: new Date(),
      })
      .where(eq(tags.id, tagId));
  }

  console.log(`  ✓ Tag processing complete`);
}
