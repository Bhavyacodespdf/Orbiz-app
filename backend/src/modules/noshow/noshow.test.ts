import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { addToCart, fund, key, menu, post, student, type Agent } from '../../tests/commerce.js';
import { signIn, staffApp, staffFor, transition } from '../../tests/staff.js';
import { processDueNoShows, processNoShow } from './noshow.service.js';
import { startNoShowWorker } from './noshow.worker.js';
import { noopPublisher } from '../../realtime/publisher.js';

let m: Awaited<ReturnType<typeof menu>>;
let manager: Agent;
let cashier: Agent;
let s: Agent;

const allDay = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  opensMinute: 0,
  closesMinute: 1440,
}));
const send = (agent: Agent, method: 'patch' | 'put' | 'post', url: string, body: object) =>
  agent[method](`/api/v1${url}`).set('X-Requested-With', 'CampusCart').send(body);

beforeEach(async () => {
  await resetDatabase();
  m = await menu(); // Chai ₹20, Puff ₹35
  ({ manager, cashier } = await staffFor(m.outlet.id));
  s = await student('student@example.com', staffApp);
  await send(manager, 'put', `/staff/outlets/${m.outlet.id}/schedule`, {
    leadMinutes: 30,
    slotMinutes: 15,
    daysAhead: 2,
    slotCapacity: null,
    hours: allDay,
  }).expect(200);
  // Classified by the manager (never guessed): puffs are packaged, chai is made fresh.
  await send(manager, 'patch', `/staff/outlets/${m.outlet.id}/items/${m.puff.id}`, {
    fulfillmentType: 'PACKAGED',
  }).expect(200);
  await send(manager, 'patch', `/staff/outlets/${m.outlet.id}/items/${m.chai.id}`, {
    fulfillmentType: 'HANDMADE',
  }).expect(200);
  for (const item of [m.puff, m.chai]) {
    await send(manager, 'post', `/staff/outlets/${m.outlet.id}/inventory/${item.id}/tracking`, {
      enabled: true,
      quantity: 10,
    }).expect(200);
  }
});

async function firstSlot() {
  const { body } = await s.get(`/api/v1/outlets/${m.outlet.slug}/slots`).expect(200);
  return body.days.flatMap((d: { slots: { startsAt: string }[] }) => d.slots)[0].startsAt as string;
}

/** Places a scheduled order, then walks it to READY as the kitchen would. */
async function readyScheduledOrder(
  lines: [string, number][],
  opts: { method?: 'WALLET' | 'COUNTER'; points?: number; agent?: Agent } = {},
) {
  const agent = opts.agent ?? s;
  const scheduledFor = await firstSlot();
  let food = 0;
  for (const [id, qty] of lines) {
    await post(agent, '/cart/items', { menuItemId: id, quantity: qty }).expect(200);
    food += (id === m.puff.id ? 3_500 : 2_000) * qty;
  }
  const expected = food - (opts.points ?? 0) * 100 + 1_000;
  const { body } = await post(
    agent,
    '/orders',
    {
      paymentMethod: opts.method ?? 'WALLET',
      expectedTotalPaise: expected,
      scheduledFor,
      pointsToRedeem: opts.points ?? 0,
    },
    key(),
  ).expect(201);
  // Bring the slot close so the kitchen may start, then make it ready.
  await prisma.order.update({
    where: { id: body.order.id },
    data: { scheduledFor: new Date(Date.now() + 5 * 60_000) },
  });
  for (const to of ['ACCEPTED', 'PREPARING', 'READY']) {
    await transition(cashier, m.outlet.id, body.order.id, to).expect(200);
  }
  return body.order as { id: string; totalPaise: number };
}

const minutesAgo = (orderId: string, minutes: number) =>
  prisma.order.update({
    where: { id: orderId },
    data: { scheduledFor: new Date(Date.now() - minutes * 60_000) },
  });
const stockOf = async (id: string) =>
  (await prisma.menuItem.findUniqueOrThrow({ where: { id } })).stockQuantity;
const balance = async () =>
  (await prisma.wallet.findFirstOrThrow({ where: { user: { email: 'student@example.com' } } }))
    .balancePaise;
