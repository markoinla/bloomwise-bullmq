import {
  boolean,
  decimal,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  date,
  time,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Import products tables for foreign key references
import { products, productVariants } from './schema/products';

// Better Auth Tables
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  firstName: text("firstName"),
  lastName: text("lastName"),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  // Better Auth admin plugin fields
  role: text("role").default("user"),
  banned: boolean("banned").default(false),
  banReason: text("banReason"),
  banExpires: timestamp("banExpires"),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expiresAt").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // Better Auth admin plugin field
  impersonatedBy: text("impersonatedBy"),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt"),
  refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

// Subscription table for payment provider webhook data (Polar/Stripe)
export const subscription = pgTable("subscription", {
  id: text("id").primaryKey(),
  createdAt: timestamp("createdAt").notNull(),
  modifiedAt: timestamp("modifiedAt"),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  recurringInterval: text("recurringInterval").notNull(),
  status: text("status").notNull(),
  currentPeriodStart: timestamp("currentPeriodStart").notNull(),
  currentPeriodEnd: timestamp("currentPeriodEnd").notNull(),
  cancelAtPeriodEnd: boolean("cancelAtPeriodEnd").notNull().default(false),
  canceledAt: timestamp("canceledAt"),
  startedAt: timestamp("startedAt").notNull(),
  endsAt: timestamp("endsAt"),
  endedAt: timestamp("endedAt"),
  customerId: text("customerId").notNull(),
  productId: text("productId").notNull(),
  discountId: text("discountId"),
  checkoutId: text("checkoutId").notNull(),
  customerCancellationReason: text("customerCancellationReason"),
  customerCancellationComment: text("customerCancellationComment"),
  metadata: text("metadata"), // JSON string
  customFieldData: text("customFieldData"), // JSON string
  userId: text("userId").references(() => user.id),
  organizationId: text("organizationId"), // For organization-based subscriptions
  planId: text("planId"), // The plan identifier (starter, pro, enterprise)
  // Stripe-specific fields
  provider: text("provider").default("polar"), // 'polar' or 'stripe'
  stripeSubscriptionId: text("stripeSubscriptionId"),
  stripePriceId: text("stripePriceId"),
  stripeCustomerId: text("stripeCustomerId"),
});

// ============================================
// Multi-Tenancy Tables
// ============================================

// Organizations table - Groups users into accounts/businesses
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(), // URL-friendly identifier

  // Owner
  ownerId: text("owner_id").notNull().references(() => user.id),

  // Subscription & Billing
  subscriptionStatus: text("subscription_status").default("trial"), // 'trial', 'active', 'canceled', 'expired'
  planType: text("plan_type").default("free"), // 'free', 'starter', 'pro', 'enterprise'
  subscriptionId: text("subscription_id").references(() => subscription.id),
  stripeCustomerId: text("stripe_customer_id"), // Stripe customer ID for the organization

  // Business Details
  businessType: text("business_type"), // 'florist', 'event_planner', 'wedding_venue'
  phone: text("phone"),
  email: text("email"),
  website: text("website"),
  shopifyStoreUrl: text("shopify_store_url"), // e.g. 'your-store.myshopify.com'

  // Additional Business Info (collected during onboarding)
  services: text("services"), // JSON array of services: ['weddings', 'events', 'retail', 'corporate', 'funeral', 'subscription']
  referralSource: text("referral_source"), // JSON array: ['google', 'social_media', 'friend', 'trade_show', 'other']
  employeeCount: text("employee_count"), // Range: '1', '2-5', '6-10', '11-20', '21-50', '50+'
  eventsPerYear: text("events_per_year"), // Range: '1-10', '11-25', '26-50', '51-100', '101-200', '200+'

  // Address
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  country: text("country").default("US"),

  // Settings
  timezone: text("timezone").default("America/New_York"),
  currency: text("currency").default("USD"),
  taxRate: decimal("tax_rate", { precision: 5, scale: 2 }),

  // Metadata
  logoUrl: text("logo_url"),
  settings: text("settings"), // JSON string for custom settings

  // Onboarding
  onboardingStatus: text("onboarding_status").default("pending"), // 'pending', 'in_progress', 'skipped', 'completed'
  onboardingStep: integer("onboarding_step").default(0), // Current step in onboarding (0 = not started)
  onboardingCompletedAt: timestamp("onboarding_completed_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Organization Members - Users belonging to organizations
export const organizationMembers = pgTable("organization_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),

  role: text("role").notNull().default("member"), // 'owner', 'admin', 'member', 'viewer'

  // Permissions (granular permission system)
  canManageInventory: boolean("can_manage_inventory").default(true),
  canManageOrders: boolean("can_manage_orders").default(true),
  canManageRecipes: boolean("can_manage_recipes").default(false),
  canManageSettings: boolean("can_manage_settings").default(false),
  canViewReports: boolean("can_view_reports").default(true),
  canManageMembers: boolean("can_manage_members").default(false),
  canManageRoles: boolean("can_manage_roles").default(false),
  canViewAuditLogs: boolean("can_view_audit_logs").default(false),
  canManageIntegrations: boolean("can_manage_integrations").default(false),

  joinedAt: timestamp("joined_at").notNull().defaultNow(),
  invitedBy: text("invited_by").references(() => user.id),
  invitedAt: timestamp("invited_at"),
  acceptedAt: timestamp("accepted_at"),
}, (table) => ({
  orgUserIdx: uniqueIndex("org_members_org_user_idx").on(table.organizationId, table.userId),
}));

// User Invitations - Pending invitations to join organizations
export const userInvitations = pgTable("user_invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default("member"),
  token: text("token").notNull().unique(),

  // Permissions for the invited user
  canManageInventory: boolean("can_manage_inventory").default(true),
  canManageOrders: boolean("can_manage_orders").default(true),
  canManageRecipes: boolean("can_manage_recipes").default(false),
  canManageSettings: boolean("can_manage_settings").default(false),
  canViewReports: boolean("can_view_reports").default(true),
  canManageMembers: boolean("can_manage_members").default(false),
  canManageRoles: boolean("can_manage_roles").default(false),
  canViewAuditLogs: boolean("can_view_audit_logs").default(false),
  canManageIntegrations: boolean("can_manage_integrations").default(false),

  invitedBy: text("invited_by").notNull().references(() => user.id),
  invitedAt: timestamp("invited_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  acceptedBy: text("accepted_by").references(() => user.id),
  status: text("status").notNull().default("pending"), // 'pending', 'accepted', 'expired', 'revoked'
}, (table) => ({
  emailOrgIdx: uniqueIndex("invitations_email_org_idx").on(table.email, table.organizationId),
  tokenIdx: index("invitations_token_idx").on(table.token),
}));

// User Activity Logs - Audit trail for all user actions
export const userActivityLogs = pgTable("user_activity_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => user.id),

  // Activity details
  action: text("action").notNull(), // 'created', 'updated', 'deleted', 'viewed', 'exported', etc.
  resource: text("resource").notNull(), // 'inventory', 'order', 'recipe', 'user', 'organization', etc.
  resourceId: text("resource_id"), // ID of the affected resource

  // Additional context
  description: text("description"),
  metadata: jsonb("metadata"), // Additional structured data
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  orgUserIdx: index("activity_logs_org_user_idx").on(table.organizationId, table.userId),
  resourceIdx: index("activity_logs_resource_idx").on(table.resource, table.resourceId),
  actionIdx: index("activity_logs_action_idx").on(table.action),
  createdAtIdx: index("activity_logs_created_at_idx").on(table.createdAt),
}));

