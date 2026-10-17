import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import {
  addToCart,
  fund,
  key,
  menu,
  placeOrder,
  post,
  student,
  type Agent,
} from '../../tests/commerce.js';
import { makeCategory, makeItem, makeOutlet } from '../../tests/fixtures.js';
import { staffFor, transition } from '../../tests/staff.js';
import { CAPACITY_FULL_MESSAGE, ORDER_CAPACITY_WINDOW_SECONDS } from './capacity.rules.js';

let m: Awaited<ReturnType<typeof menu>>;
let n = 0;

beforeEach(async () => {
  await resetDatabase();
  m = await menu(); // Night Owl Café: Chai ₹20, Puff ₹35
});

/** A fresh student who puts one chai from `itemId`'s outlet in their cart. */
async function shopperWith(itemId = m.chai.id) {
  n += 1;
  const agent = await student(`cap${n}@example.com`);
  await addToCart(agent, itemId);
  return agent;
}

/** Places `count` counter orders at the outlet, one per student. */
async function fill(count: number, itemId = m.chai.id) {
  for (let i = 0; i < count; i += 1) {
    await placeOrder(await shopperWith(itemId), 'COUNTER', 2000).expect(201);
  }
}

const counted = (outletId = m.outlet.id) =>
  prisma.outletOrderAcceptance.count({ where: { outletId } });

/** Moves every counted order of the outlet `seconds` into the past. */
const age = (seconds: number, outletId = m.outlet.id) =>
  prisma.$executeRaw`UPDATE "OutletOrderAcceptance"
    SET "acceptedAt" = "acceptedAt" - make_interval(secs => ${seconds})
    WHERE "outletId" = ${outletId}::uuid`;

