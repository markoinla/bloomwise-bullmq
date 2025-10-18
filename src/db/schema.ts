/**
 * Database schema for BullMQ Worker
 *
 * This file contains only the tables needed by the worker service:
 * - shopifyIntegrations - To fetch Shopify credentials
 * - syncJobs - To update job status and progress
 * - shopifyProducts - To store synced products (optional, for reference)
 *
 * These schemas must match the bloomwise main database exactly.
 */

import { pgTable, text, timestamp, integer, jsonb, boolean, pgEnum, uuid } from "drizzle-orm/pg-core";

// ============================================
// Sync Jobs Tables
// ============================================

export const syncJobStatusEnum = pgEnum("sync_job_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "paused"
]);

export const syncJobTypeEnum = pgEnum("sync_job_type", [
  "full_sync",
  "shopify_orders_initial",
  "shopify_orders_incremental",
  "shopify_products",
  "shopify_products_initial",
  "shopify_products_incremental",
  "shopify_customers"
]);

export const syncJobs = pgTable("sync_jobs", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),

  // Job details
  type: syncJobTypeEnum("type").notNull(),
  status: syncJobStatusEnum("status").notNull().default("pending"),

  // Progress tracking
  totalItems: integer("total_items").default(0),
  processedItems: integer("processed_items").default(0),
  successCount: integer("success_count").default(0),
  errorCount: integer("error_count").default(0),
  skipCount: integer("skip_count").default(0),

  // Pagination/batching info
  currentPage: integer("current_page").default(0),
  pageSize: integer("page_size").default(250),
  lastProcessedId: text("last_processed_id"),
  nextPageToken: text("next_page_token"),

  // Configuration
  config: jsonb("config").$type<{
    source?: string;
    dateFrom?: string;
    dateTo?: string;
    fetchAll?: boolean;
    syncToInternal?: boolean;
    filters?: Record<string, any>;
  }>(),

  // Error tracking
  errorMessage: text("error_message"),
  lastError: text("last_error"),
  errors: jsonb("errors").$type<Array<{
    timestamp: string;
    message: string;
    item?: any;
  }>>().default([]),

  // Timing
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  estimatedCompletionAt: timestamp("estimated_completion_at"),
  lastActivityAt: timestamp("last_activity_at"),

  // Metadata
  metadata: jsonb("metadata").$type<Record<string, any>>(),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdBy: text("created_by"),
});

// ============================================
// Shopify Integration Tables
// ============================================

