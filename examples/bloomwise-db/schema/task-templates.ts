import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "../schema";
import { user } from "../schema";

// Task Board Templates - Save and reuse task board configurations
export const taskBoardTemplates = pgTable("task_board_templates", (table) => ({
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),

  // Template Metadata
  name: text("name").notNull(), // "My Wedding Setup Flow"
  description: text("description"), // optional user note about when to use
  eventType: text("event_type"), // "wedding", "corporate", etc. - for filtering

  // Template Content
  tasks: jsonb("tasks").notNull().default([]), // array of task objects
  /*
    Task object structure:
    {
      taskName: string,
      taskType: string, // 'design', 'ordering', 'production', etc.
      description?: string,
      location?: string,
      criticalTask?: boolean
    }
  */
  taskCount: integer("task_count").notNull().default(0), // denormalized for display

  // Metadata
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}), (table) => ({
  orgIdx: index("idx_task_templates_org").on(table.organizationId),
  eventTypeIdx: index("idx_task_templates_event_type").on(table.eventType),
  createdByIdx: index("idx_task_templates_created_by").on(table.createdBy),
}));
