import { pgTable, uuid, text, integer, decimal, boolean, timestamp, jsonb, date, time, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, customers, recipes, inventoryItems, orders, products, productVariants } from "../schema";

// Seal Subscriptions Integration table - Stores integration configuration
export const sealIntegrations = pgTable("seal_integrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  // Seal API Configuration
  apiUrl: text("api_url").notNull(), // Base API URL for this merchant
  apiKey: text("api_key").notNull(), // Encrypted API key
  merchantId: text("merchant_id").notNull(), // Seal merchant ID

  // Integration status
  isActive: boolean("is_active").default(true),
  lastHealthCheck: timestamp("last_health_check"),
  healthStatus: text("health_status"), // 'healthy', 'degraded', 'unhealthy'

  // Sync configuration
  autoSync: boolean("auto_sync").default(true),
  syncFrequency: text("sync_frequency").default("hourly"), // '15min', 'hourly', 'daily'
  lastSyncAt: timestamp("last_sync_at"),
  nextSyncAt: timestamp("next_sync_at"),

  // Webhook configuration
  webhookEndpoint: text("webhook_endpoint"), // Our webhook URL
  webhookSecret: text("webhook_secret"), // Webhook verification secret
  subscribedEvents: text("subscribed_events").array(), // List of webhook events we're subscribed to

  // Metadata
  installedAt: timestamp("installed_at").notNull().defaultNow(),
  installedBy: text("installed_by"),
  settings: jsonb("settings"), // Additional integration settings

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: uniqueIndex("seal_integrations_org_id_idx").on(table.organizationId),
  merchantIdIdx: index("seal_integrations_merchant_id_idx").on(table.merchantId),
  statusIdx: index("seal_integrations_status_idx").on(table.isActive, table.healthStatus),
}));