// ============================================
// Inventory Management Tables
// ============================================

// Categories table - Organizes inventory items into logical groups
export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull(), // 'flowers', 'greenery', 'fillers', 'supplies', 'containers', 'custom'
  description: text("description"),

  // Visual customization
  color: text("color").default("#6B7280"), // Hex color for UI display
  icon: text("icon").default("folder"), // Icon identifier (lucide icon name)

  // Metadata
  isDefault: boolean("is_default").notNull().default(false), // Was created from template
  isActive: boolean("is_active").notNull().default(true), // Soft delete support
  sortOrder: integer("sort_order").default(0),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => {
  return {
    // Ensure unique category types per organization
    orgTypeUnique: uniqueIndex("categories_org_type_unique").on(table.organizationId, table.type),
  };
});

// Vendors table - Stores supplier information
export const vendors = pgTable("vendors", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  email: text("email"),
  phone: text("phone"),
  website: text("website"),
  address: text("address"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Inventory Items table - Core catalog with stock levels and pricing
export const inventoryItems = pgTable("inventory_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  // External catalog reference
  externalProductId: text("external_product_id"), // Catalog's product_id (e.g., "2936717")

  // Core product info
  sku: text("sku"),
  name: text("name").notNull(),
  description: text("description"),
  categoryId: uuid("category_id").references(() => categories.id), // Our internal category (flowers, greenery, etc.)
  vendorId: uuid("vendor_id").references(() => vendors.id),

  // Catalog taxonomy
  productFamily: text("product_family"), // Catalog's category_name (e.g., "Acacia Foliage", "Garden Rose")
  varietyName: text("variety_name"), // Specific variety (e.g., "Feather", "Freedom")
  colorName: text("color_name"), // Catalog color name (e.g., "Green", "Hot Pink")

  // Units & Stock
  unitType: text("unit_type").notNull(), // 'stem', 'bunch', 'piece', 'yard'
  currentStock: decimal("current_stock", { precision: 10, scale: 2 }).notNull().default("0"),
  minStock: decimal("min_stock", { precision: 10, scale: 2 }).default("0"),
  maxStock: decimal("max_stock", { precision: 10, scale: 2 }),
  reorderPoint: decimal("reorder_point", { precision: 10, scale: 2 }),

  // Pricing
  costPerUnit: decimal("cost_per_unit", { precision: 10, scale: 2 }).notNull(),
  retailPrice: decimal("retail_price", { precision: 10, scale: 2 }),

  // Perishability
  isPerishable: boolean("is_perishable").notNull().default(false),
  shelfLifeDays: integer("shelf_life_days"),

  // Visual & Metadata
  image: text("image"), // Catalog image filename (e.g., "acacia-feather-green.jpg")
  imageUrl: text("image_url"), // Full URL to image
  thumbnailUrl: text("thumbnail_url"),
  color: text("color"), // UI display color (kept for backward compatibility)
  colorHex: text("color_hex"), // Hex color code for UI display
  stemLength: integer("stem_length"), // In cm, for flowers
  tags: text("tags").array(), // Array of tags
  seasonalMonths: jsonb("seasonal_months"), // ["jan", "feb", "mar", ...] from catalog
  seasonality: text("seasonality").array(), // ['spring', 'summer', 'fall', 'winter'] - kept for compatibility

  // Status
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdBy: text("created_by").references(() => user.id),
  updatedBy: text("updated_by").references(() => user.id),
});

// Stock Movements table - Audit trail of all inventory changes
export const stockMovements = pgTable("stock_movements", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  inventoryItemId: uuid("inventory_item_id").notNull().references(() => inventoryItems.id),
  movementType: text("movement_type").notNull(), // 'purchase', 'adjustment', 'waste', 'return', 'sale'
  quantity: decimal("quantity", { precision: 10, scale: 2 }).notNull(),
  unitCost: decimal("unit_cost", { precision: 10, scale: 2 }),
  totalCost: decimal("total_cost", { precision: 10, scale: 2 }),

  // Reference to source (for future integration)
  referenceType: text("reference_type"), // 'manual', 'order', 'recipe', 'purchase_order'
  referenceId: uuid("reference_id"),

  notes: text("notes"),
  performedAt: timestamp("performed_at").notNull().defaultNow(),
  performedBy: text("performed_by").references(() => user.id),
});

// ============================================
// Recipe Management Tables
// ============================================

