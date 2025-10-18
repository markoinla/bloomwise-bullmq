// Database type exports and aliases
import type { inspirationImages } from './schema';
import { InferSelectModel, InferInsertModel } from 'drizzle-orm';

// Image types - using the polymorphic inspirationImages table
export type Image = InferSelectModel<typeof inspirationImages>;
export type NewImage = InferInsertModel<typeof inspirationImages>;

// Semantic aliases for different image contexts
export type RecipeImage = Image & { entityType: 'recipe' };
export type OrderImage = Image & { entityType: 'order' };
export type CustomerImage = Image & { entityType: 'customer' };
export type EventImage = Image & { entityType: 'event' };
export type InventoryImage = Image & { entityType: 'inventory' };

// Valid entity types for images
export const IMAGE_ENTITY_TYPES = [
  'recipe',
  'order',
  'event',
  'customer',
  'inventory',
  'product',
  'arrangement',
  'supplier',
  'location',
  'other'
] as const;

export type ImageEntityType = typeof IMAGE_ENTITY_TYPES[number];