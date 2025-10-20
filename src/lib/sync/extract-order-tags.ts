/**
 * Extract and insert tags from Shopify orders
 *
 * This handles:
 * - Parsing Shopify tags (comma-separated string)
 * - Creating tags if they don't exist
 * - Linking tags to orders via taggables table
 * - Updating tag usage counts
 */

import { getDatabaseForEnvironment } from '../../config/database';
import { tags, taggables } from '../../db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { logger } from '../utils/logger';

interface OrderWithTags {
  internalOrderId: string;
  shopifyTags: string | null;
}

interface ExtractTagsOptions {
  organizationId: string;
  orders: OrderWithTags[];
  environment?: 'staging' | 'production';
}

export async function extractAndInsertOrderTags(options: ExtractTagsOptions): Promise<{
  success: boolean;
  tagsCreated: number;
  tagsLinked: number;
  errors: string[];
}> {
  const { organizationId, orders, environment = 'production' } = options;
  const db = getDatabaseForEnvironment(environment);

  const result = {
    success: true,
    tagsCreated: 0,
    tagsLinked: 0,
    errors: [] as string[],
  };

  // Filter orders that have tags
  const ordersWithTags = orders.filter(o => o.shopifyTags && o.shopifyTags.trim().length > 0);

  if (ordersWithTags.length === 0) {
    return result;
  }

  try {
    // Parse all unique tag names from Shopify tags
    const allTagNames = new Set<string>();
    const orderTagMap = new Map<string, string[]>();

    for (const { internalOrderId, shopifyTags } of ordersWithTags) {
      // Shopify tags are comma-separated
      const tagList = shopifyTags!
        .split(',')
        .map(tag => tag.trim())
        .filter(tag => tag.length > 0);

      if (tagList.length > 0) {
        orderTagMap.set(internalOrderId, tagList);
        tagList.forEach(tag => allTagNames.add(tag));
      }
    }

    if (allTagNames.size === 0) {
      return result;
    }

    logger.info(
      { count: allTagNames.size, organizationId },
      'Processing unique tags from Shopify'
    );

    // Normalize tag names for lookup (lowercase)
    const normalizedTagNames = Array.from(allTagNames).map(name => name.toLowerCase());

    // Check which tags already exist
    const existingTags = await db
      .select()
      .from(tags)
      .where(
        and(
          eq(tags.organizationId, organizationId),
          inArray(tags.name, normalizedTagNames)
        )
      );

    const existingTagMap = new Map(
      existingTags.map(tag => [tag.name, tag])
    );

    logger.info(
      { existing: existingTags.length, total: allTagNames.size },
      'Found existing tags'
    );

    // Create missing tags
    const tagsToCreate = Array.from(allTagNames)
      .filter(tagName => !existingTagMap.has(tagName.toLowerCase()))
      .map(tagName => ({
        organizationId,
        name: tagName.toLowerCase(),
        displayName: tagName, // Keep original case for display
        description: 'Imported from Shopify',
        usageCount: 0,
        isSystemTag: false,
      }));

    if (tagsToCreate.length > 0) {
      logger.info(
        { count: tagsToCreate.length, organizationId },
        'Creating new tags from Shopify'
      );

      const newTags = await db
        .insert(tags)
        .values(tagsToCreate)
        .returning();

      result.tagsCreated = newTags.length;

      // Add new tags to the map
      newTags.forEach(tag => {
        existingTagMap.set(tag.name, tag);
      });
    }

    // Now link tags to orders via taggables table
    const taggablesToInsert: Array<{
      tagId: string;
      taggableType: 'order';
      taggableId: string;
      createdAt: Date;
    }> = [];

    orderTagMap.forEach((tagNames, orderId) => {
      tagNames.forEach(tagName => {
        const tag = existingTagMap.get(tagName.toLowerCase());
        if (tag) {
          taggablesToInsert.push({
            tagId: tag.id,
            taggableType: 'order',
            taggableId: orderId,
            createdAt: new Date(),
          });
        } else {
          logger.warn(
            { tagName, orderId, organizationId },
            'Tag not found in map after creation'
          );
        }
      });
    });

    if (taggablesToInsert.length > 0) {
      logger.info(
        { count: taggablesToInsert.length, organizationId },
        'Linking tags to orders'
      );

      // Use insert with onConflictDoNothing to avoid duplicate tag assignments
      await db
        .insert(taggables)
        .values(taggablesToInsert)
        .onConflictDoNothing();

      result.tagsLinked = taggablesToInsert.length;

      // Update usage counts for tags
      const tagIds = Array.from(new Set(taggablesToInsert.map(t => t.tagId)));

      // Batch update usage counts by recalculating from taggables
      await Promise.all(
        tagIds.map(tagId =>
          db
            .update(tags)
            .set({
              usageCount: sql`(
                SELECT COUNT(*)
                FROM ${taggables}
                WHERE ${taggables.tagId} = ${tagId}
              )`,
              updatedAt: new Date(),
            })
            .where(eq(tags.id, tagId))
        )
      );

      logger.info(
        { tagCount: tagIds.length, organizationId },
        'Updated tag usage counts'
      );
    }

    logger.info(
      {
        tagsCreated: result.tagsCreated,
        tagsLinked: result.tagsLinked,
        organizationId,
      },
      'Successfully processed Shopify tags for orders'
    );

    return result;
  } catch (error) {
    logger.error({ error, organizationId }, 'Failed to extract and insert order tags');
    result.success = false;
    result.errors.push(error instanceof Error ? error.message : 'Unknown error');
    return result;
  }
}
