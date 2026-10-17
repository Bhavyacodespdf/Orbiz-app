import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { devLoginAllowed, type Env } from '../../config/env.js';
import type { Database } from '../../lib/prisma.js';
import { AppError, unauthenticated } from '../../lib/errors.js';
import { randomToken, safeEqual } from '../../lib/crypto.js';
import { normaliseEmail } from '../../lib/email.js';
import type { GoogleOAuthClient } from './google.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import { signInWithIdentity, type VerifiedIdentity } from './provisioning.service.js';
import { createSession, deleteSessionByToken, resolveSession } from './session.service.js';
import {
  clearSessionCookie,
  OAUTH_STATE_COOKIE,
  oauthStateCookieOptions,
  sessionCookieName,
  setSessionCookie,
} from './cookies.js';
import { devLoginSchema, safeReturnTo } from './auth.schema.js';
import { toPublicUser } from '../users/users.serializer.js';

interface OAuthState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

function parseOAuthState(raw: unknown): OAuthState | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as Partial<OAuthState>;
    if (
      typeof value.state === 'string' &&
      typeof value.nonce === 'string' &&
      typeof value.codeVerifier === 'string' &&
      typeof value.returnTo === 'string'
    ) {
      return value as OAuthState;
    }
  } catch {
    // fall through
  }
  return null;
}

export interface AuthRouterDeps {
  db: Database;
  config: Env;
  realtime: RealtimePublisher;
  /** Null when Google credentials are not configured. */
  google: GoogleOAuthClient | null;
}

export function authRouter({ db, config, google, realtime }: AuthRouterDeps) {
  const router = Router();

  const signInLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.AUTH_RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new AppError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Try again later.')),
  });

  /** Sends the browser back to the frontend login page with an error code. */
  const failToLogin = (res: Response, code: string) =>
    res.redirect(303, `${config.FRONTEND_URL}/login?error=${encodeURIComponent(code)}`);

  async function startSession(req: Request, res: Response, identity: VerifiedIdentity) {
    const { userId } = await signInWithIdentity(db, identity, config);
    const token = await createSession(db, userId, req.get('user-agent'));
    setSessionCookie(res, config, token);
    return token;
  }

  /** Which sign-in methods the login page should offer. */
  router.get('/providers', (_req, res) => {
    res.json({ google: google !== null, devLogin: devLoginAllowed(config) });
  });

  /** Step 1: redirect to Google with fresh state, nonce and PKCE challenge. */
  router.get('/google', signInLimiter, async (req, res, next) => {
    try {
      if (!google) return failToLogin(res, 'GOOGLE_NOT_CONFIGURED');

      const { codeVerifier, codeChallenge } = await google.createPkcePair();
      const oauth: OAuthState = {
        state: randomToken(24),
        nonce: randomToken(24),
        codeVerifier,
        returnTo: safeReturnTo(req.query.returnTo),
      };
      res.cookie(OAUTH_STATE_COOKIE, JSON.stringify(oauth), oauthStateCookieOptions(config));
      res.redirect(303, google.buildAuthUrl({ ...oauth, codeChallenge }));
    } catch (err) {
      next(err);
    }
  });

  /** Step 2: Google redirects back here with a one-time code. */
  router.get('/google/callback', signInLimiter, async (req, res, next) => {
    const stored = parseOAuthState(req.signedCookies?.[OAUTH_STATE_COOKIE]);
    // The state cookie is single-use whatever happens next.
    res.clearCookie(OAUTH_STATE_COOKIE, { ...oauthStateCookieOptions(config), maxAge: undefined });

    try {
      if (!google) return failToLogin(res, 'GOOGLE_NOT_CONFIGURED');
      if (typeof req.query.error === 'string') return failToLogin(res, 'GOOGLE_CANCELLED');

      const { state, code } = req.query;
      if (
        !stored ||
        typeof state !== 'string' ||
        typeof code !== 'string' ||
        !safeEqual(state, stored.state)
      ) {
        return failToLogin(res, 'OAUTH_STATE_INVALID');
      }

      let profile;
      try {
        profile = await google.exchangeCode({ code, codeVerifier: stored.codeVerifier });
      } catch (err) {
        req.log.warn({ err }, 'Google code exchange or ID token verification failed');
        return failToLogin(res, 'GOOGLE_VERIFICATION_FAILED');
      }
      if (!profile.nonce || !safeEqual(profile.nonce, stored.nonce)) {
        return failToLogin(res, 'OAUTH_STATE_INVALID');
      }

      await startSession(req, res, {
        provider: 'GOOGLE',
        subject: profile.subject,
        email: profile.email,
        emailVerified: profile.emailVerified,
        name: profile.name,
        picture: profile.picture,
      });
      res.redirect(303, `${config.FRONTEND_URL}${stored.returnTo}`);
    } catch (err) {
      if (err instanceof AppError && err.status < 500) return failToLogin(res, err.code);
      next(err);
    }
  });

  /** Development/test only — never mounted in production (see devLoginAllowed). */
  if (devLoginAllowed(config)) {
    router.post('/dev-login', signInLimiter, async (req, res, next) => {
      try {
        const body = devLoginSchema.parse(req.body);
        const email = normaliseEmail(body.email);
        const token = await startSession(req, res, {
          provider: 'DEV',
          subject: email,
          email,
          emailVerified: true,
          name: body.displayName ?? null,
          picture: null,
        });
        const session = await resolveSession(db, token);
        res.json({ user: toPublicUser(session!.user) });
      } catch (err) {
        next(err);
      }
    });
  }

  router.get('/me', (req, res, next) => {
    if (!req.auth) return next(unauthenticated());
    res.json({ user: toPublicUser(req.auth.user) });
  });

  router.post('/logout', async (req, res, next) => {
    try {
      const token: unknown = req.cookies?.[sessionCookieName(config)];
      if (typeof token === 'string') await deleteSessionByToken(db, token);
      if (req.auth) realtime.endSession(req.auth.sessionId);
      clearSessionCookie(res, config);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
