import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import {
  addToCart,
  app,
  fund,
  key,
  menu,
  post,
  student,
  type Agent,
} from '../../tests/commerce.js';
import { signIn, staffApp, staffFor, transition } from '../../tests/staff.js';
import { restoreForOrder, takePoints } from './loyalty.service.js';

let s: Agent;
let m: Awaited<ReturnType<typeof menu>>;

beforeEach(async () => {
  await resetDatabase();
  m = await menu();
  s = await student('student@example.com', staffApp);
});

const startRecharge = (agent: Agent, amountPaise: unknown, idempotencyKey = key()) =>
  post(agent, '/wallet/recharges', { amountPaise }, idempotencyKey);
const settle = (agent: Agent, id: string, outcome: 'SUCCESS' | 'FAILURE' | 'CANCEL') =>
  post(agent, `/payments/mock/${id}/outcome`, { outcome });
const walletOf = async (agent: Agent) =>
  (await agent.get('/api/v1/wallet').expect(200)).body.wallet as {
    balancePaise: number;
    loyalty: { pointsBalance: number };
  };
const points = async (agent: Agent) => (await walletOf(agent)).loyalty.pointsBalance;
const ledger = () => prisma.loyaltyTransaction.findMany({ orderBy: { createdAt: 'asc' } });

/** Recharge and succeed through the real mock flow, returning the attempt id. */
async function recharge(agent: Agent, amountPaise: number) {
  const started = await startRecharge(agent, amountPaise).expect(201);
  await settle(agent, started.body.recharge.id, 'SUCCESS').expect(200);
  return started.body.recharge.id as string;
}

const order = (
  agent: Agent,
  body: {
    paymentMethod: 'WALLET' | 'COUNTER';
    expectedTotalPaise: number;
    pointsToRedeem?: number;
  },
  idempotencyKey = key(),
) => post(agent, '/orders', body, idempotencyKey);

describe('minimum recharge', () => {
  it('rejects anything below ₹99 or not a valid whole-rupee amount, creating nothing', async () => {
    for (const bad of [9_800, 0, -9_900, 9_950, 99.5, '9900', null]) {
      const res = await startRecharge(s, bad);
      expect(res.status, String(bad)).toBe(400);
    }
    expect((await startRecharge(s, 9_800)).body.error).toMatchObject({
      code: 'AMOUNT_OUT_OF_RANGE',
      message: 'The minimum recharge is ₹99.',
    });
    expect(await prisma.paymentAttempt.count()).toBe(0);
  });

  it('accepts exactly ₹99 and awards no bonus', async () => {
    const started = await startRecharge(s, 9_900).expect(201);
    expect(started.body.recharge.bonusPoints).toBe(0);
    await settle(s, started.body.recharge.id, 'SUCCESS').expect(200);
    expect(await walletOf(s)).toMatchObject({ balancePaise: 9_900, loyalty: { pointsBalance: 0 } });
    expect(await ledger()).toEqual([]);
  });
});

