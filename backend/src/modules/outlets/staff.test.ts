import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { buildTestApp, devLogin, testConfig } from '../../tests/helpers.js';
import { assign, makeCategory, makeItem, makeOutlet } from '../../tests/fixtures.js';
import { revokeRole } from '../users/roles.service.js';

const config = testConfig({
  MANAGER_ALLOWED_EMAILS: 'manager@example.com,other.manager@example.com',
  POS_ALLOWED_EMAILS: 'cashier@example.com',
});
const app = buildTestApp({ config });

async function agentFor(email: string) {
  const agent = request.agent(app);
  await devLogin(agent, email);
  return agent;
}

type Agent = Awaited<ReturnType<typeof agentFor>>;
const send = (agent: Agent, method: 'post' | 'patch', url: string, body: object) =>
  agent[method](`/api/v1/staff/outlets${url}`).set('X-Requested-With', 'CampusCart').send(body);

let outlet: Awaited<ReturnType<typeof makeOutlet>>;
let otherOutlet: Awaited<ReturnType<typeof makeOutlet>>;
let category: Awaited<ReturnType<typeof makeCategory>>;
let item: Awaited<ReturnType<typeof makeItem>>;
let manager: Agent;
let cashier: Agent;

beforeEach(async () => {
  await resetDatabase();
  outlet = await makeOutlet({ name: 'Mine', status: 'CLOSED' });
  otherOutlet = await makeOutlet({ name: 'Not mine' });
  category = await makeCategory(outlet.id, 'Snacks');
  item = await makeItem(outlet.id, category.id, { name: 'Samosa', pricePaise: 1500 });
  manager = await agentFor('manager@example.com');
  cashier = await agentFor('cashier@example.com');
  await assign('manager@example.com', outlet.id, 'MANAGER');
  await assign('cashier@example.com', outlet.id, 'POS');
});

describe('GET /staff/outlets', () => {
  it('lists only the outlets the user is assigned to, with their roles there', async () => {
    const res = await manager.get('/api/v1/staff/outlets').expect(200);
    expect(res.body.outlets).toEqual([
      { outlet: expect.objectContaining({ id: outlet.id, name: 'Mine' }), roles: ['MANAGER'] },
    ]);
  });

  it('returns nothing for a student, and requires sign-in', async () => {
    const student = await agentFor('student@example.com');
    expect((await student.get('/api/v1/staff/outlets').expect(200)).body.outlets).toEqual([]);
    await request(app).get('/api/v1/staff/outlets').expect(401);
  });
});

describe('outlet scoping', () => {
  it('forbids managers from outlets they are not assigned to', async () => {
    const res = await send(manager, 'patch', `/${otherOutlet.id}/status`, { status: 'OPEN' });
    expect(res.status).toBe(403);
    await manager.get(`/api/v1/staff/outlets/${otherOutlet.id}/menu`).expect(403);
  });

  it('forbids students even when they guess an outlet ID', async () => {
    const student = await agentFor('student@example.com');
    await student.get(`/api/v1/staff/outlets/${outlet.id}/menu`).expect(403);
  });

  it('stops working immediately when the role is revoked, even though the assignment remains', async () => {
    await send(manager, 'patch', `/${outlet.id}/status`, { status: 'OPEN' }).expect(200);
    await revokeRole(prisma, {
      email: 'manager@example.com',
      role: 'MANAGER',
      actor: { type: 'CLI' },
      reason: 'test',
    });
    const fresh = await agentFor('manager@example.com');
    await send(fresh, 'patch', `/${outlet.id}/status`, { status: 'CLOSED' }).expect(403);
    expect(await prisma.staffAssignment.count()).toBe(2);
  });

  it('treats an item from another outlet as not found (no cross-outlet edits)', async () => {
    const theirCategory = await makeCategory(otherOutlet.id);
    const theirItem = await makeItem(otherOutlet.id, theirCategory.id);
    const res = await send(manager, 'patch', `/${outlet.id}/items/${theirItem.id}`, {
      pricePaise: 100,
    });
    expect(res.status).toBe(404);
    expect(
      (await prisma.menuItem.findUniqueOrThrow({ where: { id: theirItem.id } })).pricePaise,
    ).toBe(5000);
  });

  it('refuses to file an item under another outlet’s category', async () => {
    const theirCategory = await makeCategory(otherOutlet.id);
    const res = await send(manager, 'post', `/${outlet.id}/items`, {
      categoryId: theirCategory.id,
      name: 'Sneaky',
      pricePaise: 1000,
    });
    expect(res.status).toBe(404);
    expect(await prisma.menuItem.count({ where: { name: 'Sneaky' } })).toBe(0);
  });

  it('returns 404 for malformed IDs instead of crashing', async () => {
    await manager.get('/api/v1/staff/outlets/not-a-uuid/menu').expect(404);
  });
});

