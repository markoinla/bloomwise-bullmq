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
  const origin = req.get('origin') || req.get('referer') || req.get('host') || '';

  // Detect staging environment
  if (origin.includes('staging.bloomwise.co')) {
    req.environment = 'staging';
  }
  // Detect production environment
  else if (origin.includes('app.bloomwise.co') || origin.includes('bloomwise.co')) {
    req.environment = 'production';
  }
  // Default to production for safety
  else {
    req.environment = 'production';
  }

  next();
}
