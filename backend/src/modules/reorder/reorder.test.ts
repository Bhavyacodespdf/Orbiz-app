import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import {
  addToCart,
  fund,
  key,
  menu,
  placeOrder,
  student,
  type Agent,
} from '../../tests/commerce.js';
import { makeCategory, makeItem, makeOutlet } from '../../tests/fixtures.js';
import { cancel, staffApp, staffFor, transition } from '../../tests/staff.js';
import {
  comboName,
  comboScore,
  mealTimeOf,
  mineCandidates,
  recencyScore,
  type HistoryOrder,
} from './reorder.rules.js';

let m: Awaited<ReturnType<typeof menu>>;
let manager: Agent;
let asha: Agent;
let ben: Agent;
let n = 0;

const api = (
  agent: Agent,
  method: 'get' | 'post' | 'patch' | 'delete',
  url: string,
  body?: object,
  idem?: string,
) => {
  const req = agent[method](`/api/v1${url}`).set('X-Requested-With', 'CampusCart');
  if (idem) req.set('Idempotency-Key', idem);
  return body ? req.send(body) : req;
};

beforeEach(async () => {
  await resetDatabase();
  n += 1;
  m = await menu(); // Night Owl Café: Chai ₹20, Puff ₹35
  ({ manager } = await staffFor(m.outlet.id));
  asha = await student(`asha${n}@example.com`, staffApp);
  ben = await student(`ben${n}@example.com`, staffApp);
});

/** A collected wallet order with these dishes (quantities), placed through the real flow. */
async function collected(
  agent: Agent,
  lines: { id: string; qty: number; price: number }[],
  until: 'COMPLETED' | 'CANCELLED' | 'PLACED' = 'COMPLETED',
) {
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  await fund(agent, Math.max(10_000, total));
  for (const l of lines) await addToCart(agent, l.id, l.qty);
  const order = (await placeOrder(agent, 'WALLET', total).expect(201)).body.order as {
    id: string;
  };
  if (until === 'CANCELLED') await cancel(agent, order.id).expect(200);
  if (until === 'COMPLETED') {
    for (const to of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) {
      await transition(manager, m.outlet.id, order.id, to).expect(200);
    }
  }
  return order;
}
const chaiAndPuff = () => [
  { id: m.chai.id, qty: 2, price: 2000 },
  { id: m.puff.id, qty: 1, price: 3500 },
];
const daysAgo = (orderId: string, days: number) =>
  prisma.order.update({
    where: { id: orderId },
    data: { placedAt: new Date(Date.now() - days * 86_400_000) },
  });
const clearCart = (agent: Agent) => api(agent, 'delete', '/cart');
const cart = async (agent: Agent) => (await api(agent, 'get', '/cart').expect(200)).body.cart;

describe('reorder history', () => {
  it('lists the student’s own collected orders with live prices and availability', async () => {
    const order = await collected(asha, chaiAndPuff());
    await collected(ben, [{ id: m.puff.id, qty: 3, price: 3500 }]);
    await prisma.menuItem.update({ where: { id: m.chai.id }, data: { pricePaise: 2500 } });

    const res = await api(asha, 'get', '/reorder/history').expect(200);
    expect(res.body.windowDays).toBe(90);
    expect(res.body.orders).toHaveLength(1);
    const card = res.body.orders[0];
    expect(card).toMatchObject({
      orderId: order.id,
      previousTotalPaise: 7500,
      historicalTotalPaise: 7500,
      currentTotalPaise: 8500, // 2 × ₹25 + ₹35
      timesOrdered: 1,
      unchanged: false,
      outlet: { name: 'Night Owl Café', acceptingOrders: true },
    });
    expect(card.label).toMatch(/^Your previous (breakfast|lunch|snack|dinner|late-night)$/);
    const chai = card.lines.find((l: { name: string }) => l.name === 'Chai');
    expect(chai).toMatchObject({
      requestedQuantity: 2,
      addableQuantity: 2,
      status: 'AVAILABLE',
      historicalUnitPricePaise: 2000,
      currentUnitPricePaise: 2500,
      priceChanged: true,
    });
    // Ben's order never appears in Asha's history.
    expect(JSON.stringify(res.body)).not.toContain('"requestedQuantity":3');
  });

  it('folds identical repeats into one card and leaves out cancelled and open orders', async () => {
    await collected(asha, chaiAndPuff());
    await collected(asha, chaiAndPuff());
    await collected(asha, [{ id: m.puff.id, qty: 1, price: 3500 }], 'CANCELLED');
    await collected(asha, [{ id: m.chai.id, qty: 1, price: 2000 }], 'PLACED');
    const res = await api(asha, 'get', '/reorder/history').expect(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].timesOrdered).toBe(2);
  });

  it('requires a signed-in student', async () => {
    const { default: request } = await import('supertest');
    await request(staffApp).get('/api/v1/reorder/history').expect(401);
    await request(staffApp).get('/api/v1/reorder/combos').expect(401);
  });
});

