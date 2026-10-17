import type { DbClient } from '../../lib/prisma.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import type { IdentityProvider, Role, UserStatus } from '../../generated/prisma/enums.js';

/** A session ends after this long without use… */
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** …and always after this long, however active it is. */
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
/** Avoid a database write on every request: extend the session at most this often. */
const TOUCH_INTERVAL_MS = 15 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string | null;
  phone: string | null;
  status: UserStatus;
  /** Currently active (not revoked) roles, read fresh from the database. */
  roles: Role[];
  signInMethod: IdentityProvider;
}

export interface ResolvedSession {
  sessionId: string;
  user: SessionUser;
}

/** Creates a session and returns the raw token for the cookie. Only its hash is stored. */
export async function createSession(
  db: DbClient,
  userId: string,
  userAgent: string | undefined,
  now = new Date(),
): Promise<string> {
  const token = randomToken();
  await db.session.create({
    data: {
      tokenHash: sha256(token),
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_IDLE_MS),
      absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
      userAgent: userAgent?.slice(0, 300),
    },
  });
  return token;
}

/**
 * Looks up the session for a cookie token. Returns null for unknown, expired
 * or suspended-user sessions. Roles are loaded on every call so a revoked
 * role stops working immediately.
 */
export async function resolveSession(
  db: DbClient,
  token: string,
  now = new Date(),
): Promise<ResolvedSession | null> {
  const session = await db.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: {
      user: {
        include: {
          roles: { where: { revokedAt: null }, select: { role: true } },
          identities: { select: { provider: true }, take: 1 },
        },
      },
    },
  });
  if (!session) return null;

  const expired = session.expiresAt <= now || session.absoluteExpiresAt <= now;
  if (expired || session.user.status !== 'ACTIVE') {
    await db.session.deleteMany({ where: { id: session.id } });
    return null;
  }

  if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    const extended = Math.min(now.getTime() + SESSION_IDLE_MS, session.absoluteExpiresAt.getTime());
    await db.session.update({
      where: { id: session.id },
      data: { lastSeenAt: now, expiresAt: new Date(extended) },
    });
  }

  const { user } = session;
  return {
    sessionId: session.id,
    user: {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      phone: user.phone,
      status: user.status,
      roles: user.roles.map((r) => r.role),
      signInMethod: user.identities[0]?.provider ?? 'GOOGLE',
    },
  };
}

export async function deleteSessionByToken(db: DbClient, token: string): Promise<void> {
  await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
}

/** Signs a user out everywhere, e.g. after a role is revoked. Returns how many sessions ended. */
export async function deleteAllSessionsForUser(db: DbClient, userId: string): Promise<number> {
  const { count } = await db.session.deleteMany({ where: { userId } });
  return count;
}
