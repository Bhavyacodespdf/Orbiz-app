import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { addToCart, fund, menu, placeOrder, student, type Agent } from '../../tests/commerce.js';
import { assign, makeCategory, makeItem, makeOutlet } from '../../tests/fixtures.js';
import { signIn, staffApp, staffFor, transition, cancel } from '../../tests/staff.js';
import {
  DEFAULT_PREP_MINUTES,
  dishEstimate,
  emaUpdate,
  orderBaseMinutes,
  scheduleQueue,
  validDuration,
  type QueueOrder,
} from './kitchen.rules.js';
import { recalculateOutlet } from './kitchen.service.js';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-10-17T07:00:00Z');
const minutesAfter = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

describe('estimator rules', () => {
  it('uses history once supported, else the configured time, else the documented default', () => {
    expect(dishEstimate(null, null)).toEqual({ minutes: DEFAULT_PREP_MINUTES, source: 'DEFAULT' });
    expect(dishEstimate(6, null)).toEqual({ minutes: 6, source: 'CONFIGURED' });
    expect(dishEstimate(6, { emaSeconds: 300, observations: 4 })).toEqual({
      minutes: 6,
      source: 'CONFIGURED',
    });
    expect(dishEstimate(6, { emaSeconds: 300, observations: 5 })).toEqual({
      minutes: 5,
      source: 'HISTORY',
    });
  });

  it('composes an order: the longest unit plus half of every other unit', () => {
    expect(orderBaseMinutes([{ minutes: 10, quantity: 1 }])).toBe(10);
    expect(
      orderBaseMinutes([
        { minutes: 10, quantity: 1 },
        { minutes: 4, quantity: 2 },
      ]),
    ).toBe(14);
    expect(orderBaseMinutes([])).toBe(0);
  });

  it('ignores impossible timings and clamps outliers in the moving average', () => {
    expect(validDuration(NOW, minutesAfter(NOW, 5))).toBe(300);
    expect(validDuration(NOW, minutesAfter(NOW, -1))).toBeNull(); // negative
    expect(validDuration(NOW, new Date(NOW.getTime() + 10_000))).toBeNull(); // too short
    expect(validDuration(NOW, minutesAfter(NOW, 300))).toBeNull(); // > 4 h
    expect(validDuration(null, NOW)).toBeNull();
    expect(emaUpdate(null, 300)).toBe(300);
    expect(emaUpdate(300, 360)).toBeCloseTo(312);
    // A 2-hour "observation" for a 5-minute dish counts as at most 15 minutes.
    expect(emaUpdate(300, 7200)).toBeCloseTo(0.2 * 900 + 0.8 * 300);
  });
});

