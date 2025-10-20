/**
 * Sync shopify_orders to internal orders + order_items tables
 */

import { getDatabaseForEnvironment } from '../../config/database';
import { shopifyOrders, orders, orderItems } from '../../db/schema';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { extractAndInsertOrderNotes } from './extract-order-notes';
import { extractAndInsertOrderTags } from './extract-order-tags';

interface OrderSyncOptions {
  organizationId: string;
  syncJobId?: string;
  shopifyOrderIds?: string[]; // Limit sync to specific shopify_order IDs (for batch processing)
  environment?: 'staging' | 'production';
}

export async function syncOrdersToInternal(options: OrderSyncOptions): Promise<{
  success: boolean;
  ordersProcessed: number;
  orderItemsCreated: number;
  errors: number;
}> {
  const { organizationId, syncJobId, shopifyOrderIds, environment = 'production' } = options;
  const db = getDatabaseForEnvironment(environment);

  logger.info(
    { organizationId, syncJobId, limitToIds: shopifyOrderIds?.length },
    'Starting internal orders sync'
  );

  const result = {
    success: true,
    ordersProcessed: 0,
    orderItemsCreated: 0,
    errors: 0,
  };

  try {
    // Fetch Shopify orders for this organization
    // Optionally limit to specific shopify_order IDs (for batch processing)
    const conditions = [
      eq(shopifyOrders.organizationId, organizationId),
    ];

    // If specific shopify_order IDs provided, only sync those
    if (shopifyOrderIds && shopifyOrderIds.length > 0) {
      conditions.push(sql`${shopifyOrders.shopifyOrderId} = ANY(ARRAY[${sql.join(shopifyOrderIds.map(id => sql`${id}`), sql`, `)}])`);
    }

    const shopifyOrdersToSync = await db
      .select()
      .from(shopifyOrders)
      .where(and(...conditions));

    logger.info(
      { count: shopifyOrdersToSync.length },
      'Found Shopify orders to sync'
    );

    if (shopifyOrdersToSync.length === 0) {
      return result;
    }

    // Separate orders into those already linked vs not linked
    const unlinkedOrders = shopifyOrdersToSync.filter(o => !o.internalOrderId);
    const linkedOrders = shopifyOrdersToSync.filter(o => o.internalOrderId);

    logger.info(
      { unlinked: unlinkedOrders.length, linked: linkedOrders.length },
      'Orders breakdown: linked vs unlinked'
    );

    // Get all existing orders with shopify_order_id for this org (for matching unlinked orders)
    const unlinkedShopifyOrderIds = unlinkedOrders.map(o => o.shopifyOrderId);
    let existingOrdersMap = new Map();

    if (unlinkedShopifyOrderIds.length > 0) {
      const existingOrders = await db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.organizationId, organizationId),
            sql`${orders.shopifyOrderId} = ANY(ARRAY[${sql.join(unlinkedShopifyOrderIds.map(id => sql`${id}`), sql`, `)}])`
          )
        );

      existingOrdersMap = new Map(
        existingOrders.map(o => [o.shopifyOrderId, o])
      );
    }

    // Separate into new orders and updates (for UNLINKED orders)
    const ordersToCreate: any[] = [];
    const ordersToLinkExisting: Array<{ shopifyOrder: any; existingOrder: any }> = [];
    const shopifyOrdersToLink: Array<{ shopifyOrderId: string; internalOrderId: string }> = [];

    for (const shopifyOrder of unlinkedOrders) {
      const existingOrder = existingOrdersMap.get(shopifyOrder.shopifyOrderId);
      if (existingOrder) {
        ordersToLinkExisting.push({ shopifyOrder, existingOrder });
        shopifyOrdersToLink.push({
          shopifyOrderId: shopifyOrder.id,
          internalOrderId: existingOrder.id,
        });
      } else {
        ordersToCreate.push(shopifyOrder);
      }
    }

    logger.info(
      { toCreate: ordersToCreate.length, toLink: ordersToLinkExisting.length, toUpdate: linkedOrders.length },
      'Batch processing orders'
    );

    // Batch create new orders
    if (ordersToCreate.length > 0) {
      const newOrdersData = ordersToCreate.map(shopifyOrder =>
        transformShopifyOrderToInternal(shopifyOrder)
      );

      const createdOrders = await db
        .insert(orders)
        .values(newOrdersData)
        .returning({ id: orders.id, shopifyOrderId: orders.shopifyOrderId });

      // Map created order IDs back to shopify orders for linking
      const createdOrdersMap = new Map(
        createdOrders.map((o, idx) => [ordersToCreate[idx].id, o.id])
      );

      for (const shopifyOrder of ordersToCreate) {
        const internalOrderId = createdOrdersMap.get(shopifyOrder.id);
        if (internalOrderId) {
          shopifyOrdersToLink.push({
            shopifyOrderId: shopifyOrder.id,
            internalOrderId,
          });
        }
      }

      result.ordersProcessed += createdOrders.length;
      logger.info({ count: createdOrders.length }, 'Batch created new orders');

      // Extract and insert notes for newly created orders
      const ordersForNoteExtraction = ordersToCreate
        .map(shopifyOrder => ({
          internalOrderId: createdOrdersMap.get(shopifyOrder.id)!,
          shopifyOrder,
          shopifyCreatedAt: shopifyOrder.shopifyCreatedAt,
        }))
        .filter(o => o.internalOrderId);

      if (ordersForNoteExtraction.length > 0) {
        const noteResult = await extractAndInsertOrderNotes({
          organizationId,
          orders: ordersForNoteExtraction,
          environment,
        });

        if (!noteResult.success) {
          logger.warn({ errors: noteResult.errors }, 'Failed to extract some notes');
        } else {
          logger.info({ count: noteResult.notesCreated }, 'Extracted notes for new orders');
        }
      }

      // Extract and insert tags for newly created orders
      const ordersForTagExtraction = ordersToCreate
        .map(shopifyOrder => ({
          internalOrderId: createdOrdersMap.get(shopifyOrder.id)!,
          shopifyTags: shopifyOrder.tags,
        }))
        .filter(o => o.internalOrderId);

      if (ordersForTagExtraction.length > 0) {
        const tagResult = await extractAndInsertOrderTags({
          organizationId,
          orders: ordersForTagExtraction,
          environment,
        });

        if (!tagResult.success) {
          logger.warn({ errors: tagResult.errors }, 'Failed to extract some tags');
        } else {
          logger.info(
            { created: tagResult.tagsCreated, linked: tagResult.tagsLinked },
            'Extracted tags for new orders'
          );
        }
      }
    }

    // For existing orders that need linking, just link them
    if (ordersToLinkExisting.length > 0) {
      result.ordersProcessed += ordersToLinkExisting.length;
      logger.info({ count: ordersToLinkExisting.length }, 'Found existing orders to link');
    }

    // For already-linked orders, update key fields (fulfillment type, due date, etc.)
    if (linkedOrders.length > 0) {
      for (const shopifyOrder of linkedOrders) {
        const internalOrderData = transformShopifyOrderToInternal(shopifyOrder);

        await db
          .update(orders)
          .set({
            fulfillmentType: internalOrderData.fulfillmentType,
            dueDate: internalOrderData.dueDate,
            dueTime: internalOrderData.dueTime,
            deliveryAddress: internalOrderData.deliveryAddress,
            status: internalOrderData.status,
            paymentStatus: internalOrderData.paymentStatus,
            shopifyFinancialStatus: internalOrderData.shopifyFinancialStatus,
            shopifyFulfillmentStatus: internalOrderData.shopifyFulfillmentStatus,
            shopifyTags: internalOrderData.shopifyTags,
            completedAt: internalOrderData.completedAt,
            cancelledAt: internalOrderData.cancelledAt,
            cancellationReason: internalOrderData.cancellationReason,
            updatedAt: new Date(),
          })
          .where(eq(orders.id, shopifyOrder.internalOrderId!));
      }

      result.ordersProcessed += linkedOrders.length;
      logger.info({ count: linkedOrders.length }, 'Updated already-linked orders with latest data');

      // Extract and insert notes for updated orders (in case new notes were added)
      const updatedOrdersForNoteExtraction = linkedOrders.map(shopifyOrder => ({
        internalOrderId: shopifyOrder.internalOrderId!,
        shopifyOrder,
        shopifyCreatedAt: shopifyOrder.shopifyCreatedAt,
      }));

      if (updatedOrdersForNoteExtraction.length > 0) {
        const noteResult = await extractAndInsertOrderNotes({
          organizationId,
          orders: updatedOrdersForNoteExtraction,
          environment,
        });

        if (!noteResult.success) {
          logger.warn({ errors: noteResult.errors }, 'Failed to extract notes for updated orders');
        } else {
          logger.info({ count: noteResult.notesCreated }, 'Extracted notes for updated orders');
        }
      }

      // Extract and insert tags for updated orders
      const updatedOrdersForTagExtraction = linkedOrders.map(shopifyOrder => ({
        internalOrderId: shopifyOrder.internalOrderId!,
        shopifyTags: shopifyOrder.tags,
      }));

      if (updatedOrdersForTagExtraction.length > 0) {
        const tagResult = await extractAndInsertOrderTags({
          organizationId,
          orders: updatedOrdersForTagExtraction,
          environment,
        });

        if (!tagResult.success) {
          logger.warn({ errors: tagResult.errors }, 'Failed to extract tags for updated orders');
        } else {
          logger.info(
            { created: tagResult.tagsCreated, linked: tagResult.tagsLinked },
            'Extracted tags for updated orders'
          );
        }
      }
    }

    // Batch create/update order items for newly linked orders
    const allOrderItems: any[] = [];
    for (const { shopifyOrderId, internalOrderId } of shopifyOrdersToLink) {
      const shopifyOrder = shopifyOrdersToSync.find(o => o.id === shopifyOrderId);
      if (shopifyOrder) {
        const items = transformOrderItems(shopifyOrder, internalOrderId);
        allOrderItems.push(...items);
      }
    }

    if (allOrderItems.length > 0) {
      // Delete existing items first
      const orderIds = shopifyOrdersToLink.map(o => o.internalOrderId);
      await db
        .delete(orderItems)
        .where(inArray(orderItems.orderId, orderIds));

      // Batch insert all items
      await db.insert(orderItems).values(allOrderItems);
      result.orderItemsCreated += allOrderItems.length;
      logger.info({ count: allOrderItems.length }, 'Batch created order items for newly linked orders');
    }

    // Update order items for already-linked orders (re-sync items in case they changed)
    if (linkedOrders.length > 0) {
      const linkedOrderIds = linkedOrders.map(o => o.internalOrderId!);
      const linkedOrderItems: any[] = [];

      for (const shopifyOrder of linkedOrders) {
        const items = transformOrderItems(shopifyOrder, shopifyOrder.internalOrderId!);
        linkedOrderItems.push(...items);
      }

      if (linkedOrderItems.length > 0) {
        // Delete existing items
        await db
          .delete(orderItems)
          .where(inArray(orderItems.orderId, linkedOrderIds));

        // Insert updated items
        await db.insert(orderItems).values(linkedOrderItems);
        result.orderItemsCreated += linkedOrderItems.length;
        logger.info({ count: linkedOrderItems.length }, 'Updated order items for already-linked orders');
      }
    }

    // Batch update shopify_orders with internal_order_id using a single SQL statement
    if (shopifyOrdersToLink.length > 0) {
      const values = shopifyOrdersToLink.map(
        ({ shopifyOrderId, internalOrderId }) =>
          sql`(${shopifyOrderId}::uuid, ${internalOrderId}::uuid)`
      );

      await db.execute(sql`
        UPDATE ${shopifyOrders}
        SET internal_order_id = v.internal_order_id::uuid
        FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, internal_order_id)
        WHERE ${shopifyOrders.id} = v.id::uuid
      `);

      logger.info({ count: shopifyOrdersToLink.length }, 'Batch updated shopify_orders with internal_order_id');
    }

    logger.info(
      {
        ordersProcessed: result.ordersProcessed,
        orderItemsCreated: result.orderItemsCreated,
        errors: result.errors,
      },
      'Completed internal orders sync'
    );

    return result;
  } catch (error) {
    logger.error({ error, organizationId }, 'Failed to sync orders to internal');
    result.success = false;
    throw error;
  }
}

