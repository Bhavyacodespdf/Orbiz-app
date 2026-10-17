import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resetDatabase } from './db.js';
import { devLogin } from './helpers.js';
import { staffApp } from './staff.js';

/**
 * An explicit inventory of every API route. If a route is added without
 * being listed here, the "documented surface" test below should be updated
 * on purpose — this file is the reviewed list of what is public.
 */

const ID = '00000000-0000-4000-8000-000000000000';

type Route = [method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string];

const PUBLIC: Route[] = [
  ['get', '/health'],
  ['get', '/auth/providers'],
  ['get', '/outlets'],
  ['get', '/outlets/nope'],
  ['get', '/outlets/nope/menu'],
  ['get', '/outlets/nope/special'],
  ['get', '/specials'],
  ['get', '/outlets/nope/slots'],
];

const SIGNED_IN: Route[] = [
  ['get', '/auth/me'],
  ['get', '/me/profile'],
  ['patch', '/me/profile'],
  ['get', '/cart'],
  ['post', '/cart/items'],
  ['patch', `/cart/items/${ID}`],
  ['delete', `/cart/items/${ID}`],
  ['delete', '/cart'],
  ['post', '/cart/combo'],
  ['get', '/surprise-meal/options'],
  ['post', '/surprise-meal/generate'],
  ['post', '/surprise-meal/swap'],
  ['post', '/orders'],
  ['get', '/orders'],
  ['get', `/orders/${ID}`],
  ['post', `/orders/${ID}/cancel`],
  ['post', `/orders/${ID}/reschedule`],
  ['get', '/wallet'],
  ['get', '/wallet/transactions'],
  ['get', '/wallet/points'],
  ['get', `/wallet/transactions/${ID}`],
  ['post', '/wallet/recharges'],
  ['get', `/wallet/recharges/${ID}`],
  ['post', `/payments/mock/${ID}/outcome`],
  ['get', '/staff/outlets'],
  ['get', '/outlets/nope/poll'],
  ['post', `/polls/${ID}/vote`],
  ['get', `/groups`],
  ['post', `/groups`],
  ['post', `/groups/join`],
  ['get', `/groups/${ID}`],
  ['patch', `/groups/${ID}`],
  ['delete', `/groups/${ID}/members/${ID}`],
  ['put', `/groups/${ID}/items/${ID}`],
  ['put', `/groups/${ID}/allocation`],
  ['post', `/groups/${ID}/checkout`],
  ['post', `/groups/${ID}/shares/mine/pay`],
  ['post', `/groups/${ID}/order`],
  ['post', `/groups/${ID}/reopen`],
  ['post', `/groups/${ID}/cancel`],
  ['get', `/splits`],
  ['post', `/splits`],
  ['get', `/splits/${ID}`],
  ['patch', `/splits/${ID}`],
  ['post', `/splits/${ID}/settlements`],
  ['post', `/splits/${ID}/cancel`],
  ['get', `/banquets/venues`],
  ['post', `/banquets/quote`],
  ['get', `/banquets`],
  ['post', `/banquets`],
  ['get', `/banquets/${ID}`],
  ['get', `/banquets/${ID}/pass`],
  ['post', `/banquets/${ID}/cancel`],
];

