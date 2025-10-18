import { db } from "@/db/drizzle";
import { shopifyOrders } from "@/db/schema";
import { sql } from "drizzle-orm";

interface ShopifyOrderSyncResult {
  shopifyOrderId: string;
  internalOrderId?: string;
  status: 'created' | 'updated' | 'skipped' | 'error';
  error?: string;
}

/**
 * Batch sync Shopify orders to the shopify_orders table
 * Processes all orders in a single database transaction for efficiency
 */
export async function batchSyncShopifyOrders(
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

  if (shopifyOrdersData.length === 0) {
    return { success, failed, skipped, results };
  }

  try {
    // Prepare all order data for batch insert
    const orderValues = shopifyOrdersData.map(shopifyOrder => {
      const shopifyOrderId = shopifyOrder.id.toString();
      const pickupInfo = extractPickupInfo(shopifyOrder.note_attributes);

      return {
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
        financialStatus: shopifyOrder.financial_status || 'pending',
        fulfillmentStatus: shopifyOrder.fulfillment_status || null,
        cancelReason: shopifyOrder.cancel_reason || null,
        currency: shopifyOrder.currency || 'USD',
        totalPrice: shopifyOrder.total_price || '0',
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
        rawData: shopifyOrder,
        apiVersion: "2024-10",
        syncedAt: new Date(),
        updatedAt: new Date(),
        // Internal order ID will be handled separately
        internalOrderId: null,
      };
    });

    // Batch upsert all orders
    if (orderValues.length > 0) {
      await db
        .insert(shopifyOrders)
        .values(orderValues)
        .onConflictDoUpdate({
          target: [shopifyOrders.organizationId, shopifyOrders.shopifyOrderId],
          set: {
            shopifyOrderNumber: sql`excluded.shopify_order_number`,
            name: sql`excluded.name`,
            shopifyCreatedAt: sql`excluded.shopify_created_at`,
            shopifyUpdatedAt: sql`excluded.shopify_updated_at`,
            shopifyCancelledAt: sql`excluded.shopify_cancelled_at`,
            customerEmail: sql`excluded.customer_email`,
            customerPhone: sql`excluded.customer_phone`,
            customerName: sql`excluded.customer_name`,
            shopifyCustomerId: sql`excluded.shopify_customer_id`,
            financialStatus: sql`excluded.financial_status`,
            fulfillmentStatus: sql`excluded.fulfillment_status`,
            cancelReason: sql`excluded.cancel_reason`,
            currency: sql`excluded.currency`,
            totalPrice: sql`excluded.total_price`,
            subtotalPrice: sql`excluded.subtotal_price`,
            totalTax: sql`excluded.total_tax`,
            totalDiscounts: sql`excluded.total_discounts`,
            tags: sql`excluded.tags`,
            note: sql`excluded.note`,
            sourceUrl: sql`excluded.source_url`,
            sourceName: sql`excluded.source_name`,
            test: sql`excluded.test`,
            pickupDate: sql`excluded.pickup_date`,
            pickupTime: sql`excluded.pickup_time`,
            pickupLocation: sql`excluded.pickup_location`,
            pickupLocationAddress: sql`excluded.pickup_location_address`,
            rawData: sql`excluded.raw_data`,
            apiVersion: sql`excluded.api_version`,
            syncedAt: sql`excluded.synced_at`,
            updatedAt: sql`excluded.updated_at`,
            // Preserve existing internal order ID if it exists
            internalOrderId: sql`COALESCE(shopify_orders.internal_order_id, excluded.internal_order_id)`,
          },
        });

      // Mark all as successful
      success = orderValues.length;

      // Create results for each order
      for (const shopifyOrder of shopifyOrdersData) {
        results.push({
          shopifyOrderId: shopifyOrder.id.toString(),
          status: 'created',
        });
      }
    }

    console.log(`[ORDER SYNC] Batch synced ${success} orders for org ${organizationId}`);

  } catch (error) {
    console.error(`[ORDER SYNC] Batch sync failed:`, error);
    // If batch fails, we could fall back to individual inserts
    // but for now, mark all as failed
    failed = shopifyOrdersData.length;
    for (const shopifyOrder of shopifyOrdersData) {
      results.push({
        shopifyOrderId: shopifyOrder.id.toString(),
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return { success, failed, skipped, results };
}

// Helper function to extract pickup information from note attributes
function extractPickupInfo(noteAttributes: any[]): {
  date: string | null;
  time: string | null;
  location: string | null;
  address: string | null;
} {
  if (!noteAttributes || !Array.isArray(noteAttributes)) {
    return { date: null, time: null, location: null, address: null };
  }

  let date = null;
  let time = null;
  let location = null;
  let address = null;

  for (const attr of noteAttributes) {
    const name = attr.name?.toLowerCase() || '';
    const value = attr.value || '';

    if (name.includes('pickup') && name.includes('date')) {
      date = value;
    } else if (name.includes('pickup') && name.includes('time')) {
      time = value;
    } else if (name.includes('pickup') && name.includes('location')) {
      if (name.includes('address')) {
        address = value;
      } else {
        location = value;
      }
    } else if (name === 'pickup-location-id' || name === 'pickup_location_id') {
      location = value;
    }
  }

  return { date, time, location, address };
}

// Helper function to get customer name
function getCustomerName(shopifyOrder: any): string | null {
  if (shopifyOrder.customer) {
    const firstName = shopifyOrder.customer.first_name || '';
    const lastName = shopifyOrder.customer.last_name || '';
    const fullName = `${firstName} ${lastName}`.trim();
    if (fullName) return fullName;
    return shopifyOrder.customer.name || null;
  }

  // Fallback to billing address name
  if (shopifyOrder.billing_address) {
    const firstName = shopifyOrder.billing_address.first_name || '';
    const lastName = shopifyOrder.billing_address.last_name || '';
    const fullName = `${firstName} ${lastName}`.trim();
    if (fullName) return fullName;
    return shopifyOrder.billing_address.name || null;
  }

  // Fallback to shipping address name
  if (shopifyOrder.shipping_address) {
    const firstName = shopifyOrder.shipping_address.first_name || '';
    const lastName = shopifyOrder.shipping_address.last_name || '';
    const fullName = `${firstName} ${lastName}`.trim();
    if (fullName) return fullName;
    return shopifyOrder.shipping_address.name || null;
  }

  return null;
}