import { pgTable, uuid, text, integer, decimal, boolean, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, recipes, inventoryItems } from "../schema";

export const shopifyProducts = pgTable("shopify_products", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

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
  variantPrice: decimal("variant_price", { precision: 10, scale: 2 }),
  variantCompareAtPrice: decimal("variant_compare_at_price", { precision: 10, scale: 2 }),
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
  internalRecipeId: uuid("internal_recipe_id").references(() => recipes.id, { onDelete: "set null" }),
  internalInventoryItemId: uuid("internal_inventory_item_id").references(() => inventoryItems.id, { onDelete: "set null" }),
  mappingType: text("mapping_type"),
  mappingNotes: text("mapping_notes"),

  // Metadata
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index("shopify_products_org_id_idx").on(table.organizationId),
  shopifyProductIdIdx: index("shopify_products_shopify_id_idx").on(table.shopifyProductId),
  statusIdx: index("shopify_products_status_idx").on(table.status),
  handleIdx: index("shopify_products_handle_idx").on(table.handle),
  skuIdx: index("shopify_products_sku_idx").on(table.variantSku),
  vendorIdx: index("shopify_products_vendor_idx").on(table.vendor),
  syncedAtIdx: index("shopify_products_synced_at_idx").on(table.syncedAt),
  mappingTypeIdx: index("shopify_products_mapping_type_idx").on(table.mappingType),
  uniqueShopifyProduct: uniqueIndex("shopify_products_unique").on(
    table.organizationId,
    table.shopifyProductId
  ),
}));