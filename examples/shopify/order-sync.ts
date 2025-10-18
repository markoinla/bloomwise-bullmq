import { db } from "@/db/drizzle";
import { customers, orders, orderItems, shopifySyncLog } from "@/db/schema";
import { eq, and, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { errorLogger } from "@/lib/error-logger";

// Shopify Order Types
interface ShopifyOrder {
  id: number | string;
  order_number: number;
  name: string;
  email?: string;
  phone?: string;
  created_at: string;
  updated_at: string;
  cancelled_at?: string;
  cancel_reason?: string;
  financial_status: string;
  fulfillment_status?: string;
  currency: string;
  tags?: string;
  note?: string;
  total_price: string;
  subtotal_price: string;
  total_tax: string;
  total_discounts: string;
  customer?: {
    id: number | string;
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    total_spent?: string;
    orders_count?: number;
    tags?: string;
    accepts_marketing?: boolean;
    default_address?: ShopifyAddress;
  };
  shipping_address?: ShopifyAddress;
  billing_address?: ShopifyAddress;
  line_items: ShopifyLineItem[];
  shipping_lines?: ShopifyShippingLine[];
}

interface ShopifyAddress {
  first_name?: string;
  last_name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  province_code?: string;
  country?: string;
  country_code?: string;
  zip?: string;
  phone?: string;
}

interface ShopifyLineItem {
  id: number | string;
  product_id?: number | string;
  variant_id?: number | string;
  title: string;
  variant_title?: string;
  quantity: number;
  price: string;
  sku?: string;
  vendor?: string;
  fulfillment_status?: string;
  properties?: Array<{ name: string; value: string }>;
}

interface ShopifyShippingLine {
  id: number | string;
  title: string;
  price: string;
  code?: string;
}

// Status mapping functions
export function mapShopifyOrderStatus(shopifyOrder: ShopifyOrder): string {
  // Map financial and fulfillment status to our order status
  const { financial_status, fulfillment_status, cancelled_at } = shopifyOrder;

  if (cancelled_at) return "cancelled";

  // Map based on financial status first
  const financialStatusMap: Record<string, string> = {
    pending: "pending",
    authorized: "confirmed",
    paid: fulfillment_status === "fulfilled" ? "completed" : "confirmed",
    partially_paid: "confirmed",
    refunded: "cancelled",
    voided: "cancelled",
  };

  // Then consider fulfillment status
  if (fulfillment_status === "fulfilled") {
    return "completed";
  } else if (fulfillment_status === "partial") {
    return "in_progress";
  }

  return financialStatusMap[financial_status] || "pending";
}

export function mapPaymentStatus(financial_status: string): string {
  const statusMap: Record<string, string> = {
    pending: "pending",
    authorized: "pending",
    paid: "paid",
    partially_paid: "partial",
    refunded: "refunded",
    voided: "pending",
  };
  return statusMap[financial_status] || "pending";
}

export function mapFulfillmentType(shopifyOrder: ShopifyOrder): string {
  // Determine fulfillment type based on shipping info
  if (shopifyOrder.shipping_lines && shopifyOrder.shipping_lines.length > 0) {
    const shippingCode = shopifyOrder.shipping_lines[0].code?.toLowerCase() || "";
    if (shippingCode.includes("pickup") || shippingCode.includes("local")) {
      return "pickup";
    } else if (shippingCode.includes("delivery")) {
      return "delivery";
    }
    return "shipping";
  }

  // Default based on address presence
  return shopifyOrder.shipping_address ? "shipping" : "pickup";
}

// Customer extraction and creation
export async function extractOrCreateCustomer(
  shopifyOrder: ShopifyOrder,
  organizationId: string
): Promise<string> {
  try {
    const shopifyCustomer = shopifyOrder.customer;

    // Build customer data
    const customerEmail = shopifyCustomer?.email || shopifyOrder.email;
    const customerPhone = shopifyCustomer?.phone || shopifyOrder.phone;

    if (!customerEmail && !customerPhone) {
      // Create a guest customer
      const guestCustomer = await db.insert(customers).values({
        organizationId,
        firstName: shopifyOrder.billing_address?.first_name || "Guest",
        lastName: shopifyOrder.billing_address?.last_name || "Customer",
        source: "shopify",
        shopifyCustomerId: shopifyCustomer?.id?.toString(),
        notes: `Guest customer from Shopify order ${shopifyOrder.name}`,
      }).returning();

      return guestCustomer[0].id;
    }

    // Try to find existing customer
    const existingCustomer = await db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.organizationId, organizationId),
          or(
            shopifyCustomer?.id
              ? eq(customers.shopifyCustomerId, shopifyCustomer.id.toString())
              : undefined,
            customerEmail
              ? eq(customers.email, customerEmail)
              : undefined,
            customerPhone
              ? eq(customers.phone, customerPhone)
              : undefined
          )
        )
      )
      .limit(1);

    if (existingCustomer[0]) {
      // Update customer with latest Shopify data
      await db
        .update(customers)
        .set({
          shopifyCustomerId: shopifyCustomer?.id?.toString() || existingCustomer[0].shopifyCustomerId,
          totalSpent: shopifyCustomer?.total_spent || existingCustomer[0].totalSpent,
          ordersCount: shopifyCustomer?.orders_count || existingCustomer[0].ordersCount,
          shopifyTags: shopifyCustomer?.tags || existingCustomer[0].shopifyTags,
          acceptsMarketing: shopifyCustomer?.accepts_marketing ?? existingCustomer[0].acceptsMarketing,
          updatedAt: new Date(),
        })
        .where(eq(customers.id, existingCustomer[0].id));

      return existingCustomer[0].id;
    }

    // Create new customer
    const address = shopifyCustomer?.default_address || shopifyOrder.shipping_address || shopifyOrder.billing_address;

    const newCustomer = await db.insert(customers).values({
      organizationId,
      firstName: shopifyCustomer?.first_name || address?.first_name || "Unknown",
      lastName: shopifyCustomer?.last_name || address?.last_name || "Customer",
      email: customerEmail,
      phone: customerPhone,
      addressLine1: address?.address1,
      addressLine2: address?.address2,
      city: address?.city,
      state: address?.province,
      postalCode: address?.zip,
      country: address?.country_code || "US",
      shopifyCustomerId: shopifyCustomer?.id?.toString(),
      shopifyTags: shopifyCustomer?.tags,
      totalSpent: shopifyCustomer?.total_spent,
      ordersCount: shopifyCustomer?.orders_count || 1,
      acceptsMarketing: shopifyCustomer?.accepts_marketing || false,
      source: "shopify",
    }).returning();

    return newCustomer[0].id;
  } catch (error) {
    console.error("Error extracting customer:", error);
    await errorLogger.logSync(
      `Failed to extract customer from order ${shopifyOrder.name}`,
      organizationId,
      { error: error instanceof Error ? error.message : String(error) }
    );
    throw error;
  }
}

