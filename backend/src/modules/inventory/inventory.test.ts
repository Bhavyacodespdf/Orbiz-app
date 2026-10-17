import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { makeOutlet } from '../../tests/fixtures.js';
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
import { cancel, signIn, staffApp, staffFor, transition } from '../../tests/staff.js';
import { assign } from '../../tests/fixtures.js';
import { restoreForOrder } from './inventory.service.js';

let m: Awaited<ReturnType<typeof menu>>;
let manager: Agent;
let cashier: Agent;
let s: Agent;

beforeEach(async () => {
  await resetDatabase();
  m = await menu(); // Chai ₹20, Puff ₹35 at one open outlet
  ({ manager, cashier } = await staffFor(m.outlet.id));
  s = await student('student@example.com', staffApp);
});

const base = () => `/staff/outlets/${m.outlet.id}/inventory`;
const send = (agent: Agent, method: 'post' | 'patch', url: string, body: object) =>
  agent[method](`/api/v1${url}`).set('X-Requested-With', 'CampusCart').send(body);
const track = (agent: Agent, itemId: string, quantity: number, lowStockThreshold = 5) =>
  send(agent, 'post', `${base()}/${itemId}/tracking`, {
    enabled: true,
    quantity,
    lowStockThreshold,
  });
const adjust = (agent: Agent, itemId: string, body: object) =>
  send(agent, 'post', `${base()}/${itemId}/adjustments`, body);
const setAvailable = (agent: Agent, itemId: string, isAvailable: boolean) =>
  send(agent, 'patch', `/staff/outlets/${m.outlet.id}/items/${itemId}/availability`, {
    isAvailable,
  });
const row = (itemId: string) => prisma.menuItem.findUniqueOrThrow({ where: { id: itemId } });
const publicItem = async (name: string) =>
  (
    await request(staffApp).get(`/api/v1/outlets/${m.outlet.slug}/menu`).expect(200)
  ).body.items.find((i: { name: string }) => i.name === name);

describe('stock status through the API', () => {
  it('moves AVAILABLE → LOW_STOCK → SOLD_OUT with the quantity, everywhere', async () => {
    const tracked = await track(manager, m.chai.id, 10, 5).expect(200);
    expect(tracked.body.item).toMatchObject({
      trackInventory: true,
      stockQuantity: 10,
      stockStatus: 'AVAILABLE',
    });

    const low = await adjust(manager, m.chai.id, {
      type: 'REMOVAL',
      quantity: 7,
      reason: 'Spilled',
    }).expect(200);
    expect(low.body.item).toMatchObject({ stockQuantity: 3, stockStatus: 'LOW_STOCK' });
    expect(await publicItem('Chai')).toMatchObject({ stockStatus: 'LOW_STOCK', isAvailable: true });

    const out = await adjust(cashier, m.chai.id, {
      type: 'REMOVAL',
      quantity: 3,
      reason: 'Ran out',
    }).expect(200);
    expect(out.body.item).toMatchObject({
      stockQuantity: 0,
      stockStatus: 'SOLD_OUT',
      soldOutReason: 'OUT_OF_STOCK',
    });
    const shown = await publicItem('Chai');
    expect(shown).toMatchObject({ stockStatus: 'SOLD_OUT', isAvailable: false });
    expect(shown).not.toHaveProperty('stockQuantity'); // students never see counts

    const list = await manager.get(`/api/v1${base()}?status=SOLD_OUT`).expect(200);
    expect(list.body.items.map((i: { name: string }) => i.name)).toEqual(['Chai']);
    expect(list.body.counts).toEqual({ AVAILABLE: 1, LOW_STOCK: 0, SOLD_OUT: 1 });
  });

  it('leaves untracked items untouched: no invented quantities', async () => {
    const list = await manager.get(`/api/v1${base()}`).expect(200);
    for (const item of list.body.items) {
      expect(item).toMatchObject({
        trackInventory: false,
        stockQuantity: null,
        stockStatus: 'AVAILABLE',
      });
    }
  });

  it('records every change with who, when, before and after', async () => {
    await track(manager, m.chai.id, 10).expect(200);
    await adjust(cashier, m.chai.id, { type: 'RESTOCK', quantity: 5, reason: 'Delivery' }).expect(
      200,
    );
    await adjust(manager, m.chai.id, { type: 'REMOVAL', quantity: 2, reason: 'Damaged' }).expect(
      200,
    );
    await send(manager, 'patch', `${base()}/${m.chai.id}/threshold`, {
      lowStockThreshold: 8,
    }).expect(200);
    await adjust(manager, m.chai.id, {
      type: 'COUNT_SET',
      quantity: 12,
      expectedQuantity: 13,
    }).expect(200);

    const { body } = await manager.get(`/api/v1${base()}/${m.chai.id}/history`).expect(200);
    expect(
      body.history.map((h: Record<string, unknown>) => [
        h.type,
        h.quantityChange,
        h.previousQuantity,
        h.resultingQuantity,
      ]),
    ).toEqual([
      ['COUNT_SET', -1, 13, 12],
      ['THRESHOLD_CHANGED', 0, null, null],
      ['REMOVAL', -2, 15, 13],
      ['RESTOCK', 5, 10, 15],
      ['TRACKING_ENABLED', 10, null, 10],
    ]);
    expect(body.history[3]).toMatchObject({ actor: { role: 'POS' }, reason: 'Delivery' });
    expect(body.history[2].actor.role).toBe('MANAGER');
    expect((await row(m.chai.id)).stockQuantity).toBe(12);
  });
});