// Recipes table - Master catalog of floral arrangements
export const recipes = pgTable("recipes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  code: text("code"), // Internal recipe code
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull(), // 'bouquet', 'centerpiece', 'sympathy', 'wedding', 'seasonal'

  // Difficulty and time
  difficulty: text("difficulty").notNull(), // 'easy', 'medium', 'hard'
  prepTimeMinutes: integer("prep_time_minutes").notNull(),
  designTimeMinutes: integer("design_time_minutes").default(0),

  // Pricing
  laborCost: decimal("labor_cost", { precision: 10, scale: 2 }).default("0"),
  hourlyRate: decimal("hourly_rate", { precision: 10, scale: 2 }).default("50"),
  targetMarginPercent: integer("target_margin_percent").default(65),
  retailPrice: decimal("retail_price", { precision: 10, scale: 2 }).notNull(),

  // Images
  primaryImageUrl: text("primary_image_url"),
  imageUrls: text("image_urls").array(),

  // Usage tracking
  timesUsed: integer("times_used").notNull().default(0),
  lastUsedAt: timestamp("last_used_at"),
  averageRating: decimal("average_rating", { precision: 3, scale: 2 }),

  // Metadata
  tags: text("tags").array(), // Legacy field - will be removed after migration
  seasonality: text("seasonality").array(), // ['spring', 'summer', 'fall', 'winter']
  occasions: text("occasions").array(), // ['birthday', 'anniversary', 'sympathy', etc.]

  // Shopify integration
  shopifyProductId: text("shopify_product_id"),
  shopifyVariantIds: text("shopify_variant_ids").array(),

  isActive: boolean("is_active").notNull().default(true),
  isPublished: boolean("is_published").notNull().default(false),
  publishedAt: timestamp("published_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdBy: text("created_by").references(() => user.id),
  updatedBy: text("updated_by").references(() => user.id),
  deletedAt: timestamp("deleted_at"),
});

// Recipe Ingredients table - Links recipes to inventory items
export const recipeIngredients = pgTable("recipe_ingredients", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  recipeId: uuid("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  inventoryItemId: uuid("inventory_item_id").notNull().references(() => inventoryItems.id),

  quantity: decimal("quantity", { precision: 10, scale: 2 }).notNull(),
  unitType: text("unit_type").notNull(),

  // Cost override for recipe-specific pricing
  costOverride: decimal("cost_override", { precision: 10, scale: 2 }),

  // Substitutions
  allowSubstitutions: boolean("allow_substitutions").notNull().default(true),
  substitutionNotes: text("substitution_notes"),

  // Display
  displayOrder: integer("display_order").notNull().default(0),
  isOptional: boolean("is_optional").notNull().default(false),
  notes: text("notes"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Recipe Substitutions table - Alternative items for ingredients
export const recipeSubstitutions = pgTable("recipe_substitutions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  recipeIngredientId: uuid("recipe_ingredient_id").notNull().references(() => recipeIngredients.id, { onDelete: "cascade" }),
  substituteItemId: uuid("substitute_item_id").notNull().references(() => inventoryItems.id),

  quantityMultiplier: decimal("quantity_multiplier", { precision: 5, scale: 2 }).default("1.0"),
  additionalCost: decimal("additional_cost", { precision: 10, scale: 2 }).default("0"),
  preferenceOrder: integer("preference_order").notNull().default(0),
  notes: text("notes"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Recipe Steps table - Step-by-step instructions
export const recipeSteps = pgTable("recipe_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  recipeId: uuid("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),

  stepNumber: integer("step_number").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  durationMinutes: integer("duration_minutes"),

  imageUrl: text("image_url"),
  videoUrl: text("video_url"),

  materials: text("materials").array(),
  ingredients: jsonb("ingredients"), // Store step ingredients as JSON
  tips: text("tips"),
  warningNotes: text("warning_notes"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Recipe Variants table - Size/style variations of recipes
export const recipeVariants = pgTable("recipe_variants", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  recipeId: uuid("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),

  name: text("name").notNull(), // e.g., "Small", "Medium", "Large", "Deluxe"

  // Shopify integration
  shopifyVariantId: text("shopify_variant_id"),

  // Pricing
  retailPrice: decimal("retail_price", { precision: 10, scale: 2 }),

  // Display
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  // Ensure unique variant names per recipe
  recipeVariantNameIdx: uniqueIndex("recipe_variant_name_idx").on(table.recipeId, table.name),
}));

// Recipe Variant Ingredients table - Quantity overrides for variants
export const recipeVariantIngredients = pgTable("recipe_variant_ingredients", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  variantId: uuid("variant_id").notNull().references(() => recipeVariants.id, { onDelete: "cascade" }),
  recipeIngredientId: uuid("recipe_ingredient_id").notNull().references(() => recipeIngredients.id, { onDelete: "cascade" }),

  // The adjusted quantity for this variant
  quantity: decimal("quantity", { precision: 10, scale: 2 }).notNull(),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  // Ensure one quantity override per ingredient per variant
  variantIngredientIdx: uniqueIndex("variant_ingredient_idx").on(table.variantId, table.recipeIngredientId),
}));

// Shopify Recipe Variant Mappings - 1:1 mapping between Shopify variants and recipe variants
export const shopifyRecipeVariantMappings = pgTable("shopify_recipe_variant_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  shopifyVariantId: text("shopify_variant_id").notNull(),
  recipeVariantId: uuid("recipe_variant_id").notNull().references(() => recipeVariants.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  // Unique constraints for 1:1 mapping
  shopifyVariantIdx: uniqueIndex("shopify_variant_idx").on(table.shopifyVariantId),
  recipeVariantIdx: uniqueIndex("recipe_variant_idx").on(table.recipeVariantId),
}));

// ============================================
// Customer Management Tables
// ============================================

// Customers table - Customer database
export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  // Basic info
  firstName: text("first_name"),
  lastName: text("last_name"),
  email: text("email"),
  phone: text("phone"),
  alternatePhone: text("alternate_phone"),

  // Address
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  country: text("country").default("US"),

  // Preferences
  preferredContactMethod: text("preferred_contact_method"), // 'email', 'phone', 'sms'
  notificationPreferences: jsonb("notification_preferences"),
  allergyNotes: text("allergy_notes"),
  designPreferences: text("design_preferences"),

  // Business
  companyName: text("company_name"),
  taxExempt: boolean("tax_exempt").notNull().default(false),
  taxExemptId: text("tax_exempt_id"),

  // Shopify integration
  shopifyCustomerId: text("shopify_customer_id"),
  shopifyTags: text("shopify_tags"),
  totalSpent: decimal("total_spent", { precision: 10, scale: 2 }),
  ordersCount: integer("orders_count").default(0),
  acceptsMarketing: boolean("accepts_marketing").default(false),

  // Metadata
  source: text("source"), // 'shopify', 'manual', 'import'
  tags: text("tags").array(),
  notes: text("notes"),

  // Metrics
  lifetimeValue: decimal("lifetime_value", { precision: 10, scale: 2 }).default("0"),
  orderCount: integer("order_count").default(0),
  lastOrderAt: timestamp("last_order_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdBy: text("created_by").references(() => user.id),
});

// ============================================
// Order Management Tables
// ============================================

// Orders table - Central order management
export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderNumber: text("order_number").notNull(),

  // Customer
  customerId: uuid("customer_id").references(() => customers.id),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email"),
  customerPhone: text("customer_phone"),

  // Order details
  status: text("status").notNull(), // 'draft', 'pending', 'confirmed', 'in_progress', 'ready', 'completed', 'cancelled'
  priority: text("priority").notNull().default("normal"), // 'low', 'normal', 'high', 'urgent'

  // Dates
  orderDate: timestamp("order_date").notNull().defaultNow(),
  dueDate: date("due_date").notNull(),
  dueTime: time("due_time"),
  completedAt: timestamp("completed_at"),

  // Delivery/Shipping
  fulfillmentType: text("fulfillment_type").notNull(), // 'pickup', 'delivery', 'shipping'
  deliveryAddress: text("delivery_address"), // Legacy field - prefer shippingAddress
  deliveryInstructions: text("delivery_instructions"),
  deliveryFee: decimal("delivery_fee", { precision: 10, scale: 2 }).default("0"),

  // Shipping Address & Contact
  shippingName: text("shipping_name"),
  shippingPhone: text("shipping_phone"),
  shippingEmail: text("shipping_email"),
  shippingAddress1: text("shipping_address1"),
  shippingAddress2: text("shipping_address2"),
  shippingCity: text("shipping_city"),
  shippingState: text("shipping_state"),
  shippingZip: text("shipping_zip"),
  shippingCountry: text("shipping_country"),
  shippingCompany: text("shipping_company"),

  // Billing Address & Contact
  billingName: text("billing_name"),
  billingPhone: text("billing_phone"),
  billingEmail: text("billing_email"),
  billingAddress1: text("billing_address1"),
  billingAddress2: text("billing_address2"),
  billingCity: text("billing_city"),
  billingState: text("billing_state"),
  billingZip: text("billing_zip"),
  billingCountry: text("billing_country"),
  billingCompany: text("billing_company"),

  // Pricing
  subtotal: decimal("subtotal", { precision: 10, scale: 2 }).notNull(),
  taxAmount: decimal("tax_amount", { precision: 10, scale: 2 }).default("0"),
  discountAmount: decimal("discount_amount", { precision: 10, scale: 2 }).default("0"),
  total: decimal("total", { precision: 10, scale: 2 }).notNull(),

  // Cost tracking
  totalCost: decimal("total_cost", { precision: 10, scale: 2 }),
  profitAmount: decimal("profit_amount", { precision: 10, scale: 2 }),
  profitMargin: integer("profit_margin"),

  // Payment
  paymentStatus: text("payment_status").notNull().default("pending"), // 'pending', 'partial', 'paid', 'refunded'
  paymentMethod: text("payment_method"),
  paidAmount: decimal("paid_amount", { precision: 10, scale: 2 }).default("0"),

  // External platform integration
  externalOrderId: text("external_order_id"), // Generic external ID for any platform
  orderSource: text("order_source").notNull().default("manual"), // 'online', 'walk-in', 'phone', 'email', 'shopify', 'manual'

  // Shopify specific fields (kept for backwards compatibility)
  shopifyOrderId: text("shopify_order_id"),
  shopifyOrderNumber: text("shopify_order_number"),
  shopifyFulfillmentId: text("shopify_fulfillment_id"),
  shopifyFinancialStatus: text("shopify_financial_status"),
  shopifyFulfillmentStatus: text("shopify_fulfillment_status"),
  shopifyTags: text("shopify_tags"),
  shopifyCurrency: text("shopify_currency").default("USD"),
  shopifySyncedAt: timestamp("shopify_synced_at"),

  // Notes
  internalNotes: text("internal_notes"),
  customerNotes: text("customer_notes"),
  specialInstructions: text("special_instructions"),

  // Metadata
  source: text("source").notNull().default("manual"), // DEPRECATED - use orderSource instead
  tags: text("tags").array(),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdBy: text("created_by").references(() => user.id),
  assignedTo: text("assigned_to").references(() => user.id),
  cancelledAt: timestamp("cancelled_at"),
  cancelledBy: text("cancelled_by").references(() => user.id),
  cancellationReason: text("cancellation_reason"),
}, (table) => ({
  // Unique constraint to prevent duplicate orders from external platforms
  uniqueExternalOrder: uniqueIndex("orders_org_external_id_unique").on(table.organizationId, table.externalOrderId).where(sql`${table.externalOrderId} IS NOT NULL`),
}));

