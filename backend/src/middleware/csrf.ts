import type { RequestHandler } from 'express';
import type { Env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'CampusCart';

/**
 * CSRF protection for state-changing requests, layered on top of SameSite=Lax cookies:
 *  1. A custom header is required. Plain cross-site HTML forms cannot send custom
 *     headers, and cross-origin scripts cannot without a CORS preflight we refuse.
 *  2. If the browser sends an Origin header, it must be our own frontend.
 */
export function csrfProtection(config: Env): RequestHandler {
  const allowedOrigin = new URL(config.FRONTEND_URL).origin;
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.get('origin');
    if (origin && origin !== allowedOrigin) {
      return next(new AppError(403, 'CSRF_REJECTED', 'Request origin not allowed.'));
    }
    if (req.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
      return next(new AppError(403, 'CSRF_REJECTED', 'Missing request verification header.'));
    }
    next();
  };
}