describe('validation', () => {
  it.each([
    [{ type: 'RESTOCK', quantity: -5 }],
    [{ type: 'RESTOCK', quantity: 0 }],
    [{ type: 'RESTOCK', quantity: 2.5 }],
    [{ type: 'RESTOCK', quantity: '5' }],
    [{ type: 'RESTOCK', quantity: 100_001 }],
    [{ type: 'REMOVAL', quantity: 1 }], // no reason
    [{ type: 'COUNT_SET', quantity: -1, expectedQuantity: 0 }],
    [{ type: 'COUNT_SET', quantity: 4 }], // no expected quantity
    [{ type: 'GIFT', quantity: 1 }],
    [{ type: 'RESTOCK', quantity: 1, stockQuantity: 99 }],
  ])('rejects %j', async (body) => {
    await track(manager, m.chai.id, 5).expect(200);
    const res = await adjust(manager, m.chai.id, body);
    expect(res.status).toBe(400);
    expect((await row(m.chai.id)).stockQuantity).toBe(5);
  });

  it('rejects negative or oversized thresholds and tracking without a counted quantity', async () => {
    await send(manager, 'patch', `${base()}/${m.chai.id}/threshold`, {
      lowStockThreshold: -1,
    }).expect(400);
    await send(manager, 'patch', `${base()}/${m.chai.id}/threshold`, {
      lowStockThreshold: 10_001,
    }).expect(400);
    await send(manager, 'post', `${base()}/${m.chai.id}/tracking`, { enabled: true }).expect(400);
    await track(manager, m.chai.id, -1).expect(400);
  });

  it('refuses to remove more than is left, and to adjust untracked items', async () => {
    await adjust(manager, m.puff.id, { type: 'RESTOCK', quantity: 5 }).expect(409);
    await track(manager, m.chai.id, 2).expect(200);
    const res = await adjust(manager, m.chai.id, {
      type: 'REMOVAL',
      quantity: 3,
      reason: 'Waste',
    }).expect(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await row(m.chai.id)).stockQuantity).toBe(2);
    await track(manager, m.chai.id, 9).expect(409); // already tracked
  });

  it('refuses a stock count based on an out-of-date figure', async () => {
    await track(manager, m.chai.id, 10).expect(200);
    await adjust(cashier, m.chai.id, { type: 'RESTOCK', quantity: 4 }).expect(200);
    const stale = await adjust(manager, m.chai.id, {
      type: 'COUNT_SET',
      quantity: 8,
      expectedQuantity: 10,
    }).expect(409);
    expect(stale.body.error).toMatchObject({
      code: 'STOCK_CHANGED',
      details: { stockQuantity: 14 },
    });
    expect((await row(m.chai.id)).stockQuantity).toBe(14);
  });
});