// Delivery Routes table - Optimized delivery route management
export const deliveryRoutes = pgTable("delivery_routes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  // Route metadata
  routeName: text("route_name").notNull(),
  routeDate: date("route_date").notNull(),
  status: text("status").notNull().default("draft"), // 'draft', 'optimized', 'in_progress', 'completed', 'cancelled'

  // Team member assignment
  assignedToUserId: text("assigned_to_user_id").references(() => user.id),
  assignedToName: text("assigned_to_name"), // Denormalized for historical record

  // Orders relationship (simplified for Phase 1)
  orderIds: text("order_ids").array().notNull().default([]), // Array of order UUIDs

  // Optimization results
  optimizedSequence: jsonb("optimized_sequence"), // [{ orderId, sequenceNumber, customerName, address }]
  totalDistance: text("total_distance"), // "12.5 miles"
  estimatedDuration: integer("estimated_duration"), // minutes
  googleMapsUrl: text("google_maps_url"),

  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdByUserId: text("created_by_user_id").references(() => user.id),
  optimizedAt: timestamp("optimized_at"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  orgIdx: index("delivery_routes_org_idx").on(table.organizationId),
  dateIdx: index("delivery_routes_date_idx").on(table.routeDate),
  statusIdx: index("delivery_routes_status_idx").on(table.status),
  assignedIdx: index("delivery_routes_assigned_idx").on(table.assignedToUserId),
}));