// Seal Subscriptions table - Stores subscription data from Seal
export const sealSubscriptions = pgTable("seal_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  // Seal identifiers
  sealSubscriptionId: text("seal_subscription_id").notNull(), // Seal's subscription ID
  sealCustomerId: text("seal_customer_id").notNull(), // Seal's customer ID

  // Internal mappings (new unified approach)
  internalCustomerId: uuid("internal_customer_id").references(() => customers.id),
  internalProductId: uuid("internal_product_id").references(() => products.id), // Primary product reference
  internalProductVariantId: uuid("internal_product_variant_id").references(() => productVariants.id), // Specific variant

  // Legacy internal mappings (kept for backward compatibility)
  internalRecipeId: uuid("internal_recipe_id").references(() => recipes.id),
  internalInventoryItemId: uuid("internal_inventory_item_id").references(() => inventoryItems.id),

  // Subscription details
  status: text("status").notNull(), // 'active', 'paused', 'cancelled', 'expired'
  title: text("title").notNull(), // Subscription product title
  description: text("description"),

  // Product information
  productType: text("product_type"), // 'recipe', 'inventory', 'custom'
  productSku: text("product_sku"),
  variantTitle: text("variant_title"),
  productId: text("product_id"), // External product ID
  variantId: text("variant_id"), // External variant ID

  // Pricing
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  discountAmount: decimal("discount_amount", { precision: 10, scale: 2 }).default("0"),
  discountType: text("discount_type"), // 'percentage', 'fixed_amount'

  // Billing cycle
  billingInterval: text("billing_interval").notNull(), // 'daily', 'weekly', 'monthly', 'yearly'
  billingIntervalCount: integer("billing_interval_count").notNull().default(1), // Every X intervals
  billingCycleAnchor: date("billing_cycle_anchor"), // When billing cycle starts

  // Delivery schedule
  deliveryFrequency: text("delivery_frequency"), // 'weekly', 'biweekly', 'monthly', 'quarterly'
  deliveryDay: text("delivery_day"), // 'monday', 'tuesday', etc. or specific date
  deliveryTime: time("delivery_time"),
  deliveryInstructions: text("delivery_instructions"),

  // Dates
  startDate: date("start_date").notNull(),
  nextOrderDate: date("next_order_date"),
  lastOrderDate: date("last_order_date"),
  endDate: date("end_date"), // For fixed-term subscriptions
  pausedUntil: date("paused_until"), // If temporarily paused

  // Customer information (denormalized for quick access)
  customerEmail: text("customer_email"),
  customerName: text("customer_name"),
  customerPhone: text("customer_phone"),

  // Shipping address
  shippingName: text("shipping_name"),
  shippingAddress1: text("shipping_address1"),
  shippingAddress2: text("shipping_address2"),
  shippingCity: text("shipping_city"),
  shippingState: text("shipping_state"),
  shippingZip: text("shipping_zip"),
  shippingCountry: text("shipping_country"),
  shippingPhone: text("shipping_phone"),

  // Billing address
  billingName: text("billing_name"),
  billingAddress1: text("billing_address1"),
  billingAddress2: text("billing_address2"),
  billingCity: text("billing_city"),
  billingState: text("billing_state"),
  billingZip: text("billing_zip"),
  billingCountry: text("billing_country"),

  // Payment information
  paymentMethod: text("payment_method"),
  lastPaymentStatus: text("last_payment_status"),
  nextChargeDate: date("next_charge_date"),

  // Subscription metadata
  tags: text("tags").array(),
  notes: text("notes"),
  customAttributes: jsonb("custom_attributes"),

  // Seal timestamps
  sealCreatedAt: timestamp("seal_created_at").notNull(),
  sealUpdatedAt: timestamp("seal_updated_at").notNull(),

  // Complete raw JSON from Seal
  rawData: jsonb("raw_data").notNull(),

  // Sync metadata
  syncedAt: timestamp("synced_at").notNull().defaultNow(),
  lastWebhookAt: timestamp("last_webhook_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index("seal_subscriptions_org_id_idx").on(table.organizationId),
  sealSubscriptionIdIdx: index("seal_subscriptions_seal_id_idx").on(table.sealSubscriptionId),
  statusIdx: index("seal_subscriptions_status_idx").on(table.status),
  customerEmailIdx: index("seal_subscriptions_customer_email_idx").on(table.customerEmail),
  nextOrderDateIdx: index("seal_subscriptions_next_order_date_idx").on(table.nextOrderDate),
  nextChargeDateIdx: index("seal_subscriptions_next_charge_date_idx").on(table.nextChargeDate),
  internalCustomerIdx: index("seal_subscriptions_internal_customer_idx").on(table.internalCustomerId),
  internalProductIdx: index("seal_subscriptions_internal_product_idx").on(table.internalProductId),
  internalProductVariantIdx: index("seal_subscriptions_internal_product_variant_idx").on(table.internalProductVariantId),
  internalRecipeIdx: index("seal_subscriptions_internal_recipe_idx").on(table.internalRecipeId),
  uniqueSealSubscription: uniqueIndex("seal_subscriptions_unique").on(table.organizationId, table.sealSubscriptionId),
}));

// Seal Orders table - Stores individual orders generated from subscriptions
export const sealOrders = pgTable("seal_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  // Seal identifiers
  sealOrderId: text("seal_order_id").notNull(),
  sealSubscriptionId: text("seal_subscription_id").notNull(),

  // Internal mappings
  internalOrderId: uuid("internal_order_id").references(() => orders.id),
  subscriptionId: uuid("subscription_id").references(() => sealSubscriptions.id),

  // Order details
  status: text("status").notNull(), // 'pending', 'processing', 'shipped', 'delivered', 'cancelled'
  orderNumber: text("order_number"),

  // Product information
  productTitle: text("product_title").notNull(),
  variantTitle: text("variant_title"),
  quantity: integer("quantity").notNull().default(1),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("USD"),

  // Dates
  scheduledFor: date("scheduled_for"), // When this order was scheduled to be created
  orderDate: timestamp("order_date").notNull(),
  shippedAt: timestamp("shipped_at"),
  deliveredAt: timestamp("delivered_at"),

  // Customer info (denormalized)
  customerEmail: text("customer_email"),
  customerName: text("customer_name"),

  // Shipping information
  shippingAddress: jsonb("shipping_address"),
  trackingNumber: text("tracking_number"),
  shippingMethod: text("shipping_method"),

  // Payment
  paymentStatus: text("payment_status"), // 'pending', 'paid', 'failed', 'refunded'
  transactionId: text("transaction_id"),

  // Seal timestamps
  sealCreatedAt: timestamp("seal_created_at").notNull(),
  sealUpdatedAt: timestamp("seal_updated_at").notNull(),

  // Complete raw JSON from Seal
  rawData: jsonb("raw_data").notNull(),

  // Sync metadata
  syncedAt: timestamp("synced_at").notNull().defaultNow(),
  lastWebhookAt: timestamp("last_webhook_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index("seal_orders_org_id_idx").on(table.organizationId),
  sealOrderIdIdx: index("seal_orders_seal_id_idx").on(table.sealOrderId),
  subscriptionIdIdx: index("seal_orders_subscription_id_idx").on(table.subscriptionId),
  statusIdx: index("seal_orders_status_idx").on(table.status),
  orderDateIdx: index("seal_orders_order_date_idx").on(table.orderDate),
  scheduledForIdx: index("seal_orders_scheduled_for_idx").on(table.scheduledFor),
  internalOrderIdx: index("seal_orders_internal_order_idx").on(table.internalOrderId),
  uniqueSealOrder: uniqueIndex("seal_orders_unique").on(table.organizationId, table.sealOrderId),
}));

