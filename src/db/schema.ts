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

// Type exports for use in job processors
export type SyncJob = typeof syncJobs.$inferSelect;
export type SyncJobInsert = typeof syncJobs.$inferInsert;
export type ShopifyIntegration = typeof shopifyIntegrations.$inferSelect;
