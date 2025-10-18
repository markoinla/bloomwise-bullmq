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
} from "drizzle-orm/pg-core";
import { organizations } from "../schema";
import { customers } from "../schema";
import { user } from "../schema";
import { organizationMembers } from "../schema";

// Contacts table - generic, reusable across system
export const contacts = pgTable("contacts", (table) => ({
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),

  // Contact Information
  firstName: text("first_name"),
  lastName: text("last_name"),
  email: text("email"),
  phone: text("phone"),
  alternatePhone: text("alternate_phone"),

  // Business/Organization Info
  company: text("company"),
  jobTitle: text("job_title"),
  department: text("department"),

  // Contact Type & Category
  type: text("type").notNull(), // 'customer', 'vendor', 'venue', 'planner', 'internal', 'other'
  category: text("category"), // 'florist', 'caterer', 'photographer', 'venue_manager', etc.

  // Address
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  country: text("country"),

  // Venue-specific fields (when type='venue')
  venueAccessInstructions: text("venue_access_instructions"),
  venueCapacity: integer("venue_capacity"),
  venueAmenities: text("venue_amenities").array(),

  // Preferences & Notes
  preferredContactMethod: text("preferred_contact_method"), // 'email', 'phone', 'sms'
  timezone: text("timezone"),
  language: text("language"),
  notes: text("notes"),
  tags: text("tags").array(),

  // Relationship Management
  isActive: boolean("is_active").default(true).notNull(),
  rating: integer("rating"), // 1-5 for vendor quality
  lastContactedAt: timestamp("last_contacted_at"),

  // Multi-org vendor support
  isGlobalVendor: boolean("is_global_vendor").default(false),
  globalVendorId: uuid("global_vendor_id"),

  // Integration
  customerId: uuid("customer_id").references(() => customers.id),
  externalId: text("external_id"),
  source: text("source"), // 'manual', 'import', 'shopify', etc.

  // Metadata
  customAttributes: jsonb("custom_attributes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdBy: text("created_by"),
}), (table) => ({
  orgTypeIdx: index("idx_contacts_org_type").on(table.organizationId, table.type),
  emailIdx: index("idx_contacts_email").on(table.email),
  customerIdIdx: index("idx_contacts_customer_id").on(table.customerId),
}));

// Events table
export const events = pgTable("events", (table) => ({
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),

  // Basic Information
  name: text("name").notNull(),
  eventType: text("event_type").notNull(), // 'wedding', 'corporate', 'funeral', 'birthday', 'anniversary', 'holiday', 'other'
  status: text("status").notNull().default("inquiry"), // 'inquiry', 'booked', 'planning', 'completed', 'cancelled'

  // Dates & Times
  eventDate: date("event_date"),
  eventStartTime: time("event_start_time"),
  eventEndTime: time("event_end_time"),
  setupStartTime: time("setup_start_time"),
  breakdownTime: time("breakdown_time"),

  // Client Information
  customerId: uuid("customer_id").references(() => customers.id),
  primaryContactId: uuid("primary_contact_id").references(() => contacts.id),
  contactCompany: text("contact_company"),

  // Venue Information
  venueName: text("venue_name"),
  venueAddress1: text("venue_address1"),
  venueAddress2: text("venue_address2"),
  venueCity: text("venue_city"),
  venueState: text("venue_state"),
  venueZip: text("venue_zip"),
  venueCountry: text("venue_country"),
  setupLocation: text("setup_location"), // specific location details within venue

  // Financial (simplified to JSONB)
  financialSummary: jsonb("financial_summary").default({}), // { estimated, quoted, final, deposits: [], payments: [], paymentTerms }
  paymentStatus: text("payment_status").default("pending"), // 'pending', 'deposit_paid', 'partial', 'paid', 'overdue'

  // Production & Logistics
  estimatedGuestCount: integer("estimated_guest_count"),
  finalGuestCount: integer("final_guest_count"),
  deliveryMethod: text("delivery_method"), // 'delivery', 'pickup', 'setup_service'
  setupComplexity: text("setup_complexity"), // 'simple', 'moderate', 'complex'
  laborHours: decimal("labor_hours", { precision: 10, scale: 2 }),

  // Design & Theme
  colorPalette: text("color_palette").array(),
  designTheme: text("design_theme"),
  designNotes: text("design_notes"),
  inspirationUrls: text("inspiration_urls").array(),

  // Priority
  priority: text("priority").default("normal"), // 'low', 'normal', 'high', 'vip'
  specialRequirements: text("special_requirements"),

  // Team Management
  leadDesignerId: text("lead_designer_id"),
  assignedTeam: text("assigned_team").array(),

  // Status Tracking
  bookedAt: timestamp("booked_at"),
  completedAt: timestamp("completed_at"),
  cancelledAt: timestamp("cancelled_at"),
  cancellationReason: text("cancellation_reason"),

  // Metadata
  source: text("source"), // 'website', 'phone', 'walk_in', 'referral', 'repeat'
  referralSource: text("referral_source"),
  tags: text("tags").array(),
  internalNotes: text("internal_notes"),
  clientVisibleNotes: text("client_visible_notes"),

  // Future-proofing
  seriesId: uuid("series_id"), // for recurring events
  recurrenceRule: text("recurrence_rule"), // iCal RRULE format
  isTemplate: boolean("is_template").default(false),
  eventFeatures: jsonb("event_features").default({}), // org-specific feature flags

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
}), (table) => ({
  orgDateIdx: index("idx_events_org_date").on(table.organizationId, table.eventDate),
  statusIdx: index("idx_events_status").on(table.status),
  primaryContactIdx: index("idx_events_primary_contact").on(table.primaryContactId),
}));