// Order Items table - Line items within orders
export const orderItems = pgTable("order_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),

  // Product reference (new unified approach)
  productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
  productVariantId: uuid("product_variant_id").references(() => productVariants.id, { onDelete: "set null" }),

  // Legacy product references (kept for backward compatibility and direct production linking)
  itemType: text("item_type").notNull(), // 'recipe', 'inventory', 'custom', 'product'
  recipeId: uuid("recipe_id").references(() => recipes.id),
  variantId: uuid("variant_id").references(() => recipeVariants.id), // Reference to specific recipe variant
  inventoryItemId: uuid("inventory_item_id").references(() => inventoryItems.id),

  // Item details
  name: text("name").notNull(),
  description: text("description"),

  quantity: integer("quantity").notNull(),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 }).notNull(),
  subtotal: decimal("subtotal", { precision: 10, scale: 2 }).notNull(),

  // Cost tracking
  unitCost: decimal("unit_cost", { precision: 10, scale: 2 }),
  totalCost: decimal("total_cost", { precision: 10, scale: 2 }),

  // Recipe-specific fields (snapshot at order time)
  recipeLaborMinutes: integer("recipe_labor_minutes"), // Total prep + design time for recipe
  recipeRetailPrice: decimal("recipe_retail_price", { precision: 10, scale: 2 }), // Original recipe price
  recipeMaterialCost: decimal("recipe_material_cost", { precision: 10, scale: 2 }), // Cost of ingredients at order time

  // External references
  externalItemId: text("external_item_id"), // External platform's line item ID
  externalSku: text("external_sku"), // External platform's SKU

  // Shopify specific references for better product linking
  shopifyProductId: text("shopify_product_id"), // Direct Shopify product ID
  shopifyVariantId: text("shopify_variant_id"), // Direct Shopify variant ID
  recipeVariantId: uuid("recipe_variant_id").references(() => recipeVariants.id), // Recipe variant reference

  // Customizations
  customizations: jsonb("customizations"),
  substitutions: jsonb("substitutions"),

  // Status
  status: text("status").notNull().default("pending"), // 'pending', 'in_progress', 'completed'
  completedAt: timestamp("completed_at"),
  completedBy: text("completed_by").references(() => user.id),

  notes: text("notes"),
  displayOrder: integer("display_order").notNull().default(0),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Order Activity Log table - Audit trail
export const orderActivityLog = pgTable("order_activity_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),

  activityType: text("activity_type").notNull(), // 'status_change', 'note_added', 'item_modified', 'payment_received'
  description: text("description").notNull(),

  // Status tracking
  previousValue: jsonb("previous_value"),
  newValue: jsonb("new_value"),

  // Metadata
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdBy: text("created_by").references(() => user.id),
});

// ============================================
// Production Management Tables
// ============================================

// Production Queue table - Daily workflow management
export const productionQueue = pgTable("production_queue", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderItemId: uuid("order_item_id").notNull().references(() => orderItems.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),

  recipeId: uuid("recipe_id").references(() => recipes.id),
  recipeName: text("recipe_name").notNull(),

  status: text("status").notNull().default("queued"), // 'queued', 'in_progress', 'completed', 'cancelled'
  priority: integer("priority").notNull().default(0),

  // Timing
  scheduledStartAt: timestamp("scheduled_start_at"),
  actualStartAt: timestamp("actual_start_at"),
  estimatedDurationMinutes: integer("estimated_duration_minutes"),
  actualDurationMinutes: integer("actual_duration_minutes"),
  completedAt: timestamp("completed_at"),

  // Assignment
  assignedTo: text("assigned_to").references(() => user.id),
  assignedAt: timestamp("assigned_at"),

  // Progress tracking
  currentStepNumber: integer("current_step_number"),
  completedSteps: jsonb("completed_steps"),

  notes: text("notes"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================
// Analytics & Reporting Tables
// ============================================

// Daily Metrics table - Pre-aggregated metrics
export const dailyMetrics = pgTable("daily_metrics", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  date: date("date").notNull(),

  // Order metrics
  ordersCreated: integer("orders_created").notNull().default(0),
  ordersCompleted: integer("orders_completed").notNull().default(0),
  ordersCancelled: integer("orders_cancelled").notNull().default(0),

  // Revenue metrics
  grossRevenue: decimal("gross_revenue", { precision: 10, scale: 2 }).notNull().default("0"),
  netRevenue: decimal("net_revenue", { precision: 10, scale: 2 }).notNull().default("0"),
  totalCost: decimal("total_cost", { precision: 10, scale: 2 }).notNull().default("0"),
  totalProfit: decimal("total_profit", { precision: 10, scale: 2 }).notNull().default("0"),
  averageOrderValue: decimal("average_order_value", { precision: 10, scale: 2 }),

  // Production metrics
  recipesProduced: integer("recipes_produced").notNull().default(0),
  averageProductionTime: integer("average_production_time"),

  // Inventory metrics
  inventoryValue: decimal("inventory_value", { precision: 10, scale: 2 }),
  wasteValue: decimal("waste_value", { precision: 10, scale: 2 }).notNull().default("0"),

  // Customer metrics
  newCustomers: integer("new_customers").notNull().default(0),
  returningCustomers: integer("returning_customers").notNull().default(0),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  orgDateIdx: uniqueIndex("daily_metrics_org_date_idx").on(table.organizationId, table.date),
}));

// ============================================
// Settings & Configuration Tables
// ============================================

// Settings table - Key-value configuration store
export const settings = pgTable("settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  category: text("category").notNull(), // 'general', 'shopify', 'notifications', 'tax'
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
  description: text("description"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by").references(() => user.id),
}, (table) => ({
  orgCategoryKeyIdx: uniqueIndex("settings_org_category_key_idx").on(table.organizationId, table.category, table.key),
}));

// ============================================
// Tags Tables - Normalized tagging system
// ============================================

export const tags = pgTable("tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(), // normalized lowercase
  displayName: text("display_name").notNull(), // title case for display
  description: text("description"),
  color: text("color"), // hex color for tag styling
  usageCount: integer("usage_count").notNull().default(0),
  isSystemTag: boolean("is_system_tag").notNull().default(false), // predefined tags
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  organizationNameIdx: uniqueIndex("tags_organization_name_idx").on(table.organizationId, table.name),
  usageCountIdx: index("tags_usage_count_idx").on(table.usageCount),
}));

