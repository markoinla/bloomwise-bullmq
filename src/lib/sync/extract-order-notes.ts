/**
 * Extract and insert notes from Shopify orders
 *
 * This handles:
 * - Order-level notes from `order.note` field
 * - Note attributes from `order.note_attributes`
 * - Line item properties that should be surfaced as notes
 */

import { getDatabaseForEnvironment } from '../../config/database';
import { notes, orderItems } from '../../db/schema';
import { eq, and, inArray, or } from 'drizzle-orm';
import { logger } from '../utils/logger';

interface OrderWithShopifyData {
  internalOrderId: string;
  shopifyOrder: any;
  shopifyCreatedAt: Date;
}

interface ExtractNotesOptions {
  organizationId: string;
  orders: OrderWithShopifyData[];
  environment?: 'dev' | 'staging' | 'production';
}

export async function extractAndInsertOrderNotes(options: ExtractNotesOptions): Promise<{
  success: boolean;
  notesCreated: number;
  errors: string[];
}> {
  const { organizationId, orders, environment = 'production' } = options;
  const db = getDatabaseForEnvironment(environment);

  const result = {
    success: true,
    notesCreated: 0,
    errors: [] as string[],
  };

  if (orders.length === 0) {
    return result;
  }

  try {
    // Step 1: Delete existing notes from Shopify for these orders
    // This prevents duplicates when orders are re-synced
    const orderIds = orders.map(o => o.internalOrderId);

    if (orderIds.length > 0) {
      // Get all order item IDs for these orders to delete their notes too
      const orderItemsForOrders = await db
        .select({ id: orderItems.id, orderId: orderItems.orderId })
        .from(orderItems)
        .where(inArray(orderItems.orderId, orderIds));

      const orderItemIds = orderItemsForOrders.map(oi => oi.id);

      // Build delete conditions
      const deleteConditions = [];

      // Delete order-level notes from Shopify
      deleteConditions.push(
        and(
          eq(notes.noteSource, 'shopify'),
          eq(notes.entityType, 'order'),
          inArray(notes.entityId, orderIds)
        )
      );

      // Delete order item-level notes from Shopify
      if (orderItemIds.length > 0) {
        deleteConditions.push(
          and(
            eq(notes.noteSource, 'shopify'),
            eq(notes.entityType, 'orderItem'),
            inArray(notes.entityId, orderItemIds)
          )
        );
      }

      // Execute delete
      await db
        .delete(notes)
        .where(or(...deleteConditions));

      logger.info(
        { orderCount: orderIds.length, orderItemCount: orderItemIds.length },
        'Deleted existing Shopify notes before re-sync'
      );
    }

    // Step 2: Extract notes from Shopify orders
    const notesToInsert: any[] = [];

    for (const { internalOrderId, shopifyOrder, shopifyCreatedAt } of orders) {
      const rawData = shopifyOrder.rawData as any;

      // 1. Extract order-level note (internal notes)
      if (shopifyOrder.note) {
        notesToInsert.push({
          organizationId,
          entityType: 'order',
          entityId: internalOrderId,
          noteType: 'internal',
          noteSource: 'shopify',
          title: 'Order Notes',
          content: shopifyOrder.note,
          visibility: 'internal',
          priority: 0,
          createdAt: shopifyCreatedAt,
          updatedAt: new Date(),
        });
      }

      // 2. Extract note attributes (custom attributes)
      // These can be in multiple formats depending on GraphQL vs REST
      const noteAttributes = rawData?.note_attributes ||
                             rawData?.noteAttributes ||
                             rawData?.customAttributes ||
                             [];

      if (noteAttributes && Array.isArray(noteAttributes)) {
        for (const attr of noteAttributes) {
          const attrName = attr.name || attr.key;
          const attrValue = attr.value;

          if (!attrName || !attrValue) continue;

          // Categorize the note based on attribute name
          const { noteType, title, visibility } = categorizeNoteAttribute(attrName);

          notesToInsert.push({
            organizationId,
            entityType: 'order',
            entityId: internalOrderId,
            noteType,
            noteSource: 'shopify',
            title,
            content: attrValue,
            visibility,
            priority: noteType === 'gift_note' ? 10 : 5,
            shopifyAttributeName: attrName,
            metadata: {
              originalAttributeName: attrName,
              shopifyOrderId: shopifyOrder.shopifyOrderId,
            },
            createdAt: shopifyCreatedAt,
            updatedAt: new Date(),
          });
        }
      }

      // 3. Extract line item properties as notes
      // Need to fetch order items to link notes to them
      const lineItems = rawData?.lineItems?.edges || rawData?.line_items || [];

      logger.debug({
        orderId: internalOrderId,
        shopifyOrderId: shopifyOrder.shopifyOrderId,
        hasRawData: !!rawData,
        lineItemsCount: lineItems.length,
      }, 'Processing line items for notes extraction');

      if (lineItems.length > 0) {
        // Fetch order items for this order, ordered by displayOrder to match lineItems array
        const orderItemsForOrder = await db
          .select()
          .from(orderItems)
          .where(eq(orderItems.orderId, internalOrderId))
          .orderBy(orderItems.displayOrder);

        // Process line items and their properties
        lineItems.forEach((lineItemData: any, lineIndex: number) => {
          // Handle both GraphQL (edge.node) and REST (direct) formats
          const lineItem = lineItemData.node || lineItemData;
          const properties = lineItem.properties || lineItem.customAttributes || [];

          logger.debug({
            lineIndex,
            hasNode: !!lineItemData.node,
            propertiesCount: properties?.length || 0,
            propertyKeys: properties?.map((p: any) => p.name || p.key) || [],
          }, 'Processing line item properties');

          if (!properties || !Array.isArray(properties) || properties.length === 0) {
            return;
          }

          // Try to match line item to order item by index
          const orderItem = orderItemsForOrder[lineIndex];
          if (!orderItem) {
            logger.warn(
              { lineIndex, orderId: internalOrderId },
              'Could not find order item for line item'
            );
            return;
          }

          // Extract notes from properties
          for (const prop of properties) {
            const propName = prop.name || prop.key;
            const propValue = prop.value;

            if (!propName || !propValue) {
              logger.debug({ propName, hasValue: !!propValue }, 'Skipping property - missing name or value');
              continue;
            }

            // Skip internal/system properties
            if (propName.startsWith('_')) {
              logger.debug({ propName }, 'Skipping property - starts with underscore');
              continue;
            }

            // Skip Zapiet properties (already in structured fields)
            if (propName.toLowerCase().includes('zapiet')) {
              logger.debug({ propName }, 'Skipping property - contains zapiet');
              continue;
            }

            const { noteType, title, visibility, entityType } = categorizeLineItemProperty(
              propName,
              lineItem.name || orderItem.name
            );

            logger.debug({
              propName,
              noteType,
              title,
              visibility,
              entityType,
              willAddNote: true,
            }, 'Adding note from line item property');

            notesToInsert.push({
              organizationId,
              entityType: entityType || 'orderItem',
              entityId: entityType === 'order' ? internalOrderId : orderItem.id,
              noteType,
              noteSource: 'shopify',
              title,
              content: propValue,
              visibility,
              priority: noteType === 'gift_note' || noteType === 'handwritten_card' ? 10 : 5,
              shopifyLineItemId: lineItem.id,
              metadata: {
                lineItemName: lineItem.name || orderItem.name,
                originalPropertyName: propName,
                shopifyOrderId: shopifyOrder.shopifyOrderId,
                shopifyLineItemId: lineItem.id,
              },
              createdAt: shopifyCreatedAt,
              updatedAt: new Date(),
            });
          }
        });
      }
    }

    // Batch insert all notes
    if (notesToInsert.length > 0) {
      // Deduplicate notes by creating a unique key from entity + content
      const uniqueNotes = new Map();
      for (const note of notesToInsert) {
        const key = `${note.entityType}:${note.entityId}:${note.shopifyAttributeName || note.title}:${note.content}`;
        if (!uniqueNotes.has(key)) {
          uniqueNotes.set(key, note);
        }
      }

      const notesToInsertDeduped = Array.from(uniqueNotes.values());

      await db.insert(notes).values(notesToInsertDeduped);
      result.notesCreated = notesToInsertDeduped.length;

      if (notesToInsertDeduped.length < notesToInsert.length) {
        logger.info(
          {
            total: notesToInsert.length,
            unique: notesToInsertDeduped.length,
            duplicates: notesToInsert.length - notesToInsertDeduped.length,
          },
          'Deduplicated notes before insertion'
        );
      }

      logger.info(
        { count: notesToInsertDeduped.length, organizationId },
        'Batch inserted notes from Shopify orders'
      );
    }

    return result;
  } catch (error) {
    logger.error({ error, organizationId }, 'Failed to extract and insert order notes');
    result.success = false;
    result.errors.push(error instanceof Error ? error.message : 'Unknown error');
    return result;
  }
}

