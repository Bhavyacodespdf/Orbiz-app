import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { formatPickupCode, istDay } from './pickup.js';

// Numbers refer to the "Wallet and payment tests" list in the project brief.

let s: Agent;
let m: Awaited<ReturnType<typeof menu>>;

beforeEach(async () => {
  await resetDatabase();
  m = await menu();
  s = await student();
});

const walletBalance = async (agent: Agent) =>
  (await agent.get('/api/v1/wallet').expect(200)).body.wallet.balancePaise as number;
const cartOf = async (agent: Agent) => (await agent.get('/api/v1/cart').expect(200)).body.cart;

describe('checkout with wallet', () => {
  it('#13 creates consistent order, payment and ledger records and empties the cart', async () => {
    await fund(s, 10000);
    await addToCart(s, m.chai.id, 2); // ₹40
    await addToCart(s, m.puff.id); // ₹35
    const res = await placeOrder(s, 'WALLET', 7500).expect(201);

    const { order } = res.body;
    expect(order).toMatchObject({
      status: 'PLACED',
      paymentMethod: 'WALLET',
      paymentStatus: 'PAID',
      subtotalPaise: 7500,
      totalPaise: 7500,
      currency: 'INR',
      outlet: { name: 'Night Owl Café' },
      statusHistory: [expect.objectContaining({ fromStatus: null, toStatus: 'PLACED' })],
    });
    expect(order.pickupCode).toMatch(/^N-\d{3}$/);
    expect(order.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          menuItemId: m.chai.id,
          name: 'Chai',
          unitPricePaise: 2000,
          quantity: 2,
          lineTotalPaise: 4000,
        }),
        expect.objectContaining({
          menuItemId: m.puff.id,
          name: 'Puff',
          unitPricePaise: 3500,
          quantity: 1,
          lineTotalPaise: 3500,
        }),
      ]),
    );

    expect(await walletBalance(s)).toBe(2500);
    const debit = await prisma.walletTransaction.findFirstOrThrow({
      where: { type: 'ORDER_DEBIT' },
    });
    expect(debit).toMatchObject({
      orderId: order.id,
      amountPaise: 7500,
      balanceAfterPaise: 2500,
      direction: 'DEBIT',
      status: 'COMPLETED',
    });
    expect((await cartOf(s)).items).toEqual([]);
  });

  it('#10 rejects an order larger than the balance, with no order, no debit, cart intact', async () => {
    await fund(s, 9900); // ₹99, the minimum recharge
    await addToCart(s, m.chai.id, 5); // ₹100
    const res = await placeOrder(s, 'WALLET', 10000);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      details: { balancePaise: 9900, totalPaise: 10000, shortfallPaise: 100 },
    });
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { type: 'ORDER_DEBIT' } })).toBe(0);
    expect(await walletBalance(s)).toBe(9900);
    expect((await cartOf(s)).itemCount).toBe(5);
    // No pickup number was consumed by the failed attempt.
    expect(await prisma.outletDailyCounter.count()).toBe(0);
  });

  it('#14 the same checkout submitted twice creates one order and one debit', async () => {
    await fund(s, 10000);
    await addToCart(s, m.chai.id);
    const k = key();
    const first = await placeOrder(s, 'WALLET', 2000, k).expect(201);
    const second = await placeOrder(s, 'WALLET', 2000, k).expect(200);
    expect(second.body.order.id).toBe(first.body.order.id);
    expect(await prisma.order.count()).toBe(1);
    expect(await walletBalance(s)).toBe(8000);
  });

  it('#14 concurrent duplicate submissions (same key) create one order and one debit', async () => {
    await fund(s, 10000);
    await addToCart(s, m.chai.id);
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => placeOrder(s, 'WALLET', 2000, k)),
    );
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.order.id)).size).toBe(1);
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.walletTransaction.count({ where: { type: 'ORDER_DEBIT' } })).toBe(1);
    expect(await walletBalance(s)).toBe(8000);
  });

  it('#11 concurrent checkouts with different keys cannot spend the cart or the balance twice', async () => {
    await fund(s, 10000);
    await addToCart(s, m.chai.id, 5); // ₹100, exactly the balance
    const results = await Promise.all(
      Array.from({ length: 5 }, () => placeOrder(s, 'WALLET', 10000)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'CART_EMPTY'),
    ).toBe(true);
    expect(await prisma.order.count()).toBe(1);
    expect(await walletBalance(s)).toBe(0);
  });

  it('#12 a failure after the debit rolls everything back — no orphaned debit', async () => {
    await fund(s, 10000);
    await addToCart(s, m.chai.id);
    // Inject a real database failure at the last step of checkout (emptying the cart),
    // which runs AFTER the wallet debit inside the same transaction.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_cart_clear() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END; $$ LANGUAGE plpgsql;`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_fail_cart_clear BEFORE DELETE ON "CartItem" FOR EACH ROW EXECUTE FUNCTION test_fail_cart_clear();`,
    );
    try {
      const res = await placeOrder(s, 'WALLET', 2000);
      expect(res.status).toBe(500);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_cart_clear ON "CartItem";`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_fail_cart_clear();`);
    }
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.orderItem.count()).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { type: 'ORDER_DEBIT' } })).toBe(0);
    expect(await walletBalance(s)).toBe(10000);
    expect((await cartOf(s)).itemCount).toBe(1);
  });
});

