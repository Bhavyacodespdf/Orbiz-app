import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, prisma } from '../../tests/db.js';
import { initialRoles, signInWithIdentity, type VerifiedIdentity } from './provisioning.service.js';

const lists = {
  MANAGER_ALLOWED_EMAILS: ['manager@example.com', 'both@example.com'],
  POS_ALLOWED_EMAILS: ['cashier@example.com', 'both@example.com'],
};

function google(subject: string, email: string, emailVerified = true): VerifiedIdentity {
  return { provider: 'GOOGLE', subject, email, emailVerified, name: null, picture: null };
}

async function rolesOf(userId: string) {
  const roles = await prisma.userRole.findMany({ where: { userId, revokedAt: null } });
  return roles.map((r) => r.role).sort();
}

beforeEach(resetDatabase);

describe('initialRoles', () => {
  it('gives every new account the Student role, whatever the domain', () => {
    expect(initialRoles('someone@anything.org', true, lists)).toEqual(['STUDENT']);
    expect(initialRoles('someone@gmail.com', false, lists)).toEqual(['STUDENT']);
  });

  it('adds Manager and/or POS for verified allowlisted emails, compared case-insensitively', () => {
    expect(initialRoles('Manager@Example.com', true, lists)).toEqual(['STUDENT', 'MANAGER']);
    expect(initialRoles('cashier@example.com', true, lists)).toEqual(['STUDENT', 'POS']);
    expect(initialRoles('both@example.com', true, lists)).toEqual(['STUDENT', 'MANAGER', 'POS']);
  });

  it('never grants privileged roles for an unverified email', () => {
    expect(initialRoles('both@example.com', false, lists)).toEqual(['STUDENT']);
  });

  it('never grants Admin', () => {
    expect(initialRoles('both@example.com', true, lists)).not.toContain('ADMIN');
  });
});

describe('signInWithIdentity', () => {
  it('creates the account with allowlisted roles and audits the grants', async () => {
    const { userId, isNewAccount } = await signInWithIdentity(
      prisma,
      google('g-both', 'both@example.com'),
      lists,
    );
    expect(isNewAccount).toBe(true);
    expect(await rolesOf(userId)).toEqual(['MANAGER', 'POS', 'STUDENT']);

    const audit = await prisma.auditLog.findMany({ where: { entityId: userId } });
    expect(audit.map((a) => a.action).sort()).toEqual([
      'ACCOUNT_CREATED',
      'ROLE_GRANTED',
      'ROLE_GRANTED',
    ]);
    expect(audit.every((a) => a.actorType === 'SYSTEM')).toBe(true);
  });

  it('does not promote an existing account when its email is later allowlisted', async () => {
    const { userId } = await signInWithIdentity(prisma, google('g-1', 'late@example.com'), lists);
    const laterLists = { ...lists, MANAGER_ALLOWED_EMAILS: ['late@example.com'] };
    await signInWithIdentity(prisma, google('g-1', 'late@example.com'), laterLists);
    expect(await rolesOf(userId)).toEqual(['STUDENT']);
  });

  it('does not demote an existing account when its email is removed from the allowlist', async () => {
    const { userId } = await signInWithIdentity(
      prisma,
      google('g-1', 'manager@example.com'),
      lists,
    );
    await signInWithIdentity(prisma, google('g-1', 'manager@example.com'), {
      MANAGER_ALLOWED_EMAILS: [],
      POS_ALLOWED_EMAILS: [],
    });
    expect(await rolesOf(userId)).toEqual(['MANAGER', 'STUDENT']);
  });

  it('refuses a different identity with an existing email (no automatic linking)', async () => {
    await signInWithIdentity(prisma, google('g-1', 'person@example.com'), lists);
    await expect(
      signInWithIdentity(prisma, google('g-2', 'PERSON@example.com'), lists),
    ).rejects.toMatchObject({ code: 'EMAIL_CONFLICT' });
    await expect(
      signInWithIdentity(
        prisma,
        { ...google('person@example.com', 'person@example.com'), provider: 'DEV' },
        lists,
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_CONFLICT' });
    expect(await prisma.user.count()).toBe(1);
  });

  it('refuses sign-in to a suspended account', async () => {
    await signInWithIdentity(prisma, google('g-1', 'person@example.com'), lists);
    await prisma.user.updateMany({ data: { status: 'SUSPENDED' } });
    await expect(
      signInWithIdentity(prisma, google('g-1', 'person@example.com'), lists),
    ).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
  });

  it('creates exactly one account when the same first sign-in happens concurrently', async () => {
    const identity = google('g-race', 'race@example.com');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => signInWithIdentity(prisma, identity, lists)),
    );
    expect(new Set(results.map((r) => r.userId)).size).toBe(1);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.authIdentity.count()).toBe(1);
  });
});