export const shopifyIntegrations = pgTable("shopify_integrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  shopDomain: text("shop_domain").notNull(),
  accessToken: text("access_token").notNull(),
  scope: text("scope").notNull(),
  isActive: boolean("is_active").default(true),
  nonce: text("nonce"),

  // Sync tracking fields
  lastOrderSyncAt: timestamp("last_order_sync_at"),
  autoSyncOrders: boolean("auto_sync_orders").default(false),
  autoSyncProducts: boolean("auto_sync_products").default(false),
  syncFrequency: text("sync_frequency").default("hourly"),

  installedAt: timestamp("installed_at").defaultNow(),
  uninstalledAt: timestamp("uninstalled_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ============================================
// Shopify Products Tables
// ============================================

export const shopifyProducts = pgTable("shopify_products", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),

  // Shopify identifiers
  shopifyProductId: text("shopify_product_id").notNull(),
  shopifyVariantId: text("shopify_variant_id"),

  // Product information
  title: text("title").notNull(),
  bodyHtml: text("body_html"),
  vendor: text("vendor"),
  productType: text("product_type"),
  handle: text("handle").notNull(),

  // Variant-specific information
  variantTitle: text("variant_title"),
  variantPrice: text("variant_price"), // stored as text to match GraphQL string format, DB accepts it
  variantCompareAtPrice: text("variant_compare_at_price"),
  variantSku: text("variant_sku"),
  variantBarcode: text("variant_barcode"),
  variantGrams: integer("variant_grams"),
  variantInventoryQuantity: integer("variant_inventory_quantity"),
  variantInventoryPolicy: text("variant_inventory_policy"),
  variantFulfillmentService: text("variant_fulfillment_service"),
  variantInventoryManagement: text("variant_inventory_management"),
  variantRequiresShipping: boolean("variant_requires_shipping").default(true),
  variantTaxable: boolean("variant_taxable").default(true),
  variantPosition: integer("variant_position"),

  // Variant options
  option1: text("option1"),
  option1Value: text("option1_value"),
  option2: text("option2"),
  option2Value: text("option2_value"),
  option3: text("option3"),
  option3Value: text("option3_value"),

  // Status and availability
  status: text("status").notNull(),
  publishedAt: timestamp("published_at"),
  publishedScope: text("published_scope"),

  // SEO
  seoTitle: text("seo_title"),
  seoDescription: text("seo_description"),

  // Images
  featuredImage: text("featured_image"),
  variantImage: text("variant_image"),
  allImages: jsonb("all_images"),

  // Tags and collections
  tags: text("tags"),
  collections: jsonb("collections"),

  // Timestamps from Shopify
  shopifyCreatedAt: timestamp("shopify_created_at").notNull(),
  shopifyUpdatedAt: timestamp("shopify_updated_at").notNull(),

  // Complete raw JSON from Shopify
  rawProductData: jsonb("raw_product_data").notNull(),
  rawVariantData: jsonb("raw_variant_data"),

  // Sync metadata
  apiVersion: text("api_version").notNull().default("2024-10"),
  syncedAt: timestamp("synced_at").notNull().defaultNow(),
  lastWebhookAt: timestamp("last_webhook_at"),

  // Internal mapping
  internalRecipeId: uuid("internal_recipe_id"),
  internalInventoryItemId: uuid("internal_inventory_item_id"),
  mappingType: text("mapping_type"),
  mappingNotes: text("mapping_notes"),

  // Metadata
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const shopifyVariants = pgTable("shopify_variants", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),

  // Shopify identifiers
  shopifyProductId: text("shopify_product_id").notNull(),
  shopifyVariantId: text("shopify_variant_id").notNull(),

  // Variant information
  title: text("title"),
  variantTitle: text("variant_title"),
  sku: text("sku"),
  barcode: text("barcode"),
  grams: integer("grams"),
  weight: text("weight"),
  weightUnit: text("weight_unit"),

  // Pricing
  price: text("price"),
  compareAtPrice: text("compare_at_price"),

  // Inventory
  inventoryQuantity: integer("inventory_quantity"),
  inventoryPolicy: text("inventory_policy"),
  inventoryManagement: text("inventory_management"),
  fulfillmentService: text("fulfillment_service"),
  requiresShipping: boolean("requires_shipping").default(true),
  taxable: boolean("taxable").default(true),
  taxCode: text("tax_code"),

  // Options (up to 3 in Shopify)
  option1Name: text("option1_name"),
  option1Value: text("option1_value"),
  option2Name: text("option2_name"),
  option2Value: text("option2_value"),
  option3Name: text("option3_name"),
  option3Value: text("option3_value"),

  // Display
  position: integer("position"),
  imageId: text("image_id"),
  imageSrc: text("image_src"),

  // Internal mapping
  internalRecipeVariantId: uuid("internal_recipe_variant_id"),
  internalRecipeId: uuid("internal_recipe_id"),
  internalInventoryItemId: uuid("internal_inventory_item_id"),
  mappingType: text("mapping_type"),
  mappingNotes: text("mapping_notes"),

  // Status
  isActive: boolean("is_active").notNull().default(true),
  availableForSale: boolean("available_for_sale").default(true),

  // Timestamps from Shopify
  shopifyCreatedAt: timestamp("shopify_created_at"),
  shopifyUpdatedAt: timestamp("shopify_updated_at"),

  // Raw data from Shopify
  rawData: jsonb("raw_data"),

  // Sync metadata
  syncedAt: timestamp("synced_at").notNull().defaultNow(),
  lastWebhookAt: timestamp("last_webhook_at"),

  // System timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Type exports for use in job processors
export type SyncJob = typeof syncJobs.$inferSelect;
export type SyncJobInsert = typeof syncJobs.$inferInsert;
export type ShopifyIntegration = typeof shopifyIntegrations.$inferSelect;
export type ShopifyProduct = typeof shopifyProducts.$inferSelect;
export type ShopifyProductInsert = typeof shopifyProducts.$inferInsert;
export type ShopifyVariant = typeof shopifyVariants.$inferSelect;
export type ShopifyVariantInsert = typeof shopifyVariants.$inferInsert;