function transformShopifyOrderToInternal(shopifyOrder: any) {
  const rawData = shopifyOrder.rawData as any;

  // Determine fulfillment type from pickup_location or tags
  // Default to "not available" instead of assuming shipping
  let fulfillmentType = 'not available';
  const pickupLocationStr = shopifyOrder.pickupLocation || '';

  if (pickupLocationStr.startsWith('LOCAL_DELIVERY:')) {
    fulfillmentType = 'delivery';
  } else if (shopifyOrder.pickupLocation && !pickupLocationStr.startsWith('LOCAL_DELIVERY:')) {
    fulfillmentType = 'pickup';
  } else if (shopifyOrder.tags && shopifyOrder.tags.toLowerCase().includes('local delivery')) {
    fulfillmentType = 'delivery';
  } else if (shopifyOrder.tags && shopifyOrder.tags.toLowerCase().includes('pickup')) {
    fulfillmentType = 'pickup';
  } else if (shopifyOrder.tags && shopifyOrder.tags.toLowerCase().includes('shipping')) {
    fulfillmentType = 'shipping';
  }
  // If order has shipping lines, check if it's delivery or shipping
  else if (rawData.shippingLines) {
    // Handle both GraphQL format (edges) and REST format (array)
    const shippingLines = rawData.shippingLines.edges
      ? rawData.shippingLines.edges.map((e: any) => e.node)
      : rawData.shippingLines;

    if (shippingLines && shippingLines.length > 0) {
      const shippingTitle = (shippingLines[0].title || '').toLowerCase();
      if (shippingTitle.includes('local') || shippingTitle.includes('delivery')) {
        fulfillmentType = 'delivery';
      } else if (shippingTitle) {
        fulfillmentType = 'shipping';
      }
    }
  }

  // Determine order status based on financial and fulfillment status
  let status = 'pending';
  if (shopifyOrder.shopifyCancelledAt) {
    status = 'cancelled';
  } else if (shopifyOrder.fulfillmentStatus === 'fulfilled') {
    status = 'completed';
  } else if (shopifyOrder.financialStatus === 'paid') {
    status = 'confirmed';
  }

  // Determine payment status
  let paymentStatus = 'unpaid';
  if (shopifyOrder.financialStatus === 'paid') {
    paymentStatus = 'paid';
  } else if (shopifyOrder.financialStatus === 'partially_paid') {
    paymentStatus = 'partially_paid';
  } else if (shopifyOrder.financialStatus === 'refunded' || shopifyOrder.financialStatus === 'partially_refunded') {
    paymentStatus = 'refunded';
  }

  // Extract shipping address from rawData
  const shippingAddress = rawData.shippingAddress || {};
  const billingAddress = rawData.billingAddress || {};

  // Determine due date from pickup_date (Zapiet) or try to parse from tags, or use order created date
  let dueDate = shopifyOrder.shopifyCreatedAt;

  if (shopifyOrder.pickupDate) {
    // Use Zapiet-provided date (most reliable)
    dueDate = new Date(shopifyOrder.pickupDate);
  } else if (shopifyOrder.tags) {
    // Try to parse date from tags like "10-20-2025" or "2025-10-20"
    const tags = shopifyOrder.tags.split(',');
    for (const tag of tags) {
      const trimmedTag = tag.trim();
      // Match MM-DD-YYYY or YYYY-MM-DD format
      const dateMatch = trimmedTag.match(/^(\d{2})-(\d{2})-(\d{4})$/) || trimmedTag.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dateMatch) {
        try {
          if (trimmedTag.match(/^\d{2}-\d{2}-\d{4}$/)) {
            // MM-DD-YYYY format
            const [_, month, day, year] = dateMatch;
            dueDate = new Date(`${year}-${month}-${day}`);
          } else {
            // YYYY-MM-DD format
            dueDate = new Date(trimmedTag);
          }
          break;
        } catch (e) {
          // Invalid date, continue searching
        }
      }
    }
  }

  return {
    organizationId: shopifyOrder.organizationId,
    orderNumber: shopifyOrder.shopifyOrderNumber,
    customerId: null,
    customerName: shopifyOrder.customerName || 'Guest',
    customerEmail: shopifyOrder.customerEmail,
    customerPhone: shopifyOrder.customerPhone,
    status,
    priority: 'normal',
    orderDate: shopifyOrder.shopifyCreatedAt,
    dueDate: dueDate,
    dueTime: shopifyOrder.pickupTime,
    completedAt: shopifyOrder.fulfillmentStatus === 'fulfilled' ? shopifyOrder.shopifyUpdatedAt : null,
    fulfillmentType,
    deliveryAddress: shopifyOrder.pickupLocation || shippingAddress.address1,
    deliveryInstructions: shopifyOrder.note,
    deliveryFee: null,
    shippingName: shippingAddress.name,
    shippingPhone: shippingAddress.phone,
    shippingEmail: null,
    shippingAddress1: shippingAddress.address1,
    shippingAddress2: shippingAddress.address2,
    shippingCity: shippingAddress.city,
    shippingState: shippingAddress.provinceCode || shippingAddress.province,
    shippingZip: shippingAddress.zip,
    shippingCountry: shippingAddress.countryCode || shippingAddress.country,
    shippingCompany: shippingAddress.company,
    billingName: billingAddress.name,
    billingPhone: billingAddress.phone,
    billingEmail: null,
    billingAddress1: billingAddress.address1,
    billingAddress2: billingAddress.address2,
    billingCity: billingAddress.city,
    billingState: billingAddress.provinceCode || billingAddress.province,
    billingZip: billingAddress.zip,
    billingCountry: billingAddress.countryCode || billingAddress.country,
    billingCompany: billingAddress.company,
    subtotal: shopifyOrder.subtotalPrice || '0',
    taxAmount: shopifyOrder.totalTax || '0',
    discountAmount: shopifyOrder.totalDiscounts || '0',
    total: shopifyOrder.totalPrice,
    totalCost: null,
    profitAmount: null,
    profitMargin: null,
    paymentStatus,
    paymentMethod: null,
    paidAmount: paymentStatus === 'paid' ? shopifyOrder.totalPrice : null,
    externalOrderId: shopifyOrder.shopifyOrderId,
    orderSource: 'shopify',
    shopifyOrderId: shopifyOrder.shopifyOrderId,
    shopifyOrderNumber: shopifyOrder.shopifyOrderNumber,
    shopifyFulfillmentId: null,
    shopifyFinancialStatus: shopifyOrder.financialStatus,
    shopifyFulfillmentStatus: shopifyOrder.fulfillmentStatus,
    shopifyTags: shopifyOrder.tags,
    shopifyCurrency: shopifyOrder.currency,
    shopifySyncedAt: shopifyOrder.syncedAt,
    internalNotes: null,
    customerNotes: shopifyOrder.note,
    specialInstructions: shopifyOrder.note,
    source: 'shopify',
    tags: shopifyOrder.tags ? [shopifyOrder.tags] : [],
    createdBy: null, // System-created orders don't have a user reference
    assignedTo: null,
    cancelledAt: shopifyOrder.shopifyCancelledAt,
    cancelledBy: null, // Cancelled orders don't have a user reference (external cancellation)
    cancellationReason: shopifyOrder.cancelReason,
  };
}