const orderRow = (id: string) =>
  prisma.order.findUniqueOrThrow({ where: { id }, include: { items: true, noShow: true } });

describe('the grace period', () => {
  it('does nothing within 10 minutes, and nothing once the order is collected', async () => {
    await fund(s, 50_000);
    const order = await readyScheduledOrder([[m.puff.id, 1]]);
    await minutesAgo(order.id, 9);
    expect(await processDueNoShows(prisma)).toEqual({ processed: 0, failed: 0 });

    await transition(cashier, m.outlet.id, order.id, 'COMPLETED').expect(200);
    await minutesAgo(order.id, 30);
    expect(await processDueNoShows(prisma)).toEqual({ processed: 0, failed: 0 });
    expect((await orderRow(order.id)).status).toBe('COMPLETED');
    expect(await prisma.walletTransaction.count({ where: { type: 'REFUND' } })).toBe(0);
  });

  it('settles an uncollected order once the deadline has passed', async () => {
    await fund(s, 50_000);
    const order = await readyScheduledOrder([[m.puff.id, 1]]);
    await minutesAgo(order.id, 11);
    expect(await processDueNoShows(prisma)).toEqual({ processed: 1, failed: 0 });
    const row = await orderRow(order.id);
    expect(row.status).toBe('NO_SHOW');
    expect(row.noShow).toMatchObject({ status: 'PROCESSED', attempts: 1 });
    const history = await prisma.orderStatusHistory.findFirstOrThrow({
      where: { orderId: order.id, toStatus: 'NO_SHOW' },
    });
    expect(history).toMatchObject({ fromStatus: 'READY', actorUserId: null });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'ORDER_NO_SHOW_PROCESSED' },
    });
    expect(audit.actorType).toBe('SYSTEM');
  });

  it('leaves orders the kitchen never made ready, and immediate orders, alone', async () => {
    await fund(s, 50_000);
    const scheduledFor = await firstSlot();
    await addToCart(s, m.puff.id);
    const placed = (
      await post(
        s,
        '/orders',
        { paymentMethod: 'WALLET', expectedTotalPaise: 4_500, scheduledFor },
        key(),
      ).expect(201)
    ).body.order;
    await minutesAgo(placed.id, 60); // still PLACED: needs staff attention, not a student no-show

    await addToCart(s, m.puff.id);
    const now = (
      await post(
        s,
        '/orders',
        { paymentMethod: 'WALLET', expectedTotalPaise: 3_500 },
        key(),
      ).expect(201)
    ).body.order;
    for (const to of ['ACCEPTED', 'PREPARING', 'READY'])
      await transition(cashier, m.outlet.id, now.id, to).expect(200);
    await prisma.order.update({
      where: { id: now.id },
      data: { placedAt: new Date(Date.now() - 3_600_000) },
    });

    expect(await processDueNoShows(prisma)).toEqual({ processed: 0, failed: 0 });
    expect((await orderRow(placed.id)).status).toBe('PLACED');
    expect((await orderRow(now.id)).status).toBe('READY');
  });
});