// Event-Contacts junction table
export const eventContacts = pgTable("event_contacts", (table) => ({
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id")
    .notNull()
    .references(() => contacts.id, { onDelete: "cascade" }),

  role: text("role").notNull(), // 'primary_client', 'bride', 'groom', 'planner', 'venue_coordinator', 'caterer', 'photographer', 'dj', 'other_vendor'
  isPrimary: boolean("is_primary").default(false),
  responsibilities: text("responsibilities"),
  notes: text("notes"),

  // Communication preferences for this event
  receiveUpdates: boolean("receive_updates").default(true),
  updateFrequency: text("update_frequency").default("all"), // 'all', 'major_only', 'none'

  addedAt: timestamp("added_at").defaultNow().notNull(),
  addedBy: text("added_by"),
}), (table) => ({
  eventIdx: index("idx_event_contacts_event").on(table.eventId),
  contactIdx: index("idx_event_contacts_contact").on(table.contactId),
}));

// Event Products table
export const eventProducts = pgTable("event_products", (table) => ({
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),

  // Polymorphic Reference (simplified)
  itemType: text("item_type").notNull(), // 'product', 'recipe', 'inventory_item', 'service', 'rental'
  referenceId: uuid("reference_id"), // polymorphic FK to products, recipes, or inventoryItems
  referenceType: text("reference_type"), // explicit type indicator for type safety

  // Item Details (denormalized for flexibility)
  name: text("name").notNull(),
  description: text("description"),
  category: text("category"), // 'ceremony', 'reception', 'cocktail_hour', 'bridal_party', 'venue_decor'

  // Quantities & Pricing
  quantity: integer("quantity").notNull().default(1),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 }),
  totalPrice: decimal("total_price", { precision: 10, scale: 2 }),
  costPerUnit: decimal("cost_per_unit", { precision: 10, scale: 2 }),
  totalCost: decimal("total_cost", { precision: 10, scale: 2 }),

  // Location & Placement
  location: text("location"), // 'ceremony_altar', 'reception_entrance', 'head_table', etc.
  placementNotes: text("placement_notes"),
  placementDiagram: text("placement_diagram"), // URL to diagram/image

  // Timing
  setupTime: time("setup_time"),
  displayStartTime: time("display_start_time"),
  displayEndTime: time("display_end_time"),
  breakdownTime: time("breakdown_time"),

  // Production Details
  productionNotes: text("production_notes"),
  customizations: jsonb("customizations").default({}),

  // Design Specifications
  colorVariation: text("color_variation"),
  sizeSpecification: text("size_specification"),
  specialInstructions: text("special_instructions"),

  // Status
  status: text("status").default("pending"), // 'pending', 'confirmed', 'in_production', 'completed', 'delivered'
  confirmedAt: timestamp("confirmed_at"),
  completedAt: timestamp("completed_at"),

  // Priority & Dependencies
  priority: integer("priority"),
  dependsOnProductId: uuid("depends_on_product_id"), // self-reference

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdBy: text("created_by"),
}), (table) => ({
  eventIdx: index("idx_event_products_event").on(table.eventId),
  referenceIdx: index("idx_event_products_reference").on(table.referenceType, table.referenceId),
}));