describe('permissions', () => {
  it('requires sign-in and staff assignment to this outlet', async () => {
    await request(staffApp).get(`/api/v1${base()}`).expect(401);
    await s.get(`/api/v1${base()}`).expect(403);
    await adjust(s, m.chai.id, { type: 'RESTOCK', quantity: 1 }).expect(403);
    await setAvailable(s, m.chai.id, false).expect(403);

    const other = await makeOutlet({ name: 'Elsewhere' });
    const otherManager = await signIn('other.manager@example.com');
    await assign('other.manager@example.com', other.id, 'MANAGER');
    await otherManager.get(`/api/v1${base()}`).expect(403);
    await track(otherManager, m.chai.id, 5).expect(403);
    // Their own outlet's URL with this outlet's item: not found.
    await send(otherManager, 'post', `/staff/outlets/${other.id}/inventory/${m.chai.id}/tracking`, {
      enabled: true,
      quantity: 5,
    }).expect(404);
    expect((await row(m.chai.id)).trackInventory).toBe(false);
  });

  it('lets POS staff restock, remove, and mark sold out or available — but not manager settings', async () => {
    await track(manager, m.chai.id, 5).expect(200);
    await adjust(cashier, m.chai.id, { type: 'RESTOCK', quantity: 3 }).expect(200);
    await adjust(cashier, m.chai.id, { type: 'REMOVAL', quantity: 1, reason: 'Dropped' }).expect(
      200,
    );
    await setAvailable(cashier, m.chai.id, false).expect(200);
    await setAvailable(cashier, m.chai.id, true).expect(200);

    await send(cashier, 'patch', `${base()}/${m.chai.id}/threshold`, {
      lowStockThreshold: 2,
    }).expect(403);
    await send(cashier, 'post', `${base()}/${m.chai.id}/tracking`, { enabled: false }).expect(403);
    await adjust(cashier, m.chai.id, {
      type: 'COUNT_SET',
      quantity: 1,
      expectedQuantity: 7,
    }).expect(403);
    expect((await row(m.chai.id)).stockQuantity).toBe(7);
  });
});

describe('the manual sold-out switch', () => {
  it('stays sold out through a restock until staff restore it', async () => {
    await track(manager, m.chai.id, 2).expect(200);
    await setAvailable(cashier, m.chai.id, false).expect(200);
    const restocked = await adjust(cashier, m.chai.id, { type: 'RESTOCK', quantity: 20 }).expect(
      200,
    );
    expect(restocked.body.item).toMatchObject({
      stockQuantity: 22,
      stockStatus: 'SOLD_OUT',
      soldOutManually: true,
    });
    await post(s, '/cart/items', { menuItemId: m.chai.id }).expect(409);

    const restored = await adjust(cashier, m.chai.id, {
      type: 'RESTOCK',
      quantity: 1,
      markAvailable: true,
    }).expect(200);
    expect(restored.body.item).toMatchObject({ stockStatus: 'AVAILABLE', soldOutManually: false });
    const types = (await prisma.stockAdjustment.findMany({ orderBy: { createdAt: 'asc' } })).map(
      (a) => a.type,
    );
    expect(types).toEqual([
      'TRACKING_ENABLED',
      'MARKED_SOLD_OUT',
      'RESTOCK',
      'RESTOCK',
      'MARKED_AVAILABLE',
    ]);
  });

  it('restoring an item with none left keeps it sold out', async () => {
    await track(manager, m.chai.id, 1).expect(200);
    await adjust(manager, m.chai.id, { type: 'REMOVAL', quantity: 1, reason: 'Gone' }).expect(200);
    await setAvailable(manager, m.chai.id, true).expect(200);
    expect(await publicItem('Chai')).toMatchObject({ stockStatus: 'SOLD_OUT', isAvailable: false });
  });
});

