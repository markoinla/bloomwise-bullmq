import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';

// Singleton pattern to reuse database connection across requests
let cachedDb: ReturnType<typeof drizzle> | null = null;
let cachedClient: ReturnType<typeof neon> | null = null;

function getDatabase() {
  if (!cachedDb) {
    if (!cachedClient) {
      // Use HTTP for better performance with single queries
      // HTTP is optimized for one-shot queries in serverless environments
      cachedClient = neon(process.env.DATABASE_URL!);
    }

    cachedDb = drizzle(cachedClient);
  }

  return cachedDb;
}

// Export singleton database instance
export const db = getDatabase();