describe('bonus points on recharge', () => {
  it.each([
    [50_000, 10],
    [100_000, 25],
    [130_000, 30],
    [150_000, 40],
  ])('₹%i paise awards exactly %i points, recorded in the ledger', async (amount, expected) => {
    const started = await startRecharge(s, amount).expect(201);
    expect(started.body.recharge.bonusPoints).toBe(expected); // shown before paying
    expect(await points(s)).toBe(0); // starting a recharge awards nothing

    await settle(s, started.body.recharge.id, 'SUCCESS').expect(200);
    expect(await walletOf(s)).toMatchObject({
      balancePaise: amount,
      loyalty: { pointsBalance: expected },
    });
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'EARNED_RECHARGE',
      direction: 'CREDIT',
      points: expected,
      pointsBalanceAfter: expected,
      paymentAttemptId: started.body.recharge.id,
      isSimulated: true,
    });
  });

  it.each([10_000, 49_900, 50_100, 120_000, 140_000, 200_000])(
    'awards nothing for a non-slab amount (%i paise)',
    async (amount) => {
      await recharge(s, amount);
      expect(await walletOf(s)).toMatchObject({
        balancePaise: amount,
        loyalty: { pointsBalance: 0 },
      });
      expect(await ledger()).toEqual([]);
    },
  );

  it('awards nothing for pending, failed, cancelled or expired payments', async () => {
    const pending = await startRecharge(s, 50_000).expect(201);
    const failed = await startRecharge(s, 100_000).expect(201);
    const cancelled = await startRecharge(s, 130_000).expect(201);
    const expired = await startRecharge(s, 150_000).expect(201);
    await settle(s, failed.body.recharge.id, 'FAILURE').expect(200);
    await settle(s, cancelled.body.recharge.id, 'CANCEL').expect(200);
    await prisma.paymentAttempt.update({
      where: { id: expired.body.recharge.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await settle(s, expired.body.recharge.id, 'SUCCESS').expect(200);

    expect(await walletOf(s)).toMatchObject({ balancePaise: 0, loyalty: { pointsBalance: 0 } });
    expect(await ledger()).toEqual([]);
    expect(pending.body.recharge.status).toBe('PENDING');
  });

  it('awards nothing when the credit itself fails (wallet cap reached meanwhile)', async () => {
    const started = await startRecharge(s, 150_000).expect(201);
    await prisma.wallet.update({
      where: {
        userId: (await prisma.user.findUniqueOrThrow({ where: { email: 'student@example.com' } }))
          .id,
      },
      data: { balancePaise: 400_000 },
    });
    await settle(s, started.body.recharge.id, 'SUCCESS').expect(200);
    const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: started.body.recharge.id },
    });
    expect(attempt.status).toBe('FAILED');
    expect(await points(s)).toBe(0);
    expect(await ledger()).toEqual([]);
  });

  it('credits money and points exactly once, however many callbacks or retries arrive', async () => {
    const idempotencyKey = key();
    const started = await startRecharge(s, 100_000, idempotencyKey).expect(201);
    const retry = await startRecharge(s, 100_000, idempotencyKey).expect(200);
    expect(retry.body.recharge.id).toBe(started.body.recharge.id);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => settle(s, started.body.recharge.id, 'SUCCESS')),
    );
    expect(results.filter((r) => r.body.changed)).toHaveLength(1);
    await settle(s, started.body.recharge.id, 'SUCCESS').expect(200);

    expect(await walletOf(s)).toMatchObject({
      balancePaise: 100_000,
      loyalty: { pointsBalance: 25 },
    });
    expect(await ledger()).toHaveLength(1);
    expect(
      await prisma.walletTransaction.count({ where: { type: 'RECHARGE', status: 'COMPLETED' } }),
    ).toBe(1);
  });
});

