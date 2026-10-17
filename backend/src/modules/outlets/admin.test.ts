import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { buildTestApp, devLogin, testConfig } from '../../tests/helpers.js';
import { grantRole } from '../users/roles.service.js';

const config = testConfig({
  MANAGER_ALLOWED_EMAILS: 'manager@example.com',
  POS_ALLOWED_EMAILS: '',
});
const app = buildTestApp({ config });

async function agentFor(email: string) {
  const agent = request.agent(app);
  await devLogin(agent, email);
  return agent;
}
type Agent = Awaited<ReturnType<typeof agentFor>>;
const post = (agent: Agent, url: string, body: object) =>
  agent.post(`/api/v1/admin/outlets${url}`).set('X-Requested-With', 'CampusCart').send(body);

let admin: Agent;

beforeEach(async () => {
  await resetDatabase();
  admin = await agentFor('admin@example.com');
  await grantRole(prisma, {
    email: 'admin@example.com',
    role: 'ADMIN',
    actor: { type: 'CLI' },
    lists: config,
  });
});

describe('admin outlet management', () => {
  it('is forbidden to non-admins, including managers', async () => {
    const managerAgent = await agentFor('manager@example.com');
    await managerAgent.get('/api/v1/admin/outlets').expect(403);
    await post(managerAgent, '', { name: 'X' }).expect(403);
  });

  it('creates outlets closed by default with a unique slug, and audits it', async () => {
    const a = await post(admin, '', { name: 'Night Owl Café', location: 'Library' }).expect(201);
    const b = await post(admin, '', { name: 'Night Owl Cafe' }).expect(201);
    expect(a.body.outlet).toMatchObject({
      slug: 'night-owl-cafe',
      status: 'CLOSED',
      isActive: true,
    });
    expect(b.body.outlet.slug).toBe('night-owl-cafe-2');
    expect(await prisma.auditLog.count({ where: { action: 'OUTLET_CREATED' } })).toBe(2);
  });

  it('archives an outlet so students no longer see it', async () => {
    const { body } = await post(admin, '', { name: 'Pop-up', status: 'OPEN' }).expect(201);
    await admin
      .patch(`/api/v1/admin/outlets/${body.outlet.id}`)
      .set('X-Requested-With', 'CampusCart')
      .send({ isActive: false })
      .expect(200);
    const list = await request(app).get('/api/v1/outlets').expect(200);
    expect(list.body.outlets).toEqual([]);
  });

  it('assigns staff only if they already hold the role, idempotently, with audit', async () => {
    const { body } = await post(admin, '', { name: 'Kitchen' }).expect(201);
    const outletId = body.outlet.id as string;

    const missing = await post(admin, `/${outletId}/staff`, {
      email: 'nobody@example.com',
      role: 'MANAGER',
    });
    expect(missing.status).toBe(404);

    await agentFor('student@example.com');
    const noRole = await post(admin, `/${outletId}/staff`, {
      email: 'student@example.com',
      role: 'MANAGER',
    });
    expect(noRole.status).toBe(409);
    expect(noRole.body.error.code).toBe('ROLE_REQUIRED');

    await agentFor('manager@example.com'); // allowlisted → MANAGER on creation
    await post(admin, `/${outletId}/staff`, {
      email: 'Manager@example.com',
      role: 'MANAGER',
    }).expect(201);
    await post(admin, `/${outletId}/staff`, {
      email: 'manager@example.com',
      role: 'MANAGER',
    }).expect(200);
    expect(await prisma.staffAssignment.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'STAFF_ASSIGNED' } })).toBe(1);

    const staff = await admin.get(`/api/v1/admin/outlets/${outletId}/staff`).expect(200);
    const assignmentId = staff.body.staff[0].id as string;
    await admin
      .delete(`/api/v1/admin/outlets/${outletId}/staff/${assignmentId}`)
      .set('X-Requested-With', 'CampusCart')
      .expect(204);
    expect(await prisma.staffAssignment.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'STAFF_UNASSIGNED' } })).toBe(1);
  });
});