// Polymorphic tagging system
export const taggables = pgTable("taggables", {
  id: uuid("id").primaryKey().defaultRandom(),
  tagId: uuid("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  taggableType: text("taggable_type").notNull(), // 'recipe', 'inventory', 'product', 'order', 'customer', etc.
  taggableId: uuid("taggable_id").notNull(), // ID of the tagged entity
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
}, (table) => ({
  // Composite unique index to prevent duplicate tags on same entity
  taggableIdx: uniqueIndex("taggables_type_id_tag_idx").on(table.taggableType, table.taggableId, table.tagId),
  // Index for querying all tags for an entity
  typeIdIdx: index("taggables_type_id_idx").on(table.taggableType, table.taggableId),
  // Index for querying all entities with a specific tag
  tagIdIdx: index("taggables_tag_id_idx").on(table.tagId),
  // Index for filtering by type
  typeIdx: index("taggables_type_idx").on(table.taggableType),
}));

// DEPRECATED: Legacy junction tables - kept for backward compatibility during migration
// Use taggables table for all new implementations
export const recipeTags = pgTable("recipe_tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  recipeId: uuid("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  tagId: uuid("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  recipeTagIdx: uniqueIndex("recipe_tags_recipe_tag_idx").on(table.recipeId, table.tagId),
  recipeIdIdx: index("recipe_tags_recipe_id_idx").on(table.recipeId),
  tagIdIdx: index("recipe_tags_tag_id_idx").on(table.tagId),
}));

export const inventoryTags = pgTable("inventory_tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  inventoryItemId: uuid("inventory_item_id").notNull().references(() => inventoryItems.id, { onDelete: "cascade" }),
  tagId: uuid("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  inventoryTagIdx: uniqueIndex("inventory_tags_item_tag_idx").on(table.inventoryItemId, table.tagId),
  itemIdIdx: index("inventory_tags_item_id_idx").on(table.inventoryItemId),
  tagIdIdx: index("inventory_tags_tag_id_idx").on(table.tagId),
}));

// Shopify Integration Tables
export const shopifyIntegrations = pgTable("shopify_integrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  shopDomain: text("shop_domain").notNull(),
  accessToken: text("access_token").notNull(), // Should be encrypted in production
  scope: text("scope").notNull(),
  isActive: boolean("is_active").default(true),
  nonce: text("nonce"),
  // Sync tracking fields
  lastOrderSyncAt: timestamp("last_order_sync_at"),
  autoSyncOrders: boolean("auto_sync_orders").default(false),
  autoSyncProducts: boolean("auto_sync_products").default(false),
  syncFrequency: text("sync_frequency").default("hourly"), // 15min, hourly, daily
  installedAt: timestamp("installed_at").defaultNow(),
  uninstalledAt: timestamp("uninstalled_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  orgIdIdx: index("shopify_integrations_org_id_idx").on(table.organizationId),
  shopDomainIdx: uniqueIndex("shopify_integrations_shop_domain_idx").on(table.shopDomain, table.organizationId),
}));

export const shopifySyncLog = pgTable("shopify_sync_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  syncType: text("sync_type").notNull(), // 'orders', 'products', 'inventory'
  status: text("status").notNull(), // 'success', 'error', 'in_progress'
  itemsCount: integer("items_count").default(0),
  error: text("error"),
  metadata: jsonb("metadata"), // Additional sync details
  startedAt: timestamp("started_at").defaultNow(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  orgIdIdx: index("shopify_sync_log_org_id_idx").on(table.organizationId),
  syncTypeIdx: index("shopify_sync_log_type_idx").on(table.syncType),
  statusIdx: index("shopify_sync_log_status_idx").on(table.status),
  createdAtIdx: index("shopify_sync_log_created_at_idx").on(table.createdAt),
}));

export const shopifyProductMappings = pgTable("shopify_product_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  shopifyProductId: text("shopify_product_id").notNull(),
  shopifyVariantId: text("shopify_variant_id"),

  // New unified product references
  productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
  productVariantId: uuid("product_variant_id").references(() => productVariants.id, { onDelete: "set null" }),

  // Legacy recipe reference (kept for backward compatibility)
  recipeId: uuid("recipe_id").references(() => recipes.id, { onDelete: "set null" }),

  productTitle: text("product_title").notNull(),
  variantTitle: text("variant_title"),
  lastSyncedAt: timestamp("last_synced_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  orgIdIdx: index("shopify_product_mappings_org_id_idx").on(table.organizationId),
  shopifyProductIdx: index("shopify_product_mappings_shopify_product_idx").on(table.shopifyProductId),
  productIdx: index("shopify_product_mappings_product_idx").on(table.productId),
  productVariantIdx: index("shopify_product_mappings_product_variant_idx").on(table.productVariantId),
  recipeIdx: index("shopify_product_mappings_recipe_idx").on(table.recipeId),
  uniqueMapping: uniqueIndex("shopify_product_unique_mapping").on(table.organizationId, table.shopifyProductId, table.shopifyVariantId),
}));

