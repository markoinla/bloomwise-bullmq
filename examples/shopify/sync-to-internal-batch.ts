import { db } from "@/db/drizzle";
import {
  shopifyOrders,
  orders,
  orderItems,
  customers,
  notes,
  shopifyProductMappings,
  shopifyRecipeVariantMappings,
  recipeVariants,
  products,
  productVariants,
  tags,
  taggables
} from "@/db/schema";
import { eq, and, isNull, inArray, sql } from "drizzle-orm";

// Helper to format date as YYYY-MM-DD without timezone conversion
function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface BatchSyncResult {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export async function syncShopifyOrdersToInternalBatch(
  organizationId: string,
  batchSize: number = 250,
  forceUpdate: boolean = false
): Promise<BatchSyncResult> {
  const results: BatchSyncResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  try {
    let hasMore = true;
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

      console.log(`Processing batch of ${ordersToSync.length} Shopify orders (total processed so far: ${processedCount})`);

      // Track per-batch counters
      const batchStartCreated = results.created;
      const batchStartUpdated = results.updated;
      const batchStartSkipped = results.skipped;

      // Prepare batch data collections
      const customersToCheck = new Set<string>();
      const shopifyOrderIds = ordersToSync.map(o => o.shopifyOrderId);
      const orderDataToInsert: any[] = [];
      const orderItemsToInsert: any[] = [];
      const shopifyOrderUpdates: { id: string; internalOrderId: string }[] = [];

      // Check which orders already exist in internal system
      const existingOrders = await db
        .select({
          id: orders.id,
          externalOrderId: orders.externalOrderId,
        })
        .from(orders)
        .where(
          and(
            eq(orders.organizationId, organizationId),
            inArray(orders.externalOrderId, shopifyOrderIds)
          )
        );

      const existingOrderMap = new Map(
        existingOrders.map(o => [o.externalOrderId, o.id])
      );

      // Collect unique customer emails
      ordersToSync.forEach(order => {
        if (order.customerEmail && !existingOrderMap.has(order.shopifyOrderId)) {
          customersToCheck.add(order.customerEmail);
        }
      });

      // Batch check/create customers
      const customerMap = new Map<string, string>();

      if (customersToCheck.size > 0) {
        const existingCustomers = await db
          .select({
            id: customers.id,
            email: customers.email,
          })
          .from(customers)
          .where(
            and(
              eq(customers.organizationId, organizationId),
              inArray(customers.email, Array.from(customersToCheck))
            )
          );

        existingCustomers.forEach(c => {
          customerMap.set(c.email!, c.id);
        });

        // Prepare new customers to insert
        const newCustomersData: any[] = [];
        const emailsToCreate = Array.from(customersToCheck).filter(
          email => !customerMap.has(email)
        );

        for (const email of emailsToCreate) {
          const shopifyOrder = ordersToSync.find(o => o.customerEmail === email);
          if (shopifyOrder) {
            const fullName = shopifyOrder.customerName || "Guest Customer";
            const nameParts = fullName.trim().split(' ');
            const firstName = nameParts[0] || "Guest";
            const lastName = nameParts.slice(1).join(' ') || "Customer";

            newCustomersData.push({
              organizationId,
              firstName,
              lastName,
              email,
              phone: shopifyOrder.customerPhone,
              metadata: {
                shopifyCustomerId: shopifyOrder.shopifyCustomerId,
                source: "shopify_sync",
                fullName: shopifyOrder.customerName,
              },
            });
          }
        }

        // Batch insert new customers
        if (newCustomersData.length > 0) {
          const newCustomers = await db
            .insert(customers)
            .values(newCustomersData)
            .returning({ id: customers.id, email: customers.email });

          newCustomers.forEach(c => {
            if (c.email) customerMap.set(c.email, c.id);
          });
        }
      }

      // Get all product and variant mappings we'll need
      const allLineItems: any[] = [];
      const shopifyProductIds = new Set<string>();
      const shopifyVariantIds = new Set<string>();

      ordersToSync.forEach(order => {
        if (!existingOrderMap.has(order.shopifyOrderId)) {
          const rawData = order.rawData as any;
          const lineItems = rawData?.line_items || [];
          lineItems.forEach((item: any) => {
            if (item.product_id) shopifyProductIds.add(item.product_id.toString());
            if (item.variant_id) shopifyVariantIds.add(item.variant_id.toString());
          });
          allLineItems.push(...lineItems.map((item: any) => ({ ...item, orderId: order.shopifyOrderId })));
        }
      });

      // Fetch all mappings and products in parallel for better performance
      const [productMappings, variantMappings, internalProducts, internalProductVariants] = await Promise.all([
        // Fetch product mappings
        shopifyProductIds.size > 0
          ? db
            .select()
            .from(shopifyProductMappings)
            .where(
              and(
                eq(shopifyProductMappings.organizationId, organizationId),
                inArray(shopifyProductMappings.shopifyProductId, Array.from(shopifyProductIds))
              )
            )
          : Promise.resolve([]),

        // Fetch variant mappings
        shopifyVariantIds.size > 0
          ? db
            .select()
            .from(shopifyRecipeVariantMappings)
            .where(
              and(
                eq(shopifyRecipeVariantMappings.organizationId, organizationId),
                inArray(shopifyRecipeVariantMappings.shopifyVariantId, Array.from(shopifyVariantIds))
              )
            )
          : Promise.resolve([]),

        // Fetch internal products directly by shopifyProductId
        shopifyProductIds.size > 0
          ? db
            .select()
            .from(products)
            .where(
              and(
                eq(products.organizationId, organizationId),
                inArray(products.shopifyProductId, Array.from(shopifyProductIds))
              )
            )
          : Promise.resolve([]),

        // Fetch internal product variants directly by shopifyVariantId
        shopifyVariantIds.size > 0
          ? db
            .select()
            .from(productVariants)
            .where(
              and(
                eq(productVariants.organizationId, organizationId),
                inArray(productVariants.shopifyVariantId, Array.from(shopifyVariantIds))
              )
            )
          : Promise.resolve([])
      ]);

      const productMappingMap = new Map(
        productMappings.map(pm => [pm.shopifyProductId, pm])
      );

      const variantMappingMap = new Map(
        variantMappings.map(vm => [vm.shopifyVariantId, vm])
      );

      // Create direct lookup maps for products by shopifyProductId
      const productsByShopifyId = new Map(
        internalProducts.map(p => [p.shopifyProductId!, p])
      );

      // Create direct lookup maps for product variants by shopifyVariantId
      const productVariantsByShopifyId = new Map(
        internalProductVariants.map(pv => [pv.shopifyVariantId!, pv])
      );

      // Also get recipe variants we'll need
      const recipeVariantIds = variantMappings.map(vm => vm.recipeVariantId);
      const recipeVariantsData = recipeVariantIds.length > 0
        ? await db
          .select()
          .from(recipeVariants)
          .where(inArray(recipeVariants.id, recipeVariantIds))
        : [];

      const recipeVariantMap = new Map(
        recipeVariantsData.map(rv => [rv.id, rv])
      );

      // Process each order for insertion
      for (const shopifyOrder of ordersToSync) {
        try {
          // Skip if order already exists (unless force update)
          if (existingOrderMap.has(shopifyOrder.shopifyOrderId)) {
            if (!forceUpdate) {
              results.skipped++;
              continue;
            }

            // For force update, we'll update the existing order
            const existingOrderId = existingOrderMap.get(shopifyOrder.shopifyOrderId)!;

            // Format delivery address (legacy field)
            let deliveryAddress: string | null = null;

            // Extract shipping address fields
            let shippingName: string | null = null;
            let shippingPhone: string | null = null;
            let shippingEmail: string | null = null;
            let shippingAddress1: string | null = null;
            let shippingAddress2: string | null = null;
            let shippingCity: string | null = null;
            let shippingState: string | null = null;
            let shippingZip: string | null = null;
            let shippingCountry: string | null = null;
            let shippingCompany: string | null = null;

            const rawData = shopifyOrder.rawData as any;
            if (rawData?.shipping_address) {
              const addr = rawData.shipping_address;
              // Handle both snake_case (first_name) and camelCase (firstName) from Shopify
              const firstName = addr.first_name || addr.firstName || null;
              const lastName = addr.last_name || addr.lastName || null;
              shippingName = addr.name || (firstName && lastName ? `${firstName} ${lastName}`.trim() : null);
              shippingPhone = addr.phone || null;
              shippingAddress1 = addr.address1 || null;
              shippingAddress2 = addr.address2 || null;
              shippingCity = addr.city || null;
              shippingState = addr.province || addr.province_code || null;
              shippingZip = addr.zip || null;
              shippingCountry = addr.country || addr.country_code || null;
              shippingCompany = addr.company || null;

              // Build legacy deliveryAddress field
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

            // Extract billing address fields
            let billingName: string | null = null;
            let billingPhone: string | null = null;
            let billingEmail: string | null = null;
            let billingAddress1: string | null = null;
            let billingAddress2: string | null = null;
            let billingCity: string | null = null;
            let billingState: string | null = null;
            let billingZip: string | null = null;
            let billingCountry: string | null = null;
            let billingCompany: string | null = null;

            if (rawData?.billing_address) {
              const addr = rawData.billing_address;
              // Handle both snake_case (first_name) and camelCase (firstName) from Shopify
              const firstName = addr.first_name || addr.firstName || null;
              const lastName = addr.last_name || addr.lastName || null;
              billingName = addr.name || (firstName && lastName ? `${firstName} ${lastName}`.trim() : null);
              billingPhone = addr.phone || null;
              billingAddress1 = addr.address1 || null;
              billingAddress2 = addr.address2 || null;
              billingCity = addr.city || null;
              billingState = addr.province || addr.province_code || null;
              billingZip = addr.zip || null;
              billingCountry = addr.country || addr.country_code || null;
              billingCompany = addr.company || null;
            }

            // Extract discount amount
            const discountAmount = rawData?.total_discounts
              ? parseFloat(rawData.total_discounts.toString())
              : 0;

            // Extract payment method
            let paymentMethod: string | null = null;
            if (rawData?.payment_gateway_names && Array.isArray(rawData.payment_gateway_names)) {
              paymentMethod = rawData.payment_gateway_names.join(', ');
            }

            // Extract Shopify tags
            const shopifyTags = rawData?.tags || null;

            // We'll update existing orders in a separate batch
            await db
              .update(orders)
              .set({
                customerName: shopifyOrder.customerName || "Guest",
                customerEmail: shopifyOrder.customerEmail,
                customerPhone: shopifyOrder.customerPhone,
                deliveryAddress,
                // Structured shipping address fields
                shippingName,
                shippingPhone,
                shippingEmail,
                shippingAddress1,
                shippingAddress2,
                shippingCity,
                shippingState,
                shippingZip,
                shippingCountry,
                shippingCompany,
                // Billing address fields
                billingName,
                billingPhone,
                billingEmail,
                billingAddress1,
                billingAddress2,
                billingCity,
                billingState,
                billingZip,
                billingCountry,
                billingCompany,
                // Additional fields
                discountAmount: discountAmount.toString(),
                paymentMethod,
                shopifyTags,
                updatedAt: new Date(),
              })
              .where(eq(orders.id, existingOrderId));

            // Sync notes for updated orders
            // Fetch existing Shopify notes to check for duplicates
            const existingShopifyNotes = await db
              .select()
              .from(notes)
              .where(
                and(
                  eq(notes.entityType, 'order'),
                  eq(notes.entityId, existingOrderId),
                  eq(notes.noteSource, 'shopify')
                )
              );

            const existingNotesSet = new Set(
              existingShopifyNotes.map(n => `${n.noteType}:${n.content}`)
            );

            const notesToInsert: any[] = [];
            const batchNotesSet = new Set<string>(); // Track notes in current batch to prevent duplicates

            // Add internal notes if present and doesn't exist
            if (shopifyOrder.note) {
              const noteKey = `internal:${shopifyOrder.note}`;
              if (!existingNotesSet.has(noteKey)) {
                notesToInsert.push({
                  organizationId,
                  entityType: 'order',
                  entityId: existingOrderId,
                  noteType: 'internal',
                  noteSource: 'shopify',
                  title: 'Order Notes',
                  content: shopifyOrder.note,
                  visibility: 'internal',
                  priority: 1,
                  createdAt: new Date(),
                });
              }
            }

            // Process note attributes
            const noteAttributes = rawData?.note_attributes || rawData?.noteAttributes || rawData?.customAttributes || [];
            if (noteAttributes && Array.isArray(noteAttributes)) {
              noteAttributes.forEach(attr => {
                const attrName = attr.name || attr.key;
                const attrValue = attr.value;

                if (!attrName || !attrValue) return;

                let noteType = 'custom_attribute';
                let title = attrName;
                let visibility: 'internal' | 'customer' | 'public' = 'internal';

                // Categorize based on attribute name
                const attrNameLower = attrName.toLowerCase();

                if (attrNameLower.includes('gift') && attrNameLower.includes('note') || attrNameLower === 'message' || attrNameLower === 'card_message') {
                  noteType = 'gift_note';
                  title = 'Gift Note';
                  visibility = 'customer';
                } else if (attrNameLower.includes('delivery') || attrNameLower.includes('special delivery')) {
                  noteType = 'delivery_instruction';
                  title = attrName;
                  visibility = 'internal';
                } else if (attrNameLower.includes('card') && attrNameLower.includes('message')) {
                  noteType = 'handwritten_card';
                  title = 'Handwritten Card';
                  visibility = 'customer';
                } else if (attrNameLower.includes('special') && attrNameLower.includes('instruction')) {
                  noteType = 'order_note';
                  title = 'Special Instructions';
                  visibility = 'internal';
                }

                // Check if this specific note already exists
                const noteKey = `${noteType}:${attrValue}`;
                if (!existingNotesSet.has(noteKey)) {
                  notesToInsert.push({
                    organizationId,
                    entityType: 'order',
                    entityId: existingOrderId,
                    noteType,
                    noteSource: 'shopify',
                    title,
                    content: attrValue,
                    visibility,
                    priority: noteType === 'gift_note' ? 2 : 1,
                    createdAt: new Date(),
                  });
                }
              });
            }

            // Process line item properties for notes
            const lineItems = rawData?.line_items || [];
            const existingOrderItems = await db
              .select()
              .from(orderItems)
              .where(eq(orderItems.orderId, existingOrderId));

            lineItems.forEach((lineItem: any, lineIndex: number) => {
              const properties = lineItem.properties;
              if (!properties || !Array.isArray(properties)) return;

              // Try to match line item to order item by name or index
              const orderItem = existingOrderItems[lineIndex];
              if (!orderItem) return;

              properties.forEach((prop: any) => {
                const propName = prop.name || prop.key;
                const propValue = prop.value;

                if (!propName || !propValue) return;

                // Skip internal/system properties
                if (propName.startsWith('_')) return;

                let noteType = 'custom_attribute';
                let title = propName;
                let visibility: 'internal' | 'customer' | 'public' = 'customer';
                let entityType: 'order' | 'orderItem' = 'order';
                let entityId = existingOrderId;

                const propNameLower = propName.toLowerCase();

                // Categorize the property
                if (propNameLower.includes('handwritten') && propNameLower.includes('card')) {
                  noteType = 'handwritten_card';
                  title = 'Handwritten Card';
                  visibility = 'customer';
                  entityType = 'order'; // Attach to order level
                } else if (propNameLower.includes('card')) {
                  noteType = 'handwritten_card';
                  title = 'Card Message';
                  visibility = 'customer';
                  entityType = 'order';
                } else if (propNameLower.includes('recipient')) {
                  noteType = 'delivery_instruction';
                  title = 'Recipient';
                  visibility = 'internal';
                  entityType = 'order';
                } else if (propNameLower.includes('gift') && propNameLower.includes('message')) {
                  noteType = 'gift_note';
                  title = 'Gift Message';
                  visibility = 'customer';
                  entityType = 'order';
                }

                // Check if this specific note already exists in DB or current batch
                const noteKey = `${noteType}:${propValue}`;
                if (!existingNotesSet.has(noteKey) && !batchNotesSet.has(noteKey)) {
                  batchNotesSet.add(noteKey); // Mark as added in this batch
                  notesToInsert.push({
                    organizationId,
                    entityType,
                    entityId,
                    noteType,
                    noteSource: 'shopify',
                    title,
                    content: propValue,
                    visibility,
                    priority: noteType === 'gift_note' || noteType === 'handwritten_card' ? 2 : 1,
                    createdAt: new Date(),
                  });
                }
              });
            });

            // Insert notes if any
            if (notesToInsert.length > 0) {
              try {
                await db.insert(notes).values(notesToInsert);
                console.log(`✅ Successfully inserted ${notesToInsert.length} notes for updated order`);
              } catch (noteError) {
                console.error(`❌ Error inserting notes for updated order:`, noteError);
                console.error(`Sample failed note:`, notesToInsert[0]);
                // Don't throw - continue with sync even if notes fail
              }
            }

            results.updated++;
            continue;
          }

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

          // Calculate due date
          let dueDate: Date;
          if (shopifyOrder.pickupDate) {
            dueDate = new Date(shopifyOrder.pickupDate);
          } else {
            dueDate = new Date(shopifyOrder.shopifyCreatedAt);
            dueDate.setDate(dueDate.getDate() + 3);
          }

          // Format delivery address (legacy field)
          let deliveryAddress: string | null = null;

          // Extract shipping address fields
          let shippingName: string | null = null;
          let shippingPhone: string | null = null;
          let shippingEmail: string | null = null;
          let shippingAddress1: string | null = null;
          let shippingAddress2: string | null = null;
          let shippingCity: string | null = null;
          let shippingState: string | null = null;
          let shippingZip: string | null = null;
          let shippingCountry: string | null = null;
          let shippingCompany: string | null = null;

          if (rawData?.shipping_address) {
            const addr = rawData.shipping_address;
            // Handle both snake_case (first_name) and camelCase (firstName) from Shopify
            const firstName = addr.first_name || addr.firstName || null;
            const lastName = addr.last_name || addr.lastName || null;
            shippingName = addr.name || (firstName && lastName ? `${firstName} ${lastName}`.trim() : null);
            shippingPhone = addr.phone || null;
            shippingAddress1 = addr.address1 || null;
            shippingAddress2 = addr.address2 || null;
            shippingCity = addr.city || null;
            shippingState = addr.province || addr.province_code || null;
            shippingZip = addr.zip || null;
            shippingCountry = addr.country || addr.country_code || null;
            shippingCompany = addr.company || null;

            // Build legacy deliveryAddress field
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

          // Extract billing address fields
          let billingName: string | null = null;
          let billingPhone: string | null = null;
          let billingEmail: string | null = null;
          let billingAddress1: string | null = null;
          let billingAddress2: string | null = null;
          let billingCity: string | null = null;
          let billingState: string | null = null;
          let billingZip: string | null = null;
          let billingCountry: string | null = null;
          let billingCompany: string | null = null;

          if (rawData?.billing_address) {
            const addr = rawData.billing_address;
            billingName = addr.name || null;
            billingPhone = addr.phone || null;
            billingAddress1 = addr.address1 || null;
            billingAddress2 = addr.address2 || null;
            billingCity = addr.city || null;
            billingState = addr.province || addr.province_code || null;
            billingZip = addr.zip || null;
            billingCountry = addr.country || addr.country_code || null;
            billingCompany = addr.company || null;
          }

          // Extract discount amount
          const discountAmount = rawData?.total_discounts
            ? parseFloat(rawData.total_discounts.toString())
            : 0;

          // Extract payment method
          let paymentMethod: string | null = null;
          if (rawData?.payment_gateway_names && Array.isArray(rawData.payment_gateway_names)) {
            paymentMethod = rawData.payment_gateway_names.join(', ');
          }

          // Extract Shopify tags
          const shopifyTags = rawData?.tags || null;

          const customerId = shopifyOrder.customerEmail
            ? customerMap.get(shopifyOrder.customerEmail) || null
            : null;

          // Generate a temporary ID for order items (will be replaced with actual ID after insert)
          const tempOrderId = `temp_${shopifyOrder.shopifyOrderId}`;

          orderDataToInsert.push({
            organizationId,
            customerId,
            customerName: shopifyOrder.customerName || "Guest",
            customerEmail: shopifyOrder.customerEmail,
            customerPhone: shopifyOrder.customerPhone,
            orderNumber: `SHO-${shopifyOrder.shopifyOrderNumber || shopifyOrder.name.replace(/^#/, '')}`,
            status: mapFulfillmentStatus(shopifyOrder.fulfillmentStatus),
            paymentStatus: mapFinancialStatus(shopifyOrder.financialStatus),
            subtotal: subtotal.toString(),
            taxAmount: tax.toString(),
            discountAmount: discountAmount.toString(),
            total: total.toString(),
            internalNotes: shopifyOrder.note,
            dueDate: formatDateOnly(dueDate),
            dueTime: shopifyOrder.pickupTime,
            fulfillmentType,
            deliveryAddress,
            // Structured shipping address fields
            shippingName,
            shippingPhone,
            shippingEmail,
            shippingAddress1,
            shippingAddress2,
            shippingCity,
            shippingState,
            shippingZip,
            shippingCountry,
            shippingCompany,
            // Billing address fields
            billingName,
            billingPhone,
            billingEmail,
            billingAddress1,
            billingAddress2,
            billingCity,
            billingState,
            billingZip,
            billingCountry,
            billingCompany,
            // Payment info
            paymentMethod,
            // Shopify-specific fields
            shopifyTags,
            orderSource: 'shopify',
            externalOrderId: shopifyOrder.shopifyOrderId,
            shopifyOrderId: shopifyOrder.shopifyOrderId,
            shopifyOrderNumber: shopifyOrder.shopifyOrderNumber,
            createdAt: new Date(shopifyOrder.shopifyCreatedAt),
            updatedAt: new Date(shopifyOrder.shopifyUpdatedAt),
            _tempId: tempOrderId, // Temporary identifier for linking items
          });

          // Process line items for this order
          for (let i = 0; i < lineItems.length; i++) {
            const item = lineItems[i];
            const itemPrice = parseFloat(item.price || "0");
            const itemQuantity = item.quantity || 1;
            const itemSubtotal = itemPrice * itemQuantity;

            const shopifyProductId = item.product_id?.toString();
            const shopifyVariantId = item.variant_id?.toString();

            let itemType: "recipe" | "custom" | "inventory" = "custom";
            let recipeId: string | null = null;
            let recipeVariantId: string | null = null;
            let productId: string | null = null;
            let productVariantId: string | null = null;

            // PRIORITY 1: Look up product directly by shopifyProductId
            if (shopifyProductId && productsByShopifyId.has(shopifyProductId)) {
              const product = productsByShopifyId.get(shopifyProductId)!;
              productId = product.id;

              // If product has a linked recipe, use it
              if (product.recipeId) {
                recipeId = product.recipeId;
                itemType = "recipe";
              }
            }

            // PRIORITY 2: Look up product variant directly by shopifyVariantId
            if (shopifyVariantId && productVariantsByShopifyId.has(shopifyVariantId)) {
              const productVariant = productVariantsByShopifyId.get(shopifyVariantId)!;
              productVariantId = productVariant.id;

              // If we haven't set productId yet, get it from the variant
              if (!productId && productVariant.productId) {
                productId = productVariant.productId;
              }

              // If variant has a linked recipe variant, use it
              if (productVariant.recipeVariantId) {
                recipeVariantId = productVariant.recipeVariantId;

                const variant = recipeVariantMap.get(recipeVariantId);
                if (variant) {
                  recipeId = variant.recipeId;
                  itemType = "recipe";
                }
              }
            }

            // FALLBACK: Use legacy product mappings if direct lookup didn't work
            if (!productId) {
              // Check variant mapping first (includes product references)
              if (shopifyVariantId && productMappingMap.has(shopifyProductId || '')) {
                const mapping = productMappingMap.get(shopifyProductId!)!;
                productId = mapping.productId || null;
                productVariantId = productVariantId || mapping.productVariantId || null;

                // Also check for recipe mapping
                if (!recipeVariantId && variantMappingMap.has(shopifyVariantId)) {
                  const recipeMapping = variantMappingMap.get(shopifyVariantId)!;
                  recipeVariantId = recipeMapping.recipeVariantId;

                  const variant = recipeVariantMap.get(recipeVariantId);
                  if (variant) {
                    recipeId = variant.recipeId;
                    itemType = "recipe";
                  }
                } else if (!recipeId && mapping.recipeId) {
                  recipeId = mapping.recipeId;
                  itemType = "recipe";
                }
              }
              // Check product mapping if no variant mapping
              else if (shopifyProductId && productMappingMap.has(shopifyProductId)) {
                const mapping = productMappingMap.get(shopifyProductId)!;
                productId = mapping.productId || null;

                if (!recipeId && mapping.recipeId) {
                  recipeId = mapping.recipeId;
                  itemType = "recipe";
                }
              }
            }

            orderItemsToInsert.push({
              organizationId,
              _tempOrderId: tempOrderId, // Temporary link to order
              itemType,
              recipeId,
              recipeVariantId,
              variantId: recipeVariantId, // Legacy field
              productId, // NEW: Add product reference
              productVariantId, // NEW: Add product variant reference
              shopifyProductId,
              shopifyVariantId,
              name: item.title || item.name || "Unnamed Item",
              description: item.variant_title,
              quantity: itemQuantity,
              unitPrice: itemPrice.toString(),
              subtotal: itemSubtotal.toString(),
              status: "pending",
              displayOrder: i,
              externalItemId: item.id?.toString(),
              externalSku: item.sku,
              notes: item.properties ? JSON.stringify(item.properties) : null,
            });
          }

          // Activity logs are not created for sync operations
          // Only user-initiated actions should create activity logs

          // Track which shopify orders to update
          shopifyOrderUpdates.push({
            id: shopifyOrder.id,
            internalOrderId: tempOrderId, // Will be replaced with actual ID
          });

        } catch (error) {
          console.error(`Error preparing Shopify order ${shopifyOrder.shopifyOrderNumber}:`, error);
          results.errors.push(
            `Order ${shopifyOrder.shopifyOrderNumber}: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
          results.skipped++;
        }
      }

      // Batch insert orders
      if (orderDataToInsert.length > 0) {
        console.log(`Batch inserting ${orderDataToInsert.length} orders`);

        // Store temp IDs before removing them
        const tempIdMapping = new Map<string, string>();
        const tempIds = orderDataToInsert.map(order => order._tempId);

        // Remove the _tempId before insertion
        const ordersToInsert = orderDataToInsert.map(order => {
          const { _tempId, ...orderWithoutTempId } = order;
          return orderWithoutTempId;
        });

        const insertedOrders = await db
          .insert(orders)
          .values(ordersToInsert)
          .returning({ id: orders.id, externalOrderId: orders.externalOrderId });

        // Verify we got the same number of orders back
        if (insertedOrders.length !== tempIds.length) {
          console.error(`Order insertion mismatch: expected ${tempIds.length}, got ${insertedOrders.length}`);
        }

        // Create mapping from temp ID to internal order ID
        insertedOrders.forEach((order, index) => {
          const originalTempId = tempIds[index];
          if (originalTempId) {
            tempIdMapping.set(originalTempId, order.id);
          }
        });

        // Update order items with actual order IDs
        const finalOrderItems: any[] = [];
        const failedItems: any[] = [];

        orderItemsToInsert.forEach(item => {
          const actualOrderId = tempIdMapping.get(item._tempOrderId);
          if (!actualOrderId) {
            console.error(`Failed to find order ID for temp ID: ${item._tempOrderId}, item: ${item.name}`);
            failedItems.push({ tempId: item._tempOrderId, itemName: item.name });
            return; // Skip this item
          }
          delete item._tempOrderId;
          finalOrderItems.push({
            ...item,
            orderId: actualOrderId,
          });
        });

        if (failedItems.length > 0) {
          console.error(`Failed to map ${failedItems.length} order items:`, failedItems);
          console.error('Available temp IDs in mapping:', Array.from(tempIdMapping.keys()));
        }

        // Batch insert order items and get their IDs back
        let insertedOrderItems: any[] = [];
        if (finalOrderItems.length > 0) {
          console.log(`Batch inserting ${finalOrderItems.length} order items`);
          insertedOrderItems = await db.insert(orderItems).values(finalOrderItems).returning();
        }

        // Create notes from Shopify data
        const notesToInsert: any[] = [];

        // Process notes for each inserted order
        insertedOrders.forEach((order, index) => {
          const originalTempId = tempIds[index];
          const shopifyOrder = ordersToSync.find(so =>
            orderDataToInsert.find(od => od._tempId === originalTempId)?.shopifyOrderId === so.shopifyOrderId
          );

          if (!shopifyOrder) return;

          // Add internal notes if present
          if (shopifyOrder.note) {
            notesToInsert.push({
              organizationId,
              entityType: 'order',
              entityId: order.id,
              noteType: 'internal',
              noteSource: 'shopify',
              title: 'Order Notes',
              content: shopifyOrder.note,
              visibility: 'internal',
              priority: 0,
              createdAt: new Date(shopifyOrder.shopifyCreatedAt),
              updatedAt: new Date(),
            });
          }

          // Process note attributes (custom attributes from Shopify)
          // Note attributes can be in rawData or directly on the order
          const rawData = shopifyOrder.rawData as any;
          const noteAttributes = rawData?.note_attributes || rawData?.noteAttributes ||
                                  rawData?.customAttributes || [];
          if (noteAttributes && Array.isArray(noteAttributes)) {
            noteAttributes.forEach(attr => {
              const attrName = attr.name || attr.key;
              const attrValue = attr.value;

              if (!attrValue) return;

              // Map specific note types
              let noteType = 'custom_attribute';
              let title = attrName;
              let visibility: 'internal' | 'customer' | 'public' = 'internal';

              const lowerName = attrName?.toLowerCase() || '';

              if (lowerName.includes('gift') && lowerName.includes('note')) {
                noteType = 'gift_note';
                title = 'Gift Note';
                visibility = 'customer';
              } else if (lowerName.includes('card') || lowerName.includes('message')) {
                noteType = 'handwritten_card';
                title = 'Card Message';
                visibility = 'customer';
              } else if (lowerName.includes('delivery') && lowerName.includes('instruction')) {
                noteType = 'delivery_instruction';
                title = 'Delivery Instructions';
                visibility = 'internal';
              } else if (lowerName.includes('special') || lowerName.includes('instruction')) {
                noteType = 'order_note';
                title = 'Special Instructions';
                visibility = 'internal';
              }

              notesToInsert.push({
                organizationId,
                entityType: 'order',
                entityId: order.id,
                noteType,
                noteSource: 'shopify',
                title,
                content: attrValue,
                visibility,
                priority: noteType === 'gift_note' ? 10 : 5,
                metadata: {
                  originalAttributeName: attrName,
                  shopifyOrderId: shopifyOrder.shopifyOrderId,
                },
                createdAt: new Date(shopifyOrder.shopifyCreatedAt),
                updatedAt: new Date(),
              });
            });
          }

          // Process line item properties - each property becomes a note (except Zapiet)
          const lineItems = rawData?.line_items || [];

          // Filter order items for this specific order
          const currentOrderItems = insertedOrderItems.filter(item => item.orderId === order.id);

          currentOrderItems.forEach((orderItem, itemIndex) => {
            // Find the matching line item from raw data by index
            const lineItem = lineItems[itemIndex];
            if (!lineItem) return;

            const itemProperties = lineItem.properties || lineItem.customAttributes || [];
            if (Array.isArray(itemProperties) && itemProperties.length > 0) {
              itemProperties.forEach((prop: any) => {
                const propName = prop.name || prop.key;
                const propValue = prop.value;

                if (!propValue || !propName) return;

                // Filter out Zapiet properties
                const lowerName = propName.toLowerCase();
                if (lowerName.includes('zapiet')) return;

                // Determine note type based on property name
                let noteType = 'order_note';
                let title = propName;

                if (lowerName.includes('gift') && (lowerName.includes('note') || lowerName.includes('message'))) {
                  noteType = 'gift_note';
                  title = `Gift Note - ${lineItem.name || orderItem.name}`;
                } else if (lowerName.includes('card')) {
                  noteType = 'handwritten_card';
                  title = `Card Message - ${lineItem.name || orderItem.name}`;
                } else if (lowerName.includes('delivery') || lowerName.includes('instruction')) {
                  noteType = 'delivery_instruction';
                } else {
                  // Generic property - keep original title
                  title = `${propName} - ${lineItem.name || orderItem.name}`;
                }

                notesToInsert.push({
                  organizationId,
                  entityType: 'orderItem',
                  entityId: orderItem.id, // Now we have the actual inserted ID
                  noteType,
                  noteSource: 'shopify',
                  title,
                  content: propValue,
                  visibility: noteType === 'gift_note' || noteType === 'handwritten_card' ? 'customer' : 'internal',
                  priority: noteType === 'gift_note' ? 10 : 5,
                  metadata: {
                    lineItemName: lineItem.name || orderItem.name,
                    originalPropertyName: propName,
                    shopifyOrderId: shopifyOrder.shopifyOrderId,
                    shopifyLineItemId: lineItem.id,
                  },
                  createdAt: new Date(shopifyOrder.shopifyCreatedAt),
                  updatedAt: new Date(),
                });
              });
            }
          });
        });

        // Batch insert notes
        if (notesToInsert.length > 0) {
          console.log(`Batch inserting ${notesToInsert.length} notes from Shopify orders`);
          try {
            await db.insert(notes).values(notesToInsert);
            console.log(`✅ Successfully inserted ${notesToInsert.length} notes`);
          } catch (noteError) {
            console.error(`❌ Error inserting notes:`, noteError);
            console.error(`Note insertion failed for ${notesToInsert.length} notes`);
            // Log first failed note for debugging
            if (notesToInsert.length > 0) {
              console.error(`Sample failed note:`, JSON.stringify(notesToInsert[0], null, 2));
            }
            // Don't throw - continue with sync even if notes fail
          }
        }

        // Process Shopify tags and link to orders
        const tagsToProcess: Array<{ orderId: string; shopifyTags: string }> = [];
        insertedOrders.forEach((order, index) => {
          const originalTempId = tempIds[index];
          const shopifyOrder = ordersToSync.find(so =>
            orderDataToInsert.find(od => od._tempId === originalTempId)?.shopifyOrderId === so.shopifyOrderId
          );

          if (shopifyOrder && shopifyOrder.tags) {
            tagsToProcess.push({
              orderId: order.id,
              shopifyTags: shopifyOrder.tags,
            });
          }
        });

        if (tagsToProcess.length > 0) {
          console.log(`Processing tags for ${tagsToProcess.length} orders`);
          await processShopifyOrderTags(organizationId, tagsToProcess);
        }

        // Activity logs are not created during sync operations
        // This reduces database load and noise in the activity log

        // Update shopify_orders with internal order IDs
        const finalShopifyUpdates = shopifyOrderUpdates.map(update => {
          const actualOrderId = tempIdMapping.get(update.internalOrderId);
          return {
            id: update.id,
            internalOrderId: actualOrderId,
          };
        });

        // Batch update shopify_orders
        for (const update of finalShopifyUpdates) {
          if (update.internalOrderId) {
            await db
              .update(shopifyOrders)
              .set({
                internalOrderId: update.internalOrderId,
                updatedAt: new Date(),
              })
              .where(eq(shopifyOrders.id, update.id));
          }
        }

        results.created += insertedOrders.length;

        // Customer metrics are now automatically updated by database triggers
        // No manual update needed - triggers fire on INSERT/UPDATE/DELETE of orders
        // Nightly reconciliation cron job (3 AM) will catch any edge cases
        console.log(`✓ Customer metrics will be updated automatically by database triggers`);
      }

      // Calculate per-batch changes
      const batchCreated = results.created - batchStartCreated;
      const batchUpdated = results.updated - batchStartUpdated;
      const batchSkipped = results.skipped - batchStartSkipped;

      console.log(
        `Batch complete: +${batchCreated} created, +${batchUpdated} updated, +${batchSkipped} skipped | ` +
        `Cumulative: ${results.created} created, ${results.updated} updated, ${results.skipped} skipped`
      );
      processedCount += ordersToSync.length;
    }

    console.log(`\nBatch sync complete! Final results: ${results.created} created, ${results.updated} updated, ${results.skipped} skipped`);
    return results;

  } catch (error) {
    console.error("Error in syncShopifyOrdersToInternalBatch:", error);
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

/**
 * Process Shopify tags and link them to orders via polymorphic tags system
 */
async function processShopifyOrderTags(
  organizationId: string,
  ordersWithTags: Array<{ orderId: string; shopifyTags: string }>
): Promise<void> {
  try {
    // Parse all unique tag names from Shopify tags
    const allTagNames = new Set<string>();
    const orderTagMap = new Map<string, string[]>();

    ordersWithTags.forEach(({ orderId, shopifyTags }) => {
      // Shopify tags are comma-separated
      const tagList = shopifyTags
        .split(',')
        .map(tag => tag.trim())
        .filter(tag => tag.length > 0);

      if (tagList.length > 0) {
        orderTagMap.set(orderId, tagList);
        tagList.forEach(tag => allTagNames.add(tag));
      }
    });

    if (allTagNames.size === 0) {
      return;
    }

    console.log(`Processing ${allTagNames.size} unique tags from Shopify`);

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

    // Create missing tags
    const tagsToCreate = Array.from(allTagNames)
      .filter(tagName => !existingTagMap.has(tagName.toLowerCase()))
      .map(tagName => ({
        organizationId,
        name: tagName.toLowerCase(),
        displayName: tagName, // Keep original case for display
        description: `Imported from Shopify`,
        usageCount: 0,
        isSystemTag: false,
      }));

    if (tagsToCreate.length > 0) {
      console.log(`Creating ${tagsToCreate.length} new tags from Shopify`);
      const newTags = await db
        .insert(tags)
        .values(tagsToCreate)
        .returning();

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
        }
      });
    });

    if (taggablesToInsert.length > 0) {
      console.log(`Linking ${taggablesToInsert.length} tags to orders`);

      // Use insert with onConflictDoNothing to avoid duplicate tag assignments
      await db
        .insert(taggables)
        .values(taggablesToInsert)
        .onConflictDoNothing();

      // Update usage counts for tags
      const tagIds = Array.from(new Set(taggablesToInsert.map(t => t.tagId)));

      // Batch update usage counts
      await Promise.all(
        tagIds.map(tagId =>
          db
            .update(tags)
            .set({
              usageCount: sql`${tags.usageCount} + (
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

    console.log(`Successfully processed Shopify tags for orders`);
  } catch (error) {
    console.error('Error processing Shopify order tags:', error);
    // Don't throw - tag processing failure shouldn't block order sync
  }
}