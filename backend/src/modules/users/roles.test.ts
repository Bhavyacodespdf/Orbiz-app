import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, prisma } from '../../tests/db.js';
import { signInWithIdentity } from '../auth/provisioning.service.js';
import { createSession } from '../auth/session.service.js';
import { grantRole, revokeRole } from './roles.service.js';

const lists = { MANAGER_ALLOWED_EMAILS: ['manager@example.com'], POS_ALLOWED_EMAILS: [] };
const cli = { type: 'CLI' as const };

async function account(email: string, emailVerified = true) {
  const { userId } = await signInWithIdentity(
    prisma,
    { provider: 'GOOGLE', subject: `g-${email}`, email, emailVerified, name: null, picture: null },
    { MANAGER_ALLOWED_EMAILS: [], POS_ALLOWED_EMAILS: [] },
  );
  return userId;
}

beforeEach(resetDatabase);

describe('grantRole', () => {
  it('provisions the first Admin for an existing, verified account and audits it', async () => {
    const userId = await account('owner@example.com');
    const result = await grantRole(prisma, {
      email: 'Owner@example.com',
      role: 'ADMIN',
      actor: cli,
      lists,
    });
    expect(result.changed).toBe(true);
    const role = await prisma.userRole.findUniqueOrThrow({
      where: { userId_role: { userId, role: 'ADMIN' } },
    });
    expect(role.grantedVia).toBe('CLI');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'ROLE_GRANTED' } });
    expect(audit).toMatchObject({ actorType: 'CLI', entityId: userId });
  });

  it('requires the person to have signed in first', async () => {
    await expect(
      grantRole(prisma, { email: 'nobody@example.com', role: 'ADMIN', actor: cli, lists }),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('refuses privileged roles for unverified emails', async () => {
    await account('unverified@example.com', false);
    await expect(
      grantRole(prisma, { email: 'unverified@example.com', role: 'ADMIN', actor: cli, lists }),
    ).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
  });

  it('treats the Manager/POS allowlists as a ceiling', async () => {
    await account('manager@example.com');
    await account('random@example.com');
    await expect(
      grantRole(prisma, { email: 'random@example.com', role: 'MANAGER', actor: cli, lists }),
    ).rejects.toMatchObject({ code: 'NOT_ALLOWLISTED' });
    await expect(
      grantRole(prisma, { email: 'manager@example.com', role: 'POS', actor: cli, lists }),
    ).rejects.toMatchObject({ code: 'NOT_ALLOWLISTED' });
    await expect(
      grantRole(prisma, { email: 'manager@example.com', role: 'MANAGER', actor: cli, lists }),
    ).resolves.toMatchObject({ changed: true });
  });

  it('is idempotent', async () => {
    await account('owner@example.com');
    await grantRole(prisma, { email: 'owner@example.com', role: 'ADMIN', actor: cli, lists });
    const again = await grantRole(prisma, {
      email: 'owner@example.com',
      role: 'ADMIN',
      actor: cli,
      lists,
    });
    expect(again.changed).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: 'ROLE_GRANTED' } })).toBe(1);
  });
});

describe('revokeRole', () => {
  it('requires a reason', async () => {
    await account('owner@example.com');
    await expect(
      revokeRole(prisma, { email: 'owner@example.com', role: 'ADMIN', actor: cli, reason: ' ' }),
    ).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
  });

  it('revokes, ends every session, keeps the record and audits it', async () => {
    const userId = await account('manager@example.com');
    await grantRole(prisma, { email: 'manager@example.com', role: 'MANAGER', actor: cli, lists });
    await createSession(prisma, userId, 'phone');
    await createSession(prisma, userId, 'laptop');

    const result = await revokeRole(prisma, {
      email: 'manager@example.com',
      role: 'MANAGER',
      actor: cli,
      reason: 'No longer staff',
    });
    expect(result).toMatchObject({ changed: true, sessionsEnded: 2 });
    expect(await prisma.session.count({ where: { userId } })).toBe(0);

    const row = await prisma.userRole.findUniqueOrThrow({
      where: { userId_role: { userId, role: 'MANAGER' } },
    });
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokeReason).toBe('No longer staff');
    expect(await prisma.auditLog.count({ where: { action: 'ROLE_REVOKED' } })).toBe(1);
  });

  it('allows an explicit re-grant after revocation', async () => {
    await account('manager@example.com');
    await grantRole(prisma, { email: 'manager@example.com', role: 'MANAGER', actor: cli, lists });
    await revokeRole(prisma, {
      email: 'manager@example.com',
      role: 'MANAGER',
      actor: cli,
      reason: 'Paused',
    });
    const again = await grantRole(prisma, {
      email: 'manager@example.com',
      role: 'MANAGER',
      actor: cli,
      lists,
    });
    expect(again.changed).toBe(true);
    expect(await prisma.userRole.count({ where: { role: 'MANAGER', revokedAt: null } })).toBe(1);
  });

  it('refuses to remove the last active administrator', async () => {
    await account('owner@example.com');
    await grantRole(prisma, { email: 'owner@example.com', role: 'ADMIN', actor: cli, lists });
    await expect(
      revokeRole(prisma, { email: 'owner@example.com', role: 'ADMIN', actor: cli, reason: 'Oops' }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' });

    await account('second@example.com');
    await grantRole(prisma, { email: 'second@example.com', role: 'ADMIN', actor: cli, lists });
    await expect(
      revokeRole(prisma, {
        email: 'owner@example.com',
        role: 'ADMIN',
        actor: cli,
        reason: 'Handover',
      }),
    ).resolves.toMatchObject({ changed: true });
  });
});
