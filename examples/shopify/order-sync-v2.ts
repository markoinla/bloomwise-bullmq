import { db } from "@/db/drizzle";
import { customers, orders, orderItems, shopifyOrders, shopifySyncLog, notes, shopifyVariants, recipeVariants, shopifyProducts, tags, taggables } from "@/db/schema";
import { eq, and, or, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { errorLogger } from "@/lib/error-logger";

// Helper to format date as YYYY-MM-DD without timezone conversion
function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Enhanced Shopify order sync that saves to shopify_orders table first

interface ShopifyOrderSyncResult {
  shopifyOrderId: string;
  internalOrderId?: string;
  status: 'created' | 'updated' | 'skipped' | 'error';
  error?: string;
}

/**
 * Sync Shopify orders to the shopify_orders table
 * This function saves the complete order data including raw JSON
 */
export async function syncShopifyOrders(
  shopifyOrdersData: any[],
  organizationId: string
): Promise<{
  success: number;
  failed: number;
  skipped: number;
  results: ShopifyOrderSyncResult[];
}> {
  const results: ShopifyOrderSyncResult[] = [];
  let success = 0;
  let failed = 0;
  const skipped = 0;

  for (const shopifyOrder of shopifyOrdersData) {
    try {
      const shopifyOrderId = shopifyOrder.id.toString();

      // Check if order already exists
      const existingOrder = await db
        .select()
        .from(shopifyOrders)
        .where(
          and(
            eq(shopifyOrders.organizationId, organizationId),
            eq(shopifyOrders.shopifyOrderId, shopifyOrderId)
          )
        )
        .limit(1);

      // Extract pickup info from note_attributes
      const pickupInfo = extractPickupInfo(shopifyOrder.note_attributes);

      // Prepare the order data
      const orderData = {
        organizationId,
        shopifyOrderId,
        shopifyOrderNumber: shopifyOrder.order_number?.toString() || shopifyOrder.name.replace(/^#/, ''),
        name: shopifyOrder.name,
        shopifyCreatedAt: new Date(shopifyOrder.created_at),
        shopifyUpdatedAt: new Date(shopifyOrder.updated_at),
        shopifyCancelledAt: shopifyOrder.cancelled_at ? new Date(shopifyOrder.cancelled_at) : null,
        customerEmail: shopifyOrder.email || shopifyOrder.customer?.email || null,
        customerPhone: shopifyOrder.phone || shopifyOrder.customer?.phone || null,
        customerName: getCustomerName(shopifyOrder),
        shopifyCustomerId: shopifyOrder.customer?.id?.toString() || null,
        financialStatus: shopifyOrder.financial_status,
        fulfillmentStatus: shopifyOrder.fulfillment_status || null,
        cancelReason: shopifyOrder.cancel_reason || null,
        currency: shopifyOrder.currency,
        totalPrice: shopifyOrder.total_price,
        subtotalPrice: shopifyOrder.subtotal_price || null,
        totalTax: shopifyOrder.total_tax || null,
        totalDiscounts: shopifyOrder.total_discounts || null,
        tags: shopifyOrder.tags || null,
        note: shopifyOrder.note || null,
        sourceUrl: shopifyOrder.source_url || null,
        sourceName: shopifyOrder.source_name || null,
        test: shopifyOrder.test || false,
        pickupDate: pickupInfo.date,
        pickupTime: pickupInfo.time,
        pickupLocation: pickupInfo.location,
        pickupLocationAddress: pickupInfo.address,
        rawData: shopifyOrder, // Store complete JSON
        apiVersion: "2024-10",
        syncedAt: new Date(),
        updatedAt: new Date(),
      };

      if (existingOrder[0]) {
        // Update existing shopify order
        await db
          .update(shopifyOrders)
          .set(orderData)
          .where(eq(shopifyOrders.id, existingOrder[0].id));

        // Check if internal order exists, create or update it
        let internalOrderId = existingOrder[0].internalOrderId;

        if (!internalOrderId && shouldCreateInternalOrder(shopifyOrder)) {
          // No internal order exists yet, create one
          console.log(`Creating internal order for existing Shopify order ${shopifyOrderId}`);
          internalOrderId = await createInternalOrder(shopifyOrder, organizationId, existingOrder[0].id);

          // Update shopify order with internal order link
          if (internalOrderId) {
            await db
              .update(shopifyOrders)
              .set({ internalOrderId, updatedAt: new Date() })
              .where(eq(shopifyOrders.id, existingOrder[0].id));
          }
        } else if (internalOrderId) {
          // Internal order exists, update it
          console.log(`Updating internal order ${internalOrderId} for Shopify order ${shopifyOrderId}`);
          await updateInternalOrder(shopifyOrder, internalOrderId, organizationId);
        }

        results.push({
          shopifyOrderId,
          internalOrderId: internalOrderId || undefined,
          status: 'updated',
        });
        success++;
      } else {
        // Check if a shopify order already exists to preserve internalOrderId
        const existingShopifyOrder = await db
          .select({ internalOrderId: shopifyOrders.internalOrderId })
          .from(shopifyOrders)
          .where(and(
            eq(shopifyOrders.organizationId, orderData.organizationId),
            eq(shopifyOrders.shopifyOrderId, orderData.shopifyOrderId)
          ))
          .limit(1);

        // Create new order or update if it exists (upsert)
        const [newShopifyOrder] = await db
          .insert(shopifyOrders)
          .values({
            ...orderData,
            // Preserve existing internalOrderId if it exists
            internalOrderId: existingShopifyOrder[0]?.internalOrderId || orderData.internalOrderId,
            createdAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [shopifyOrders.organizationId, shopifyOrders.shopifyOrderId],
            set: {
              ...orderData,
              // IMPORTANT: Preserve the internalOrderId if it exists
              internalOrderId: existingShopifyOrder[0]?.internalOrderId || orderData.internalOrderId,
              updatedAt: new Date(),
            },
          })
          .returning();

        // Check if internal order already exists
        let internalOrderId = newShopifyOrder.internalOrderId;

        // Create internal order if it doesn't exist
        if (!internalOrderId && shouldCreateInternalOrder(shopifyOrder)) {
          internalOrderId = await createInternalOrder(shopifyOrder, organizationId, newShopifyOrder.id);

          // Update shopify order with internal order link
          if (internalOrderId) {
            await db
              .update(shopifyOrders)
              .set({ internalOrderId })
              .where(eq(shopifyOrders.id, newShopifyOrder.id));
          }
        } else if (internalOrderId) {
          // Update existing internal order
          await updateInternalOrder(shopifyOrder, internalOrderId, organizationId);
        }

        results.push({
          shopifyOrderId,
          internalOrderId,
          status: newShopifyOrder.createdAt.getTime() === newShopifyOrder.updatedAt.getTime() ? 'created' : 'updated',
        });
        success++;
      }
    } catch (error) {
      console.error(`Failed to sync order ${shopifyOrder.id}:`, error);
      results.push({
        shopifyOrderId: shopifyOrder.id.toString(),
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      failed++;
    }
  }

  // Log the sync operation
  await db.insert(shopifySyncLog).values({
    organizationId,
    syncType: 'orders',
    status: 'completed',
    recordsProcessed: shopifyOrdersData.length,
    recordsSucceeded: success,
    recordsFailed: failed,
    metadata: { results },
    completedAt: new Date(),
  });

  return { success, failed, skipped, results };
}

/**
 * Extract pickup and delivery information from Shopify note_attributes
 */
function extractPickupInfo(noteAttributes?: any[]): {
  date: string | null;
  time: string | null;
  location: string | null;
  address: string | null;
  deliveryInfo?: Record<string, any>;
} {
  if (!noteAttributes || !Array.isArray(noteAttributes)) {
    return { date: null, time: null, location: null, address: null };
  }

  // Extract pickup attributes
  const pickupDate = noteAttributes.find(attr => attr.name === 'Pickup-Date')?.value;
  const pickupTime = noteAttributes.find(attr => attr.name === 'Pickup-Time')?.value;
  const pickupCompany = noteAttributes.find(attr => attr.name === 'Pickup-Location-Company')?.value;
  const pickupAddress = noteAttributes.find(attr => attr.name === 'Pickup-Location-Address-Line-1')?.value;
  const pickupCity = noteAttributes.find(attr => attr.name === 'Pickup-Location-City')?.value;
  const pickupState = noteAttributes.find(attr => attr.name === 'Pickup-Location-Region')?.value;
  const pickupZip = noteAttributes.find(attr => attr.name === 'Pickup-Location-Postal-Code')?.value;

  // Extract delivery-related attributes
  const deliveryLocationId = noteAttributes.find(attr => attr.name === 'Delivery-Location-Id')?.value;
  const deliveryDay = noteAttributes.find(attr => attr.name === 'Delivery-Day')?.value;
  const deliveryDate = noteAttributes.find(attr => attr.name === 'Delivery-Date')?.value;
  const checkoutMethod = noteAttributes.find(attr => attr.name === 'Checkout-Method')?.value;
  const acceptedTerms = noteAttributes.find(attr => attr.name === 'Accepted terms/conditions?')?.value;
  const giftNote = noteAttributes.find(attr => attr.name === 'Gift note' || attr.name === 'gift-note' || attr.name === 'Gift Note')?.value;

  // Format date if present (for pickup or delivery)
  let formattedDate: string | null = null;
  if (pickupDate) {
    try {
      // Convert from "2025/09/30" to "2025-09-30"
      formattedDate = pickupDate.replace(/\//g, '-');
    } catch {
      formattedDate = null;
    }
  } else if (deliveryDate) {
    try {
      // Convert from "2025/03/28" to "2025-03-28"
      formattedDate = deliveryDate.replace(/\//g, '-');
    } catch {
      formattedDate = null;
    }
  }

  // Format time if present
  let formattedTime: string | null = null;
  if (pickupTime) {
    try {
      // Convert "3:00 PM" to "15:00:00"
      const [time, period] = pickupTime.split(' ');
      const [hours, minutes] = time.split(':');
      let hour = parseInt(hours);
      if (period === 'PM' && hour !== 12) hour += 12;
      if (period === 'AM' && hour === 12) hour = 0;
      formattedTime = `${hour.toString().padStart(2, '0')}:${minutes}:00`;
    } catch {
      formattedTime = null;
    }
  }

  // Build full address
  let fullAddress: string | null = null;
  if (pickupAddress) {
    const parts = [pickupAddress, pickupCity, pickupState, pickupZip].filter(Boolean);
    fullAddress = parts.join(', ');
  }

  // Build delivery info object
  const deliveryInfo: Record<string, any> = {};
  if (deliveryLocationId) deliveryInfo.deliveryLocationId = deliveryLocationId;
  if (deliveryDay) deliveryInfo.deliveryDay = deliveryDay;
  if (deliveryDate) deliveryInfo.deliveryDate = deliveryDate;
  if (checkoutMethod) deliveryInfo.checkoutMethod = checkoutMethod;
  if (acceptedTerms) deliveryInfo.acceptedTerms = acceptedTerms;
  if (giftNote) deliveryInfo.giftNote = giftNote;

  return {
    date: formattedDate,
    time: formattedTime,
    location: pickupCompany,
    address: fullAddress,
    deliveryInfo: Object.keys(deliveryInfo).length > 0 ? deliveryInfo : undefined,
  };
}

/**
 * Get customer name from Shopify order
 */
function getCustomerName(shopifyOrder: any): string {
  if (shopifyOrder.customer) {
    const firstName = shopifyOrder.customer.first_name || shopifyOrder.customer.firstName || '';
    const lastName = shopifyOrder.customer.last_name || shopifyOrder.customer.lastName || '';
    return `${firstName} ${lastName}`.trim();
  }

  if (shopifyOrder.billing_address) {
    const firstName = shopifyOrder.billing_address.first_name || shopifyOrder.billing_address.firstName || '';
    const lastName = shopifyOrder.billing_address.last_name || shopifyOrder.billing_address.lastName || '';
    return `${firstName} ${lastName}`.trim();
  }

  return 'Guest Customer';
}

/**
 * Normalize address object to handle both snake_case and camelCase field names
 * Shopify APIs inconsistently return address fields in different formats
 */
function normalizeAddress(address: any): {
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  phone: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
  company: string | null;
} {
  if (!address) {
    return {
      firstName: null,
      lastName: null,
      name: null,
      phone: null,
      address1: null,
      address2: null,
      city: null,
      province: null,
      zip: null,
      country: null,
      company: null,
    };
  }

  const firstName = address.first_name || address.firstName || null;
  const lastName = address.last_name || address.lastName || null;

  return {
    firstName,
    lastName,
    name: address.name || (firstName && lastName ? `${firstName} ${lastName}`.trim() : null),
    phone: address.phone || null,
    address1: address.address1 || null,
    address2: address.address2 || null,
    city: address.city || null,
    province: address.province || address.province_code || null,
    zip: address.zip || null,
    country: address.country || address.country_code || null,
    company: address.company || null,
  };
}

/**
 * Determine if we should create an internal order
 */
function shouldCreateInternalOrder(shopifyOrder: any): boolean {
  // Always create internal orders for all Shopify orders
  // This ensures we never miss an order and can track everything
  return true;

  // Previous logic kept for reference:
  // - Test orders: We might want to track these for testing
  // - Cancelled orders: We want to track these for records
  // - Draft orders: We want to track these as they often become real orders
}

/**
 * Create an internal order from Shopify order data
 */
async function createInternalOrder(
  shopifyOrder: any,
  organizationId: string,
  shopifyOrdersId: string
): Promise<string | undefined> {
  try {
    // CRITICAL: First check if an internal order already exists for this Shopify order
    // This prevents duplicate orders when Shopify orders are updated
    const shopifyOrderId = shopifyOrder.id.toString();
    const [existingInternalOrder] = await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.organizationId, organizationId),
          eq(orders.externalOrderId, shopifyOrderId) // Use externalOrderId to match the unique constraint
        )
      )
      .limit(1);

    if (existingInternalOrder) {
      console.log(`Internal order already exists for Shopify order ${shopifyOrderId}, skipping creation`);
      // Update the shopifyOrders table to link to this existing order
      await db
        .update(shopifyOrders)
        .set({
          internalOrderId: existingInternalOrder.id,
          updatedAt: new Date()
        })
        .where(eq(shopifyOrders.id, shopifyOrdersId));
      return existingInternalOrder.id;
    }

    // Extract or create customer
    const customerId = await extractOrCreateCustomer(shopifyOrder, organizationId);

    // Extract pickup and delivery info
    const pickupInfo = extractPickupInfo(shopifyOrder.note_attributes);
    const dueDate = pickupInfo.date || new Date().toISOString().split('T')[0];

    // Determine fulfillment type from shipping lines or checkout method
    let fulfillmentType = 'pickup';
    if (pickupInfo.deliveryInfo?.checkoutMethod === 'delivery') {
      fulfillmentType = 'delivery';
    } else if (shopifyOrder.shipping_lines?.length > 0) {
      const shippingTitle = shopifyOrder.shipping_lines[0].title?.toLowerCase() || '';
      if (shippingTitle.includes('delivery')) fulfillmentType = 'delivery';
      else if (shippingTitle.includes('shipping')) fulfillmentType = 'shipping';
    }

    // Normalize addresses to handle both snake_case and camelCase
    const shippingAddr = normalizeAddress(shopifyOrder.shipping_address);
    const billingAddr = normalizeAddress(shopifyOrder.billing_address);

    // Create the order with all available Shopify data
    const [newOrder] = await db.insert(orders).values({
      organizationId,
      orderNumber: shopifyOrder.order_number?.toString() || shopifyOrder.name?.replace(/^#/, '') || `SH-${shopifyOrder.id}`,
      customerId,
      customerName: getCustomerName(shopifyOrder),
      customerEmail: shopifyOrder.email || shopifyOrder.customer?.email || null,
      customerPhone: shopifyOrder.phone || shopifyOrder.customer?.phone || null,
      status: mapShopifyStatus(shopifyOrder.financial_status, shopifyOrder.fulfillment_status, shopifyOrder),
      priority: 'normal',
      orderDate: new Date(shopifyOrder.created_at),
      dueDate,
      dueTime: pickupInfo.time,
      fulfillmentType,
      deliveryAddress: formatAddress(shopifyOrder.shipping_address),

      // Shipping address fields (normalized)
      shippingName: shippingAddr.name,
      shippingPhone: shippingAddr.phone,
      shippingEmail: shopifyOrder.email,
      shippingAddress1: shippingAddr.address1,
      shippingAddress2: shippingAddr.address2,
      shippingCity: shippingAddr.city,
      shippingState: shippingAddr.province,
      shippingZip: shippingAddr.zip,
      shippingCountry: shippingAddr.country,
      shippingCompany: shippingAddr.company,

      // Billing address fields (normalized)
      billingName: billingAddr.name,
      billingPhone: billingAddr.phone,
      billingEmail: shopifyOrder.billing_address?.email || shopifyOrder.email,
      billingAddress1: billingAddr.address1,
      billingAddress2: billingAddr.address2,
      billingCity: billingAddr.city,
      billingState: billingAddr.province,
      billingZip: billingAddr.zip,
      billingCountry: billingAddr.country,
      billingCompany: billingAddr.company,

      // Notes - will be stored in notes table
      specialInstructions: null,
      customerNotes: null,
      internalNotes: null,

      // Pricing
      subtotal: shopifyOrder.subtotal_price || '0',
      taxAmount: shopifyOrder.total_tax || '0',
      discountAmount: shopifyOrder.total_discounts || '0',
      deliveryFee: shopifyOrder.shipping_lines?.[0]?.price || '0',
      total: shopifyOrder.total_price || '0',
      paymentStatus: mapPaymentStatus(shopifyOrder.financial_status),

      // Shopify specific fields
      shopifyOrderId: shopifyOrder.id.toString(),
      shopifyOrderNumber: shopifyOrder.order_number?.toString(),
      shopifyFinancialStatus: shopifyOrder.financial_status,
      shopifyFulfillmentStatus: shopifyOrder.fulfillment_status,
      shopifyTags: shopifyOrder.tags,
      shopifyCurrency: shopifyOrder.currency || 'USD',
      shopifySyncedAt: new Date(),

      // External references
      externalOrderId: shopifyOrder.id.toString(),
      orderSource: 'shopify',
      tags: shopifyOrder.tags ? shopifyOrder.tags.split(',').map((tag: string) => tag.trim()).filter(Boolean) : null,
    }).returning();

    // Process notes - create entries in notes table
    const notesToInsert = [];

    // Add order note if exists
    if (shopifyOrder.note) {
      notesToInsert.push({
        organizationId,
        entityType: 'order',
        entityId: newOrder.id,
        noteType: 'order_note',
        noteSource: 'shopify',
        title: 'Order Note',
        content: shopifyOrder.note,
        visibility: 'internal',
        priority: 1,
      });
    }

    // Process note_attributes
    if (shopifyOrder.note_attributes && Array.isArray(shopifyOrder.note_attributes)) {
      for (const attr of shopifyOrder.note_attributes) {
        if (!attr.name || !attr.value) continue;

        // Determine note type based on attribute name
        let noteType = 'custom_attribute';
        let visibility = 'internal';
        let priority = 0;

        const lowerName = attr.name.toLowerCase();
        if (lowerName.includes('gift') && lowerName.includes('note')) {
          noteType = 'gift_note';
          visibility = 'customer';
          priority = 10;
        } else if (lowerName.includes('delivery') || lowerName.includes('location')) {
          noteType = 'delivery_instruction';
          priority = 5;
        } else if (lowerName === 'delivery day' || lowerName === 'delivery-day') {
          noteType = 'delivery_instruction';
          priority = 5;
        } else if (lowerName === 'checkout method' || lowerName === 'checkout-method') {
          noteType = 'delivery_instruction';
          priority = 5;
        }

        notesToInsert.push({
          organizationId,
          entityType: 'order',
          entityId: newOrder.id,
          noteType,
          noteSource: 'shopify',
          title: attr.name,
          content: attr.value,
          visibility,
          priority,
          shopifyAttributeName: attr.name,
        });
      }
    }

    // Insert all order notes
    if (notesToInsert.length > 0) {
      await db.insert(notes).values(notesToInsert);
    }

    // Create order items
    if (shopifyOrder.line_items?.length > 0) {
      await createOrderItems(shopifyOrder.line_items, newOrder.id, organizationId);
    }

    // Process Shopify tags and link to order
    if (shopifyOrder.tags) {
      await processOrderTags(organizationId, newOrder.id, shopifyOrder.tags);
    }

    return newOrder.id;
  } catch (error) {
    console.error('Failed to create internal order:', error);
    return undefined;
  }
}

/**
 * Extract or create customer from Shopify order
 */
async function extractOrCreateCustomer(
  shopifyOrder: any,
  organizationId: string
): Promise<string | undefined> {
  if (!shopifyOrder.customer && !shopifyOrder.email) {
    return undefined;
  }

  const email = shopifyOrder.customer?.email || shopifyOrder.email;
  const phone = shopifyOrder.customer?.phone || shopifyOrder.phone;

  // Try to find existing customer
  const existingCustomer = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, organizationId),
        or(
          email ? eq(customers.email, email) : undefined,
          phone ? eq(customers.phone, phone) : undefined
        )
      )
    )
    .limit(1);

  if (existingCustomer[0]) {
    return existingCustomer[0].id;
  }

  // Create new customer
  const customerData = shopifyOrder.customer || {};
  const address = customerData.default_address || shopifyOrder.billing_address || {};

  const [newCustomer] = await db.insert(customers).values({
    organizationId,
    firstName: customerData.first_name || address.first_name || '',
    lastName: customerData.last_name || address.last_name || '',
    email: email || null,
    phone: phone || null,
    address: formatAddress(address),
    city: address.city || null,
    state: address.province || null,
    zipCode: address.zip || null,
    country: address.country || null,
    shopifyCustomerId: customerData.id?.toString() || null,
    tags: customerData.tags || null,
    acceptsMarketing: customerData.email_marketing_consent?.state === 'subscribed',
    source: 'shopify',
  }).returning();

  return newCustomer.id;
}

/**
 * Create order items from Shopify line items
 */
async function createOrderItems(
  lineItems: any[],
  orderId: string,
  organizationId: string
): Promise<void> {
  for (let index = 0; index < lineItems.length; index++) {
    const item = lineItems[index];

    // Look up the variant to get product mapping
    let itemType: 'custom' | 'recipe' | 'inventory' = 'custom';
    let recipeId: string | null = null;
    let recipeVariantId: string | null = null;
    let inventoryItemId: string | null = null;

    // Try to find recipe mapping through multiple approaches
    if (item.variant_id) {
      const variantIdStr = item.variant_id?.toString();
      const productIdStr = item.product_id?.toString();

      // First, check if there's a recipe variant directly mapped to this Shopify variant
      const [mappedRecipeVariant] = await db
        .select()
        .from(recipeVariants)
        .where(
          and(
            eq(recipeVariants.organizationId, organizationId),
            eq(recipeVariants.shopifyVariantId, variantIdStr)
          )
        )
        .limit(1);

      if (mappedRecipeVariant) {
        // Found a direct recipe variant mapping
        itemType = 'recipe';
        recipeId = mappedRecipeVariant.recipeId;
        recipeVariantId = mappedRecipeVariant.id;
      } else if (productIdStr) {
        // Check if the Shopify product is mapped to a recipe
        const [mappedProduct] = await db
          .select()
          .from(shopifyProducts)
          .where(
            and(
              eq(shopifyProducts.organizationId, organizationId),
              eq(shopifyProducts.shopifyProductId, productIdStr)
            )
          )
          .limit(1);

        if (mappedProduct?.internalRecipeId) {
          // Product is mapped to a recipe
          itemType = 'recipe';
          recipeId = mappedProduct.internalRecipeId;

          // Try to find the corresponding recipe variant based on position or title
          const recipeVariantsList = await db
            .select()
            .from(recipeVariants)
            .where(
              and(
                eq(recipeVariants.organizationId, organizationId),
                eq(recipeVariants.recipeId, mappedProduct.internalRecipeId)
              )
            )
            .orderBy(recipeVariants.sortOrder);

          // Match by variant title or position
          const variantTitle = item.variant_title || '';
          for (const rv of recipeVariantsList) {
            if (rv.shopifyVariantId === variantIdStr ||
                rv.name === variantTitle ||
                rv.name === item.title) {
              recipeVariantId = rv.id;
              break;
            }
          }

          // If no specific variant matched, use the default variant
          if (!recipeVariantId && recipeVariantsList.length > 0) {
            const defaultVariant = recipeVariantsList.find(v => v.isDefault) || recipeVariantsList[0];
            recipeVariantId = defaultVariant.id;
          }
        }
      }

      // Also check the shopifyVariants table for any mappings (backward compatibility)
      if (!recipeId) {
        const [variant] = await db
          .select()
          .from(shopifyVariants)
          .where(
            and(
              eq(shopifyVariants.organizationId, organizationId),
              eq(shopifyVariants.shopifyVariantId, variantIdStr)
            )
          )
          .limit(1);

        if (variant) {
          if (variant.internalRecipeVariantId) {
            const [recipeVariant] = await db
              .select()
              .from(recipeVariants)
              .where(eq(recipeVariants.id, variant.internalRecipeVariantId))
              .limit(1);

            if (recipeVariant) {
              itemType = 'recipe';
              recipeId = recipeVariant.recipeId;
              recipeVariantId = variant.internalRecipeVariantId;
            }
          } else if (variant.internalRecipeId) {
            itemType = 'recipe';
            recipeId = variant.internalRecipeId;
          } else if (variant.internalInventoryItemId) {
            itemType = 'inventory';
            inventoryItemId = variant.internalInventoryItemId;
          }
        }
      }
    }

    // Create the order item with proper linking
    const [orderItem] = await db.insert(orderItems).values({
      orderId,
      organizationId,
      itemType,
      recipeId,
      recipeVariantId,
      inventoryItemId,
      name: item.title || item.name || 'Unnamed Item',
      description: item.variant_title || null,
      quantity: item.quantity || 1,
      unitPrice: item.price || '0',
      subtotal: (parseFloat(item.price || '0') * (item.quantity || 1)).toFixed(2),
      externalItemId: item.id?.toString(),
      externalSku: item.sku || null,
      // Store Shopify product and variant IDs directly in columns
      shopifyProductId: item.product_id?.toString() || null,
      shopifyVariantId: item.variant_id?.toString() || null,
      // Also store in metadata for backward compatibility
      metadata: JSON.stringify({
        shopifyProductId: item.product_id?.toString(),
        shopifyVariantId: item.variant_id?.toString(),
      }),
    }).returning();

    // Process line item properties as notes
    if (item.properties && Array.isArray(item.properties)) {
      const itemNotes = [];
      for (const prop of item.properties) {
        if (!prop.name || !prop.value) continue;

        // Determine note type
        let noteType = 'custom_attribute';
        let visibility = 'internal';
        let priority = 0;

        const lowerName = prop.name.toLowerCase();
        if (lowerName.includes('handwritten') || lowerName.includes('card')) {
          noteType = 'handwritten_card';
          visibility = 'customer';
          priority = 10;
        }

        itemNotes.push({
          organizationId,
          entityType: 'orderItem',
          entityId: orderItem.id,
          noteType,
          noteSource: 'shopify',
          title: prop.name,
          content: prop.value,
          visibility,
          priority,
          shopifyLineItemId: item.id?.toString(),
          metadata: { lineItemName: item.title || item.name },
        });
      }

      if (itemNotes.length > 0) {
        await db.insert(notes).values(itemNotes);
      }
    }
  }
}

/**
 * Update an existing internal order from Shopify order data
 */
async function updateInternalOrder(
  shopifyOrder: any,
  internalOrderId: string,
  organizationId: string
): Promise<void> {
  try {
    // Extract pickup and delivery info
    const pickupInfo = extractPickupInfo(shopifyOrder.note_attributes);
    const dueDate = pickupInfo.date || new Date().toISOString().split('T')[0];

    // Determine fulfillment type
    let fulfillmentType = 'pickup';
    if (pickupInfo.deliveryInfo?.checkoutMethod === 'delivery') {
      fulfillmentType = 'delivery';
    } else if (shopifyOrder.shipping_lines?.length > 0) {
      const shippingTitle = shopifyOrder.shipping_lines[0].title?.toLowerCase() || '';
      if (shippingTitle.includes('delivery')) fulfillmentType = 'delivery';
      else if (shippingTitle.includes('shipping')) fulfillmentType = 'shipping';
    }

    // Normalize addresses to handle both snake_case and camelCase
    const shippingAddr = normalizeAddress(shopifyOrder.shipping_address);
    const billingAddr = normalizeAddress(shopifyOrder.billing_address);

    // Update the order with latest Shopify data
    await db
      .update(orders)
      .set({
        customerName: getCustomerName(shopifyOrder),
        customerEmail: shopifyOrder.email || shopifyOrder.customer?.email || null,
        customerPhone: shopifyOrder.phone || shopifyOrder.customer?.phone || null,
        status: mapShopifyStatus(shopifyOrder.financial_status, shopifyOrder.fulfillment_status, shopifyOrder),
        orderDate: new Date(shopifyOrder.created_at),
        dueDate,
        dueTime: pickupInfo.time,
        fulfillmentType,
        deliveryAddress: formatAddress(shopifyOrder.shipping_address),

        // Update shipping address fields (normalized)
        shippingName: shippingAddr.name,
        shippingPhone: shippingAddr.phone,
        shippingEmail: shopifyOrder.email,
        shippingAddress1: shippingAddr.address1,
        shippingAddress2: shippingAddr.address2,
        shippingCity: shippingAddr.city,
        shippingState: shippingAddr.province,
        shippingZip: shippingAddr.zip,
        shippingCountry: shippingAddr.country,
        shippingCompany: shippingAddr.company,

        // Update billing address fields (normalized)
        billingName: billingAddr.name,
        billingPhone: billingAddr.phone,
        billingEmail: shopifyOrder.billing_address?.email || shopifyOrder.email,
        billingAddress1: billingAddr.address1,
        billingAddress2: billingAddr.address2,
        billingCity: billingAddr.city,
        billingState: billingAddr.province,
        billingZip: billingAddr.zip,
        billingCountry: billingAddr.country,
        billingCompany: billingAddr.company,

        // Update pricing
        subtotal: shopifyOrder.subtotal_price || '0',
        taxAmount: shopifyOrder.total_tax || '0',
        discountAmount: shopifyOrder.total_discounts || '0',
        total: shopifyOrder.total_price || '0',
        deliveryFee: shopifyOrder.shipping_lines?.[0]?.price || '0',
        paymentStatus: mapPaymentStatus(shopifyOrder.financial_status),

        // Update Shopify-specific fields
        shopifyOrderNumber: shopifyOrder.order_number?.toString(),
        shopifyFinancialStatus: shopifyOrder.financial_status,
        shopifyFulfillmentStatus: shopifyOrder.fulfillment_status,
        shopifyTags: shopifyOrder.tags,
        shopifyCurrency: shopifyOrder.currency,
        shopifySyncedAt: new Date(),

        tags: shopifyOrder.tags ? shopifyOrder.tags.split(',').map((tag: string) => tag.trim()).filter(Boolean) : null,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, internalOrderId));

    // Update or create notes
    await syncOrderNotes(shopifyOrder, internalOrderId, organizationId);

    // Process Shopify tags and link to order
    if (shopifyOrder.tags) {
      await processOrderTags(organizationId, internalOrderId, shopifyOrder.tags);
    }

    console.log(`Updated internal order ${internalOrderId} with latest Shopify data`);
  } catch (error) {
    console.error('Failed to update internal order:', error);
  }
}

/**
 * Sync notes for an order - update existing or create new ones
 */
async function syncOrderNotes(
  shopifyOrder: any,
  orderId: string,
  organizationId: string
): Promise<void> {
  // Delete existing notes for this order to avoid duplicates
  // (In production, you might want to update instead of delete/recreate)
  await db.delete(notes).where(
    and(
      eq(notes.entityType, 'order'),
      eq(notes.entityId, orderId)
    )
  );

  const notesToInsert = [];

  // Add order note if exists
  if (shopifyOrder.note) {
    notesToInsert.push({
      organizationId,
      entityType: 'order',
      entityId: orderId,
      noteType: 'order_note',
      noteSource: 'shopify',
      title: 'Order Note',
      content: shopifyOrder.note,
      visibility: 'internal',
      priority: 1,
    });
  }

  // Process note_attributes
  if (shopifyOrder.note_attributes && Array.isArray(shopifyOrder.note_attributes)) {
    for (const attr of shopifyOrder.note_attributes) {
      if (!attr.name || !attr.value) continue;

      let noteType = 'custom_attribute';
      let visibility = 'internal';
      let priority = 0;

      const lowerName = attr.name.toLowerCase();
      if (lowerName.includes('gift') && lowerName.includes('note')) {
        noteType = 'gift_note';
        visibility = 'customer';
        priority = 10;
      } else if (lowerName.includes('delivery') || lowerName.includes('location')) {
        noteType = 'delivery_instruction';
        priority = 5;
      }

      notesToInsert.push({
        organizationId,
        entityType: 'order',
        entityId: orderId,
        noteType,
        noteSource: 'shopify',
        title: attr.name,
        content: attr.value,
        visibility,
        priority,
        shopifyAttributeName: attr.name,
      });
    }
  }

  // Insert all notes
  if (notesToInsert.length > 0) {
    await db.insert(notes).values(notesToInsert);
  }
}

/**
 * Map Shopify order status to internal status
 */
function mapShopifyStatus(financialStatus: string, fulfillmentStatus?: string, shopifyOrder?: any): string {
  // Handle cancelled orders
  if (shopifyOrder?.cancelled_at) {
    return 'cancelled';
  }

  // Handle draft orders
  if (shopifyOrder?.source_name === 'shopify_draft_order') {
    return financialStatus === 'paid' ? 'confirmed' : 'draft';
  }

  // Standard order status mapping
  if (financialStatus === 'pending' || financialStatus === 'authorized') {
    return 'pending';
  }
  if (fulfillmentStatus === 'fulfilled') {
    return 'completed';
  }
  if (financialStatus === 'paid') {
    return fulfillmentStatus === 'partial' ? 'in_progress' : 'confirmed';
  }
  if (financialStatus === 'refunded' || financialStatus === 'voided') {
    return 'cancelled';
  }
  return 'pending';
}

/**
 * Map Shopify financial status to payment status
 */
function mapPaymentStatus(financialStatus: string): string {
  switch (financialStatus) {
    case 'paid':
      return 'paid';
    case 'partially_paid':
      return 'partial';
    case 'refunded':
    case 'partially_refunded':
      return 'refunded';
    default:
      return 'pending';
  }
}

/**
 * Format address for storage
 */
function formatAddress(address: any): string | null {
  if (!address) return null;

  const parts = [
    address.address1,
    address.address2,
    address.city,
    address.province || address.state,
    address.zip || address.postal_code,
    address.country,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Process Shopify tags and link them to order via polymorphic tags system
 * This function handles get-or-create for tags and links them to the order
 */
async function processOrderTags(
  organizationId: string,
  orderId: string,
  shopifyTagsString: string
): Promise<void> {
  try {
    if (!shopifyTagsString || shopifyTagsString.trim() === '') {
      return;
    }

    // Parse Shopify tags (comma-separated)
    const tagNames = shopifyTagsString
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0);

    if (tagNames.length === 0) {
      return;
    }

    // Normalize tag names for lookup (lowercase)
    const normalizedTagNames = tagNames.map(name => name.toLowerCase());

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

    // Create missing tags
    const tagsToCreate = tagNames
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
      const newTags = await db
        .insert(tags)
        .values(tagsToCreate)
        .onConflictDoNothing({
          target: [tags.organizationId, tags.name],
        })
        .returning();

      // Add new tags to the map
      newTags.forEach(tag => {
        existingTagMap.set(tag.name, tag);
      });

      // If some tags were skipped due to conflict, fetch them
      if (newTags.length < tagsToCreate.length) {
        const skippedTagNames = tagsToCreate
          .filter(t => !newTags.find(nt => nt.name === t.name))
          .map(t => t.name);

        const skippedTags = await db
          .select()
          .from(tags)
          .where(
            and(
              eq(tags.organizationId, organizationId),
              inArray(tags.name, skippedTagNames)
            )
          );

        skippedTags.forEach(tag => {
          existingTagMap.set(tag.name, tag);
        });
      }
    }

    // Remove existing taggables for this order to avoid duplicates
    await db
      .delete(taggables)
      .where(
        and(
          eq(taggables.taggableType, 'order'),
          eq(taggables.taggableId, orderId)
        )
      );

    // Link tags to order via taggables table
    const taggablesToInsert = tagNames
      .map(tagName => {
        const tag = existingTagMap.get(tagName.toLowerCase());
        if (!tag) return null;

        return {
          tagId: tag.id,
          taggableType: 'order' as const,
          taggableId: orderId,
          createdAt: new Date(),
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);

    if (taggablesToInsert.length > 0) {
      await db
        .insert(taggables)
        .values(taggablesToInsert)
        .onConflictDoNothing();

      // Update usage counts for tags
      const tagIds = Array.from(new Set(taggablesToInsert.map(t => t.tagId)));

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
    }
  } catch (error) {
    console.error('Error processing order tags:', error);
    // Don't throw - tag processing failure shouldn't block order sync
  }
}