describe('queue scheduler', () => {
  const order = (
    id: string,
    placed: number,
    minutes: number,
    extra: Partial<QueueOrder> = {},
  ): QueueOrder => ({
    id,
    status: 'ACCEPTED',
    placedAt: minutesAfter(NOW, placed),
    scheduledFor: null,
    prepStartedAt: null,
    minutes,
    ...extra,
  });

  it('serves first come, first served on one kitchen place', () => {
    const plan = scheduleQueue([order('b', -2, 5), order('a', -5, 10)], 1, NOW);
    expect(plan.get('a')).toMatchObject({
      position: 1,
      ordersAhead: 0,
      readyAt: minutesAfter(NOW, 10),
    });
    expect(plan.get('b')).toMatchObject({
      position: 2,
      ordersAhead: 1,
      readyAt: minutesAfter(NOW, 15),
    });
  });

  it('runs orders side by side when the kitchen has parallel places', () => {
    const plan = scheduleQueue([order('a', -5, 10), order('b', -4, 6), order('c', -3, 4)], 2, NOW);
    expect(plan.get('a')!.readyAt).toEqual(minutesAfter(NOW, 10));
    expect(plan.get('b')!.readyAt).toEqual(minutesAfter(NOW, 6));
    // c waits for the first free place (b's, at +6).
    expect(plan.get('c')!.readyAt).toEqual(minutesAfter(NOW, 10));
  });

  it('counts orders being prepared as ahead and keeps their place busy', () => {
    const plan = scheduleQueue(
      [
        order('cooking', -10, 8, { status: 'PREPARING', prepStartedAt: minutesAfter(NOW, -3) }),
        order('next', -1, 5),
      ],
      1,
      NOW,
    );
    expect(plan.get('cooking')).toMatchObject({ position: 0, readyAt: minutesAfter(NOW, 5) });
    expect(plan.get('next')).toMatchObject({
      position: 1,
      ordersAhead: 1,
      readyAt: minutesAfter(NOW, 10),
    });
  });

  it('plans a scheduled order for its slot instead of putting it ahead of today’s orders', () => {
    const plan = scheduleQueue(
      [
        order('tomorrow', -60 * 20, 10, { scheduledFor: minutesAfter(NOW, 120) }), // placed yesterday
        order('now', -1, 5),
      ],
      1,
      NOW,
    );
    expect(plan.get('now')).toMatchObject({ position: 1, readyAt: minutesAfter(NOW, 5) });
    expect(plan.get('tomorrow')).toMatchObject({ position: 2, readyAt: minutesAfter(NOW, 120) });
  });

  it('is deterministic for ties and never gives waiting orders more places than configured', () => {
    const same = [order('b', -1, 5), order('a', -1, 5)];
    expect([...scheduleQueue(same, 1, NOW).entries()]).toEqual([
      ...scheduleQueue([...same].reverse(), 1, NOW).entries(),
    ]);
    expect(scheduleQueue(same, 1, NOW).get('a')!.position).toBe(1);
    const busy = scheduleQueue(
      [
        order('p1', -9, 10, { status: 'PREPARING', prepStartedAt: minutesAfter(NOW, -1) }),
        order('p2', -8, 20, { status: 'PREPARING', prepStartedAt: minutesAfter(NOW, -1) }),
        order('w', -1, 5),
      ],
      1,
      NOW,
    );
    // Only one place: w waits for the later of the two in progress.
    expect(busy.get('w')!.startAt).toEqual(minutesAfter(NOW, 19));
  });
});

// ─── Integration ─────────────────────────────────────────────────────────────

let m: Awaited<ReturnType<typeof menu>>;
let manager: Agent;
let cashier: Agent;
let n = 0;
const api = (
  agent: Agent,
  method: 'get' | 'post' | 'put' | 'patch',
  url: string,
  body?: object,
) => {
  const req = agent[method](`/api/v1${url}`).set('X-Requested-With', 'CampusCart');
  return body ? req.send(body) : req;
};
const kitchen = (agent: Agent, method: 'get' | 'put' | 'patch', path = '', body?: object) =>
  api(agent, method, `/staff/outlets/${m.outlet.id}/kitchen${path}`, body);

beforeEach(async () => {
  await resetDatabase();
  n += 1;
  m = await menu(); // Chai ₹20, Puff ₹35
  ({ manager, cashier } = await staffFor(m.outlet.id));
});

async function order(lines: { id: string; qty?: number; price: number }[], who?: Agent) {
  const s = who ?? (await student(`s${n}-${Math.random()}@example.com`, staffApp));
  await fund(s, 10_000);
  for (const l of lines) await addToCart(s, l.id, l.qty ?? 1);
  const total = lines.reduce((t, l) => t + l.price * (l.qty ?? 1), 0);
  const o = (await placeOrder(s, 'WALLET', total).expect(201)).body.order as { id: string };
  return { ...o, agent: s };
}
/** Accept, start preparing `minutesAgo` minutes ago, then mark ready now. */
async function cook(orderId: string, minutesAgo: number) {
  await transition(cashier, m.outlet.id, orderId, 'ACCEPTED').expect(200);
  await transition(cashier, m.outlet.id, orderId, 'PREPARING').expect(200);
  await prisma.orderStatusHistory.updateMany({
    where: { orderId, toStatus: 'PREPARING' },
    data: { createdAt: new Date(Date.now() - minutesAgo * 60_000) },
  });
  await transition(cashier, m.outlet.id, orderId, 'READY').expect(200);
}

