import { db } from "@/db/drizzle";
import {
  shopifyOrders,
  orders,
  orderItems,
  customers,
  shopifyProductMappings,
  shopifyRecipeVariantMappings,
  shopifyProducts,
  shopifyVariants,
  recipeVariants
} from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";

// Helper to format date as YYYY-MM-DD without timezone conversion
function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function syncShopifyOrdersToInternal(organizationId: string, batchSize: number = 250, forceUpdate: boolean = false) {
  const results = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [] as string[],
  };

  try {
    let hasMore = true;
    let batchNumber = 0;
    let processedCount = 0;

    while (hasMore) {
      // Get a batch of shopify_orders to sync
      const ordersToSync = forceUpdate
        ? await db
          .select()
          .from(shopifyOrders)
          .where(eq(shopifyOrders.organizationId, organizationId))
          .limit(batchSize)
          .offset(processedCount)
        : await db
          .select()
          .from(shopifyOrders)
          .where(
            and(
              eq(shopifyOrders.organizationId, organizationId),
              isNull(shopifyOrders.internalOrderId)
            )
          )
          .limit(batchSize);

      if (ordersToSync.length === 0) {
        hasMore = false;
        break;
      }

      batchNumber++;
      console.log(`Processing batch ${batchNumber}: ${ordersToSync.length} Shopify orders to sync`);

      for (const shopifyOrder of ordersToSync) {
      try {
        // First check if this order already exists in internal orders
        // Check by both shopifyOrderId and externalOrderId fields
        const existingOrder = await db
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.organizationId, organizationId),
              eq(orders.externalOrderId, shopifyOrder.shopifyOrderId)
            )
          )
          .limit(1);

        if (existingOrder.length > 0) {
          // Order already exists
          await db
            .update(shopifyOrders)
            .set({
              internalOrderId: existingOrder[0].id,
              updatedAt: new Date(),
            })
            .where(eq(shopifyOrders.id, shopifyOrder.id));

          if (!forceUpdate) {
            console.log(`Order ${shopifyOrder.shopifyOrderNumber} already exists in internal orders, skipping`);
            results.skipped++;
            continue;
          }

          // ForceUpdate is true, so update the existing internal order with fresh Shopify data
          console.log(`Force updating existing order ${shopifyOrder.shopifyOrderNumber}`);

          // Format delivery/shipping address if available
          let deliveryAddress: string | null = null;
          if (shopifyOrder.rawData) {
            const rawData = shopifyOrder.rawData as any;
            if (rawData.shipping_address) {
              const addr = rawData.shipping_address;
              const addressParts = [
                addr.address1,
                addr.address2,
                addr.city,
                addr.province,
                addr.zip,
                addr.country
              ].filter(Boolean);
              deliveryAddress = addressParts.join(', ');
            }
          }

          // Update the existing internal order
          await db
            .update(orders)
            .set({
              customerName: shopifyOrder.customerName || "Guest",
              customerEmail: shopifyOrder.customerEmail,
              customerPhone: shopifyOrder.customerPhone,
              deliveryAddress,
              updatedAt: new Date(),
            })
            .where(eq(orders.id, existingOrder[0].id));

          results.updated++;
          continue;
        }

        // Check if customer exists, create if not
        let customerId = null;
        if (shopifyOrder.customerEmail) {
          const existingCustomer = await db
            .select()
            .from(customers)
            .where(
              and(
                eq(customers.organizationId, organizationId),
                eq(customers.email, shopifyOrder.customerEmail)
              )
            )
            .limit(1);

          if (existingCustomer.length > 0) {
            customerId = existingCustomer[0].id;
          } else {
            // Parse customer name into first and last names
            const fullName = shopifyOrder.customerName || "Guest Customer";
            const nameParts = fullName.trim().split(' ');
            const firstName = nameParts[0] || "Guest";
            const lastName = nameParts.slice(1).join(' ') || "Customer";

            // Create new customer
            const newCustomer = await db
              .insert(customers)
              .values({
                organizationId,
                firstName,
                lastName,
                email: shopifyOrder.customerEmail,
                phone: shopifyOrder.customerPhone,
                metadata: {
                  shopifyCustomerId: shopifyOrder.shopifyCustomerId,
                  source: "shopify_sync",
                  fullName: shopifyOrder.customerName,
                },
              })
              .returning({ id: customers.id });

            customerId = newCustomer[0].id;
          }
        }

        // Extract line items from raw data
        const rawData = shopifyOrder.rawData as any;
        const lineItems = rawData?.line_items || [];

        // Calculate totals
        const subtotal = parseFloat(shopifyOrder.subtotalPrice.toString());
        const tax = parseFloat(shopifyOrder.totalTax.toString());
        const total = parseFloat(shopifyOrder.totalPrice.toString());

        // Determine fulfillment type
        let fulfillmentType: "pickup" | "delivery" | "shipping" = "pickup";
        if (shopifyOrder.pickupLocation) {
          fulfillmentType = "pickup";
        } else if (rawData?.shipping_lines?.length > 0) {
          const shippingTitle = rawData.shipping_lines[0].title?.toLowerCase() || "";
          if (shippingTitle.includes("delivery")) {
            fulfillmentType = "delivery";
          } else if (shippingTitle.includes("shipping")) {
            fulfillmentType = "shipping";
          }
        }

        // Calculate due date (use pickup date if available, otherwise 3 days from creation)
        let dueDate: Date;
        if (shopifyOrder.pickupDate) {
          dueDate = new Date(shopifyOrder.pickupDate);
        } else {
          dueDate = new Date(shopifyOrder.shopifyCreatedAt);
          dueDate.setDate(dueDate.getDate() + 3); // Default to 3 days after order creation
        }

        // Format delivery/shipping address if available
        let deliveryAddress: string | null = null;
        if (rawData?.shipping_address) {
          const addr = rawData.shipping_address;
          const addressParts = [
            addr.address1,
            addr.address2,
            addr.city,
            addr.province,
            addr.zip,
            addr.country
          ].filter(Boolean);
          deliveryAddress = addressParts.join(', ');
        }

        // Create internal order
        const [newOrder] = await db
          .insert(orders)
          .values({
            organizationId,
            customerId,
            customerName: shopifyOrder.customerName || "Guest",
            customerEmail: shopifyOrder.customerEmail,
            customerPhone: shopifyOrder.customerPhone,
            orderNumber: shopifyOrder.shopifyOrderNumber || shopifyOrder.name?.replace(/^#/, ''),
            status: mapFulfillmentStatus(shopifyOrder.fulfillmentStatus) as "draft" | "pending" | "confirmed" | "in_progress" | "ready" | "completed" | "cancelled",
            paymentStatus: mapFinancialStatus(shopifyOrder.financialStatus) as "pending" | "partial" | "paid" | "refunded",
            subtotal: subtotal.toString(),
            taxAmount: tax.toString(),
            total: total.toString(),
            internalNotes: shopifyOrder.note,
            dueDate: formatDateOnly(dueDate), // Format as YYYY-MM-DD
            dueTime: shopifyOrder.pickupTime,
            fulfillmentType,
            deliveryAddress, // Add the formatted shipping address
            orderSource: 'shopify',
            externalOrderId: shopifyOrder.shopifyOrderId, // Set the external order ID to prevent duplicates
            shopifyOrderId: shopifyOrder.shopifyOrderId, // Keep for backwards compatibility
            shopifyOrderNumber: shopifyOrder.shopifyOrderNumber,
            createdAt: new Date(shopifyOrder.shopifyCreatedAt),
            updatedAt: new Date(shopifyOrder.shopifyUpdatedAt),
          })
          .returning({ id: orders.id });

        // Create order items with proper recipe/variant linking
        for (const item of lineItems) {
          const itemPrice = parseFloat(item.price || "0");
          const itemQuantity = item.quantity || 1;
          const itemSubtotal = itemPrice * itemQuantity;

          // Extract Shopify product and variant IDs
          const shopifyProductId = item.product_id?.toString();
          const shopifyVariantId = item.variant_id?.toString();

          // Initialize item data
          let itemType: "recipe" | "custom" | "inventory" = "custom";
          let recipeId: string | null = null;
          let recipeVariantId: string | null = null;
          let variantId: string | null = null;

          // First, try to find a variant mapping (most specific)
          if (shopifyVariantId) {
            try {
              // Check if we have this Shopify variant mapped to a recipe variant
              const variantMapping = await db
                .select()
                .from(shopifyRecipeVariantMappings)
                .where(
                  and(
                    eq(shopifyRecipeVariantMappings.organizationId, organizationId),
                    eq(shopifyRecipeVariantMappings.shopifyVariantId, shopifyVariantId)
                  )
                )
                .limit(1);

              if (variantMapping.length > 0) {
                recipeVariantId = variantMapping[0].recipeVariantId;
                variantId = recipeVariantId; // Set for backward compatibility

                // Get the recipe from the variant
                const variant = await db
                  .select()
                  .from(recipeVariants)
                  .where(eq(recipeVariants.id, recipeVariantId))
                  .limit(1);

                if (variant.length > 0) {
                  recipeId = variant[0].recipeId;
                  itemType = "recipe";
                }
              }
            } catch (error) {
              console.log(`Could not find variant mapping for Shopify variant ${shopifyVariantId}:`, error);
            }
          }

          // If no variant mapping found, try product mapping
          if (itemType === "custom" && shopifyProductId) {
            try {
              const productMapping = await db
                .select()
                .from(shopifyProductMappings)
                .where(
                  and(
                    eq(shopifyProductMappings.organizationId, organizationId),
                    eq(shopifyProductMappings.shopifyProductId, shopifyProductId)
                  )
                )
                .limit(1);

              if (productMapping.length > 0 && productMapping[0].recipeId) {
                recipeId = productMapping[0].recipeId;
                itemType = "recipe";

                // If we have a Shopify variant but no variant mapping,
                // try to find the default recipe variant
                if (shopifyVariantId && !recipeVariantId) {
                  const defaultVariant = await db
                    .select()
                    .from(recipeVariants)
                    .where(
                      and(
                        eq(recipeVariants.recipeId, recipeId),
                        eq(recipeVariants.isDefault, true)
                      )
                    )
                    .limit(1);

                  if (defaultVariant.length > 0) {
                    recipeVariantId = defaultVariant[0].id;
                    variantId = recipeVariantId;
                  }
                }
              }
            } catch (error) {
              console.log(`Could not find product mapping for Shopify product ${shopifyProductId}:`, error);
            }
          }

          // Create the order item with all the proper links
          await db.insert(orderItems).values({
            organizationId,
            orderId: newOrder.id,
            itemType,
            recipeId,
            recipeVariantId,
            variantId, // Legacy field
            shopifyProductId,
            shopifyVariantId,
            name: item.title || item.name || "Unnamed Item",
            description: item.variant_title,
            quantity: itemQuantity,
            unitPrice: itemPrice.toString(),
            subtotal: itemSubtotal.toString(),
            status: "pending",
            displayOrder: lineItems.indexOf(item),
            externalItemId: item.id?.toString(),
            externalSku: item.sku,
            notes: item.properties ? JSON.stringify(item.properties) : null,
          });

          // Log successful recipe linking for monitoring
          if (itemType === "recipe") {
            console.log(
              `Linked Shopify item "${item.title}" to recipe ${recipeId}` +
              (recipeVariantId ? ` with variant ${recipeVariantId}` : "")
            );
          }
        }

        // Activity logs are only created for user-initiated actions, not sync operations

        // Update shopify_orders with the internal order ID
        await db
          .update(shopifyOrders)
          .set({
            internalOrderId: newOrder.id,
            updatedAt: new Date(),
          })
          .where(eq(shopifyOrders.id, shopifyOrder.id));

        results.created++;
      } catch (error) {
        console.error(`Error syncing Shopify order ${shopifyOrder.shopifyOrderNumber}:`, error);
        results.errors.push(
          `Order ${shopifyOrder.shopifyOrderNumber}: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
        results.skipped++;
      }
    }

    console.log(`Batch ${batchNumber} complete. Total synced so far: ${results.created} created, ${results.updated} updated, ${results.skipped} skipped`);
    processedCount += ordersToSync.length;
  }

  console.log(`\nSync complete! Final results: ${results.created} created, ${results.updated} updated, ${results.skipped} skipped`);
  return results;
  } catch (error) {
    console.error("Error in syncShopifyOrdersToInternal:", error);
    throw error;
  }
}

// Map Shopify fulfillment status to our internal status
function mapFulfillmentStatus(
  shopifyStatus: string | null
): "draft" | "pending" | "confirmed" | "in_progress" | "ready" | "completed" | "cancelled" {
  switch (shopifyStatus) {
    case "fulfilled":
      return "completed";
    case "partial":
      return "in_progress";
    case "unfulfilled":
      return "confirmed";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

// Map Shopify financial status to our internal payment status
function mapFinancialStatus(
  shopifyStatus: string | null
): "pending" | "partial" | "paid" | "refunded" {
  switch (shopifyStatus) {
    case "paid":
      return "paid";
    case "partially_paid":
      return "partial";
    case "refunded":
    case "partially_refunded":
      return "refunded";
    case "voided":
    case "pending":
    case "authorized":
    default:
      return "pending";
  }
}