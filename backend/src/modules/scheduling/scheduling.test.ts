import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { addToCart, fund, key, menu, post, student, type Agent } from '../../tests/commerce.js';
import { cancel, signIn, staffApp, staffFor, transition } from '../../tests/staff.js';
import { istDayOf } from './slots.js';

let m: Awaited<ReturnType<typeof menu>>;
let manager: Agent;
let cashier: Agent;
let s: Agent;

/** Pickup hours all day, every day, so slots exist whenever the tests run. */
const allDay = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  opensMinute: 0,
  closesMinute: 1440,
}));
const schedule = (agent: Agent, body: object) =>
  agent
    .put(`/api/v1/staff/outlets/${m.outlet.id}/schedule`)
    .set('X-Requested-With', 'CampusCart')
    .send(body);
const settings = (overrides: object = {}) => ({
  leadMinutes: 30,
  slotMinutes: 15,
  daysAhead: 2,
  slotCapacity: null,
  hours: allDay,
  ...overrides,
});

beforeEach(async () => {
  await resetDatabase();
  m = await menu(); // Chai ₹20, Puff ₹35, outlet OPEN
  ({ manager, cashier } = await staffFor(m.outlet.id));
  s = await student('student@example.com', staffApp);
  await schedule(manager, settings()).expect(200);
});

async function slots(slug = m.outlet.slug) {
  return (await request(staffApp).get(`/api/v1/outlets/${slug}/slots`).expect(200)).body as {
    feePaise: number;
    days: { date: string; slots: { startsAt: string; label: string; available: boolean }[] }[];
  };
}
/** A bookable slot about `hoursAhead` hours from now. */
async function slotAbout(hoursAhead = 2) {
  const all = (await slots()).days.flatMap((d) => d.slots);
  const target = Date.now() + hoursAhead * 3_600_000;
  return all.find((x) => Date.parse(x.startsAt) >= target)!.startsAt;
}
const order = (
  agent: Agent,
  body: {
    paymentMethod?: 'WALLET' | 'COUNTER';
    expectedTotalPaise: number;
    scheduledFor?: string | null;
    [k: string]: unknown;
  },
  idempotencyKey = key(),
) => post(agent, '/orders', { paymentMethod: 'WALLET', ...body }, idempotencyKey);
const debitOf = (orderId: string) =>
  prisma.walletTransaction.findFirstOrThrow({ where: { orderId, type: 'ORDER_DEBIT' } });

describe('pricing', () => {
  it('charges nothing extra for an order placed now — exactly as before', async () => {
    await fund(s, 50_000);
    await addToCart(s, m.chai.id, 2);
    const { body } = await order(s, { expectedTotalPaise: 4_000 }).expect(201);
    expect(body.order).toMatchObject({
      timing: 'IMMEDIATE',
      scheduledFor: null,
      scheduledFeePaise: 0,
      subtotalPaise: 4_000,
      totalPaise: 4_000,
    });
    expect((await debitOf(body.order.id)).amountPaise).toBe(4_000);
  });

  it('adds exactly ₹10 once per scheduled order, however many items, and charges that total', async () => {
    await fund(s, 50_000);
    const scheduledFor = await slotAbout();
    await addToCart(s, m.chai.id, 3);
    await addToCart(s, m.puff.id, 2);
    const { body } = await order(s, { expectedTotalPaise: 13_000 + 1_000, scheduledFor }).expect(
      201,
    );
    expect(body.order).toMatchObject({
      timing: 'SCHEDULED',
      scheduledFor,
      scheduledFeePaise: 1_000,
      subtotalPaise: 13_000,
      totalPaise: 14_000,
    });
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: body.order.id } });
    expect(stored.totalPaise).toBe(14_000);
    expect((await debitOf(body.order.id)).amountPaise).toBe(14_000);
    expect(await prisma.wallet.findFirstOrThrow()).toMatchObject({ balancePaise: 36_000 });
    // The pickup number belongs to the collection day.
    expect(stored.pickupDay.toISOString().slice(0, 10)).toBe(istDayOf(Date.parse(scheduledFor)));
  });

  it('works with loyalty points: the fee is added after the food discount', async () => {
    await fund(s, 100_000); // ₹1,000 recharge → 25 points
    const scheduledFor = await slotAbout();
    await addToCart(s, m.puff.id, 1); // ₹35
    const { body } = await order(s, {
      expectedTotalPaise: 3_500 - 2_000 + 1_000,
      scheduledFor,
      pointsToRedeem: 20,
    }).expect(201);
    expect(body.order).toMatchObject({
      pointsDiscountPaise: 2_000,
      scheduledFeePaise: 1_000,
      totalPaise: 2_500,
    });
  });

  it('ignores any fee the browser tries to set, and needs the total with the fee', async () => {
    const scheduledFor = await slotAbout();
    await addToCart(s, m.chai.id);
    await order(s, { expectedTotalPaise: 2_000, scheduledFor, scheduledFeePaise: 0 }).expect(400);
    const stale = await order(s, {
      paymentMethod: 'COUNTER',
      expectedTotalPaise: 2_000,
      scheduledFor,
    }).expect(409);
    expect(stale.body.error).toMatchObject({
      code: 'PRICE_CHANGED',
      details: { totalPaise: 3_000 },
    });
    expect(await prisma.order.count()).toBe(0);
  });

  it('charges the fee once even when the same checkout is retried', async () => {
    await fund(s, 50_000);
    const scheduledFor = await slotAbout();
    await addToCart(s, m.chai.id);
    const idempotencyKey = key();
    const body = { expectedTotalPaise: 3_000, scheduledFor };
    const results = await Promise.all([1, 2, 3].map(() => order(s, body, idempotencyKey)));
    expect(new Set(results.map((r) => r.body.order.id)).size).toBe(1);
    await order(s, body, idempotencyKey).expect(200);
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.walletTransaction.count({ where: { type: 'ORDER_DEBIT' } })).toBe(1);
    expect(await prisma.wallet.findFirstOrThrow()).toMatchObject({ balancePaise: 47_000 });
  });
});

