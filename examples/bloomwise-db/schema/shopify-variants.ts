import { pgTable, uuid, text, integer, decimal, boolean, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, recipes, inventoryItems, recipeVariants } from "../schema";

export const shopifyVariants = pgTable("shopify_variants", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  // Shopify identifiers
  shopifyProductId: text("shopify_product_id").notNull(),
  shopifyVariantId: text("shopify_variant_id").notNull(),

  // Variant information
  title: text("title"),
  variantTitle: text("variant_title"),
  sku: text("sku"),
  barcode: text("barcode"),
  grams: integer("grams"),
  weight: decimal("weight", { precision: 10, scale: 2 }),
  weightUnit: text("weight_unit"),

  // Pricing
  price: decimal("price", { precision: 10, scale: 2 }),
  compareAtPrice: decimal("compare_at_price", { precision: 10, scale: 2 }),

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

  // Internal mapping - to our system
  internalRecipeVariantId: uuid("internal_recipe_variant_id").references(() => recipeVariants.id, { onDelete: "set null" }),
  internalRecipeId: uuid("internal_recipe_id").references(() => recipes.id, { onDelete: "set null" }),
  internalInventoryItemId: uuid("internal_inventory_item_id").references(() => inventoryItems.id, { onDelete: "set null" }),
  mappingType: text("mapping_type"), // 'recipe', 'inventory', 'recipe_variant'
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
}, (table) => ({
  // Unique constraint on org + variant ID
  orgVariantIdx: uniqueIndex("shopify_variants_org_variant_idx").on(
    table.organizationId,
    table.shopifyVariantId
  ),
  // Index for product lookups
  productIdx: index("shopify_variants_product_idx").on(table.shopifyProductId),
  // Index for SKU lookups
  skuIdx: index("shopify_variants_sku_idx").on(table.sku),
  // Index for organization queries
  orgIdx: index("shopify_variants_org_idx").on(table.organizationId),
  // Index for mapping type queries
  mappingTypeIdx: index("shopify_variants_mapping_type_idx").on(table.mappingType),
  // Index for active variants
  activeIdx: index("shopify_variants_active_idx").on(table.isActive),
  // Composite index for org + product
  orgProductIdx: index("shopify_variants_org_product_idx").on(
    table.organizationId,
    table.shopifyProductId
  ),
}));