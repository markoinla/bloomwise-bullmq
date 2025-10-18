import {
  boolean,
  decimal,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, recipes, inventoryItems, user } from "../schema";

// ============================================
// Products & Product Variants Tables
// ============================================

// Products table - Unified catalog of all sellable items
export const products = pgTable("products", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  // Product type classification
  type: text("type").notNull(), // 'recipe', 'inventory_item', 'subscription', 'bundle', 'custom', 'add_on'

  // Internal references (flexible based on type)
  recipeId: uuid("recipe_id").references(() => recipes.id, { onDelete: "set null" }), // For recipe-based products
  inventoryItemId: uuid("inventory_item_id").references(() => inventoryItems.id, { onDelete: "set null" }), // For direct inventory products
  bundleItems: jsonb("bundle_items"), // For bundle products: [{productId, quantity, optional}]

  // Core product information
  name: text("name").notNull(),
  description: text("description"),
  sku: text("sku"), // Internal SKU
  barcode: text("barcode"),

  // Pricing
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  compareAtPrice: decimal("compare_at_price", { precision: 10, scale: 2 }), // Original price for sale display
  costPerUnit: decimal("cost_per_unit", { precision: 10, scale: 2 }), // Internal cost

  // Product attributes
  requiresShipping: boolean("requires_shipping").notNull().default(true),
  isPhysicalProduct: boolean("is_physical_product").notNull().default(true),
  isTaxable: boolean("is_taxable").notNull().default(true),
  weight: decimal("weight", { precision: 10, scale: 2 }), // In pounds or kg
  weightUnit: text("weight_unit").default("lb"), // 'lb', 'kg'

  // Subscription support
  isSubscriptionEligible: boolean("is_subscription_eligible").notNull().default(false),
  subscriptionIntervals: text("subscription_intervals").array(), // ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']
  subscriptionConfig: jsonb("subscription_config"), // {deliveryFrequency, minCommitment, contentType, etc}

  // External platform mappings
  shopifyProductId: text("shopify_product_id"),
  shopifyVariantIds: text("shopify_variant_ids").array(), // Array of associated Shopify variant IDs

  // External IDs for other platforms
  externalProductId: text("external_product_id"), // Generic external product ID
  externalPlatform: text("external_platform"), // 'shopify', 'woocommerce', 'etsy', etc.

  // Images & Media
  primaryImageUrl: text("primary_image_url"),
  imageUrls: text("image_urls").array(),
  videoUrl: text("video_url"),

  // Categorization & Discovery
  category: text("category"), // Product category
  tags: text("tags").array(),
  collections: text("collections").array(), // Product collections

  // SEO & Display
  handle: text("handle"), // URL-friendly slug
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  displayOrder: integer("display_order").default(0),

  // Inventory tracking (if not linked to inventoryItems)
  trackInventory: boolean("track_inventory").notNull().default(false),
  inventoryQuantity: integer("inventory_quantity").default(0),
  allowBackorder: boolean("allow_backorder").notNull().default(false),
  lowStockThreshold: integer("low_stock_threshold"),

  // Status & Publishing
  isActive: boolean("is_active").notNull().default(true),
  isPublished: boolean("is_published").notNull().default(false),
  publishedAt: timestamp("published_at"),
  isFeatured: boolean("is_featured").notNull().default(false),
  featuredOrder: integer("featured_order"),

  // Metadata
  customAttributes: jsonb("custom_attributes"), // Flexible key-value pairs
  internalNotes: text("internal_notes"), // Staff-only notes

  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdBy: text("created_by").references(() => user.id),
  updatedBy: text("updated_by").references(() => user.id),
  deletedAt: timestamp("deleted_at"), // Soft delete
}, (table) => ({
  orgIdIdx: index("products_org_id_idx").on(table.organizationId),
  typeIdx: index("products_type_idx").on(table.type),
  recipeIdIdx: index("products_recipe_id_idx").on(table.recipeId),
  inventoryItemIdIdx: index("products_inventory_item_id_idx").on(table.inventoryItemId),
  shopifyProductIdIdx: index("products_shopify_product_id_idx").on(table.shopifyProductId),
  skuIdx: index("products_sku_idx").on(table.sku),
  handleIdx: index("products_handle_idx").on(table.handle),
  isActiveIdx: index("products_is_active_idx").on(table.isActive),
  isPublishedIdx: index("products_is_published_idx").on(table.isPublished),
  subscriptionEligibleIdx: index("products_subscription_eligible_idx").on(table.isSubscriptionEligible),
  featuredIdx: index("products_featured_idx").on(table.isFeatured, table.featuredOrder),
  // Ensure unique SKU per organization (if SKU is provided)
  orgSkuIdx: uniqueIndex("products_org_sku_idx").on(table.organizationId, table.sku),
  // Ensure unique handle per organization (if handle is provided)
  orgHandleIdx: uniqueIndex("products_org_handle_idx").on(table.organizationId, table.handle),
  // Ensure unique Shopify product mapping per organization
  orgShopifyProductIdx: uniqueIndex("products_org_shopify_product_idx").on(table.organizationId, table.shopifyProductId),
}));

