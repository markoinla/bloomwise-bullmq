import {
  pgTable,
  text,
  timestamp,
  uuid,
  date,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "../schema";

export const deliveryRoutes = pgTable(
  "delivery_routes",
  (table) => ({
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    // Route details
    routeName: text("route_name").notNull(),
    routeDate: date("route_date").notNull(),
    status: text("status").notNull(), // 'draft', 'planned', 'in_progress', 'completed', 'cancelled'

    // Assignment
    assignedToUserId: text("assigned_to_user_id"),
    assignedToName: text("assigned_to_name"),

    // Orders in this route (stored as array of UUIDs)
    orderIds: text("order_ids").array().notNull().default([]),

    // Optimization data
    optimizedSequence: jsonb("optimized_sequence"), // Array of stops with lat/lng
    totalDistance: text("total_distance"), // e.g., "15.3 miles"
    estimatedDuration: integer("estimated_duration"), // minutes
    googleMapsUrl: text("google_maps_url"),

    // Timestamps
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdByUserId: text("created_by_user_id"),
    optimizedAt: timestamp("optimized_at"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
  }),
  (table) => [
    index("delivery_routes_org_idx").on(table.organizationId),
    index("delivery_routes_date_idx").on(table.routeDate),
    index("delivery_routes_status_idx").on(table.status),
  ],
);