describe('configured preparation times', () => {
  it('lets the outlet’s manager set them (validated and audited), not POS or other managers', async () => {
    const res = await kitchen(manager, 'patch', `/items/${m.chai.id}`, { prepMinutes: 4 }).expect(
      200,
    );
    const chai = res.body.dishes.find((d: { id: string }) => d.id === m.chai.id);
    expect(chai).toMatchObject({ prepMinutes: 4, estimate: { minutes: 4, source: 'CONFIGURED' } });
    const puff = res.body.dishes.find((d: { id: string }) => d.id === m.puff.id);
    expect(puff.estimate).toEqual({ minutes: DEFAULT_PREP_MINUTES, source: 'DEFAULT' });
    for (const bad of [0, 181, 2.5, -3, 'five']) {
      await kitchen(manager, 'patch', `/items/${m.chai.id}`, { prepMinutes: bad }).expect(400);
    }
    await kitchen(manager, 'patch', `/items/${m.chai.id}`, {}).expect(400);
    await kitchen(cashier, 'patch', `/items/${m.chai.id}`, { prepMinutes: 9 }).expect(403);
    const other = await makeOutlet({ name: 'Juice Junction', status: 'OPEN' });
    const otherManager = await signIn('other.manager@example.com');
    await assign('other.manager@example.com', other.id, 'MANAGER');
    await kitchen(otherManager, 'patch', `/items/${m.chai.id}`, { prepMinutes: 9 }).expect(403);
    // An item from another outlet can't be edited through this outlet.
    const cat = await makeCategory(other.id, 'Drinks');
    const juice = await makeItem(other.id, cat.id, { name: 'Juice', pricePaise: 5000 });
    await kitchen(manager, 'patch', `/items/${juice.id}`, { prepMinutes: 3 }).expect(404);
    expect(await prisma.auditLog.count({ where: { action: 'MENU_PREP_TIME_UPDATED' } })).toBe(1);
    expect(
      (await prisma.menuItem.findUniqueOrThrow({ where: { id: m.chai.id } })).prepMinutes,
    ).toBe(4);
  });
});

describe('learning from real preparation times', () => {
  it('learns a dish only from single-dish single-unit orders, keeps the configured time, and calibrates the outlet', async () => {
    await kitchen(manager, 'patch', `/items/${m.chai.id}`, { prepMinutes: 4 }).expect(200);
    for (const minutes of [6, 6, 6, 6]) {
      const o = await order([{ id: m.chai.id, price: 2000 }]);
      await cook(o.id, minutes);
    }
    let view = (await kitchen(manager, 'get').expect(200)).body;
    let chai = view.dishes.find((d: { id: string }) => d.id === m.chai.id);
    expect(chai.history).toMatchObject({ observations: 4, emaMinutes: 6 });
    expect(chai.estimate.source).toBe('CONFIGURED'); // 4 observations: not enough yet

    const fifth = await order([{ id: m.chai.id, price: 2000 }]);
    await cook(fifth.id, 6);
    view = (await kitchen(manager, 'get').expect(200)).body;
    chai = view.dishes.find((d: { id: string }) => d.id === m.chai.id);
    expect(chai).toMatchObject({ prepMinutes: 4, estimate: { minutes: 6, source: 'HISTORY' } });

    // Two chai in one order, or chai + puff: no dish-level learning, outlet calibration only.
    const two = await order([{ id: m.chai.id, qty: 2, price: 2000 }]);
    await cook(two.id, 9);
    const mixed = await order([
      { id: m.chai.id, price: 2000 },
      { id: m.puff.id, price: 3500 },
    ]);
    await cook(mixed.id, 12);
    view = (await kitchen(manager, 'get').expect(200)).body;
    expect(view.dishes.find((d: { id: string }) => d.id === m.chai.id).history.observations).toBe(
      5,
    );
    expect(view.dishes.find((d: { id: string }) => d.id === m.puff.id).history).toBeNull();
    expect(view.calibration.observations).toBe(7);

    // An impossible timing (prep "started" after ready) is ignored.
    const odd = await order([{ id: m.chai.id, price: 2000 }]);
    await cook(odd.id, -5);
    view = (await kitchen(manager, 'get').expect(200)).body;
    expect(view.dishes.find((d: { id: string }) => d.id === m.chai.id).history.observations).toBe(
      5,
    );
    expect(
      (await prisma.menuItem.findUniqueOrThrow({ where: { id: m.chai.id } })).prepMinutes,
    ).toBe(4);
  });
});

