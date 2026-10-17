import type { CookieOptions, Response } from 'express';
import type { Env } from '../../config/env.js';
import { SESSION_ABSOLUTE_MS } from './session.service.js';

/**
 * In production the "__Host-" prefix makes browsers insist on Secure, Path=/
 * and no Domain attribute, so no other subdomain can plant or read it.
 */
export function sessionCookieName(config: Env): string {
  return config.NODE_ENV === 'production' ? '__Host-cc_session' : 'cc_session';
}

export const OAUTH_STATE_COOKIE = 'cc_oauth';
export const OAUTH_COOKIE_PATH = '/api/v1/auth';

function baseOptions(config: Env): CookieOptions {
  return {
    httpOnly: true, // JavaScript in the page can never read it
    sameSite: 'lax', // not sent on cross-site POSTs (CSRF defence)
    secure: config.NODE_ENV === 'production',
  };
}

export function setSessionCookie(res: Response, config: Env, token: string): void {
  res.cookie(sessionCookieName(config), token, {
    ...baseOptions(config),
    path: '/',
    maxAge: SESSION_ABSOLUTE_MS,
  });
}

export function clearSessionCookie(res: Response, config: Env): void {
  res.clearCookie(sessionCookieName(config), { ...baseOptions(config), path: '/' });
}

export function oauthStateCookieOptions(config: Env): CookieOptions {
  return {
    ...baseOptions(config),
    path: OAUTH_COOKIE_PATH,
    signed: true,
    maxAge: 10 * 60 * 1000,
  };
}
