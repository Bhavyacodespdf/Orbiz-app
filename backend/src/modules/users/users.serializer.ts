import type { SessionUser } from '../auth/session.service.js';

/** The user shape sent to the browser. Contains nothing secret. */
export function toPublicUser(user: SessionUser) {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    phone: user.phone,
    roles: user.roles,
    signInMethod: user.signInMethod,
  };
}

export type PublicUser = ReturnType<typeof toPublicUser>;