describe('queue and tracking', () => {
  it('ranks active orders per outlet, excludes ready and cancelled orders, and tracks privately', async () => {
    await kitchen(manager, 'patch', `/items/${m.chai.id}`, { prepMinutes: 5 }).expect(200);
    const a = await order([{ id: m.chai.id, price: 2000 }]);
    const b = await order([{ id: m.chai.id, price: 2000 }]);
    const c = await order([{ id: m.chai.id, price: 2000 }]);
    // Another outlet's queue is separate.
    const other = await makeOutlet({ name: 'Juice Junction', status: 'OPEN' });
    const cat = await makeCategory(other.id, 'Drinks');
    const juice = await makeItem(other.id, cat.id, { name: 'Juice', pricePaise: 5000 });
    await order([{ id: juice.id, price: 5000 }]);

    const track = async (o: { id: string; agent: Agent }) =>
      (await api(o.agent, 'get', `/orders/${o.id}/tracking`).expect(200)).body.tracking;
    expect((await track(a)).estimate).toMatchObject({
      queuePosition: 1,
      ordersAhead: 0,
      awaitingAcceptance: true,
    });
    expect((await track(c)).estimate).toMatchObject({ queuePosition: 3, ordersAhead: 2 });

    await transition(cashier, m.outlet.id, a.id, 'ACCEPTED').expect(200);
    await transition(cashier, m.outlet.id, a.id, 'PREPARING').expect(200);
    await cancel(b.agent, b.id).expect(200);
    const cView = await track(c);
    expect(cView.estimate).toMatchObject({ queuePosition: 1, ordersAhead: 1 });
    const ready = new Date(cView.estimate.predictedReadyAt).getTime();
    expect(ready - Date.now()).toBeGreaterThan(8 * 60_000); // after a's 5 min + its own 5 min
    expect(ready - Date.now()).toBeLessThan(11 * 60_000);

    await transition(cashier, m.outlet.id, a.id, 'READY').expect(200);
    const aView = await track(a);
    expect(aView.estimate).toBeNull();
    expect(aView.readyAt).not.toBeNull();
    expect(aView.timeline.map((t: { status: string }) => t.status)).toEqual([
      'PLACED',
      'ACCEPTED',
      'PREPARING',
      'READY',
    ]);
    expect((await track(c)).estimate).toMatchObject({ queuePosition: 1, ordersAhead: 0 });

    // Staff see the same estimates on their board; other students can't track this order.
    const board = await api(cashier, 'get', `/staff/outlets/${m.outlet.id}/orders`).expect(200);
    expect(board.body.orders.find((o: { id: string }) => o.id === c.id).estimate).toMatchObject({
      queuePosition: 1,
    });
    const stranger = await student(`x${n}@example.com`, staffApp);
    await api(stranger, 'get', `/orders/${c.id}/tracking`).expect(404);
    await request(staffApp).get(`/api/v1/orders/${c.id}/tracking`).expect(401);
  });

  it('applies configuration changes to future estimates and tells students about big changes (at most twice)', async () => {
    await kitchen(manager, 'patch', `/items/${m.chai.id}`, { prepMinutes: 5 }).expect(200);
    const a = await order([{ id: m.chai.id, price: 2000 }]);
    await transition(cashier, m.outlet.id, a.id, 'ACCEPTED').expect(200);
    const before = await prisma.orderEstimate.findUniqueOrThrow({ where: { orderId: a.id } });
    await kitchen(manager, 'patch', `/items/${m.chai.id}`, { prepMinutes: 25 }).expect(200);
    const after = await prisma.orderEstimate.findUniqueOrThrow({ where: { orderId: a.id } });
    expect(
      after.predictedReadyAt.getTime() - before.predictedReadyAt.getTime(),
    ).toBeGreaterThanOrEqual(19 * 60_000);
    // Two kitchen places halve nothing for a single order, but parallel settings apply too.
    await kitchen(manager, 'put', '/settings', {
      kitchenParallelOrders: 2,
      autoAcceptMode: 'MANUAL',
      autoAcceptMaxWaitMinutes: 30,
    }).expect(200);
    await kitchen(manager, 'patch', `/items/${m.chai.id}`, { prepMinutes: 2 }).expect(200);
    await kitchen(manager, 'patch', `/items/${m.chai.id}`, { prepMinutes: 40 }).expect(200);
    const notices = await prisma.notification.findMany({ where: { type: 'ORDER_ETA_CHANGED' } });
    expect(notices).toHaveLength(2); // capped
    expect(notices[0]!.body).toMatch(/approximate/);
    expect(await prisma.auditLog.count({ where: { action: 'KITCHEN_SETTINGS_UPDATED' } })).toBe(1);
    await kitchen(manager, 'put', '/settings', {
      kitchenParallelOrders: 0,
      autoAcceptMode: 'MANUAL',
      autoAcceptMaxWaitMinutes: 30,
    }).expect(400);
    await kitchen(cashier, 'put', '/settings', {
      kitchenParallelOrders: 2,
      autoAcceptMode: 'AUTO',
      autoAcceptMaxWaitMinutes: 30,
    }).expect(403);
  });

  it('snapshots predictions at acceptance and preparation start, and scores them when ready', async () => {
    await kitchen(manager, 'patch', `/items/${m.chai.id}`, { prepMinutes: 5 }).expect(200);
    const o = await order([{ id: m.chai.id, price: 2000 }]);
    await cook(o.id, 7);
    const rows = await prisma.orderPrediction.findMany({
      where: { orderId: o.id },
      orderBy: { kind: 'asc' },
    });
    expect(rows.map((r) => r.kind)).toEqual(['AT_ACCEPT', 'AT_PREP_START']);
    expect(rows.every((r) => r.actualReadyAt !== null && r.absErrorSeconds !== null)).toBe(true);
    expect(rows[0]!.context).toMatchObject({ parallelOrders: 1, scheduled: false });
    // Recalculating again doesn't add rows.
    await recalculateOutlet(prisma, m.outlet.id);
    expect(await prisma.orderPrediction.count({ where: { orderId: o.id } })).toBe(2);
  });
});