describe('redeeming points at checkout', () => {
  beforeEach(async () => {
    await recharge(s, 100_000); // ₹1,000 and 25 points
  });

  it('takes ₹1 per point off the order, atomically with the order and the wallet debit', async () => {
    await addToCart(s, m.chai.id, 3); // ₹60
    const res = await order(s, {
      paymentMethod: 'WALLET',
      expectedTotalPaise: 4_000,
      pointsToRedeem: 20,
    }).expect(201);
    expect(res.body.order).toMatchObject({
      subtotalPaise: 6_000,
      pointsRedeemed: 20,
      pointsDiscountPaise: 2_000,
      totalPaise: 4_000,
    });
    expect(await walletOf(s)).toMatchObject({
      balancePaise: 96_000,
      loyalty: { pointsBalance: 5 },
    });
    const debit = await prisma.walletTransaction.findFirstOrThrow({
      where: { type: 'ORDER_DEBIT' },
    });
    expect(debit.amountPaise).toBe(4_000);
    const redeemed = await prisma.loyaltyTransaction.findFirstOrThrow({
      where: { type: 'REDEEMED_ORDER' },
    });
    expect(redeemed).toMatchObject({
      direction: 'DEBIT',
      points: 20,
      pointsBalanceAfter: 5,
      orderId: res.body.order.id,
    });
  });

  it('works for pay-at-counter orders: the counter collects the discounted total', async () => {
    await addToCart(s, m.puff.id); // ₹35
    const res = await order(s, {
      paymentMethod: 'COUNTER',
      expectedTotalPaise: 1_500,
      pointsToRedeem: 20,
    }).expect(201);
    expect(res.body.order).toMatchObject({ totalPaise: 1_500, paymentStatus: 'PENDING_COUNTER' });
    expect(await walletOf(s)).toMatchObject({
      balancePaise: 100_000,
      loyalty: { pointsBalance: 5 },
    });
  });

  it('refuses more points than held, with nothing saved', async () => {
    await addToCart(s, m.chai.id, 3); // ₹60
    const res = await order(s, {
      paymentMethod: 'WALLET',
      expectedTotalPaise: 3_400,
      pointsToRedeem: 26,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_POINTS',
      details: { pointsBalance: 25, requested: 26 },
    });
    expect(await prisma.order.count()).toBe(0);
    expect(await walletOf(s)).toMatchObject({
      balancePaise: 100_000,
      loyalty: { pointsBalance: 25 },
    });
    expect((await s.get('/api/v1/cart').expect(200)).body.cart.itemCount).toBe(3);
  });

  it('refuses more points than the order allows, always leaving ₹1 to pay', async () => {
    await addToCart(s, m.chai.id); // ₹20
    const cart = (await s.get('/api/v1/cart').expect(200)).body.cart;
    expect(cart.loyalty).toEqual({
      availablePoints: 25,
      maxRedeemablePoints: 19,
      pointValuePaise: 100,
    });

    const tooMany = await order(s, {
      paymentMethod: 'WALLET',
      expectedTotalPaise: 100,
      pointsToRedeem: 20,
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toMatchObject({
      code: 'POINTS_EXCEED_ORDER',
      details: { maxPoints: 19 },
    });

    await order(s, { paymentMethod: 'WALLET', expectedTotalPaise: 100, pointsToRedeem: 19 }).expect(
      201,
    );
    expect(await walletOf(s)).toMatchObject({
      balancePaise: 99_900,
      loyalty: { pointsBalance: 6 },
    });
  });

  it('recalculates the total on the server: a stale total is refused', async () => {
    await addToCart(s, m.chai.id, 3);
    const res = await order(s, {
      paymentMethod: 'WALLET',
      expectedTotalPaise: 6_000,
      pointsToRedeem: 10,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'PRICE_CHANGED', details: { totalPaise: 5_000 } });
    expect(await points(s)).toBe(25);
  });

  it('a repeated checkout request spends the points only once', async () => {
    await addToCart(s, m.chai.id, 3);
    const idempotencyKey = key();
    const body = {
      paymentMethod: 'WALLET' as const,
      expectedTotalPaise: 4_000,
      pointsToRedeem: 20,
    };
    const results = await Promise.all([1, 2, 3, 4].map(() => order(s, body, idempotencyKey)));
    expect(new Set(results.map((r) => r.body.order.id)).size).toBe(1);
    expect(await prisma.loyaltyTransaction.count({ where: { type: 'REDEEMED_ORDER' } })).toBe(1);
    expect(await points(s)).toBe(5);
  });

  it('concurrent checkouts with different keys cannot spend the same points twice', async () => {
    await addToCart(s, m.chai.id, 3);
    const body = {
      paymentMethod: 'WALLET' as const,
      expectedTotalPaise: 4_000,
      pointsToRedeem: 20,
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => order(s, body)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await prisma.order.count()).toBe(1);
    expect(await points(s)).toBe(5);
  });

  it('the points primitive itself never overspends under concurrency', async () => {
    const wallet = await prisma.wallet.findFirstOrThrow();
    // Five separate transactions each try to take 10 of the 25 points at once.
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => prisma.$transaction((tx) => takePoints(tx, wallet.id, 10))),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(2);
    expect(
      (await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).pointsBalance,
    ).toBe(5);
  });
});

describe('restoring points', () => {
  beforeEach(async () => {
    await recharge(s, 50_000); // ₹500 and 10 points
  });

  it('gives points back once when the student cancels; a second cancel changes nothing', async () => {
    await addToCart(s, m.chai.id, 3);
    const placed = await order(s, {
      paymentMethod: 'WALLET',
      expectedTotalPaise: 5_000,
      pointsToRedeem: 10,
    }).expect(201);
    expect(await points(s)).toBe(0);

    const id = placed.body.order.id as string;
    await post(s, `/orders/${id}/cancel`, {}).expect(200);
    await post(s, `/orders/${id}/cancel`, {}).expect(409);

    expect(await walletOf(s)).toMatchObject({
      balancePaise: 50_000,
      loyalty: { pointsBalance: 10 },
    });
    const restored = await prisma.loyaltyTransaction.findMany({
      where: { type: 'RESTORED_ORDER' },
    });
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ points: 10, pointsBalanceAfter: 10, orderId: id });

    // Even calling the restore directly again is refused by the unique ledger key.
    await expect(
      prisma.$transaction((tx) => restoreForOrder(tx, { orderId: id, label: 'again' })),
    ).rejects.toThrow();
    expect(await points(s)).toBe(10);
  });

  it('gives points back when the outlet rejects an unpaid counter order', async () => {
    const { manager } = await staffFor(m.outlet.id);
    await addToCart(s, m.puff.id); // ₹35
    const placed = await order(s, {
      paymentMethod: 'COUNTER',
      expectedTotalPaise: 2_500,
      pointsToRedeem: 10,
    }).expect(201);
    await transition(manager, m.outlet.id, placed.body.order.id, 'REJECTED', 'Out of stock').expect(
      200,
    );
    await transition(manager, m.outlet.id, placed.body.order.id, 'REJECTED', 'Again').expect(409);

    expect(await points(s)).toBe(10);
    expect(await prisma.loyaltyTransaction.count({ where: { type: 'RESTORED_ORDER' } })).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'ORDER_REJECTED' } });
    expect(audit.metadata).toMatchObject({ pointsRestored: 10 });
  });

  it('completed orders keep their discount: no points come back', async () => {
    const { cashier } = await staffFor(m.outlet.id);
    await addToCart(s, m.chai.id, 3);
    const placed = await order(s, {
      paymentMethod: 'WALLET',
      expectedTotalPaise: 5_000,
      pointsToRedeem: 10,
    }).expect(201);
    for (const to of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) {
      await transition(cashier, m.outlet.id, placed.body.order.id, to).expect(200);
    }
    expect(await points(s)).toBe(0);
    expect(await prisma.loyaltyTransaction.count({ where: { type: 'RESTORED_ORDER' } })).toBe(0);
  });
});