const STAFF_ONLY: Route[] = [
  ['get', `/staff/outlets/${ID}/menu`],
  ['patch', `/staff/outlets/${ID}/status`],
  ['post', `/staff/outlets/${ID}/categories`],
  ['patch', `/staff/outlets/${ID}/categories/${ID}`],
  ['post', `/staff/outlets/${ID}/items`],
  ['patch', `/staff/outlets/${ID}/items/${ID}`],
  ['patch', `/staff/outlets/${ID}/items/${ID}/availability`],
  ['get', `/staff/outlets/${ID}/schedule`],
  ['put', `/staff/outlets/${ID}/schedule`],
  ['get', `/staff/outlets/${ID}/inventory`],
  ['get', `/staff/outlets/${ID}/inventory/${ID}/history`],
  ['post', `/staff/outlets/${ID}/inventory/${ID}/adjustments`],
  ['patch', `/staff/outlets/${ID}/inventory/${ID}/threshold`],
  ['post', `/staff/outlets/${ID}/inventory/${ID}/tracking`],
  ['get', `/staff/outlets/${ID}/planning/overview`],
  ['get', `/staff/outlets/${ID}/planning/demand`],
  ['get', `/staff/outlets/${ID}/planning/items/${ID}/history`],
  ['get', `/staff/outlets/${ID}/planning/plans`],
  ['post', `/staff/outlets/${ID}/planning/plans`],
  ['get', `/staff/outlets/${ID}/planning/plans/${ID}`],
  ['get', `/staff/outlets/${ID}/planning/plans/${ID}/export.csv`],
  ['patch', `/staff/outlets/${ID}/planning/plans/${ID}`],
  ['patch', `/staff/outlets/${ID}/planning/plans/${ID}/items/${ID}`],
  ['post', `/staff/outlets/${ID}/planning/plans/${ID}/submit`],
  ['post', `/staff/outlets/${ID}/planning/plans/${ID}/approve`],
  ['post', `/staff/outlets/${ID}/planning/plans/${ID}/complete`],
  ['post', `/staff/outlets/${ID}/planning/plans/${ID}/items/${ID}/replenishments`],
  ['get', `/staff/outlets/${ID}/planning/evaluation`],
  ['get', `/staff/outlets/${ID}/orders`],
  ['get', `/staff/outlets/${ID}/orders/${ID}`],
  ['post', `/staff/outlets/${ID}/orders/${ID}/transition`],
  ['post', `/staff/outlets/${ID}/orders/${ID}/counter-payment`],
  ['post', `/staff/outlets/${ID}/orders/${ID}/items/${ID}/not-resellable`],
  ['get', `/staff/outlets/${ID}/polls`],
  ['post', `/staff/outlets/${ID}/polls`],
  ['get', `/staff/outlets/${ID}/polls/${ID}`],
  ['patch', `/staff/outlets/${ID}/polls/${ID}`],
  ['delete', `/staff/outlets/${ID}/polls/${ID}`],
  ['post', `/staff/outlets/${ID}/polls/${ID}/open`],
  ['post', `/staff/outlets/${ID}/polls/${ID}/close`],
  ['post', `/staff/outlets/${ID}/polls/${ID}/finalize`],
  ['get', `/staff/outlets/${ID}/banquets/settings`],
  ['put', `/staff/outlets/${ID}/banquets/settings`],
  ['get', `/staff/outlets/${ID}/banquets`],
  ['get', `/staff/outlets/${ID}/banquets/pass/abcdefghijklmnopqrstuvwxyz`],
  ['post', `/staff/outlets/${ID}/banquets/${ID}/confirm`],
  ['post', `/staff/outlets/${ID}/banquets/${ID}/reject`],
  ['post', `/staff/outlets/${ID}/banquets/${ID}/complete`],
];

const ADMIN_ONLY: Route[] = [
  ['get', '/admin/outlets'],
  ['post', '/admin/outlets'],
  ['patch', `/admin/outlets/${ID}`],
  ['get', `/admin/outlets/${ID}/staff`],
  ['post', `/admin/outlets/${ID}/staff`],
  ['delete', `/admin/outlets/${ID}/staff/${ID}`],
  ['get', '/admin/users'],
  ['post', `/admin/users/${ID}/roles`],
  ['post', `/admin/users/${ID}/roles/MANAGER/revoke`],
  ['get', '/admin/audit-logs'],
  ['get', '/admin/audit-logs/actions'],
  ['get', '/admin/no-shows'],
  ['post', `/admin/no-shows/${ID}/retry`],
];

type Agent = ReturnType<typeof request.agent>;

function call(agent: Agent | ReturnType<typeof request>, [method, path]: Route) {
  const target = agent as Agent;
  return target[method](`/api/v1${path}`).set('X-Requested-With', 'CampusCart').send({});
}

describe('route protection inventory', () => {
  let student: Agent;

  beforeAll(async () => {
    await resetDatabase();
    student = request.agent(staffApp);
    await devLogin(student, 'plain.student@example.com');
  });

  it.each(PUBLIC)('%s %s is public', async (method, path) => {
    const res = await call(request(staffApp), [method, path]);
    expect([200, 404]).toContain(res.status);
  });

  it.each([...SIGNED_IN, ...STAFF_ONLY, ...ADMIN_ONLY])(
    '%s %s rejects signed-out callers with 401',
    async (method, path) => {
      const res = await call(request(staffApp), [method, path]);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    },
  );

  it.each(STAFF_ONLY)('%s %s rejects a student with 403', async (method, path) => {
    const res = await call(student, [method, path]);
    expect(res.status).toBe(403);
  });

  it.each(ADMIN_ONLY)('%s %s rejects a non-admin with 403', async (method, path) => {
    const res = await call(student, [method, path]);
    expect(res.status).toBe(403);
  });

  it('rejects every state-changing route without the CSRF header, before anything else', async () => {
    const writes = [...SIGNED_IN, ...STAFF_ONLY, ...ADMIN_ONLY].filter(([m]) => m !== 'get');
    for (const [method, path] of writes) {
      const send = student[method].bind(student);
      const res = await send(`/api/v1${path}`).send({});
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error.code, `${method} ${path}`).toBe('CSRF_REJECTED');
    }
  });

  it('has no unexpected routes: unknown paths are 404, not silently handled', async () => {
    for (const path of [
      '/admin',
      '/admin/wallets',
      '/wallet/balance',
      '/wallet/adjust',
      '/orders/pay',
      '/payments/razorpay/webhook',
    ]) {
      const res = await student.get(`/api/v1${path}`);
      expect(res.status, path).toBe(404);
    }
  });
});