describe('preview', () => {
  it('refuses another student’s order with 404 and cancelled orders with 409', async () => {
    const mine = await collected(asha, chaiAndPuff());
    await api(ben, 'post', '/reorder/preview', { orderId: mine.id }).expect(404);
    const cancelled = await collected(ben, chaiAndPuff(), 'CANCELLED');
    const res = await api(ben, 'post', '/reorder/preview', { orderId: cancelled.id }).expect(409);
    expect(res.body.error.code).toBe('ORDER_NOT_REORDERABLE');
    const open = await collected(ben, chaiAndPuff(), 'PLACED');
    await api(ben, 'post', '/reorder/preview', { orderId: open.id }).expect(409);
  });

  it('reports sold-out, removed and low-stock dishes, with same-category alternatives', async () => {
    const samosa = await makeItem(m.outlet.id, m.category.id, { name: 'Samosa', pricePaise: 1500 });
    const order = await collected(asha, [
      { id: m.chai.id, qty: 3, price: 2000 },
      { id: m.puff.id, qty: 1, price: 3500 },
      { id: samosa.id, qty: 1, price: 1500 },
    ]);
    await prisma.menuItem.update({
      where: { id: m.chai.id },
      data: { trackInventory: true, stockQuantity: 2 },
    });
    await prisma.menuItem.update({ where: { id: m.puff.id }, data: { isAvailable: false } });
    await prisma.menuItem.update({ where: { id: samosa.id }, data: { isActive: false } });
    const veg = await makeItem(m.outlet.id, m.category.id, { name: 'Veg roll', pricePaise: 4000 });

    const { preview } = (
      await api(asha, 'post', '/reorder/preview', { orderId: order.id }).expect(200)
    ).body;
    const byName = (name: string) => preview.lines.find((l: { name: string }) => l.name === name);
    expect(byName('Chai')).toMatchObject({
      status: 'LIMITED',
      limitReason: 'STOCK',
      requestedQuantity: 3,
      addableQuantity: 2,
    });
    expect(byName('Puff')).toMatchObject({ status: 'SOLD_OUT', addableQuantity: 0 });
    expect(byName('Samosa')).toMatchObject({ status: 'NO_LONGER_ON_MENU', addableQuantity: 0 });
    // Offered, not substituted: alternatives from the same outlet and category, in stock.
    expect(byName('Puff').alternatives.map((a: { name: string }) => a.name)).toEqual(['Veg roll']);
    expect(byName('Puff').alternatives[0].menuItemId).toBe(veg.id);
    expect(preview).toMatchObject({ addableCount: 1, currentTotalPaise: 4000, unchanged: false });
  });

  it('offers the dish at another outlet only when that outlet has it in stock and is open', async () => {
    const order = await collected(asha, [{ id: m.chai.id, qty: 1, price: 2000 }]);
    await prisma.outlet.update({ where: { id: m.outlet.id }, data: { status: 'CLOSED' } });
    const other = await makeOutlet({ name: 'Juice Junction', status: 'OPEN' });
    const cat = await makeCategory(other.id, 'Drinks');
    const otherChai = await makeItem(other.id, cat.id, { name: 'chai', pricePaise: 2200 });
    const closed = await makeOutlet({ name: 'Closed Corner', status: 'CLOSED' });
    const closedCat = await makeCategory(closed.id, 'Drinks');
    await makeItem(closed.id, closedCat.id, { name: 'Chai', pricePaise: 1000 });

    const { preview } = (
      await api(asha, 'post', '/reorder/preview', { orderId: order.id }).expect(200)
    ).body;
    expect(preview.outlet.acceptingOrders).toBe(false);
    expect(preview.lines[0]).toMatchObject({ status: 'OUTLET_UNAVAILABLE', alternatives: [] });
    expect(preview.lines[0].elsewhere).toEqual([
      {
        menuItemId: otherChai.id,
        name: 'chai',
        pricePaise: 2200,
        outlet: { id: other.id, name: 'Juice Junction', slug: other.slug },
      },
    ]);
  });

  it('checks customised items: real dishes from one outlet only', async () => {
    const other = await makeOutlet({ name: 'Juice Junction', status: 'OPEN' });
    const cat = await makeCategory(other.id, 'Drinks');
    const juice = await makeItem(other.id, cat.id, { name: 'Orange juice', pricePaise: 5000 });
    const mixed = await api(asha, 'post', '/reorder/preview', {
      items: [
        { menuItemId: m.chai.id, quantity: 1 },
        { menuItemId: juice.id, quantity: 1 },
      ],
    }).expect(400);
    expect(mixed.body.error.code).toBe('MIXED_OUTLETS');
    await api(asha, 'post', '/reorder/preview', {
      items: [{ menuItemId: crypto.randomUUID(), quantity: 1 }],
    }).expect(404);
    await api(asha, 'post', '/reorder/preview', {
      items: [{ menuItemId: m.chai.id, quantity: 11 }],
    }).expect(400);
    const ok = await api(asha, 'post', '/reorder/preview', {
      items: [
        { menuItemId: m.chai.id, quantity: 3 },
        { menuItemId: m.puff.id, quantity: 1 },
      ],
    }).expect(200);
    expect(ok.body.preview).toMatchObject({ currentTotalPaise: 9500, historicalTotalPaise: null });
  });
});

