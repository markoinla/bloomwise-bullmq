/**
 * Environment detection middleware
 * Detects dev/staging/production environment based on request origin
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/utils/logger';

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
 * Checks custom X-Environment header first, then Origin/Referer/Host headers
 *
 * Priority:
 * 1. X-Environment header (if valid)
 * 2. Origin/Referer/Host header detection
 * 3. Default to production
 *
 * Routing:
 * - dev-local.bloomwise.co → 'dev' (DEV_DATABASE_URL)
 * - staging.bloomwise.co → 'staging' (STAGING_DATABASE_URL)
 * - app.bloomwise.co → 'production' (PRODUCTION_DATABASE_URL)
 */
export function detectEnvironment(req: Request, _res: Response, next: NextFunction) {
  // Check for explicit X-Environment header first
  const explicitEnv = req.get('x-environment')?.toLowerCase();
  if (explicitEnv === 'dev' || explicitEnv === 'staging' || explicitEnv === 'production') {
    req.environment = explicitEnv as Environment;
    logger.debug({
      detectedEnvironment: req.environment,
      source: 'X-Environment header',
      path: req.path,
      method: req.method,
    }, 'Environment detected from custom header');
    next();
    return;
  }

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
  logger.debug({
    origin: origin || '(empty)',
    referer: referer || '(empty)',
    host: host || '(empty)',
    detectedEnvironment: req.environment,
    source: 'header detection',
    path: req.path,
    method: req.method,
  }, 'Environment detected from request headers');

  next();
}