describe('packaged food', () => {
  it('refunds 90% of what was paid, keeps 10% and the ₹10 fee, and restocks', async () => {
    await fund(s, 50_000);
    const order = await readyScheduledOrder([[m.puff.id, 2]]); // ₹70 food + ₹10 fee = ₹80
    expect(await stockOf(m.puff.id)).toBe(8);
    expect(await balance()).toBe(42_000);
    await minutesAgo(order.id, 11);
    await processDueNoShows(prisma);

    const row = await orderRow(order.id);
    expect(row).toMatchObject({ status: 'NO_SHOW', paymentStatus: 'PARTIALLY_REFUNDED' });
    expect(row.noShow).toMatchObject({
      refundPaise: 6_300,
      convenienceFeePaise: 700,
      scheduledFeeRetainedPaise: 1_000,
      restockedUnits: 2,
    });
    expect(row.items[0]).toMatchObject({
      fulfillmentType: 'PACKAGED',
      noShowPaidPaise: 7_000,
      noShowRefundPaise: 6_300,
      noShowFeePaise: 700,
      noShowRestockedQty: 2,
    });
    expect(await balance()).toBe(48_300);
    const refund = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, type: 'REFUND' },
    });
    expect(refund).toMatchObject({
      amountPaise: 6_300,
      idempotencyKey: `noshow-refund:${order.id}`,
      status: 'COMPLETED',
    });
    expect(row.noShow!.refundTransactionId).toBe(refund.id);

    expect(await stockOf(m.puff.id)).toBe(10);
    const restock = await prisma.stockAdjustment.findFirstOrThrow({
      where: { orderId: order.id, type: 'ORDER_RESTORE' },
    });
    expect(restock).toMatchObject({ quantityChange: 2, reason: 'SCHEDULED_ORDER_NO_SHOW' });

    const view = (await s.get(`/api/v1/orders/${order.id}`).expect(200)).body.order;
    expect(view).toMatchObject({
      status: 'NO_SHOW',
      noShow: {
        status: 'PROCESSED',
        refundPaise: 6_300,
        convenienceFeePaise: 700,
        scheduledFeeRetainedPaise: 1_000,
      },
    });
    expect(view.noShow).not.toHaveProperty('lastError');
  });

  it('refunds but never restocks an item staff marked not resellable', async () => {
    await fund(s, 50_000);
    const order = await readyScheduledOrder([[m.puff.id, 2]]);
    await send(
      cashier,
      'post',
      `/staff/outlets/${m.outlet.id}/orders/${order.id}/items/${m.puff.id}/not-resellable`,
      {
        reason: 'Packet opened',
      },
    ).expect(200);
    await minutesAgo(order.id, 11);
    await processDueNoShows(prisma);
    const row = await orderRow(order.id);
    expect(row.noShow).toMatchObject({ refundPaise: 6_300, restockedUnits: 0 });
    expect(await stockOf(m.puff.id)).toBe(8);
  });

  it('uses the classification the order was placed with, not a later change', async () => {
    await fund(s, 50_000);
    const order = await readyScheduledOrder([[m.puff.id, 1]]);
    await send(manager, 'patch', `/staff/outlets/${m.outlet.id}/items/${m.puff.id}`, {
      fulfillmentType: 'HANDMADE',
    }).expect(200);
    await minutesAgo(order.id, 11);
    await processDueNoShows(prisma);
    expect((await orderRow(order.id)).noShow!.refundPaise).toBe(3_150);
  });
});

describe('handmade food', () => {
  it('gets no refund and is never restocked', async () => {
    await fund(s, 50_000);
    const order = await readyScheduledOrder([[m.chai.id, 2]]);
    expect(await stockOf(m.chai.id)).toBe(8);
    await minutesAgo(order.id, 11);
    await processDueNoShows(prisma);
    const row = await orderRow(order.id);
    expect(row).toMatchObject({ status: 'NO_SHOW', paymentStatus: 'PAID' });
    expect(row.noShow).toMatchObject({ refundPaise: 0, convenienceFeePaise: 0, restockedUnits: 0 });
    expect(row.items[0]).toMatchObject({
      noShowPaidPaise: 4_000,
      noShowRefundPaise: 0,
      noShowRestockedQty: 0,
    });
    expect(await prisma.walletTransaction.count({ where: { type: 'REFUND' } })).toBe(0);
    expect(await stockOf(m.chai.id)).toBe(8);
    await expect(
      send(
        cashier,
        'post',
        `/staff/outlets/${m.outlet.id}/orders/${order.id}/items/${m.chai.id}/not-resellable`,
        { reason: 'x x x' },
      ),
    ).resolves.toMatchObject({ status: 409 });
  });

  it('treats an unclassified item as handmade', async () => {
    await prisma.menuItem.update({ where: { id: m.puff.id }, data: { fulfillmentType: null } });
    await fund(s, 50_000);
    const order = await readyScheduledOrder([[m.puff.id, 1]]);
    await minutesAgo(order.id, 11);
    await processDueNoShows(prisma);
    expect((await orderRow(order.id)).noShow).toMatchObject({ refundPaise: 0, restockedUnits: 0 });
  });
});

