import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { logger } from '../lib/utils/logger';

// Environment-specific database URLs
const DEV_DATABASE_URL = process.env.DEV_DATABASE_URL;
const STAGING_DATABASE_URL = process.env.STAGING_DATABASE_URL;
const PRODUCTION_DATABASE_URL = process.env.PRODUCTION_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL; // Fallback for backward compatibility

// Validate that at least one database URL is configured
if (!DATABASE_URL && !DEV_DATABASE_URL && !STAGING_DATABASE_URL && !PRODUCTION_DATABASE_URL) {
  throw new Error('At least one database URL must be configured (DATABASE_URL, DEV_DATABASE_URL, STAGING_DATABASE_URL, or PRODUCTION_DATABASE_URL)');
}

// Create database connections
const devSql = DEV_DATABASE_URL ? neon(DEV_DATABASE_URL) : null;
const stagingSql = STAGING_DATABASE_URL ? neon(STAGING_DATABASE_URL) : null;
const productionSql = PRODUCTION_DATABASE_URL ? neon(PRODUCTION_DATABASE_URL) : null;
const defaultSql = DATABASE_URL ? neon(DATABASE_URL) : null;

export const devDb = devSql ? drizzle(devSql) : null;
export const stagingDb = stagingSql ? drizzle(stagingSql) : null;
export const productionDb = productionSql ? drizzle(productionSql) : null;

// Default database connection (for backward compatibility)
export const db = defaultSql ? drizzle(defaultSql) : (productionDb || stagingDb || devDb)!;

/**
 * Get database connection for a specific environment
 */
export function getDatabaseForEnvironment(environment: 'dev' | 'staging' | 'production' = 'production') {
  if (environment === 'dev') {
    if (!devDb) {
      logger.warn('Dev database not configured, falling back to staging or production');
      return stagingDb || productionDb || db;
    }
    return devDb;
  }

  if (environment === 'staging') {
    if (!stagingDb) {
      logger.warn('Staging database not configured, falling back to production');
      return productionDb || db;
    }
    return stagingDb;
  }

  if (environment === 'production') {
    if (!productionDb) {
      logger.warn('Production database not configured, falling back to default');
      return db;
    }
    return productionDb;
  }

  return db;
}

export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    const sql = defaultSql || productionSql || stagingSql || devSql;
    if (!sql) {
      throw new Error('No database connection available');
    }
    await sql`SELECT 1`;
    return true;
  } catch (error) {
    logger.error({ error }, 'Database health check failed');
    return false;
  }
}