// Generic Tasks table (for events, orders, production)
export const tasks = pgTable("tasks", (table) => ({
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),

  // Polymorphic entity reference
  entityType: text("entity_type").notNull(), // 'event', 'order', 'production', 'custom'
  entityId: uuid("entity_id").notNull(),

  // Task Information
  taskType: text("task_type").notNull(), // 'design', 'ordering', 'production', 'delivery', 'setup', 'breakdown', 'follow_up'
  taskName: text("task_name").notNull(),
  description: text("description"),

  // Timing
  scheduledDate: date("scheduled_date"),
  scheduledStartTime: time("scheduled_start_time"),
  scheduledEndTime: time("scheduled_end_time"),
  actualStartTime: timestamp("actual_start_time"),
  actualEndTime: timestamp("actual_end_time"),
  duration: integer("duration"), // minutes

  // Assignment
  assignedTo: text("assigned_to").array(),
  assignedTeamSize: integer("assigned_team_size"),

  // Dependencies
  dependsOnTaskId: uuid("depends_on_task_id"), // self-reference
  blocksTaskIds: uuid("blocks_task_ids").array(),

  // Status & Progress
  status: text("status").default("pending"), // 'pending', 'ready', 'in_progress', 'completed', 'cancelled'
  completionPercentage: integer("completion_percentage").default(0),

  // Location
  location: text("location"),

  // Resources
  requiredResources: jsonb("required_resources").default({}), // {vehicles: [], tools: [], materials: []}

  // Alerts & Reminders
  reminderTime: timestamp("reminder_time"),
  reminderSent: boolean("reminder_sent").default(false),
  criticalTask: boolean("critical_task").default(false),

  // Notes
  notes: text("notes"),
  completionNotes: text("completion_notes"),
  issues: text("issues"),

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
    uploadedBy?: string;
  }[]>().default([]),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  completedBy: text("completed_by"),
}), (table) => ({
  entityIdx: index("idx_tasks_entity").on(table.entityType, table.entityId),
  orgDateIdx: index("idx_tasks_org_date").on(table.organizationId, table.scheduledDate),
  statusIdx: index("idx_tasks_status").on(table.status),
  assignedIdx: index("idx_tasks_assigned").on(table.assignedTo),
}));

