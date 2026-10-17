import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { devLogin } from '../../tests/helpers.js';
import { staffApp, staffConfig } from '../../tests/staff.js';
import { grantRole } from './roles.service.js';
import type { Agent } from '../../tests/commerce.js';

async function signIn(email: string): Promise<Agent> {
  const agent = request.agent(staffApp);
  await devLogin(agent, email);
  return agent;
}
const post = (agent: Agent, url: string, body: object) =>
  agent.post(`/api/v1${url}`).set('X-Requested-With', 'CampusCart').send(body);

let admin: Agent;
let adminId: string;

beforeEach(async () => {
  await resetDatabase();
  admin = await signIn('admin@example.com');
  await grantRole(prisma, {
    email: 'admin@example.com',
    role: 'ADMIN',
    actor: { type: 'CLI' },
    lists: staffConfig,
  });
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.com' } })).id;
});

const userId = async (email: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { email } })).id;

describe('admin user management', () => {
  it('is forbidden to everyone but administrators', async () => {
    const manager = await signIn('manager@example.com');
    await manager.get('/api/v1/admin/users').expect(403);
    await manager.get('/api/v1/admin/audit-logs').expect(403);
    await request(staffApp).get('/api/v1/admin/users').expect(401);
  });

  it('lists and searches users with roles and allowlist eligibility', async () => {
    await signIn('manager@example.com');
    await signIn('student@example.com');
    const all = await admin.get('/api/v1/admin/users').expect(200);
    expect(all.body.users).toHaveLength(3);
    const res = await admin.get('/api/v1/admin/users?q=MANAGER@').expect(200);
    expect(res.body.users).toEqual([
      expect.objectContaining({
        email: 'manager@example.com',
        roles: ['STUDENT', 'MANAGER'],
        eligibleFor: { MANAGER: true, POS: false, ADMIN: true },
        signInMethod: 'DEV',
      }),
    ]);
  });

  it('paginates', async () => {
    for (const n of [1, 2, 3]) await signIn(`s${n}@example.com`);
    const first = await admin.get('/api/v1/admin/users?limit=2').expect(200);
    const second = await admin
      .get(`/api/v1/admin/users?limit=2&cursor=${first.body.nextCursor}`)
      .expect(200);
    const ids = [...first.body.users, ...second.body.users].map((u: { id: string }) => u.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('grants roles within the allowlist ceiling and audits the admin as actor', async () => {
    await signIn('cashier@example.com');
    await signIn('student@example.com');
    // cashier@ is on the POS list but already has POS from creation; MANAGER is not allowed.
    const notAllowed = await post(
      admin,
      `/admin/users/${await userId('cashier@example.com')}/roles`,
      { role: 'MANAGER' },
    );
    expect(notAllowed.status).toBe(409);
    expect(notAllowed.body.error.code).toBe('NOT_ALLOWLISTED');

    await post(admin, `/admin/users/${await userId('student@example.com')}/roles`, {
      role: 'ADMIN',
    }).expect(201);
    await post(admin, `/admin/users/${await userId('student@example.com')}/roles`, {
      role: 'ADMIN',
    }).expect(200);
    const audit = await prisma.auditLog.findMany({
      where: { action: 'ROLE_GRANTED', actorUserId: adminId },
    });
    expect(audit).toHaveLength(1);
  });

  it('revokes with a reason, ends the user’s sessions, and refuses self-lockout', async () => {
    const manager = await signIn('manager@example.com');
    const managerId = await userId('manager@example.com');
    await post(admin, `/admin/users/${managerId}/roles/MANAGER/revoke`, {}).expect(400);
    const res = await post(admin, `/admin/users/${managerId}/roles/MANAGER/revoke`, {
      reason: 'Left the team',
    }).expect(200);
    expect(res.body).toEqual({ changed: true, sessionsEnded: 1 });
    await manager.get('/api/v1/auth/me').expect(401);

    const self = await post(admin, `/admin/users/${adminId}/roles/ADMIN/revoke`, {
      reason: 'Oops',
    });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('SELF_REVOKE');
  });

  it('cannot grant or revoke the Student role', async () => {
    const id = await userId('admin@example.com');
    await post(admin, `/admin/users/${id}/roles`, { role: 'STUDENT' }).expect(400);
    await post(admin, `/admin/users/${id}/roles/STUDENT/revoke`, { reason: 'Nope' }).expect(404);
  });
});

describe('audit log', () => {
  it('lists entries newest first with the actor, filters by action, and lists actions', async () => {
    await signIn('student@example.com');
    await post(admin, `/admin/users/${await userId('student@example.com')}/roles`, {
      role: 'ADMIN',
    }).expect(201);

    const res = await admin.get('/api/v1/admin/audit-logs').expect(200);
    expect(res.body.entries[0]).toMatchObject({
      action: 'ROLE_GRANTED',
      actorType: 'USER',
      actor: { email: 'admin@example.com' },
      metadata: { role: 'ADMIN' },
    });
    const filtered = await admin.get('/api/v1/admin/audit-logs?action=ACCOUNT_CREATED').expect(200);
    expect(
      filtered.body.entries.every((e: { action: string }) => e.action === 'ACCOUNT_CREATED'),
    ).toBe(true);
    expect(filtered.body.entries.length).toBeGreaterThanOrEqual(2);
    const actions = await admin.get('/api/v1/admin/audit-logs/actions').expect(200);
    expect(actions.body.actions).toEqual(
      expect.arrayContaining(['ACCOUNT_CREATED', 'ROLE_GRANTED']),
    );
  });

  it('is read-only: there is no way to edit or delete entries', async () => {
    const entry = (await admin.get('/api/v1/admin/audit-logs').expect(200)).body.entries[0];
    await admin
      .delete(`/api/v1/admin/audit-logs/${entry.id}`)
      .set('X-Requested-With', 'CampusCart')
      .expect(404);
    await admin
      .patch(`/api/v1/admin/audit-logs/${entry.id}`)
      .set('X-Requested-With', 'CampusCart')
      .send({})
      .expect(404);
  });
});