describe('adding to the cart', () => {
  it('adds a completed order at current prices, once per idempotency key, and records it once', async () => {
    const order = await collected(asha, chaiAndPuff());
    await prisma.menuItem.update({ where: { id: m.puff.id }, data: { pricePaise: 4000 } });
    const { preview } = (
      await api(asha, 'post', '/reorder/preview', { orderId: order.id }).expect(200)
    ).body;
    const body = {
      items: preview.lines.map((l: { menuItemId: string; addableQuantity: number }) => ({
        menuItemId: l.menuItemId,
        quantity: l.addableQuantity,
      })),
      expectedTotalPaise: preview.currentTotalPaise,
      source: { type: 'ORDER', orderId: order.id },
    };
    expect(body.expectedTotalPaise).toBe(8000);
    const k = key();
    const results = await Promise.all(
      [1, 2, 3].map(() => api(asha, 'post', '/reorder/cart', body, k)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    const c = await cart(asha);
    expect(c.items.map((i: { name: string; quantity: number }) => [i.name, i.quantity])).toEqual(
      expect.arrayContaining([
        ['Chai', 2],
        ['Puff', 1],
      ]),
    );
    expect(c.subtotalPaise).toBe(8000);
    expect(await prisma.reorderEvent.count()).toBe(1);
    expect(await prisma.reorderEvent.findFirstOrThrow()).toMatchObject({
      source: 'ORDER',
      orderId: order.id,
      itemCount: 3,
      totalPaise: 8000,
    });
    // Nothing was charged or ordered: still just one (the original) order.
    expect(await prisma.order.count({ where: { userId: (await me(asha)).id } })).toBe(1);
  });

  it('refuses a stale total, an unavailable dish and another student’s order as the source', async () => {
    const order = await collected(asha, chaiAndPuff());
    const items = [
      { menuItemId: m.chai.id, quantity: 2 },
      { menuItemId: m.puff.id, quantity: 1 },
    ];
    const stale = await api(
      asha,
      'post',
      '/reorder/cart',
      { items, expectedTotalPaise: 6000, source: { type: 'ORDER', orderId: order.id } },
      key(),
    ).expect(409);
    expect(stale.body.error.code).toBe('PRICE_CHANGED');

    await prisma.menuItem.update({ where: { id: m.puff.id }, data: { isAvailable: false } });
    const gone = await api(
      asha,
      'post',
      '/reorder/cart',
      { items, expectedTotalPaise: 7500, source: { type: 'ORDER', orderId: order.id } },
      key(),
    ).expect(409);
    expect(gone.body.error.code).toBe('ITEMS_UNAVAILABLE');

    await api(
      ben,
      'post',
      '/reorder/cart',
      {
        items: [{ menuItemId: m.chai.id, quantity: 1 }],
        expectedTotalPaise: 2000,
        source: { type: 'ORDER', orderId: order.id },
      },
      key(),
    ).expect(404);
    expect((await cart(asha)).items).toHaveLength(0);
    expect((await cart(ben)).items).toHaveLength(0);
    await api(asha, 'post', '/reorder/cart', {
      items,
      expectedTotalPaise: 7500,
      source: { type: 'SUGGESTED_COMBO' },
    }).expect(400); // no Idempotency-Key
  });

  it('partial reorder: only the dishes still available are added', async () => {
    const order = await collected(asha, chaiAndPuff());
    await prisma.menuItem.update({ where: { id: m.puff.id }, data: { isAvailable: false } });
    const { preview } = (
      await api(asha, 'post', '/reorder/preview', { orderId: order.id }).expect(200)
    ).body;
    const addable = preview.lines.filter((l: { addableQuantity: number }) => l.addableQuantity > 0);
    expect(addable).toHaveLength(1);
    await api(
      asha,
      'post',
      '/reorder/cart',
      {
        items: addable.map((l: { menuItemId: string; addableQuantity: number }) => ({
          menuItemId: l.menuItemId,
          quantity: l.addableQuantity,
        })),
        expectedTotalPaise: preview.currentTotalPaise,
        source: { type: 'ORDER', orderId: order.id },
      },
      key(),
    ).expect(201);
    expect((await cart(asha)).items.map((i: { name: string }) => i.name)).toEqual(['Chai']);
  });

  it('follows the one-outlet cart rule and enforces stock and quantity limits', async () => {
    const order = await collected(asha, chaiAndPuff());
    const other = await makeOutlet({ name: 'Juice Junction', status: 'OPEN' });
    const cat = await makeCategory(other.id, 'Drinks');
    const juice = await makeItem(other.id, cat.id, { name: 'Orange juice', pricePaise: 5000 });
    await addToCart(asha, juice.id);
    const body = {
      items: [
        { menuItemId: m.chai.id, quantity: 2 },
        { menuItemId: m.puff.id, quantity: 1 },
      ],
      expectedTotalPaise: 7500,
      source: { type: 'ORDER', orderId: order.id },
    };
    const conflict = await api(asha, 'post', '/reorder/cart', body, key()).expect(409);
    expect(conflict.body.error.code).toBe('CART_OUTLET_CONFLICT');
    expect((await cart(asha)).items.map((i: { name: string }) => i.name)).toEqual(['Orange juice']);
    await api(asha, 'post', '/reorder/cart', { ...body, replaceCart: true }, key()).expect(201);
    expect((await cart(asha)).outlet.name).toBe('Night Owl Café');

    // Already 9 chai in the cart: 2 more would pass the per-item limit of 10.
    await clearCart(asha);
    await addToCart(asha, m.chai.id, 9);
    const limit = await api(asha, 'post', '/reorder/cart', body, key()).expect(409);
    expect(limit.body.error.code).toBe('QUANTITY_LIMIT');

    await clearCart(asha);
    await prisma.menuItem.update({
      where: { id: m.chai.id },
      data: { trackInventory: true, stockQuantity: 1 },
    });
    const stock = await api(asha, 'post', '/reorder/cart', body, key()).expect(409);
    expect(stock.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await cart(asha)).items).toHaveLength(0);
  });

  it('goes through normal checkout, which still applies the outlet capacity limit and keeps the cart', async () => {
    const order = await collected(asha, chaiAndPuff());
    await api(
      asha,
      'post',
      '/reorder/cart',
      {
        items: [
          { menuItemId: m.chai.id, quantity: 2 },
          { menuItemId: m.puff.id, quantity: 1 },
        ],
        expectedTotalPaise: 7500,
        source: { type: 'ORDER', orderId: order.id },
      },
      key(),
    ).expect(201);
    // Reordering reserved nothing: stock and capacity are only used at checkout.
    expect(await prisma.outletOrderAcceptance.count()).toBe(1); // the original order
    // Fill the outlet: 9 more orders in the window (10 with the original).
    for (let i = 0; i < 9; i++) {
      const s = await student(`filler${n}-${i}@example.com`, staffApp);
      await addToCart(s, m.chai.id);
      await placeOrder(s, 'COUNTER', 2000).expect(201);
    }
    const full = await placeOrder(asha, 'WALLET', 7500).expect(429);
    expect(full.body.error.code).toBe('ORDER_CAPACITY_FULL');
    expect((await cart(asha)).itemCount).toBe(3);
    await fund(asha, 10_000);
    // Room again: the reordered cart checks out normally and is counted once.
    await prisma.$executeRaw`UPDATE "OutletOrderAcceptance" SET "acceptedAt" = "acceptedAt" - interval '4 minutes'`;
    const placed = await placeOrder(asha, 'WALLET', 7500).expect(201);
    expect(
      await prisma.outletOrderAcceptance.count({ where: { orderId: placed.body.order.id } }),
    ).toBe(1);
  });
});

async function me(agent: Agent) {
  return (await api(agent, 'get', '/auth/me').expect(200)).body.user as { id: string };
}

describe('favourite combos', () => {
  it('finds dishes ordered together, with counts over a stated window', async () => {
    const samosa = await makeItem(m.outlet.id, m.category.id, { name: 'Samosa', pricePaise: 1500 });
    const a = await collected(asha, chaiAndPuff());
    const b = await collected(asha, chaiAndPuff());
    const c = await collected(asha, [
      { id: m.chai.id, qty: 1, price: 2000 },
      { id: samosa.id, qty: 1, price: 1500 },
    ]);
    await daysAgo(a.id, 10);
    await daysAgo(b.id, 3);
    await daysAgo(c.id, 1);
    // Ben's habits never leak into Asha's combos.
    await collected(ben, [{ id: samosa.id, qty: 1, price: 1500 }]);
    await collected(ben, [{ id: samosa.id, qty: 1, price: 1500 }]);

    const res = await api(asha, 'get', '/reorder/combos').expect(200);
    expect(res.body).toMatchObject({ personalized: true, windowDays: 90, popular: [] });
    // By the documented score, chai (in all 3 orders, most recently yesterday) ranks first.
    expect(res.body.combos.map((c: { name: string }) => c.name)).toEqual([
      'Your usual Chai',
      'Chai + Puff',
    ]);
    const [usual, basket] = res.body.combos;
    expect(usual).toMatchObject({
      kind: 'SINGLE',
      explanation: 'Ordered 3 times in the last 90 days',
      timesOrdered: 3,
      currentTotalPaise: 2000, // one chai, as in the latest order with it
    });
    expect(basket).toMatchObject({
      kind: 'BASKET',
      explanation: 'Ordered together 2 times in the last 90 days',
      timesOrdered: 2,
      currentTotalPaise: 7500,
    });
    expect(usual.score).toBeGreaterThan(basket.score);
    // Samosa was bought once: never suggested.
    expect(JSON.stringify(res.body.combos)).not.toContain('Samosa');
  });

  it('ignores orders outside the 90-day window and never suggests an unavailable combo', async () => {
    const a = await collected(asha, chaiAndPuff());
    const b = await collected(asha, chaiAndPuff());
    await daysAgo(a.id, 120);
    expect((await api(asha, 'get', '/reorder/combos').expect(200)).body.personalized).toBe(false);
    await daysAgo(a.id, 5);
    await daysAgo(b.id, 2);
    await prisma.menuItem.updateMany({ data: { isAvailable: false } });
    const res = await api(asha, 'get', '/reorder/combos').expect(200);
    expect(res.body.combos).toEqual([]);
  });

  it('falls back to popular dishes from aggregate data (3+ students), clearly not personal', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await student(`pop${n}-${i}@example.com`, staffApp);
      await collected(s, [{ id: m.puff.id, qty: 1, price: 3500 }]);
    }
    // Chai: only two students — below the threshold, never shown.
    await collected(ben, [{ id: m.chai.id, qty: 1, price: 2000 }]);
    await collected(await student(`one${n}@example.com`, staffApp), [
      { id: m.chai.id, qty: 1, price: 2000 },
    ]);
    const res = await api(asha, 'get', '/reorder/combos').expect(200);
    expect(res.body.personalized).toBe(false);
    expect(res.body.combos).toEqual([]);
    expect(res.body.popular.map((p: { name: string }) => p.name)).toEqual(['Puff']);
    expect(res.body.popular[0].explanation).toBe('Collected by 3 students in the last 30 days');
    expect(JSON.stringify(res.body)).not.toContain('@example.com');
  });
});

