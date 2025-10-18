import {
  boolean,
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { user } from "../schema";

// Admin Users - Track which users have super admin access
export const adminUsers = pgTable(
  "admin_users",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    isSuperAdmin: boolean("isSuperAdmin").notNull().default(false),
    permissions: jsonb("permissions").$type<string[]>().default([]), // Future: granular permissions
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    createdBy: text("createdBy").references(() => user.id),
    revokedAt: timestamp("revokedAt"),
    revokedBy: text("revokedBy").references(() => user.id),
  },
  (table) => ({
    userIdIdx: index("admin_users_user_id_idx").on(table.userId),
    superAdminIdx: index("admin_users_super_admin_idx").on(table.isSuperAdmin),
  })
);

// Impersonation Sessions - Track when admins impersonate users
export const impersonationSessions = pgTable(
  "impersonation_sessions",
  {
    id: text("id").primaryKey(),
    adminUserId: text("adminUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    targetUserId: text("targetUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    startedAt: timestamp("startedAt").notNull().defaultNow(),
    endedAt: timestamp("endedAt"),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    reason: text("reason"), // Why the impersonation was needed
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  },
  (table) => ({
    adminUserIdx: index("impersonation_sessions_admin_user_idx").on(table.adminUserId),
    targetUserIdx: index("impersonation_sessions_target_user_idx").on(table.targetUserId),
    startedAtIdx: index("impersonation_sessions_started_at_idx").on(table.startedAt),
  })
);

// Admin Activity Log - Audit trail for all admin actions
export const adminActivityLog = pgTable(
  "admin_activity_log",
  {
    id: text("id").primaryKey(),
    adminUserId: text("adminUserId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    action: text("action").notNull(), // e.g., "impersonate_start", "user_update", "org_delete"
    resourceType: text("resourceType"), // e.g., "user", "organization", "order"
    resourceId: text("resourceId"), // ID of the affected resource
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => ({
    adminUserIdx: index("admin_activity_log_admin_user_idx").on(table.adminUserId),
    actionIdx: index("admin_activity_log_action_idx").on(table.action),
    resourceIdx: index("admin_activity_log_resource_idx").on(table.resourceType, table.resourceId),
    createdAtIdx: index("admin_activity_log_created_at_idx").on(table.createdAt),
  })
);
