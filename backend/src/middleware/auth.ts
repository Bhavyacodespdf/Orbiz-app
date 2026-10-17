import type { RequestHandler } from 'express';
import type { Env } from '../config/env.js';
import type { Database } from '../lib/prisma.js';
import { forbidden, unauthenticated } from '../lib/errors.js';
import type { Role } from '../generated/prisma/enums.js';
import { resolveSession } from '../modules/auth/session.service.js';
import { sessionCookieName } from '../modules/auth/cookies.js';

/** Attaches req.auth when the request carries a valid session cookie. Never rejects. */
export function loadSession(db: Database, config: Env): RequestHandler {
  const cookieName = sessionCookieName(config);
  return async (req, _res, next) => {
    try {
      const token: unknown = req.cookies?.[cookieName];
      if (typeof token === 'string' && token.length > 0 && token.length < 200) {
        req.auth = (await resolveSession(db, token)) ?? undefined;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  next(req.auth ? undefined : unauthenticated());
};

/**
 * Allows the request only if the signed-in user currently holds at least one
 * of the given roles. Roles always come from the database, never the client.
 */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(unauthenticated());
    const allowed = req.auth.user.roles.some((role) => roles.includes(role));
    next(allowed ? undefined : forbidden());
  };
}