describe('10 orders per outlet per rolling 3 minutes', () => {
  it('accepts 10 orders and refuses the 11th with 429, a retry time and the cart kept', async () => {
    await fill(10);
    expect(await counted()).toBe(10);

    const eleventh = await shopperWith();
    await fund(eleventh, 10_000);
    const res = await placeOrder(eleventh, 'WALLET', 2000).expect(429);
    expect(res.body.error).toMatchObject({
      code: 'ORDER_CAPACITY_FULL',
      message: CAPACITY_FULL_MESSAGE,
    });
    const { retryAt, retryAfterSeconds } = res.body.error.details;
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(retryAfterSeconds).toBeLessThanOrEqual(ORDER_CAPACITY_WINDOW_SECONDS);
    expect(Number(res.headers['retry-after'])).toBe(retryAfterSeconds);
    // Room opens when the earliest counted order leaves the window.
    const earliest = await prisma.outletOrderAcceptance.findFirstOrThrow({
      orderBy: { acceptedAt: 'asc' },
    });
    expect(new Date(retryAt).getTime()).toBe(
      earliest.acceptedAt.getTime() + ORDER_CAPACITY_WINDOW_SECONDS * 1000,
    );

    // Nothing created or charged; the cart is intact; nothing counted.
    expect(await prisma.order.count()).toBe(10);
    expect(await prisma.walletTransaction.count({ where: { type: 'ORDER_DEBIT' } })).toBe(0);
    expect((await eleventh.get('/api/v1/wallet').expect(200)).body.wallet.balancePaise).toBe(
      10_000,
    );
    const cart = (await eleventh.get('/api/v1/cart').expect(200)).body.cart;
    expect(cart.items).toEqual([expect.objectContaining({ menuItemId: m.chai.id, quantity: 1 })]);
    expect(await counted()).toBe(10);
  });

  it('keeps each outlet’s capacity separate', async () => {
    const other = await makeOutlet({ name: 'Canteen', status: 'OPEN' });
    const cat = await makeCategory(other.id, 'Meals');
    const thali = await makeItem(other.id, cat.id, { name: 'Thali', pricePaise: 2000 });

    await fill(10);
    await placeOrder(await shopperWith(), 'COUNTER', 2000).expect(429);
    // Outlet B is unaffected by A being full, and B's orders don't use A's capacity.
    await fill(4, thali.id);
    expect(await counted(other.id)).toBe(4);
    expect(await counted()).toBe(10);
    await fill(6, thali.id);
    await placeOrder(await shopperWith(thali.id), 'COUNTER', 2000).expect(429);
  });

  it('frees capacity as earlier orders leave the rolling window', async () => {
    await fill(5);
    await age(150); // five orders 2½ minutes ago
    await fill(5); // five just now
    await placeOrder(await shopperWith(), 'COUNTER', 2000).expect(429);

    await age(31); // the first five are now 3 min 1 s old, the rest 31 s old
    await fill(5);
    await placeOrder(await shopperWith(), 'COUNTER', 2000).expect(429);
    expect(await prisma.order.count()).toBe(15);
  });

  it('never lets concurrent checkouts exceed the limit', async () => {
    await fill(3);
    const shoppers = await Promise.all(Array.from({ length: 12 }, () => shopperWith()));
    const results = await Promise.all(shoppers.map((agent) => placeOrder(agent, 'COUNTER', 2000)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(7);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    expect(await prisma.order.count()).toBe(10);
    expect(await counted()).toBe(10);
  });

  it('does not count duplicate retries of the same checkout', async () => {
    await fill(9);
    const agent = await shopperWith();
    await fund(agent, 10_000);
    const idempotencyKey = key();
    const [a, b] = await Promise.all([
      placeOrder(agent, 'WALLET', 2000, idempotencyKey),
      placeOrder(agent, 'WALLET', 2000, idempotencyKey),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.order.id).toBe(b.body.order.id);
    await placeOrder(agent, 'WALLET', 2000, idempotencyKey).expect(200);
    // One order, one debit, one unit of capacity: the 10th place is still the last one.
    expect(await counted()).toBe(10);
    expect(await prisma.walletTransaction.count({ where: { type: 'ORDER_DEBIT' } })).toBe(1);
    await placeOrder(await shopperWith(), 'COUNTER', 2000).expect(429);
  });

  it('does not count failed checkouts', async () => {
    await fill(9);
    const broke = await shopperWith();
    await placeOrder(broke, 'WALLET', 2000).expect(409); // no wallet funds
    await placeOrder(broke, 'COUNTER', 9999).expect(409); // stale total
    expect(await counted()).toBe(9);
    await placeOrder(broke, 'COUNTER', 2000).expect(201);
    expect(await counted()).toBe(10);
  });
});

describe('lifecycle and scheduled orders', () => {
  const allDay = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    opensMinute: 0,
    closesMinute: 1440,
  }));

  async function enableScheduling() {
    const staff = await staffFor(m.outlet.id);
    await staff.manager
      .put(`/api/v1/staff/outlets/${m.outlet.id}/schedule`)
      .set('X-Requested-With', 'CampusCart')
      .send({ leadMinutes: 30, slotMinutes: 15, daysAhead: 2, slotCapacity: null, hours: allDay })
      .expect(200);
    return staff;
  }

  async function scheduledOrder(agent: Agent, status: number) {
    const { body: slots } = await agent.get(`/api/v1/outlets/${m.outlet.slug}/slots`).expect(200);
    const scheduledFor = slots.days[0].slots[0].startsAt as string;
    await addToCart(agent, m.chai.id);
    return post(
      agent,
      '/orders',
      { paymentMethod: 'COUNTER', expectedTotalPaise: 3000, scheduledFor },
      key(),
    ).expect(status);
  }

  it('counts a scheduled order once, when it is placed, alongside immediate orders', async () => {
    await enableScheduling();
    await fill(5);
    for (let i = 0; i < 5; i += 1) {
      n += 1;
      await scheduledOrder(await student(`sched${n}@example.com`), 201);
    }
    expect(await counted()).toBe(10);
    n += 1;
    const late = await student(`sched${n}@example.com`);
    const res = await scheduledOrder(late, 429);
    expect(res.body.error.code).toBe('ORDER_CAPACITY_FULL');
    expect(await prisma.order.count({ where: { timing: 'SCHEDULED' } })).toBe(5);
  });

  it('does not count an order again when staff move it along or it is rescheduled', async () => {
    const { cashier } = await enableScheduling();
    n += 1;
    const agent = await student(`life${n}@example.com`);
    const { body } = await scheduledOrder(agent, 201);
    const { body: slots } = await agent.get(`/api/v1/outlets/${m.outlet.slug}/slots`).expect(200);
    await post(agent, `/orders/${body.order.id}/reschedule`, {
      scheduledFor: slots.days[0].slots[1].startsAt,
    }).expect(200);
    await prisma.order.update({
      where: { id: body.order.id },
      data: { scheduledFor: new Date(Date.now() + 5 * 60_000) },
    });
    for (const to of ['ACCEPTED', 'PREPARING', 'READY']) {
      await transition(cashier, m.outlet.id, body.order.id, to).expect(200);
    }
    expect(await counted()).toBe(1);
  });

  it('keeps a rejected order counted (the outlet already took it on), but only once', async () => {
    await fill(1);
    const order = await prisma.order.findFirstOrThrow();
    const { manager } = await staffFor(m.outlet.id);
    await transition(manager, m.outlet.id, order.id, 'REJECTED', 'Out of milk').expect(200);
    expect(await counted()).toBe(1);
  });
});