describe('mixed orders', () => {
  it('settles each line on its own, with the points discount spread across lines', async () => {
    await fund(s, 100_000); // ₹1,000 recharge earns 25 points
    // Puff ₹35 (packaged) + 2 chai ₹40 (handmade) = ₹75 food; 20 points (₹20) off; + ₹10 fee.
    const order = await readyScheduledOrder(
      [
        [m.puff.id, 1],
        [m.chai.id, 2],
      ],
      { points: 20 },
    );
    expect(order.totalPaise).toBe(6_500);
    await minutesAgo(order.id, 11);
    await processDueNoShows(prisma);

    const row = await orderRow(order.id);
    const puff = row.items.find((i) => i.menuItemId === m.puff.id)!;
    const chai = row.items.find((i) => i.menuItemId === m.chai.id)!;
    // ₹20 discount split 9.33 / 10.67 → 933 / 1067 paise.
    expect(puff).toMatchObject({
      noShowPaidPaise: 2_567,
      noShowRefundPaise: 2_310,
      noShowFeePaise: 257,
      noShowRestockedQty: 1,
    });
    expect(chai).toMatchObject({
      noShowPaidPaise: 2_933,
      noShowRefundPaise: 0,
      noShowRestockedQty: 0,
    });
    expect(puff.noShowPaidPaise! + chai.noShowPaidPaise!).toBe(6_500 - 1_000); // all food money, no fee
    expect(row.noShow).toMatchObject({
      refundPaise: 2_310,
      convenienceFeePaise: 257,
      scheduledFeeRetainedPaise: 1_000,
    });
    expect(await stockOf(m.puff.id)).toBe(10);
    expect(await stockOf(m.chai.id)).toBe(8);
  });

  it('refunds nothing for an unpaid counter order, but still restocks packaged food', async () => {
    const order = await readyScheduledOrder(
      [
        [m.puff.id, 1],
        [m.chai.id, 1],
      ],
      { method: 'COUNTER' },
    );
    await minutesAgo(order.id, 11);
    await processDueNoShows(prisma);
    const row = await orderRow(order.id);
    expect(row).toMatchObject({ status: 'NO_SHOW', paymentStatus: 'VOID' });
    expect(row.noShow).toMatchObject({ refundPaise: 0, convenienceFeePaise: 0, restockedUnits: 1 });
    expect(await stockOf(m.puff.id)).toBe(10);
    expect(await stockOf(m.chai.id)).toBe(9);
  });

  it('leaves a counter order that was already paid in cash for staff, untouched', async () => {
    const order = await readyScheduledOrder([[m.puff.id, 1]], { method: 'COUNTER' });
    await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } });
    await minutesAgo(order.id, 11);
    expect(await processDueNoShows(prisma)).toEqual({ processed: 0, failed: 0 });
    expect(await processNoShow(prisma, order.id)).toBeNull();
    const row = await orderRow(order.id);
    expect(row).toMatchObject({ status: 'READY', paymentStatus: 'PAID', noShow: null });
    expect(await stockOf(m.puff.id)).toBe(9);
  });
});

describe('only once', () => {
  it('never refunds or restocks twice, however often the worker runs', async () => {
    await fund(s, 50_000);
    const order = await readyScheduledOrder([[m.puff.id, 2]]);
    await minutesAgo(order.id, 11);
    const runs = await Promise.all([1, 2, 3, 4].map(() => processDueNoShows(prisma)));
    expect(runs.reduce((n, r) => n + r.processed, 0)).toBe(1);
    await processDueNoShows(prisma);
    expect(await processNoShow(prisma, order.id)).toBeNull();

    expect(
      await prisma.walletTransaction.count({ where: { orderId: order.id, type: 'REFUND' } }),
    ).toBe(1);
    expect(
      await prisma.stockAdjustment.count({ where: { orderId: order.id, type: 'ORDER_RESTORE' } }),
    ).toBe(1);
    expect(await stockOf(m.puff.id)).toBe(10);
    expect(await balance()).toBe(48_300);
  });

  it('a pickup confirmed at the same moment as the worker: exactly one of them wins', async () => {
    const shoppers = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => student(`racer${n}@example.com`, staffApp)),
    );
    const orders = [];
    for (const shopper of shoppers) {
      await fund(shopper, 50_000);
      const order = await readyScheduledOrder([[m.puff.id, 1]], { agent: shopper });
      await minutesAgo(order.id, 11);
      orders.push(order);
    }
    await Promise.all(
      orders.flatMap((o) => [
        processNoShow(prisma, o.id).catch(() => null),
        transition(cashier, m.outlet.id, o.id, 'COMPLETED'),
      ]),
    );
    for (const o of orders) {
      const row = await orderRow(o.id);
      const refunds = await prisma.walletTransaction.count({
        where: { orderId: o.id, type: 'REFUND' },
      });
      if (row.status === 'COMPLETED') {
        expect(refunds).toBe(0);
        expect(row.noShow).toBeNull();
      } else {
        expect(row.status).toBe('NO_SHOW');
        expect(refunds).toBe(1);
      }
    }
    const restocked = await prisma.stockAdjustment.count({ where: { type: 'ORDER_RESTORE' } });
    const noShows = await prisma.order.count({ where: { status: 'NO_SHOW' } });
    expect(restocked).toBe(noShows);
    expect(await stockOf(m.puff.id)).toBe(5 + noShows);
  });
});

