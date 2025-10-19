/**
 * Sync shopify_orders to internal orders + order_items tables
 */

import { db } from '../../config/database';
import { shopifyOrders, orders, orderItems } from '../../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '../utils/logger';

interface OrderSyncOptions {
  organizationId: string;
  syncJobId?: string;
}

export async function syncOrdersToInternal(options: OrderSyncOptions): Promise<{
  success: boolean;
  ordersProcessed: number;
  orderItemsCreated: number;
  errors: number;
}> {
  const { organizationId, syncJobId } = options;

  logger.info({ organizationId, syncJobId }, 'Starting internal orders sync');

  const result = {
    success: true,
    ordersProcessed: 0,
    orderItemsCreated: 0,
    errors: 0,
  };

  try {
    // Fetch all Shopify orders for this organization that don't have an internal_order_id yet
    const shopifyOrdersToSync = await db
      .select()
      .from(shopifyOrders)
      .where(
        and(
          eq(shopifyOrders.organizationId, organizationId),
          sql`${shopifyOrders.internalOrderId} IS NULL`
        )
      );

    logger.info(
      { count: shopifyOrdersToSync.length },
      'Found Shopify orders without internal order'
    );

    if (shopifyOrdersToSync.length === 0) {
      return result;
    }

    // Process each Shopify order
    for (const shopifyOrder of shopifyOrdersToSync) {
      try {
        // Check if an order already exists with this shopify_order_id
        const [existingOrder] = await db
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.organizationId, organizationId),
              eq(orders.shopifyOrderId, shopifyOrder.shopifyOrderId)
            )
          )
          .limit(1);

        let internalOrderId: string;

        if (existingOrder) {
          // Update existing order
          internalOrderId = existingOrder.id;
          await updateInternalOrder(shopifyOrder, existingOrder.id);
          logger.info(
            { shopifyOrderId: shopifyOrder.shopifyOrderId, internalOrderId },
            'Updated existing internal order'
          );
        } else {
          // Create new order
          internalOrderId = await createInternalOrder(shopifyOrder);
          logger.info(
            { shopifyOrderId: shopifyOrder.shopifyOrderId, internalOrderId },
            'Created new internal order'
          );
        }

        // Create/update order items
        const itemsCreated = await syncOrderItems(shopifyOrder, internalOrderId);
        result.orderItemsCreated += itemsCreated;

        // Update shopify_orders with internal_order_id
        await db
          .update(shopifyOrders)
          .set({ internalOrderId })
          .where(eq(shopifyOrders.id, shopifyOrder.id));

        result.ordersProcessed++;
      } catch (error) {
        logger.error(
          { error, shopifyOrderId: shopifyOrder.shopifyOrderId },
          'Failed to sync individual order'
        );
        result.errors++;
      }
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

async function createInternalOrder(shopifyOrder: any): Promise<string> {
  const rawData = shopifyOrder.rawData as any;

  // Determine fulfillment type
  let fulfillmentType = 'shipping';
  if (shopifyOrder.pickupDate || shopifyOrder.pickupLocation) {
    fulfillmentType = 'pickup';
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

  // Determine due date (default to pickup_date or 7 days from order date)
  const dueDate = shopifyOrder.pickupDate || new Date(new Date(shopifyOrder.shopifyCreatedAt).getTime() + 7 * 24 * 60 * 60 * 1000);

  const [newOrder] = await db
    .insert(orders)
    .values({
      organizationId: shopifyOrder.organizationId,
      orderNumber: shopifyOrder.shopifyOrderNumber,
      customerId: null, // Could be linked later if customer sync is implemented
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
      createdBy: 'system',
      assignedTo: null,
      cancelledAt: shopifyOrder.shopifyCancelledAt,
      cancelledBy: shopifyOrder.shopifyCancelledAt ? 'shopify' : null,
      cancellationReason: shopifyOrder.cancelReason,
    })
    .returning({ id: orders.id });

  return newOrder.id;
}

async function updateInternalOrder(shopifyOrder: any, internalOrderId: string): Promise<void> {
  // Determine order status
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

  await db
    .update(orders)
    .set({
      status,
      paymentStatus,
      completedAt: shopifyOrder.fulfillmentStatus === 'fulfilled' ? shopifyOrder.shopifyUpdatedAt : null,
      shopifyFinancialStatus: shopifyOrder.financialStatus,
      shopifyFulfillmentStatus: shopifyOrder.fulfillmentStatus,
      shopifySyncedAt: shopifyOrder.syncedAt,
      paidAmount: paymentStatus === 'paid' ? shopifyOrder.totalPrice : null,
      cancelledAt: shopifyOrder.shopifyCancelledAt,
      cancelledBy: shopifyOrder.shopifyCancelledAt ? 'shopify' : null,
      cancellationReason: shopifyOrder.cancelReason,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, internalOrderId));
}

async function syncOrderItems(shopifyOrder: any, internalOrderId: string): Promise<number> {
  const rawData = shopifyOrder.rawData as any;
  const lineItems = rawData.lineItems?.edges || [];

  if (lineItems.length === 0) {
    return 0;
  }

  // Delete existing items for this order (we'll recreate them)
  await db
    .delete(orderItems)
    .where(eq(orderItems.orderId, internalOrderId));

  // Create order items from line items
  const itemsToInsert = lineItems.map((edge: any, index: number) => {
    const item = edge.node;
    const variant = item.variant || {};
    const product = variant.product || {};

    return {
      organizationId: shopifyOrder.organizationId,
      orderId: internalOrderId,
      productId: null, // Could be linked if product matching is implemented
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

  await db.insert(orderItems).values(itemsToInsert);

  logger.info(
    { internalOrderId, itemCount: itemsToInsert.length },
    'Created order items'
  );

  return itemsToInsert.length;
}