describe('privacy', () => {
  it('shows each student only their own points; no request can name another user', async () => {
    await recharge(s, 50_000);
    const other = await signIn('other.student@example.com');
    await fund(other, 100_000);

    const mine = (await s.get('/api/v1/wallet/points').expect(200)).body;
    const theirs = (await other.get('/api/v1/wallet/points').expect(200)).body;
    expect(mine.pointsBalance).toBe(10);
    expect(mine.transactions).toHaveLength(1);
    expect(theirs.pointsBalance).toBe(25);
    expect(theirs.transactions.map((t: { id: string }) => t.id)).not.toContain(
      mine.transactions[0].id,
    );

    const otherUser = await prisma.user.findUniqueOrThrow({
      where: { email: 'other.student@example.com' },
    });
    await post(s, '/orders', {
      paymentMethod: 'WALLET',
      expectedTotalPaise: 2_000,
      pointsToRedeem: 1,
      userId: otherUser.id,
    }).expect(400);
    await post(s, '/wallet/recharges', { amountPaise: 50_000, userId: otherUser.id }, key()).expect(
      400,
    );
    expect(await points(other)).toBe(25);
  });

  it('requires sign-in for the points ledger', async () => {
    const request = (await import('supertest')).default;
    await request(app).get('/api/v1/wallet/points').expect(401);
  });
});
