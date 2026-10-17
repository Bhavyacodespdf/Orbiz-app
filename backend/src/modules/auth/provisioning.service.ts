import type { Env } from '../../config/env.js';
import type { Database } from '../../lib/prisma.js';
import { isUniqueViolation } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { normaliseEmail } from '../../lib/email.js';
import { recordAudit } from '../../lib/audit.js';
import type { IdentityProvider, Role } from '../../generated/prisma/enums.js';

export interface VerifiedIdentity {
  provider: IdentityProvider;
  /** Provider's stable account ID (Google "sub"). This — not email — identifies the account. */
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export interface SignInResult {
  userId: string;
  isNewAccount: boolean;
}

export type Allowlists = Pick<Env, 'MANAGER_ALLOWED_EMAILS' | 'POS_ALLOWED_EMAILS'>;

/**
 * Roles a brand-new account receives. Everyone is a Student. Manager/POS are
 * added only when the provider has verified the email and it is allowlisted.
 * Admin is never granted here.
 */
export function initialRoles(email: string, emailVerified: boolean, lists: Allowlists): Role[] {
  const roles: Role[] = ['STUDENT'];
  if (!emailVerified) return roles;
  const normalised = normaliseEmail(email);
  if (lists.MANAGER_ALLOWED_EMAILS.includes(normalised)) roles.push('MANAGER');
  if (lists.POS_ALLOWED_EMAILS.includes(normalised)) roles.push('POS');
  return roles;
}

function displayNameFor(identity: VerifiedIdentity): string {
  const name = identity.name?.trim();
  if (name) return name.slice(0, 60);
  return normaliseEmail(identity.email).split('@')[0]!.slice(0, 60);
}

/**
 * Signs in an already-verified identity, creating the account on first use.
 *
 * - Existing identity → profile details are refreshed; roles are NOT changed,
 *   even if the allowlists changed since (approved decision Q4).
 * - New identity whose email already belongs to another account → refused.
 *   Accounts are never linked automatically by email.
 */
export async function signInWithIdentity(
  db: Database,
  identity: VerifiedIdentity,
  lists: Allowlists,
): Promise<SignInResult> {
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.authIdentity.findUnique({
        where: { provider_subject: { provider: identity.provider, subject: identity.subject } },
        include: { user: true },
      });

      if (existing) {
        if (existing.user.status !== 'ACTIVE') {
          throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended.');
        }
        await tx.authIdentity.update({
          where: { id: existing.id },
          data: {
            email: normaliseEmail(identity.email),
            emailVerified: identity.emailVerified,
            lastLoginAt: new Date(),
          },
        });
        await tx.user.update({
          where: { id: existing.userId },
          data: { avatarUrl: identity.picture ?? existing.user.avatarUrl },
        });
        return { userId: existing.userId, isNewAccount: false };
      }

      const email = normaliseEmail(identity.email);
      const emailTaken = await tx.user.findUnique({ where: { email }, select: { id: true } });
      if (emailTaken) {
        throw new AppError(
          409,
          'EMAIL_CONFLICT',
          'Another CampusCart account already uses this email address.',
        );
      }

      const roles = initialRoles(email, identity.emailVerified, lists);
      const user = await tx.user.create({
        data: {
          email,
          emailVerified: identity.emailVerified,
          displayName: displayNameFor(identity),
          avatarUrl: identity.picture,
          identities: {
            create: {
              provider: identity.provider,
              subject: identity.subject,
              email,
              emailVerified: identity.emailVerified,
            },
          },
          roles: {
            create: roles.map((role) => ({
              role,
              grantedVia: role === 'STUDENT' ? 'DEFAULT' : 'ALLOWLIST',
            })),
          },
        },
      });

      await recordAudit(tx, {
        actor: { type: 'SYSTEM' },
        action: 'ACCOUNT_CREATED',
        entityType: 'User',
        entityId: user.id,
        metadata: { provider: identity.provider, roles },
      });
      for (const role of roles.filter((r) => r !== 'STUDENT')) {
        await recordAudit(tx, {
          actor: { type: 'SYSTEM' },
          action: 'ROLE_GRANTED',
          entityType: 'User',
          entityId: user.id,
          metadata: { role, via: 'ALLOWLIST' },
        });
      }

      return { userId: user.id, isNewAccount: true };
    });
  } catch (error) {
    // Two simultaneous first sign-ins for the same identity: one creates the account;
    // the other either hits the unique constraint or (if it checked after the first
    // committed) sees the email as taken. In both cases, if this exact identity now
    // exists, it is the same person — sign them in to the account that was created.
    const raceLost =
      isUniqueViolation(error) || (error instanceof AppError && error.code === 'EMAIL_CONFLICT');
    if (raceLost) {
      const winner = await db.authIdentity.findUnique({
        where: { provider_subject: { provider: identity.provider, subject: identity.subject } },
        include: { user: { select: { status: true } } },
      });
      if (winner && winner.user.status === 'ACTIVE') {
        return { userId: winner.userId, isNewAccount: false };
      }
    }
    throw error;
  }
}
