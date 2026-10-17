import type { ResolvedSession } from '../modules/auth/session.service.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by the session middleware when a valid session cookie is present. */
      auth?: ResolvedSession;
    }
  }
}

export {};