/**
 * Categorize a note attribute to determine note type, title, and visibility
 */
function categorizeNoteAttribute(attrName: string): {
  noteType: string;
  title: string;
  visibility: 'internal' | 'customer' | 'public';
} {
  const lowerName = attrName.toLowerCase();

  if (lowerName.includes('gift') && lowerName.includes('note')) {
    return {
      noteType: 'gift_note',
      title: 'Gift Note',
      visibility: 'customer',
    };
  }

  if (lowerName.includes('card') || lowerName.includes('message')) {
    return {
      noteType: 'handwritten_card',
      title: 'Card Message',
      visibility: 'customer',
    };
  }

  if (lowerName.includes('delivery') && lowerName.includes('instruction')) {
    return {
      noteType: 'delivery_instruction',
      title: 'Delivery Instructions',
      visibility: 'internal',
    };
  }

  if (lowerName.includes('special') || lowerName.includes('instruction')) {
    return {
      noteType: 'order_note',
      title: 'Special Instructions',
      visibility: 'internal',
    };
  }

  // Default: custom attribute
  return {
    noteType: 'custom_attribute',
    title: attrName,
    visibility: 'internal',
  };
}

/**
 * Categorize a line item property to determine note type, title, visibility, and entity
 */
function categorizeLineItemProperty(
  propName: string,
  lineItemName: string
): {
  noteType: string;
  title: string;
  visibility: 'internal' | 'customer' | 'public';
  entityType?: 'order' | 'orderItem';
} {
  const lowerName = propName.toLowerCase();

  if (lowerName.includes('gift') && (lowerName.includes('note') || lowerName.includes('message'))) {
    return {
      noteType: 'gift_note',
      title: `Gift Note - ${lineItemName}`,
      visibility: 'customer',
      entityType: 'orderItem',
    };
  }

  if (lowerName.includes('card')) {
    return {
      noteType: 'handwritten_card',
      title: `Card Message - ${lineItemName}`,
      visibility: 'customer',
      entityType: 'orderItem',
    };
  }

  if (lowerName.includes('handwritten') && lowerName.includes('card')) {
    return {
      noteType: 'handwritten_card',
      title: 'Handwritten Card',
      visibility: 'customer',
      entityType: 'order', // Attach to order level
    };
  }

  if (lowerName.includes('recipient')) {
    return {
      noteType: 'delivery_instruction',
      title: 'Recipient',
      visibility: 'internal',
      entityType: 'order',
    };
  }

  if (lowerName.includes('delivery') || lowerName.includes('instruction')) {
    return {
      noteType: 'delivery_instruction',
      title: propName,
      visibility: 'internal',
      entityType: 'orderItem',
    };
  }

  // Default: generic property
  return {
    noteType: 'order_note',
    title: `${propName} - ${lineItemName}`,
    visibility: 'internal',
    entityType: 'orderItem',
  };
}