describe('pay at counter', () => {
  it('#19 creates the order as unpaid and does not touch the wallet', async () => {
    await addToCart(s, m.puff.id);
    const res = await placeOrder(s, 'COUNTER', 3500).expect(201);
    expect(res.body.order).toMatchObject({
      paymentMethod: 'COUNTER',
      paymentStatus: 'PENDING_COUNTER',
    });
    expect(await prisma.walletTransaction.count()).toBe(0);
    expect(await walletBalance(s)).toBe(0);
  });

  it('cannot be marked paid by the student through any order field', async () => {
    await addToCart(s, m.puff.id);
    const res = await post(
      s,
      '/orders',
      { paymentMethod: 'COUNTER', expectedTotalPaise: 3500, paymentStatus: 'PAID' },
      key(),
    );
    expect(res.status).toBe(400);
  });
});

describe('server-side validation at checkout', () => {
  it('rejects a stale total so the student can review new prices', async () => {
    await addToCart(s, m.chai.id);
    await prisma.menuItem.update({ where: { id: m.chai.id }, data: { pricePaise: 2500 } });
    const res = await placeOrder(s, 'COUNTER', 2000);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'PRICE_CHANGED', details: { totalPaise: 2500 } });
    expect(await prisma.order.count()).toBe(0);
    await placeOrder(s, 'COUNTER', 2500).expect(201);
  });

  it('rejects checkout when the outlet has closed since items were added', async () => {
    await addToCart(s, m.chai.id);
    await prisma.outlet.update({ where: { id: m.outlet.id }, data: { status: 'CLOSED' } });
    expect((await placeOrder(s, 'COUNTER', 2000)).body.error.code).toBe('OUTLET_NOT_ACCEPTING');
  });

  it('rejects items that sold out or were removed, naming them', async () => {
    await addToCart(s, m.chai.id);
    await addToCart(s, m.puff.id);
    await prisma.menuItem.update({ where: { id: m.puff.id }, data: { isAvailable: false } });
    const res = await placeOrder(s, 'COUNTER', 5500);
    expect(res.body.error).toMatchObject({
      code: 'ITEMS_UNAVAILABLE',
      details: { items: [{ name: 'Puff' }] },
    });
  });

  it('rejects an empty cart and requires an idempotency key', async () => {
    expect((await placeOrder(s, 'COUNTER', 100)).body.error.code).toBe('CART_EMPTY');
    const noKey = await post(s, '/orders', { paymentMethod: 'COUNTER', expectedTotalPaise: 100 });
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('orders after checkout', () => {
  it('keeps the purchased name and price even after the menu item changes', async () => {
    await addToCart(s, m.chai.id);
    const { order } = (await placeOrder(s, 'COUNTER', 2000).expect(201)).body;
    await prisma.menuItem.update({
      where: { id: m.chai.id },
      data: { name: 'Chai (large)', pricePaise: 9900, isActive: false },
    });
    const again = await s.get(`/api/v1/orders/${order.id}`).expect(200);
    expect(again.body.order.items[0]).toMatchObject({ name: 'Chai', unitPricePaise: 2000 });
  });

  it('lets a student see only their own orders', async () => {
    await addToCart(s, m.chai.id);
    const { order } = (await placeOrder(s, 'COUNTER', 2000).expect(201)).body;
    const other = await student('other@example.com');
    await other.get(`/api/v1/orders/${order.id}`).expect(404);
    await other.get('/api/v1/orders/not-a-uuid').expect(404);
  });

  it('gives concurrent orders at one outlet distinct, sequential pickup codes', async () => {
    const students = await Promise.all(
      Array.from({ length: 6 }, (_, n) => student(`s${n}@example.com`)),
    );
    for (const agent of students) await addToCart(agent, m.chai.id);
    const results = await Promise.all(students.map((agent) => placeOrder(agent, 'COUNTER', 2000)));
    const codes = results.map((r) => r.body.order.pickupCode).sort();
    expect(codes).toEqual(['N-001', 'N-002', 'N-003', 'N-004', 'N-005', 'N-006']);
  });
});

describe('pickup helpers', () => {
  afterEach(() => undefined);
  it('formats codes and uses the Indian calendar day', () => {
    expect(formatPickupCode('Night Owl Café', 7)).toBe('N-007');
    expect(formatPickupCode('42 Diner', 123)).toBe('4-123');
    // 20:00 UTC is already the next day in IST (UTC+5:30).
    expect(istDay(new Date('2026-10-16T20:00:00Z'))).toBe('2026-10-17');
  });
});
