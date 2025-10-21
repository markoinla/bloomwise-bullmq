/**
 * Environment detection middleware
 * Detects staging vs production environment based on request origin
 */

import { Request, Response, NextFunction } from 'express';

export type Environment = 'staging' | 'production';

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
 * Checks Origin, Referer, and Host headers to determine if request is from staging or production
 */
export function detectEnvironment(req: Request, _res: Response, next: NextFunction) {
  const origin = req.get('origin') || '';
  const referer = req.get('referer') || '';
  const host = req.get('host') || '';

  // Check all headers for staging
  const headers = `${origin}|${referer}|${host}`;

  // Detect staging environment
  if (headers.includes('staging.bloomwise.co')) {
    req.environment = 'staging';
  }
  // Detect production environment
  else if (headers.includes('app.bloomwise.co') || headers.includes('bloomwise.co')) {
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