// Product Variants table - Customer-facing variations of products
export const productVariants = pgTable("product_variants", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),

  // Variant identification
  name: text("name").notNull(), // e.g., "Small", "Medium", "Large", "Weekly", "Monthly"
  sku: text("sku"), // Variant-specific SKU
  barcode: text("barcode"),

  // Variant options (for multi-dimensional variants)
  option1Name: text("option1_name"), // e.g., "Size", "Frequency", "Color"
  option1Value: text("option1_value"), // e.g., "Large", "Monthly", "Red"
  option2Name: text("option2_name"), // e.g., "Style"
  option2Value: text("option2_value"), // e.g., "Classic"
  option3Name: text("option3_name"), // e.g., "Add-on"
  option3Value: text("option3_value"), // e.g., "With Card"

  // Pricing (overrides product pricing if set)
  price: decimal("price", { precision: 10, scale: 2 }),
  compareAtPrice: decimal("compare_at_price", { precision: 10, scale: 2 }),
  costPerUnit: decimal("cost_per_unit", { precision: 10, scale: 2 }),

  // Physical attributes
  weight: decimal("weight", { precision: 10, scale: 2 }),
  weightUnit: text("weight_unit"),

  // Recipe variant mapping (for recipe-based products)
  recipeVariantId: uuid("recipe_variant_id"), // Links to recipeVariants for production purposes

  // External platform mappings
  shopifyVariantId: text("shopify_variant_id"),
  externalVariantId: text("external_variant_id"),

  // Images (variant-specific images override product images)
  imageUrl: text("image_url"),
  imageUrls: text("image_urls").array(),

  // Inventory tracking (variant level)
  trackInventory: boolean("track_inventory").notNull().default(false),
  inventoryQuantity: integer("inventory_quantity").default(0),
  allowBackorder: boolean("allow_backorder").notNull().default(false),
  lowStockThreshold: integer("low_stock_threshold"),

  // Display & Ordering
  sortOrder: integer("sort_order").notNull().default(0),
  isDefault: boolean("is_default").notNull().default(false), // Default selected variant
  displayName: text("display_name"), // How to display in UI (can differ from name)

  // Status
  isActive: boolean("is_active").notNull().default(true),
  isAvailable: boolean("is_available").notNull().default(true), // Temporary availability toggle

  // Metadata
  customAttributes: jsonb("custom_attributes"),
  internalNotes: text("internal_notes"),

  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index("product_variants_org_id_idx").on(table.organizationId),
  productIdIdx: index("product_variants_product_id_idx").on(table.productId),
  recipeVariantIdIdx: index("product_variants_recipe_variant_id_idx").on(table.recipeVariantId),
  shopifyVariantIdIdx: index("product_variants_shopify_variant_id_idx").on(table.shopifyVariantId),
  skuIdx: index("product_variants_sku_idx").on(table.sku),
  sortOrderIdx: index("product_variants_sort_order_idx").on(table.sortOrder),
  isDefaultIdx: index("product_variants_is_default_idx").on(table.isDefault),
  // Ensure unique variant name per product
  productVariantNameIdx: uniqueIndex("product_variants_product_name_idx").on(table.productId, table.name),
  // Ensure unique SKU per organization (if SKU is provided)
  orgSkuIdx: uniqueIndex("product_variants_org_sku_idx").on(table.organizationId, table.sku),
  // Ensure unique Shopify variant mapping per organization (variants are unique within a Shopify store)
  shopifyVariantUniqueIdx: uniqueIndex("product_variants_shopify_variant_unique_idx").on(table.organizationId, table.shopifyVariantId),
}));