// Event Items table - tracks arrangement types and quantities for estimating
export const eventItems = pgTable("event_items", (table) => ({
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),

  // Item Information
  arrangementType: text("arrangement_type").notNull(), // 'centerpiece', 'bar_table', 'ceremony', 'bridal_bouquet', etc.
  quantity: integer("quantity").notNull().default(1),

  // Optional recipe link (for later integration)
  recipeId: uuid("recipe_id"), // future link to recipes table
  productId: uuid("product_id"), // future link to products table

  // Time Tracking (in minutes)
  designTime: integer("design_time"), // Time to design/conceptualize the arrangement
  prepTime: integer("prep_time"), // Time to prep materials, process flowers, etc.
  assemblyTime: integer("assembly_time"), // Time to actually create the arrangement
  totalProductionTime: integer("total_production_time"), // Total time (can be override or calculated)

  // Labor Assignment
  designerId: text("designer_id"), // Who's designing this item
  preparerId: text("preparer_id"), // Who's prepping materials
  assemblerId: text("assembler_id"), // Who's assembling

  // Pricing & Estimation
  estimatedCost: decimal("estimated_cost", { precision: 10, scale: 2 }),
  quotedPrice: decimal("quoted_price", { precision: 10, scale: 2 }),

  // Production Status
  productionStatus: text("production_status").default("pending"), // 'pending', 'designing', 'prepping', 'assembling', 'completed'
  designCompletedAt: timestamp("design_completed_at"),
  prepCompletedAt: timestamp("prep_completed_at"),
  assemblyCompletedAt: timestamp("assembly_completed_at"),

  // Notes & Details
  notes: text("notes"),
  customizations: text("customizations"),
  designNotes: text("design_notes"), // Specific notes for design phase
  prepNotes: text("prep_notes"), // Specific notes for prep phase

  // Custom ingredients (workspace items format)
  customIngredients: jsonb("custom_ingredients").default([]),

  // Priority & Scheduling
  priority: integer("priority").default(5), // 1-10 scale
  scheduledPrepDate: date("scheduled_prep_date"),
  scheduledAssemblyDate: date("scheduled_assembly_date"),

  // Metadata
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdBy: text("created_by"),
  updatedBy: text("updated_by"),
}), (table) => ({
  eventIdx: index("idx_event_items_event").on(table.eventId),
  orgIdx: index("idx_event_items_org").on(table.organizationId),
  productionStatusIdx: index("idx_event_items_production_status").on(table.productionStatus),
  scheduledPrepIdx: index("idx_event_items_scheduled_prep").on(table.scheduledPrepDate),
  scheduledAssemblyIdx: index("idx_event_items_scheduled_assembly").on(table.scheduledAssemblyDate),
}));

// Event Team Members table - flexible support for org members and external contractors
export const eventTeamMembers = pgTable("event_team_members", (table) => ({
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),

  // Flexible member reference (either org member OR external contractor)
  userId: text("user_id")
    .references(() => user.id, { onDelete: "cascade" }), // Optional - for org members
  organizationMemberId: uuid("organization_member_id")
    .references(() => organizationMembers.id, { onDelete: "cascade" }), // Optional - for org members

  // External contractor details (when not an org member)
  externalName: text("external_name"), // Full name for external contractors
  externalEmail: text("external_email"), // Contact email
  externalPhone: text("external_phone"), // Contact phone
  externalCompany: text("external_company"), // Contractor's company/business name

  // Role & Responsibilities
  role: text("role").notNull(), // 'lead_designer', 'florist', 'setup_crew', 'coordinator', 'driver', 'contractor', etc.
  isPrimaryContact: boolean("is_primary_contact").default(false),
  responsibilities: text("responsibilities"),

  // Financial tracking
  hourlyRate: decimal("hourly_rate", { precision: 10, scale: 2 }), // Hourly rate for budget calculation
  flatFee: decimal("flat_fee", { precision: 10, scale: 2 }), // Alternative to hourly - flat fee for the event
  paymentType: text("payment_type").default("hourly"), // 'hourly', 'flat_fee', 'volunteer'
  estimatedHours: decimal("estimated_hours", { precision: 10, scale: 2 }),
  actualHours: decimal("actual_hours", { precision: 10, scale: 2 }),
  totalCost: decimal("total_cost", { precision: 10, scale: 2 }), // Calculated or override total

  // Status & Availability
  status: text("status").default("assigned").notNull(), // 'assigned', 'confirmed', 'declined', 'completed', 'cancelled'
  confirmationSentAt: timestamp("confirmation_sent_at"),
  confirmedAt: timestamp("confirmed_at"),
  declinedReason: text("declined_reason"),

  // Notes
  notes: text("notes"),
  internalNotes: text("internal_notes"), // Not visible to external contractors

  // Metadata
  assignedAt: timestamp("assigned_at").defaultNow().notNull(),
  assignedBy: text("assigned_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}), (table) => ({
  eventIdx: index("idx_event_team_members_event").on(table.eventId),
  userIdx: index("idx_event_team_members_user").on(table.userId),
  orgMemberIdx: index("idx_event_team_members_org_member").on(table.organizationMemberId),
  orgIdx: index("idx_event_team_members_org").on(table.organizationId),
  statusIdx: index("idx_event_team_members_status").on(table.status),
  externalEmailIdx: index("idx_event_team_members_external_email").on(table.externalEmail),
}));