describe('slot rules', () => {
  it('offers slots with the ₹10 fee only once the outlet sets pickup hours', async () => {
    const offered = await slots();
    expect(offered.feePaise).toBe(1_000);
    expect(offered.days.flatMap((d) => d.slots).length).toBeGreaterThan(0);
    expect(Date.parse(offered.days.flatMap((d) => d.slots)[0]!.startsAt)).toBeGreaterThanOrEqual(
      Date.now() + 30 * 60_000 - 1_000,
    );

    await schedule(manager, settings({ hours: [] })).expect(200);
    expect((await slots()).days).toEqual([]);
    await addToCart(s, m.chai.id);
    const res = await order(s, {
      paymentMethod: 'COUNTER',
      expectedTotalPaise: 3_000,
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    }).expect(409);
    expect(res.body.error.code).toBe('SCHEDULING_UNAVAILABLE');
  });

  it.each([
    ['in the past', () => new Date(Date.now() - 60_000).toISOString(), 'SLOT_IN_PAST'],
    [
      'without enough notice',
      () => new Date(Date.now() + 5 * 60_000).toISOString(),
      'SLOT_TOO_SOON',
    ],
    [
      'too many days ahead',
      () => new Date(Date.now() + 5 * 86_400_000).toISOString(),
      'SLOT_TOO_FAR',
    ],
  ])('refuses a time %s', async (_label, when, code) => {
    await addToCart(s, m.chai.id);
    const res = await order(s, {
      paymentMethod: 'COUNTER',
      expectedTotalPaise: 3_000,
      scheduledFor: when(),
    }).expect(409);
    expect(res.body.error.code).toBe(code);
    expect(await prisma.order.count()).toBe(0);
  });

  it('refuses a time that is not one of the slots, and malformed times', async () => {
    const valid = await slotAbout();
    await addToCart(s, m.chai.id);
    const offBoundary = new Date(Date.parse(valid) + 7 * 60_000).toISOString();
    expect(
      (
        await order(s, {
          paymentMethod: 'COUNTER',
          expectedTotalPaise: 3_000,
          scheduledFor: offBoundary,
        }).expect(409)
      ).body.error.code,
    ).toBe('INVALID_SLOT');
    await order(s, {
      paymentMethod: 'COUNTER',
      expectedTotalPaise: 3_000,
      scheduledFor: 'tomorrow noon',
    }).expect(400);
    await order(s, {
      paymentMethod: 'COUNTER',
      expectedTotalPaise: 3_000,
      scheduledFor: '2026-10-20T12:00:00',
    }).expect(400); // no timezone
  });

  it('refuses times outside the pickup hours', async () => {
    // Hours only 03:00–04:00 IST: a 2-hour-ahead slot is outside them unless it's 1–2 am now.
    await schedule(
      manager,
      settings({ hours: allDay.map((h) => ({ ...h, opensMinute: 180, closesMinute: 240 })) }),
    ).expect(200);
    const offered = (await slots()).days.flatMap((d) => d.slots);
    for (const slot of offered) {
      const local = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
      }).format(Date.parse(slot.startsAt));
      expect(local >= '03:00' && local < '04:00').toBe(true);
    }
  });

  it('a paused outlet takes no scheduled orders; a closed-for-now outlet still does', async () => {
    const scheduledFor = await slotAbout();
    await addToCart(s, m.chai.id);
    await prisma.outlet.update({ where: { id: m.outlet.id }, data: { status: 'PAUSED' } });
    expect((await slots()).days).toEqual([]);
    expect(
      (
        await order(s, {
          paymentMethod: 'COUNTER',
          expectedTotalPaise: 3_000,
          scheduledFor,
        }).expect(409)
      ).body.error.code,
    ).toBe('SCHEDULING_UNAVAILABLE');

    await prisma.outlet.update({ where: { id: m.outlet.id }, data: { status: 'CLOSED' } });
    expect(
      (await order(s, { paymentMethod: 'COUNTER', expectedTotalPaise: 2_000 }).expect(409)).body
        .error.code,
    ).toBe('OUTLET_NOT_ACCEPTING');
    await order(s, { paymentMethod: 'COUNTER', expectedTotalPaise: 3_000, scheduledFor }).expect(
      201,
    );
  });

  it('never overfills a slot, even with orders arriving together', async () => {
    await schedule(manager, settings({ slotCapacity: 2 })).expect(200);
    const scheduledFor = await slotAbout();
    const buyers = await Promise.all(
      [1, 2, 3, 4].map((n) => student(`slot${n}@example.com`, staffApp)),
    );
    for (const b of buyers) await addToCart(b, m.chai.id);
    const results = await Promise.all(
      buyers.map((b) =>
        order(b, { paymentMethod: 'COUNTER', expectedTotalPaise: 3_000, scheduledFor }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    for (const r of results.filter((x) => x.status !== 201))
      expect(r.body.error.code).toBe('SLOT_FULL');
    const slot = (await slots()).days
      .flatMap((d) => d.slots)
      .find((x) => x.startsAt === scheduledFor)!;
    expect(slot.available).toBe(false);
  });
});

describe('staff', () => {
  it('lists scheduled orders with their slot and fee, filters them, and orders the queue by due time', async () => {
    const later = await slotAbout(5);
    const sooner = await slotAbout(2);
    await addToCart(s, m.chai.id);
    const a = (
      await order(s, {
        paymentMethod: 'COUNTER',
        expectedTotalPaise: 3_000,
        scheduledFor: later,
      }).expect(201)
    ).body.order;
    await addToCart(s, m.chai.id);
    const b = (
      await order(s, {
        paymentMethod: 'COUNTER',
        expectedTotalPaise: 3_000,
        scheduledFor: sooner,
      }).expect(201)
    ).body.order;
    await addToCart(s, m.chai.id);
    const now = (
      await order(s, { paymentMethod: 'COUNTER', expectedTotalPaise: 2_000 }).expect(201)
    ).body.order;

    const queue = (await cashier.get(`/api/v1/staff/outlets/${m.outlet.id}/orders`).expect(200))
      .body.orders;
    expect(queue.map((o: { id: string }) => o.id)).toEqual([now.id, b.id, a.id]);
    expect(queue[1]).toMatchObject({
      timing: 'SCHEDULED',
      scheduledFor: sooner,
      scheduledFeePaise: 1_000,
      totalPaise: 3_000,
    });

    const scheduledOnly = (
      await manager.get(`/api/v1/staff/outlets/${m.outlet.id}/orders?timing=SCHEDULED`).expect(200)
    ).body.orders;
    expect(scheduledOnly.map((o: { id: string }) => o.id)).toEqual([b.id, a.id]);
    const nowOnly = (
      await manager.get(`/api/v1/staff/outlets/${m.outlet.id}/orders?timing=IMMEDIATE`).expect(200)
    ).body.orders;
    expect(nowOnly.map((o: { id: string }) => o.id)).toEqual([now.id]);

    await prisma.order.update({
      where: { id: a.id },
      data: { scheduledFor: new Date(Date.now() - 60_000) },
    });
    const pastDue = (
      await manager.get(`/api/v1/staff/outlets/${m.outlet.id}/orders?due=past_due`).expect(200)
    ).body.orders;
    expect(pastDue.map((o: { id: string }) => o.id)).toEqual([a.id]);
    const upcoming = (
      await manager.get(`/api/v1/staff/outlets/${m.outlet.id}/orders?due=upcoming`).expect(200)
    ).body.orders;
    expect(upcoming.map((o: { id: string }) => o.id)).toEqual([b.id]);
  });

  it('accepts a scheduled order early but won’t start preparing it before its lead time', async () => {
    const scheduledFor = await slotAbout(3);
    await addToCart(s, m.chai.id);
    const placed = (
      await order(s, { paymentMethod: 'COUNTER', expectedTotalPaise: 3_000, scheduledFor }).expect(
        201,
      )
    ).body.order;
    await transition(cashier, m.outlet.id, placed.id, 'ACCEPTED').expect(200);
    const early = await transition(cashier, m.outlet.id, placed.id, 'PREPARING').expect(409);
    expect(early.body.error.code).toBe('TOO_EARLY_TO_PREPARE');
    expect(Date.parse(early.body.error.details.canStartAt)).toBe(
      Date.parse(scheduledFor) - 30 * 60_000,
    );

    // When the slot is close, preparation can start; nothing is completed automatically.
    await prisma.order.update({
      where: { id: placed.id },
      data: { scheduledFor: new Date(Date.now() + 10 * 60_000) },
    });
    await transition(cashier, m.outlet.id, placed.id, 'PREPARING').expect(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.id } })).status).toBe(
      'PREPARING',
    );
  });

  it('lets the manager set pickup hours, with validation; POS staff can only read them', async () => {
    await schedule(manager, settings({ slotMinutes: 3 })).expect(400);
    await schedule(
      manager,
      settings({ hours: [{ weekday: 1, opensMinute: 600, closesMinute: 540 }] }),
    ).expect(400);
    await schedule(
      manager,
      settings({
        hours: [
          { weekday: 1, opensMinute: 540, closesMinute: 600 },
          { weekday: 1, opensMinute: 700, closesMinute: 800 },
        ],
      }),
    ).expect(400);
    await schedule(cashier, settings()).expect(403);
    await schedule(s, settings()).expect(403);
    const read = await cashier.get(`/api/v1/staff/outlets/${m.outlet.id}/schedule`).expect(200);
    expect(read.body.schedule).toMatchObject({
      leadMinutes: 30,
      slotMinutes: 15,
      daysAhead: 2,
      slotCapacity: null,
    });
    expect(read.body.schedule.hours).toHaveLength(7);
    expect(await prisma.auditLog.count({ where: { action: 'OUTLET_SCHEDULE_UPDATED' } })).toBe(1);
  });
});