describe('ordering', () => {
  it('takes stock when an order is placed, and keeps low-stock items orderable', async () => {
    await track(manager, m.chai.id, 6, 5).expect(200);
    await fund(s, 50_000);
    await addToCart(s, m.chai.id, 2);
    await placeOrder(s, 'WALLET', 4_000).expect(201);
    const item = await row(m.chai.id);
    expect(item.stockQuantity).toBe(4);
    expect(await publicItem('Chai')).toMatchObject({ stockStatus: 'LOW_STOCK', isAvailable: true });
    const deduction = await prisma.stockAdjustment.findFirstOrThrow({
      where: { type: 'ORDER_DEDUCTION' },
    });
    expect(deduction).toMatchObject({
      quantityChange: -2,
      previousQuantity: 6,
      resultingQuantity: 4,
      actorRole: 'STUDENT',
    });

    await addToCart(s, m.chai.id, 1);
    await placeOrder(s, 'WALLET', 2_000).expect(201); // low stock, still orderable
    expect((await row(m.chai.id)).stockQuantity).toBe(3);
  });

  it('never oversells when many students order the last units at once', async () => {
    await track(manager, m.chai.id, 3, 1).expect(200);
    const buyers = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => student(`buyer${n}@example.com`, staffApp)),
    );
    for (const b of buyers) {
      await addToCart(b, m.chai.id);
    }
    const results = await Promise.all(buyers.map((b) => placeOrder(b, 'COUNTER', 2_000)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    const refused = results.filter((r) => r.status === 409);
    expect(refused).toHaveLength(3);
    for (const r of refused)
      expect(['INSUFFICIENT_STOCK', 'ITEMS_UNAVAILABLE']).toContain(r.body.error.code);
    expect((await row(m.chai.id)).stockQuantity).toBe(0);
    expect(await prisma.order.count()).toBe(3);
    expect(await prisma.stockAdjustment.count({ where: { type: 'ORDER_DEDUCTION' } })).toBe(3);
  });

  it('refuses sold-out items in the cart and at checkout, and too many of a counted item', async () => {
    await track(manager, m.chai.id, 2).expect(200);
    const tooMany = await post(s, '/cart/items', { menuItemId: m.chai.id, quantity: 3 }).expect(
      409,
    );
    expect(tooMany.body.error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: { available: 2 },
    });

    await addToCart(s, m.chai.id, 2);
    await s
      .patch(`/api/v1/cart/items/${m.chai.id}`)
      .set('X-Requested-With', 'CampusCart')
      .send({ quantity: 3 })
      .expect(409);

    // Someone else buys one: this cart now wants more than is left.
    await adjust(cashier, m.chai.id, {
      type: 'REMOVAL',
      quantity: 1,
      reason: 'Sold at counter',
    }).expect(200);
    const cart = (await s.get('/api/v1/cart').expect(200)).body.cart;
    expect(cart.canCheckout).toBe(false);
    expect(cart.issues).toEqual([
      { menuItemId: m.chai.id, name: 'Chai', reason: 'NOT_ENOUGH_STOCK', available: 1 },
    ]);
    const short = await placeOrder(s, 'COUNTER', 4_000).expect(409);
    expect(short.body.error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: { items: [{ menuItemId: m.chai.id, available: 1, requested: 2 }] },
    });

    await setAvailable(manager, m.chai.id, false).expect(200);
    const sold = (await s.get('/api/v1/cart').expect(200)).body.cart;
    expect(sold.issues[0].reason).toBe('SOLD_OUT');
    expect((await placeOrder(s, 'COUNTER', 4_000).expect(409)).body.error.code).toBe(
      'ITEMS_UNAVAILABLE',
    );
    expect(await prisma.order.count()).toBe(0);
    expect((await row(m.chai.id)).stockQuantity).toBe(1);
  });

  it('takes no stock when the payment fails', async () => {
    await track(manager, m.chai.id, 5).expect(200);
    await addToCart(s, m.chai.id, 2); // wallet is empty
    expect((await placeOrder(s, 'WALLET', 4_000).expect(409)).body.error.code).toBe(
      'INSUFFICIENT_BALANCE',
    );
    expect((await row(m.chai.id)).stockQuantity).toBe(5);
    expect(await prisma.stockAdjustment.count({ where: { type: 'ORDER_DEDUCTION' } })).toBe(0);
  });
});