describe('combo rules (pure)', () => {
  const at = (iso: string) => new Date(iso);
  const order = (id: string, placedAt: string, ids: string[]): HistoryOrder => ({
    id,
    outletId: 'o1',
    placedAt: at(placedAt),
    lines: ids.map((x) => ({ menuItemId: x, name: x.toUpperCase(), quantity: 1 })),
  });

  it('counts co-occurrence, frequency, usual meal time and weekday deterministically', () => {
    // Three Tuesday lunches (IST) with a + b, one with c too.
    const orders = [
      order('1', '2026-10-06T07:00:00Z', ['a', 'b']),
      order('2', '2026-10-13T07:30:00Z', ['a', 'b', 'c']),
      order('3', '2026-09-29T06:45:00Z', ['b', 'a']),
      order('4', '2026-10-15T15:00:00Z', ['c']),
    ];
    const cands = mineCandidates(orders);
    const pair = cands.find((c) => c.key === 'PAIR:o1:a,b')!;
    expect(pair).toMatchObject({ support: 3, usualMealTime: 'lunch', usualWeekday: 'Tuesdays' });
    expect(pair.itemFrequency).toBeCloseTo(0.75);
    // a and b alone appear exactly as often as the pair: folded into it. The pair (3 orders)
    // beats the exact a+b basket (2 orders) for the same dishes.
    expect(cands.map((c) => c.key)).toEqual(['PAIR:o1:a,b', 'SINGLE:o1:c']);
    expect(mineCandidates(orders)).toEqual(cands);
    expect(mineCandidates([])).toEqual([]);
  });

  it('needs at least two matching orders (insufficient history gives nothing)', () => {
    expect(mineCandidates([order('1', '2026-10-06T07:00:00Z', ['a', 'b'])])).toEqual([]);
  });

  it('scores support, recency and availability as documented', () => {
    expect(recencyScore(0)).toBe(1);
    expect(recencyScore(14)).toBeCloseTo(0.5);
    const full = comboScore({ support: 3, daysSinceLast: 0, itemFrequency: 1, availableShare: 1 });
    expect(full).toBe(2 * 3 + 3 + 1);
    const half = comboScore({
      support: 3,
      daysSinceLast: 0,
      itemFrequency: 1,
      availableShare: 0.5,
    });
    expect(half).toBeCloseTo(10 * 0.625);
    expect(mealTimeOf(at('2026-10-06T07:00:00Z'))).toBe('lunch'); // 12:30 IST
    expect(mealTimeOf(at('2026-10-06T15:00:00Z'))).toBe('dinner'); // 20:30 IST
    expect(comboName(['Chai', 'Puff', 'Samosa', 'Roll'])).toBe('Chai, Puff + 2 more');
  });
});