// Create or update order
export async function syncShopifyOrder(
  shopifyOrder: ShopifyOrder,
  organizationId: string,
  options: { skipExisting?: boolean } = {}
): Promise<string> {
  try {
    // Check if order already exists
    const existingOrder = await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.organizationId, organizationId),
          eq(orders.externalOrderId, shopifyOrder.id.toString()) // Use externalOrderId to match the unique constraint
        )
      )
      .limit(1);

    if (existingOrder[0]) {
      if (options.skipExisting) {
        return existingOrder[0].id;
      }

      // Update existing order
      await db
        .update(orders)
        .set({
          status: mapShopifyOrderStatus(shopifyOrder),
          paymentStatus: mapPaymentStatus(shopifyOrder.financial_status),
          shopifyFinancialStatus: shopifyOrder.financial_status,
          shopifyFulfillmentStatus: shopifyOrder.fulfillment_status || null,
          shopifyTags: shopifyOrder.tags || null,
          shopifySyncedAt: new Date(),
          cancelledAt: shopifyOrder.cancelled_at ? new Date(shopifyOrder.cancelled_at) : null,
          cancellationReason: shopifyOrder.cancel_reason || null,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, existingOrder[0].id));

      return existingOrder[0].id;
    }

    // Extract or create customer
    const customerId = await extractOrCreateCustomer(shopifyOrder, organizationId);

    // Get customer details for order
    const customer = await db
      .select()
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);

    const customerData = customer[0];

    // Calculate due date (default to 3 days from order for florist arrangements)
    const orderDate = new Date(shopifyOrder.created_at);
    const dueDate = new Date(orderDate);
    dueDate.setDate(dueDate.getDate() + 3);

    // Format delivery address
    const shippingAddr = shopifyOrder.shipping_address;
    const deliveryAddress = shippingAddr
      ? `${shippingAddr.address1}${shippingAddr.address2 ? `, ${shippingAddr.address2}` : ""}, ${shippingAddr.city}, ${shippingAddr.province} ${shippingAddr.zip}`
      : null;

    // Create the order
    const newOrder = await db.insert(orders).values({
      organizationId,
      orderNumber: shopifyOrder.order_number?.toString() || shopifyOrder.name?.replace(/^#/, ''),
      customerId,
      customerName: `${customerData.firstName} ${customerData.lastName}`,
      customerEmail: customerData.email,
      customerPhone: customerData.phone,
      status: mapShopifyOrderStatus(shopifyOrder),
      priority: "normal",
      orderDate: orderDate,
      dueDate: dueDate.toISOString().split("T")[0],
      fulfillmentType: mapFulfillmentType(shopifyOrder),
      deliveryAddress,
      deliveryInstructions: shopifyOrder.note,
      subtotal: shopifyOrder.subtotal_price,
      taxAmount: shopifyOrder.total_tax,
      discountAmount: shopifyOrder.total_discounts,
      total: shopifyOrder.total_price,
      paymentStatus: mapPaymentStatus(shopifyOrder.financial_status),
      paidAmount: shopifyOrder.financial_status === "paid" ? shopifyOrder.total_price : "0",
      orderSource: "shopify",
      shopifyOrderId: shopifyOrder.id.toString(),
      shopifyOrderNumber: shopifyOrder.order_number?.toString() || shopifyOrder.name.replace(/^#/, ''),
      shopifyFinancialStatus: shopifyOrder.financial_status,
      shopifyFulfillmentStatus: shopifyOrder.fulfillment_status || null,
      shopifyTags: shopifyOrder.tags || null,
      shopifyCurrency: shopifyOrder.currency,
      shopifySyncedAt: new Date(),
      customerNotes: shopifyOrder.note,
      createdAt: new Date(shopifyOrder.created_at),
      updatedAt: new Date(shopifyOrder.updated_at),
    }).returning();

    const orderId = newOrder[0].id;

    // Create order items
    for (const lineItem of shopifyOrder.line_items) {
      await db.insert(orderItems).values({
        organizationId,
        orderId,
        itemType: "custom", // Will be mapped to recipes later
        name: lineItem.title + (lineItem.variant_title ? ` - ${lineItem.variant_title}` : ""),
        quantity: lineItem.quantity,
        unitPrice: lineItem.price,
        subtotal: (parseFloat(lineItem.price) * lineItem.quantity).toFixed(2),
        externalItemId: lineItem.id?.toString(),
        externalSku: lineItem.sku || null,
        customizations: lineItem.properties && lineItem.properties.length > 0
          ? { properties: lineItem.properties }
          : null,
        notes: lineItem.properties
          ?.map((p) => `${p.name}: ${p.value}`)
          .join(", "),
      });
    }

    return orderId;
  } catch (error) {
    console.error("Error syncing Shopify order:", error);
    await errorLogger.logSync(
      `Failed to sync order ${shopifyOrder.name}`,
      organizationId,
      {
        orderId: shopifyOrder.id,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    throw error;
  }
}

// Batch sync orders
export async function syncShopifyOrders(
  shopifyOrders: ShopifyOrder[],
  organizationId: string,
  options: { skipExisting?: boolean } = {}
): Promise<{ success: number; failed: number; errors: any[] }> {
  const results = {
    success: 0,
    failed: 0,
    errors: [] as any[],
  };

  // Log sync start
  const syncLog = await db.insert(shopifySyncLog).values({
    organizationId,
    syncType: "orders",
    status: "in_progress",
    itemsCount: shopifyOrders.length,
    startedAt: new Date(),
  }).returning();

  const syncLogId = syncLog[0].id;

  for (const shopifyOrder of shopifyOrders) {
    try {
      await syncShopifyOrder(shopifyOrder, organizationId, options);
      results.success++;
    } catch (error) {
      results.failed++;
      results.errors.push({
        orderId: shopifyOrder.id,
        orderName: shopifyOrder.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Update sync log
  await db
    .update(shopifySyncLog)
    .set({
      status: results.failed === 0 ? "success" : "partial",
      itemsCount: results.success,
      error: results.failed > 0
        ? `Failed to sync ${results.failed} orders`
        : null,
      metadata: {
        successCount: results.success,
        failedCount: results.failed,
        errors: results.errors,
      },
      completedAt: new Date(),
    })
    .where(eq(shopifySyncLog.id, syncLogId));

  return results;
}