describe('manager menu management', () => {
  it('opens the outlet and audits the change', async () => {
    const res = await send(manager, 'patch', `/${outlet.id}/status`, { status: 'OPEN' }).expect(
      200,
    );
    expect(res.body.outlet).toMatchObject({ status: 'OPEN', acceptingOrders: true });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'OUTLET_STATUS_CHANGED' },
    });
    expect(audit.metadata).toEqual({ from: 'CLOSED', to: 'OPEN' });
  });

  it('creates categories and items; duplicate names are rejected', async () => {
    const cat = await send(manager, 'post', `/${outlet.id}/categories`, { name: 'Drinks' }).expect(
      201,
    );
    const created = await send(manager, 'post', `/${outlet.id}/items`, {
      categoryId: cat.body.category.id,
      name: 'Chai',
      description: 'Masala',
      pricePaise: 2000,
      dietary: 'VEG',
    }).expect(201);
    expect(created.body.item).toMatchObject({ name: 'Chai', pricePaise: 2000, isActive: true });

    const dup = await send(manager, 'post', `/${outlet.id}/categories`, { name: 'Drinks' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_NAME');
  });

  it('changes a price and records old and new price in the audit log', async () => {
    await send(manager, 'patch', `/${outlet.id}/items/${item.id}`, { pricePaise: 1800 }).expect(
      200,
    );
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'MENU_ITEM_PRICE_CHANGED' },
    });
    expect(audit.metadata).toMatchObject({ fromPaise: 1500, toPaise: 1800 });
  });

  it.each([
    [0, 'zero'],
    [-500, 'negative'],
    [12.5, 'fractional paise'],
    [1_000_001, 'above ₹10,000'],
    ['1500', 'a string'],
  ])('rejects a price of %s (%s)', async (pricePaise, _label) => {
    const res = await send(manager, 'patch', `/${outlet.id}/items/${item.id}`, { pricePaise });
    expect(res.status).toBe(400);
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } })).pricePaise).toBe(
      1500,
    );
  });

  it('deactivates an item: hidden from students, kept in the database, audited', async () => {
    await send(manager, 'patch', `/${outlet.id}/items/${item.id}`, { isActive: false }).expect(200);
    const menu = await request(app).get(`/api/v1/outlets/${outlet.slug}/menu`).expect(200);
    expect(menu.body.items).toEqual([]);
    expect(await prisma.menuItem.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'MENU_ITEM_DEACTIVATED' } })).toBe(1);

    const staffMenu = await manager.get(`/api/v1/staff/outlets/${outlet.id}/menu`).expect(200);
    expect(staffMenu.body.items[0]).toMatchObject({ id: item.id, isActive: false });
  });

  it('rejects unknown fields such as outletId', async () => {
    await send(manager, 'patch', `/${outlet.id}/items/${item.id}`, {
      outletId: otherOutlet.id,
    }).expect(400);
  });
});

describe('POS permissions', () => {
  it('can mark items sold out and back in stock', async () => {
    await send(cashier, 'patch', `/${outlet.id}/items/${item.id}/availability`, {
      isAvailable: false,
    }).expect(200);
    const menu = await request(app).get(`/api/v1/outlets/${outlet.slug}/menu`).expect(200);
    expect(menu.body.items[0].isAvailable).toBe(false);
  });

  it('cannot change prices, create items or change outlet status', async () => {
    await send(cashier, 'patch', `/${outlet.id}/items/${item.id}`, { pricePaise: 1 }).expect(403);
    await send(cashier, 'post', `/${outlet.id}/items`, {
      categoryId: category.id,
      name: 'x',
      pricePaise: 100,
    }).expect(403);
    await send(cashier, 'patch', `/${outlet.id}/status`, { status: 'OPEN' }).expect(403);
  });
});

describe('database constraints (defence in depth)', () => {
  it('rejects non-positive prices even if application validation were bypassed', async () => {
    await expect(
      prisma.menuItem.update({ where: { id: item.id }, data: { pricePaise: 0 } }),
    ).rejects.toThrow();
  });

  it('rejects an item whose category belongs to a different outlet', async () => {
    const theirCategory = await makeCategory(otherOutlet.id);
    await expect(makeItem(outlet.id, theirCategory.id)).rejects.toThrow();
  });
});
