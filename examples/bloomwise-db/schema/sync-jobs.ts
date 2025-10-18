import { pgTable, text, timestamp, integer, jsonb, boolean, pgEnum } from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";

// Enum for sync job status
export const syncJobStatusEnum = pgEnum("sync_job_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "paused"
]);

// Enum for sync job type
export const syncJobTypeEnum = pgEnum("sync_job_type", [
  "full_sync",
  "shopify_orders_initial",
  "shopify_orders_incremental",
  "shopify_products",
  "shopify_products_initial",
  "shopify_products_incremental",
  "shopify_customers"
]);

// Sync jobs table for tracking background sync operations
export const syncJobs = pgTable("sync_jobs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  organizationId: text("organization_id")
    .notNull(),

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
  pageSize: integer("page_size").default(250), // Shopify GraphQL max is 250
  lastProcessedId: text("last_processed_id"), // For cursor-based pagination
  nextPageToken: text("next_page_token"), // For API pagination

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