describe('giving stock back', () => {
  async function orderTwoChai(method: 'WALLET' | 'COUNTER' = 'WALLET') {
    await track(manager, m.chai.id, 10).expect(200);
    if (method === 'WALLET') await fund(s, 50_000);
    await addToCart(s, m.chai.id, 2);
    await addToCart(s, m.puff.id, 1); // untracked: nothing to deduct or restore
    return (await placeOrder(s, method, 7_500).expect(201)).body.order as { id: string };
  }

  it('restores exactly once when the student cancels', async () => {
    const order = await orderTwoChai();
    expect((await row(m.chai.id)).stockQuantity).toBe(8);
    await cancel(s, order.id).expect(200);
    await cancel(s, order.id).expect(409);
    expect((await row(m.chai.id)).stockQuantity).toBe(10);
    const restores = await prisma.stockAdjustment.findMany({ where: { type: 'ORDER_RESTORE' } });
    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatchObject({
      menuItemId: m.chai.id,
      quantityChange: 2,
      resultingQuantity: 10,
    });

    // Even a direct second call gives nothing back twice.
    await prisma
      .$transaction((tx) =>
        restoreForOrder(tx, {
          orderId: order.id,
          actor: { userId: 'x', role: 'STUDENT' },
          reason: 'again',
        }),
      )
      .catch(() => undefined);
    expect((await row(m.chai.id)).stockQuantity).toBe(10);
  });

  it('restores when the outlet rejects an unpaid counter order', async () => {
    const order = await orderTwoChai('COUNTER');
    await transition(manager, m.outlet.id, order.id, 'REJECTED', 'Kitchen closed').expect(200);
    expect((await row(m.chai.id)).stockQuantity).toBe(10);
    expect(await prisma.stockAdjustment.count({ where: { type: 'ORDER_RESTORE' } })).toBe(1);
  });

  it('keeps stock deducted for orders that are fulfilled', async () => {
    const order = await orderTwoChai();
    for (const to of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) {
      await transition(cashier, m.outlet.id, order.id, to).expect(200);
    }
    expect((await row(m.chai.id)).stockQuantity).toBe(8);
    expect(await prisma.stockAdjustment.count({ where: { type: 'ORDER_RESTORE' } })).toBe(0);
  });

  it('records a restoration without inventing stock if tracking was switched off', async () => {
    const order = await orderTwoChai();
    await send(manager, 'post', `${base()}/${m.chai.id}/tracking`, { enabled: false }).expect(200);
    await cancel(s, order.id).expect(200);
    expect((await row(m.chai.id)).stockQuantity).toBeNull();
    expect(
      await prisma.stockAdjustment.findFirstOrThrow({ where: { type: 'ORDER_RESTORE' } }),
    ).toMatchObject({
      quantityChange: 0,
      resultingQuantity: null,
    });
  });
});

describe('recommendations respect stock', () => {
  it('keeps sold-out items out of Surprise Meal combos and Today’s Special polls', async () => {
    await track(manager, m.chai.id, 1).expect(200);
    await adjust(manager, m.chai.id, { type: 'REMOVAL', quantity: 1, reason: 'Gone' }).expect(200);
    for (let i = 0; i < 10; i++) {
      const { body } = await post(s, '/surprise-meal/generate', {
        budgetPaise: 10_000,
        mood: 'CAFE_TREAT',
        diet: 'ANY',
        outletId: m.outlet.id,
      }).expect(200);
      expect(body.combo.items.map((d: { id: string }) => d.id)).not.toContain(m.chai.id);
    }
    const now = Date.now();
    const poll = await post(manager, `/staff/outlets/${m.outlet.id}/polls`, {
      day: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now + 3_600_000),
      opensAt: new Date(now - 60_000).toISOString(),
      closesAt: new Date(now + 3_600_000).toISOString(),
      menuItemIds: [m.chai.id, m.puff.id],
    });
    expect(poll.status).toBe(400);
    expect(poll.body.error.details.invalidMenuItemIds).toEqual([m.chai.id]);
  });

  it('a low-stock item can still be recommended', async () => {
    await track(manager, m.chai.id, 2, 5).expect(200);
    const seen = new Set<string>();
    for (let i = 0; i < 15; i++) {
      const { body } = await post(s, '/surprise-meal/generate', {
        budgetPaise: 6_000,
        mood: 'CAFE_TREAT',
        diet: 'ANY',
        outletId: m.outlet.id,
      }).expect(200);
      for (const d of body.combo.items) seen.add(d.id);
    }
    expect(seen.has(m.chai.id)).toBe(true);
  });

  it('a sold-out dish can’t be added to the cart as part of a combo', async () => {
    await track(manager, m.chai.id, 1).expect(200);
    await adjust(manager, m.chai.id, { type: 'REMOVAL', quantity: 1, reason: 'Gone' }).expect(200);
    const res = await s
      .post('/api/v1/cart/combo')
      .set('X-Requested-With', 'CampusCart')
      .set('Idempotency-Key', key())
      .send({ items: [{ menuItemId: m.chai.id, quantity: 1 }], expectedTotalPaise: 2_000 })
      .expect(409);
    expect(res.body.error.code).toBe('ITEMS_UNAVAILABLE');
  });
});