// Seal Customers table - Customer data from Seal Subscriptions
export const sealCustomers = pgTable("seal_customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  // Seal identifier
  sealCustomerId: text("seal_customer_id").notNull(),

  // Internal mapping
  internalCustomerId: uuid("internal_customer_id").references(() => customers.id),

  // Customer details
  email: text("email").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  phone: text("phone"),
  acceptsMarketing: boolean("accepts_marketing").default(false),

  // Default addresses
  defaultShippingAddress: jsonb("default_shipping_address"),
  defaultBillingAddress: jsonb("default_billing_address"),

  // Customer metadata
  tags: text("tags").array(),
  notes: text("notes"),
  totalSpent: decimal("total_spent", { precision: 10, scale: 2 }).default("0"),
  ordersCount: integer("orders_count").default(0),

  // Seal timestamps
  sealCreatedAt: timestamp("seal_created_at").notNull(),
  sealUpdatedAt: timestamp("seal_updated_at").notNull(),

  // Complete raw JSON from Seal
  rawData: jsonb("raw_data").notNull(),

  // Sync metadata
  syncedAt: timestamp("synced_at").notNull().defaultNow(),
  lastWebhookAt: timestamp("last_webhook_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index("seal_customers_org_id_idx").on(table.organizationId),
  sealCustomerIdIdx: index("seal_customers_seal_id_idx").on(table.sealCustomerId),
  emailIdx: index("seal_customers_email_idx").on(table.email),
  internalCustomerIdx: index("seal_customers_internal_customer_idx").on(table.internalCustomerId),
  uniqueSealCustomer: uniqueIndex("seal_customers_unique").on(table.organizationId, table.sealCustomerId),
}));

// Seal Sync Log table - Track sync operations for Seal
export const sealSyncLog = pgTable("seal_sync_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  // Sync operation details
  syncType: text("sync_type").notNull(), // 'subscriptions', 'orders', 'customers', 'full_sync'
  direction: text("direction").notNull(), // 'inbound', 'outbound'
  status: text("status").notNull(), // 'success', 'error', 'in_progress'

  // Metrics
  itemsProcessed: integer("items_processed").default(0),
  itemsSuccess: integer("items_success").default(0),
  itemsError: integer("items_error").default(0),
  itemsSkipped: integer("items_skipped").default(0),

  // Error details
  errorMessage: text("error_message"),
  errorDetails: jsonb("error_details"),

  // Timing
  startedAt: timestamp("started_at").defaultNow(),
  completedAt: timestamp("completed_at"),

  // Metadata
  metadata: jsonb("metadata"), // Additional sync details
  triggeredBy: text("triggered_by"), // 'manual', 'webhook', 'scheduled'

  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  orgIdIdx: index("seal_sync_log_org_id_idx").on(table.organizationId),
  syncTypeIdx: index("seal_sync_log_type_idx").on(table.syncType),
  statusIdx: index("seal_sync_log_status_idx").on(table.status),
  createdAtIdx: index("seal_sync_log_created_at_idx").on(table.createdAt),
}));