/**
 * Environment detection middleware
 * Detects dev/staging/production environment based on request origin
 */

import { Request, Response, NextFunction } from 'express';

export type Environment = 'dev' | 'staging' | 'production';

// Extend Express Request type to include environment
declare global {
  namespace Express {
    interface Request {
      environment?: Environment;
    }
  }
}

/**
 * Middleware to detect environment from request headers
 * Checks Origin, Referer, and Host headers to determine environment
 *
 * Routing:
 * - dev-local.bloomwise.co → 'dev' (DEV_DATABASE_URL)
 * - staging.bloomwise.co → 'staging' (STAGING_DATABASE_URL)
 * - app.bloomwise.co → 'production' (PRODUCTION_DATABASE_URL)
 */
export function detectEnvironment(req: Request, _res: Response, next: NextFunction) {
  const origin = req.get('origin') || '';
  const referer = req.get('referer') || '';
  const host = req.get('host') || '';

  // Check all headers
  const headers = `${origin}|${referer}|${host}`;

  // Detect dev environment (local development)
  if (headers.includes('dev-local.bloomwise.co')) {
    req.environment = 'dev';
  }
  // Detect staging environment
  else if (headers.includes('staging.bloomwise.co')) {
    req.environment = 'staging';
  }
  // Detect production environment
  else if (headers.includes('app.bloomwise.co')) {
    req.environment = 'production';
  }
  // Default to production for safety
  else {
    req.environment = 'production';
  }

  // Log for debugging
  console.log('[ENV DETECTION]', {
    origin: origin || '(empty)',
    referer: referer || '(empty)',
    host: host || '(empty)',
    combinedHeaders: headers,
    detected: req.environment,
    path: req.path,
  });

  next();
}