// Shopify Orders table - stores complete Shopify order data
export const shopifyOrders = pgTable("shopify_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  // Shopify identifiers
  shopifyOrderId: text("shopify_order_id").notNull(),
  shopifyOrderNumber: text("shopify_order_number").notNull(),
  name: text("name"), // Shopify's order name (e.g., "#1001")

  // Timestamps from Shopify
  shopifyCreatedAt: timestamp("shopify_created_at").notNull(),
  shopifyUpdatedAt: timestamp("shopify_updated_at").notNull(),
  shopifyCancelledAt: timestamp("shopify_cancelled_at"),

  // Customer info (denormalized for quick access)
  customerEmail: text("customer_email"),
  customerPhone: text("customer_phone"),
  customerName: text("customer_name"),
  shopifyCustomerId: text("shopify_customer_id"),

  // Order status
  financialStatus: text("financial_status").notNull(),
  fulfillmentStatus: text("fulfillment_status"),
  cancelReason: text("cancel_reason"),

  // Pricing (stored as text to match Shopify format exactly)
  currency: text("currency").notNull(),
  totalPrice: decimal("total_price", { precision: 10, scale: 2 }).notNull(),
  subtotalPrice: decimal("subtotal_price", { precision: 10, scale: 2 }),
  totalTax: decimal("total_tax", { precision: 10, scale: 2 }),
  totalDiscounts: decimal("total_discounts", { precision: 10, scale: 2 }),

  // Shopify metadata
  tags: text("tags"),
  note: text("note"),
  sourceUrl: text("source_url"),
  sourceName: text("source_name"),
  test: boolean("test").default(false),

  // Pickup/delivery info extracted from note_attributes
  pickupDate: date("pickup_date"),
  pickupTime: time("pickup_time"),
  pickupLocation: text("pickup_location"),
  pickupLocationAddress: text("pickup_location_address"),

  // Complete raw JSON from Shopify
  rawData: jsonb("raw_data").notNull(),

  // Sync metadata
  apiVersion: text("api_version").notNull().default("2024-10"),
  syncedAt: timestamp("synced_at").notNull().defaultNow(),
  lastWebhookAt: timestamp("last_webhook_at"),

  // Link to internal order (if created)
  internalOrderId: uuid("internal_order_id").references(() => orders.id, { onDelete: "set null" }),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index("shopify_orders_org_id_idx").on(table.organizationId),
  shopifyOrderIdIdx: index("shopify_orders_shopify_id_idx").on(table.shopifyOrderId),
  customerEmailIdx: index("shopify_orders_customer_email_idx").on(table.customerEmail),
  financialStatusIdx: index("shopify_orders_financial_status_idx").on(table.financialStatus),
  pickupDateIdx: index("shopify_orders_pickup_date_idx").on(table.pickupDate),
  createdAtIdx: index("shopify_orders_created_at_idx").on(table.shopifyCreatedAt),
  internalOrderIdx: index("shopify_orders_internal_order_idx").on(table.internalOrderId),
  uniqueShopifyOrder: uniqueIndex("shopify_orders_unique").on(table.organizationId, table.shopifyOrderId),
}));

// Export sync jobs table
export { syncJobs, syncJobStatusEnum, syncJobTypeEnum } from './schema/sync-jobs';

// Export shopify products table
export { shopifyProducts } from './schema/shopify-products';
export { shopifyVariants } from "./schema/shopify-variants";

// Export seal subscriptions tables
export {
  sealIntegrations,
  sealSubscriptions,
  sealOrders,
  sealCustomers,
  sealSyncLog
} from './schema/seal-subscriptions';

// Export products tables (already imported at the top for foreign key references)
export { products, productVariants };

// ============================================
// External Integration Framework
// ============================================

// External Platforms Registry - Central registry for all external platform integrations
export const externalPlatforms = pgTable("external_platforms", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  // Platform identification
  platformType: text("platform_type").notNull(), // 'shopify', 'seal_subscriptions', 'woocommerce', 'etsy', etc.
  platformName: text("platform_name").notNull(), // Display name
  platformVersion: text("platform_version"), // API version or platform version

  // Configuration
  config: jsonb("config").notNull(), // Platform-specific configuration
  credentials: jsonb("credentials").notNull(), // Encrypted credentials (API keys, tokens, etc.)

  // Status and health
  status: text("status").notNull().default("inactive"), // 'active', 'inactive', 'error', 'pending'
  lastHealthCheck: timestamp("last_health_check"),
  healthStatus: text("health_status"), // 'healthy', 'degraded', 'unhealthy'
  errorMessage: text("error_message"),

  // Sync configuration
  autoSync: boolean("auto_sync").notNull().default(false),
  syncFrequency: text("sync_frequency").default("hourly"), // '15min', 'hourly', 'daily', 'manual'
  lastSyncAt: timestamp("last_sync_at"),
  nextSyncAt: timestamp("next_sync_at"),

  // Webhooks
  webhookUrl: text("webhook_url"), // Our webhook endpoint for this platform
  webhookSecret: text("webhook_secret"), // Webhook verification secret
  webhookEvents: text("webhook_events").array(), // Subscribed webhook events

  // Metadata
  installedAt: timestamp("installed_at").notNull().defaultNow(),
  installedBy: text("installed_by").references(() => user.id),
  uninstalledAt: timestamp("uninstalled_at"),
  uninstalledBy: text("uninstalled_by").references(() => user.id),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  orgPlatformIdx: uniqueIndex("external_platforms_org_platform_idx").on(table.organizationId, table.platformType),
  statusIdx: index("external_platforms_status_idx").on(table.status),
  healthIdx: index("external_platforms_health_idx").on(table.healthStatus),
  syncIdx: index("external_platforms_sync_idx").on(table.nextSyncAt),
}));

// External Sync Jobs - Generic sync job tracking for all platforms
export const externalSyncJobs = pgTable("external_sync_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  platformId: uuid("platform_id").notNull().references(() => externalPlatforms.id, { onDelete: "cascade" }),

  // Job identification
  jobType: text("job_type").notNull(), // 'full_sync', 'incremental_sync', 'webhook_processing', 'manual_sync'
  entityType: text("entity_type").notNull(), // 'orders', 'products', 'customers', 'subscriptions', etc.
  direction: text("direction").notNull(), // 'inbound', 'outbound', 'bidirectional'

  // Job parameters
  parameters: jsonb("parameters"), // Job-specific parameters (date ranges, filters, etc.)
  batchSize: integer("batch_size").default(100),

  // Status tracking
  status: text("status").notNull().default("pending"), // 'pending', 'running', 'completed', 'failed', 'cancelled'
  progress: integer("progress").default(0), // Percentage complete (0-100)

  // Metrics
  totalItems: integer("total_items").default(0),
  processedItems: integer("processed_items").default(0),
  successfulItems: integer("successful_items").default(0),
  failedItems: integer("failed_items").default(0),
  skippedItems: integer("skipped_items").default(0),

  // Error handling
  errorMessage: text("error_message"),
  errorDetails: jsonb("error_details"),
  retryCount: integer("retry_count").default(0),
  maxRetries: integer("max_retries").default(3),

  // Timing
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  estimatedCompletionAt: timestamp("estimated_completion_at"),

  // Pagination support
  lastProcessedId: text("last_processed_id"), // For cursor-based pagination
  pageToken: text("page_token"), // Platform-specific page token

  // Metadata
  triggeredBy: text("triggered_by"), // 'user', 'webhook', 'scheduler', 'api'
  triggeredByUserId: text("triggered_by_user_id").references(() => user.id),
  metadata: jsonb("metadata"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  orgIdx: index("external_sync_jobs_org_idx").on(table.organizationId),
  platformIdx: index("external_sync_jobs_platform_idx").on(table.platformId),
  statusIdx: index("external_sync_jobs_status_idx").on(table.status),
  typeIdx: index("external_sync_jobs_type_idx").on(table.jobType, table.entityType),
  createdAtIdx: index("external_sync_jobs_created_at_idx").on(table.createdAt),
  startedAtIdx: index("external_sync_jobs_started_at_idx").on(table.startedAt),
}));