describe('saved combos', () => {
  const items = () => [
    { menuItemId: m.chai.id, quantity: 2 },
    { menuItemId: m.puff.id, quantity: 1 },
  ];

  it('saves, lists with live prices, edits, reorders and deletes — owner only', async () => {
    const created = await api(asha, 'post', '/saved-combos', {
      name: 'Exam fuel',
      items: items(),
    }).expect(201);
    const id = created.body.combo.id;
    expect(created.body.combo).toMatchObject({ name: 'Exam fuel', currentTotalPaise: 7500 });
    await api(asha, 'post', '/saved-combos', { name: 'Exam fuel', items: items() }).expect(409);

    await prisma.menuItem.update({ where: { id: m.chai.id }, data: { pricePaise: 3000 } });
    const list = (await api(asha, 'get', '/saved-combos').expect(200)).body.combos;
    expect(list[0].currentTotalPaise).toBe(9500); // prices are never stored
    expect((await api(ben, 'get', '/saved-combos').expect(200)).body.combos).toEqual([]);

    await api(ben, 'patch', `/saved-combos/${id}`, { name: 'Mine now' }).expect(404);
    await api(ben, 'delete', `/saved-combos/${id}`).expect(404);
    await api(ben, 'post', '/reorder/preview', { savedComboId: id }).expect(404);

    const edited = await api(asha, 'patch', `/saved-combos/${id}`, {
      items: [{ menuItemId: m.puff.id, quantity: 3 }],
    }).expect(200);
    expect(edited.body.combo).toMatchObject({ currentTotalPaise: 10_500 });
    expect(edited.body.combo.lines).toHaveLength(1);

    const { preview } = (
      await api(asha, 'post', '/reorder/preview', { savedComboId: id }).expect(200)
    ).body;
    await api(
      asha,
      'post',
      '/reorder/cart',
      {
        items: [{ menuItemId: m.puff.id, quantity: 3 }],
        expectedTotalPaise: preview.currentTotalPaise,
        source: { type: 'SAVED_COMBO', savedComboId: id },
      },
      key(),
    ).expect(201);

    await api(asha, 'delete', `/saved-combos/${id}`).expect(204);
    expect(await prisma.savedMealCombo.count()).toBe(0);
    // The analytics row survives without the combo.
    expect(await prisma.reorderEvent.findFirstOrThrow()).toMatchObject({
      source: 'SAVED_COMBO',
      savedComboId: null,
    });
  });

  it('refuses dishes from two outlets, removed dishes and bad quantities', async () => {
    const other = await makeOutlet({ name: 'Juice Junction', status: 'OPEN' });
    const cat = await makeCategory(other.id, 'Drinks');
    const juice = await makeItem(other.id, cat.id, { name: 'Orange juice', pricePaise: 5000 });
    await api(asha, 'post', '/saved-combos', {
      name: 'Mixed',
      items: [...items(), { menuItemId: juice.id, quantity: 1 }],
    }).expect(400);
    await prisma.menuItem.update({ where: { id: m.puff.id }, data: { isActive: false } });
    const gone = await api(asha, 'post', '/saved-combos', { name: 'Gone', items: items() }).expect(
      409,
    );
    expect(gone.body.error.code).toBe('ITEMS_UNAVAILABLE');
    await api(asha, 'post', '/saved-combos', {
      name: 'Too many',
      items: [{ menuItemId: m.chai.id, quantity: 0 }],
    }).expect(400);
    await api(asha, 'post', '/saved-combos', { name: '  ', items: items() }).expect(400);
  });
});