describe('failures and recovery', () => {
  it('rolls back a failed attempt completely and retries it safely', async () => {
    await fund(s, 50_000);
    const order = await readyScheduledOrder([[m.puff.id, 2]]);
    await minutesAgo(order.id, 11);
    // Simulate the wallet ledger failing mid-way through the settlement.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_refund() RETURNS trigger AS $$
      BEGIN IF NEW.type = 'REFUND' THEN RAISE EXCEPTION 'ledger unavailable'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql;`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_fail_refund BEFORE INSERT ON "WalletTransaction" FOR EACH ROW EXECUTE FUNCTION test_fail_refund();`,
    );
    try {
      expect(await processDueNoShows(prisma)).toEqual({ processed: 0, failed: 1 });
      expect(await processDueNoShows(prisma)).toEqual({ processed: 0, failed: 1 });
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS test_fail_refund ON "WalletTransaction";`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_fail_refund();`);
    }
    let row = await orderRow(order.id);
    expect(row.status).toBe('READY'); // nothing committed
    expect(row.noShow).toMatchObject({ status: 'FAILED', attempts: 2 });
    expect(row.noShow!.lastError).toContain('ledger unavailable');
    expect(await stockOf(m.puff.id)).toBe(8);
    expect(await balance()).toBe(42_000);
    const studentView = (await s.get(`/api/v1/orders/${order.id}`).expect(200)).body.order;
    expect(studentView.noShow).toMatchObject({ status: 'FAILED', refundPaise: 0 });
    expect(JSON.stringify(studentView)).not.toContain('ledger unavailable');

    // An admin retries: the same policy runs, once.
    const admin = await signIn('admin@example.com');
    const adminUser = await prisma.user.findUniqueOrThrow({
      where: { email: 'admin@example.com' },
    });
    await prisma.userRole.create({
      data: { userId: adminUser.id, role: 'ADMIN', grantedVia: 'CLI' },
    });
    const failed = (await admin.get('/api/v1/admin/no-shows?status=FAILED').expect(200)).body
      .settlements;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      orderId: order.id,
      attempts: 2,
      lastError: expect.stringContaining('ledger'),
    });
    const retried = await send(admin, 'post', `/admin/no-shows/${order.id}/retry`, {}).expect(200);
    expect(retried.body).toMatchObject({ processed: true, order: { status: 'NO_SHOW' } });
    await send(admin, 'post', `/admin/no-shows/${order.id}/retry`, {}).expect(200); // no-op now

    row = await orderRow(order.id);
    expect(row.noShow).toMatchObject({
      status: 'PROCESSED',
      attempts: 3,
      lastError: null,
      refundPaise: 6_300,
    });
    expect(await prisma.walletTransaction.count({ where: { type: 'REFUND' } })).toBe(1);
    expect(await balance()).toBe(48_300);
    expect(await stockOf(m.puff.id)).toBe(10);
    expect(await prisma.auditLog.count({ where: { action: 'NO_SHOW_RETRY_REQUESTED' } })).toBe(2);
  });

  it('keeps manual recovery to administrators, with no way to set an amount', async () => {
    await fund(s, 50_000);
    const order = await readyScheduledOrder([[m.puff.id, 1]]);
    await minutesAgo(order.id, 11);
    for (const agent of [s, manager, cashier]) {
      await send(agent, 'post', `/admin/no-shows/${order.id}/retry`, {}).expect(403);
      await agent.get('/api/v1/admin/no-shows').expect(403);
    }
    await send(
      s,
      'post',
      `/staff/outlets/${m.outlet.id}/orders/${order.id}/items/${m.puff.id}/not-resellable`,
      { reason: 'Opened' },
    ).expect(403);
    expect((await orderRow(order.id)).status).toBe('READY');
  });
});