describe('stock, cancellation and rescheduling', () => {
  it('takes stock when a scheduled order is placed and gives it back on cancel, once', async () => {
    await post(manager, `/staff/outlets/${m.outlet.id}/inventory/${m.chai.id}/tracking`, {
      enabled: true,
      quantity: 3,
    }).expect(200);
    await fund(s, 50_000);
    const scheduledFor = await slotAbout();
    await addToCart(s, m.chai.id, 2);
    const placed = (await order(s, { expectedTotalPaise: 5_000, scheduledFor }).expect(201)).body
      .order;
    expect(
      (await prisma.menuItem.findUniqueOrThrow({ where: { id: m.chai.id } })).stockQuantity,
    ).toBe(1);

    const other = await student('other@example.com', staffApp);
    await addToCart(other, m.chai.id);
    await post(other, '/cart/items', { menuItemId: m.chai.id }).expect(409); // only 1 left

    await cancel(s, placed.id).expect(200);
    await cancel(s, placed.id).expect(409);
    expect(
      (await prisma.menuItem.findUniqueOrThrow({ where: { id: m.chai.id } })).stockQuantity,
    ).toBe(3);
  });

  it('refunds the food but keeps the ₹10 fee when a scheduled wallet order is rejected', async () => {
    await fund(s, 50_000);
    const scheduledFor = await slotAbout();
    await addToCart(s, m.chai.id);
    const placed = (await order(s, { expectedTotalPaise: 3_000, scheduledFor }).expect(201)).body
      .order;
    expect(placed.refundPaise).toBe(2_000); // shown before anyone cancels
    const rejected = await transition(
      manager,
      m.outlet.id,
      placed.id,
      'REJECTED',
      'Kitchen closed',
    ).expect(200);
    expect(rejected.body.order).toMatchObject({ paymentStatus: 'REFUNDED', refundPaise: 2_000 });
    const refund = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: placed.id, type: 'REFUND' },
    });
    expect(refund.amountPaise).toBe(2_000);
    expect(refund.description).toContain('₹10 scheduled-order fee not refunded');
    expect(await prisma.wallet.findFirstOrThrow()).toMatchObject({ balancePaise: 49_000 });
  });

  it('keeps the fee when the student cancels too, and refunds exactly once', async () => {
    await fund(s, 50_000);
    const scheduledFor = await slotAbout();
    await addToCart(s, m.chai.id, 2);
    const placed = (await order(s, { expectedTotalPaise: 5_000, scheduledFor }).expect(201)).body
      .order;
    await cancel(s, placed.id).expect(200);
    await cancel(s, placed.id).expect(409);
    const refunds = await prisma.walletTransaction.findMany({
      where: { orderId: placed.id, type: 'REFUND' },
    });
    expect(refunds.map((r) => r.amountPaise)).toEqual([4_000]);
    expect(await prisma.wallet.findFirstOrThrow()).toMatchObject({ balancePaise: 49_000 });
  });

  it('still refunds orders placed for now in full', async () => {
    await fund(s, 50_000);
    await addToCart(s, m.chai.id);
    const placed = (await order(s, { expectedTotalPaise: 2_000 }).expect(201)).body.order;
    expect(placed.refundPaise).toBe(2_000);
    await cancel(s, placed.id).expect(200);
    expect(await prisma.wallet.findFirstOrThrow()).toMatchObject({ balancePaise: 50_000 });
  });

  it('lets the student move a placed scheduled order to another slot without paying again', async () => {
    await fund(s, 50_000);
    const first = await slotAbout(2);
    const second = await slotAbout(4);
    await addToCart(s, m.chai.id);
    const placed = (await order(s, { expectedTotalPaise: 3_000, scheduledFor: first }).expect(201))
      .body.order;
    const moved = await post(s, `/orders/${placed.id}/reschedule`, { scheduledFor: second }).expect(
      200,
    );
    expect(moved.body.order).toMatchObject({
      scheduledFor: second,
      scheduledFeePaise: 1_000,
      totalPaise: 3_000,
      version: 2,
    });
    const again = await post(s, `/orders/${placed.id}/reschedule`, { scheduledFor: second }).expect(
      200,
    );
    expect(again.body.order.version).toBe(2); // same slot: nothing changes
    expect(await prisma.walletTransaction.count({ where: { type: 'ORDER_DEBIT' } })).toBe(1);

    await post(s, `/orders/${placed.id}/reschedule`, {
      scheduledFor: new Date(Date.now() - 1).toISOString(),
    }).expect(409);
    const someone = await signIn('someone@example.com');
    await post(someone, `/orders/${placed.id}/reschedule`, { scheduledFor: first }).expect(404);

    await transition(cashier, m.outlet.id, placed.id, 'ACCEPTED').expect(200);
    const late = await post(s, `/orders/${placed.id}/reschedule`, { scheduledFor: first }).expect(
      409,
    );
    expect(late.body.error.code).toBe('TOO_LATE_TO_RESCHEDULE');
  });

  it('won’t reschedule an order placed for now', async () => {
    await addToCart(s, m.chai.id);
    const placed = (
      await order(s, { paymentMethod: 'COUNTER', expectedTotalPaise: 2_000 }).expect(201)
    ).body.order;
    const res = await post(s, `/orders/${placed.id}/reschedule`, {
      scheduledFor: await slotAbout(),
    }).expect(409);
    expect(res.body.error.code).toBe('NOT_SCHEDULED');
  });
});