function transformOrderItems(shopifyOrder: any, internalOrderId: string) {
  const rawData = shopifyOrder.rawData as any;
  const lineItems = rawData.lineItems?.edges || [];

  if (lineItems.length === 0) {
    return [];
  }

  // Transform line items to order items format
  return lineItems.map((edge: any, index: number) => {
    const item = edge.node;
    const variant = item.variant || {};
    const product = variant.product || {};

    return {
      organizationId: shopifyOrder.organizationId,
      orderId: internalOrderId,
      productId: null,
      productVariantId: null,
      itemType: 'product',
      recipeId: null,
      variantId: null,
      inventoryItemId: null,
      name: item.title || 'Unknown Item',
      description: item.variantTitle || variant.title,
      quantity: item.quantity || 1,
      unitPrice: item.originalUnitPriceSet?.shopMoney?.amount || '0',
      subtotal: item.discountedTotalSet?.shopMoney?.amount || '0',
      unitCost: null,
      totalCost: null,
      recipeLaborMinutes: null,
      recipeRetailPrice: null,
      recipeMaterialCost: null,
      externalItemId: item.id,
      externalSku: variant.sku,
      shopifyProductId: product.legacyResourceId || variant.product?.legacyResourceId,
      shopifyVariantId: variant.legacyResourceId,
      recipeVariantId: null,
      customizations: item.customAttributes ? { customAttributes: item.customAttributes } : null,
      substitutions: null,
      status: 'pending',
      completedAt: null,
      completedBy: null,
      notes: null,
      displayOrder: index,
    };
  });
}