describe('the background worker', () => {
  it('settles due orders on its own and tells the student, wallet and stock views', async () => {
    await fund(s, 50_000);
    const order = await readyScheduledOrder([[m.puff.id, 1]]);
    await minutesAgo(order.id, 11);
    const events: string[] = [];
    const worker = startNoShowWorker(
      prisma,
      {
        ...noopPublisher,
        orderUpdated: (o) => events.push(`order:${o.status}`),
        walletUpdated: (_u, reason) => events.push(`wallet:${reason}`),
        stockChanged: (_o, ids) => events.push(`stock:${ids.length}`),
      },
      3_600_000, // only the first, immediate sweep runs during the test
    );
    try {
      await worker.sweep(); // waits for the in-flight first sweep, if any
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      worker.stop();
    }
    expect((await orderRow(order.id)).status).toBe('NO_SHOW');
    expect(events.sort()).toEqual(['order:NO_SHOW', 'stock:1', 'wallet:REFUND']);
  });
});

describe('pickup codes for scheduled orders', () => {
  const pickupOf = async (orderId: string) =>
    (await s.get(`/api/v1/orders/${orderId}/pickup`).expect(200)).body.pickup;

  it('get a code only when staff mark the order READY — not when the slot arrives', async () => {
    await fund(s, 50_000);
    await post(s, '/cart/items', { menuItemId: m.puff.id, quantity: 1 }).expect(200);
    const { body } = await post(
      s,
      '/orders',
      { paymentMethod: 'WALLET', expectedTotalPaise: 4_500, scheduledFor: await firstSlot() },
      key(),
    ).expect(201);
    await minutesAgo(body.order.id, 5); // the slot has come, the food isn't ready
    expect((await pickupOf(body.order.id)).state).toBe('NOT_READY');
    expect(await prisma.pickupCredential.count({ where: { orderId: body.order.id } })).toBe(0);

    await prisma.order.update({
      where: { id: body.order.id },
      data: { scheduledFor: new Date(Date.now() + 5 * 60_000) },
    });
    for (const to of ['ACCEPTED', 'PREPARING', 'READY']) {
      await transition(cashier, m.outlet.id, body.order.id, to).expect(200);
    }
    expect((await pickupOf(body.order.id)).state).toBe('ACTIVE');
    // Same verification and explicit confirmation as any other order.
    await transition(cashier, m.outlet.id, body.order.id, 'COMPLETED').expect(200);
    expect((await pickupOf(body.order.id)).state).toBe('COLLECTED');
  });

  it('revoke the code when the order is processed as a no-show', async () => {
    await fund(s, 50_000);
    const order = await readyScheduledOrder([[m.puff.id, 1]]);
    const { code } = await pickupOf(order.id);
    await minutesAgo(order.id, 11);
    await processNoShow(prisma, order.id);
    expect(
      await prisma.pickupCredential.findFirstOrThrow({ where: { orderId: order.id } }),
    ).toMatchObject({
      status: 'REVOKED',
      revokedReason: 'ORDER_NO_SHOW',
    });
    expect((await pickupOf(order.id)).state).toBe('ENDED');
    const res = await cashier
      .post(`/api/v1/staff/outlets/${m.outlet.id}/pickup/verify`)
      .set('X-Requested-With', 'CampusCart')
      .send({ method: 'CODE', code })
      .expect(404);
    expect(res.body.error.code).toBe('PICKUP_NO_MATCH');
    expect(await prisma.auditLog.count({ where: { action: 'PICKUP_CREDENTIAL_REVOKED' } })).toBe(1);
  });
});