describe('accuracy dashboard', () => {
  it('says when there isn’t enough data, then reports real errors only', async () => {
    const empty = await kitchen(manager, 'get', '/accuracy').expect(200);
    expect(empty.body.accuracy).toMatchObject({
      enoughData: false,
      prepStartToReady: { evaluated: 0, meanAbsErrorMinutes: null },
    });
    await kitchen(manager, 'patch', `/items/${m.chai.id}`, { prepMinutes: 5 }).expect(200);
    for (const minutes of [5, 7, 10]) {
      const o = await order([{ id: m.chai.id, price: 2000 }]);
      await cook(o.id, minutes);
    }
    // An order with a prediction but no outcome yet is not counted.
    const open = await order([{ id: m.chai.id, price: 2000 }]);
    await transition(cashier, m.outlet.id, open.id, 'ACCEPTED').expect(200);
    const res = (await kitchen(manager, 'get', '/accuracy?days=7').expect(200)).body.accuracy;
    expect(res.enoughData).toBe(true); // 3 at-accept + 3 at-prep-start evaluated
    expect(res.acceptToReady.evaluated).toBe(3);
    expect(res.prepStartToReady.evaluated).toBe(3);
    expect(res.prepStartToReady.meanAbsErrorMinutes).toBeGreaterThan(0);
    expect(res.perDay.length).toBeGreaterThan(0);
    await kitchen(cashier, 'get', '/accuracy').expect(403);
    await kitchen(manager, 'get', '/accuracy?days=500').expect(400);
  });
});