// External Webhooks Log - Track all incoming webhooks from external platforms
export const externalWebhooks = pgTable("external_webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  platformId: uuid("platform_id").notNull().references(() => externalPlatforms.id, { onDelete: "cascade" }),

  // Webhook identification
  webhookId: text("webhook_id"), // Platform's webhook ID if provided
  eventType: text("event_type").notNull(), // Platform-specific event type
  eventAction: text("event_action"), // 'created', 'updated', 'deleted', etc.

  // Request details
  method: text("method").notNull().default("POST"),
  headers: jsonb("headers"),
  body: jsonb("body").notNull(),
  signature: text("signature"), // Webhook signature for verification

  // Processing status
  status: text("status").notNull().default("pending"), // 'pending', 'processed', 'failed', 'ignored'
  processedAt: timestamp("processed_at"),
  errorMessage: text("error_message"),

  // Related entities
  entityType: text("entity_type"), // What entity this webhook affects
  entityId: text("entity_id"), // External entity ID
  internalEntityId: uuid("internal_entity_id"), // Our internal entity ID if mapped

  // Sync job tracking
  syncJobId: uuid("sync_job_id").references(() => externalSyncJobs.id),

  // Metadata
  sourceIp: text("source_ip"),
  userAgent: text("user_agent"),
  retryCount: integer("retry_count").default(0),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  orgIdx: index("external_webhooks_org_idx").on(table.organizationId),
  platformIdx: index("external_webhooks_platform_idx").on(table.platformId),
  statusIdx: index("external_webhooks_status_idx").on(table.status),
  eventIdx: index("external_webhooks_event_idx").on(table.eventType, table.eventAction),
  entityIdx: index("external_webhooks_entity_idx").on(table.entityType, table.entityId),
  createdAtIdx: index("external_webhooks_created_at_idx").on(table.createdAt),
}));

// ============================================
// Notes Management Table (Polymorphic)
// ============================================
export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  // Polymorphic relationship
  entityType: text("entity_type").notNull(), // 'order', 'orderItem', 'customer', 'recipe', etc.
  entityId: uuid("entity_id").notNull(), // ID of the related entity

  // Note categorization
  noteType: text("note_type").notNull(), // 'gift_note', 'order_note', 'handwritten_card', 'delivery_instruction', 'internal', 'custom_attribute'
  noteSource: text("note_source").notNull().default("manual"), // 'shopify', 'manual', 'customer_portal', 'webhook'

  // Note content
  title: text("title"), // e.g., "Gift note", "Delivery Day", "Handwritten Card"
  content: text("content").notNull(), // The actual note content

  // Metadata
  metadata: jsonb("metadata"), // Store additional context like line item properties, position, etc.
  visibility: text("visibility").notNull().default("internal"), // 'internal', 'customer', 'public'
  priority: integer("priority").default(0), // For sorting/importance

  // Attachments
  attachments: jsonb("attachments").$type<{
    id: string;
    type: 'image' | 'pdf' | 'document' | 'spreadsheet' | 'other';
    url: string; // R2 path
    filename: string;
    size: number;
    mimeType: string;
    thumbnailUrl?: string; // For images
    uploadedAt: string;
  }[]>(), // File attachments (images, PDFs, documents, spreadsheets, etc.)

  // Shopify specific
  shopifyAttributeName: text("shopify_attribute_name"), // Original attribute name from Shopify
  shopifyLineItemId: text("shopify_line_item_id"), // If note is from line item property

  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdBy: text("created_by").references(() => user.id),
}, (table) => ({
  // Indexes for performance
  entityIdx: index("notes_entity_idx").on(table.entityType, table.entityId),
  organizationIdx: index("notes_organization_idx").on(table.organizationId),
  noteTypeIdx: index("notes_type_idx").on(table.noteType),
  visibilityIdx: index("notes_visibility_idx").on(table.visibility),
  createdAtIdx: index("notes_created_at_idx").on(table.createdAt),
}));

// ============================================
// Images Table (Polymorphic) - Generic table for all images in the system
// Used for storing images related to any entity (recipes, products, orders, events, customers, etc.)
// The entityType field categorizes the purpose (e.g., 'product', 'recipe', 'inspiration', 'order', etc.)
// ============================================
export const images = pgTable("images", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

  // Polymorphic relationship for reuse across entities
  entityType: text("entity_type").notNull(), // 'product', 'recipe', 'inspiration', 'order', 'event', 'customer', 'inventory', etc.
  entityId: uuid("entity_id").notNull(), // ID of the related entity (product.id, recipe.id, order.id, event.id, etc.)

  // Image details
  imageUrl: text("image_url").notNull(), // R2 storage path
  caption: text("caption"), // Optional descriptive text
  displayOrder: integer("display_order").notNull().default(0), // For sorting/ordering
  imageType: text("image_type"), // Additional categorization: 'primary', 'gallery', 'thumbnail', 'inspiration', etc.

  // Metadata
  uploadedBy: text("uploaded_by").references(() => user.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  // Indexes for performance
  entityIdx: index("images_entity_idx").on(table.entityType, table.entityId),
  organizationIdx: index("images_organization_idx").on(table.organizationId),
  displayOrderIdx: index("images_display_order_idx").on(table.displayOrder),
}));

// Backward compatibility alias - will be removed in future version
export const inspirationImages = images;

// ============================================
// Event Management Module
// ============================================
export * from './schema/events';

// ============================================
// Delivery Routes Module
// ============================================
export * from './schema/delivery-routes';

// ============================================
// Admin & Impersonation Module
// ============================================
export * from './schema/admin';

// ============================================
// Task Templates Module
// ============================================
export * from './schema/task-templates';