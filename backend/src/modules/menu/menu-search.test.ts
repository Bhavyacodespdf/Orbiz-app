import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { addToCart, fund, menu, placeOrder, student, type Agent } from '../../tests/commerce.js';
import { makeCategory, makeItem, makeOutlet } from '../../tests/fixtures.js';
import { cancel, staffApp, staffFor, transition } from '../../tests/staff.js';
import { bayesianScore, reorderScore } from './menu-search.js';

let m: Awaited<ReturnType<typeof menu>>;
let manager: Agent;
let asha: Agent;
let n = 0;

const anon = () => request(staffApp);
const names = (res: request.Response) => res.body.items.map((i: { name: string }) => i.name);
const campus = (query: string, agent?: Agent) =>
  (agent ?? anon()).get(`/api/v1/menu${query}`).set('X-Requested-With', 'CampusCart');
const outletMenu = (query: string, agent?: Agent) =>
  (agent ?? anon())
    .get(`/api/v1/outlets/${m.outlet.slug}/menu${query}`)
    .set('X-Requested-With', 'CampusCart');

beforeEach(async () => {
  await resetDatabase();
  n += 1;
  m = await menu(); // Night Owl Café · Snacks: Chai ₹20, Puff ₹35
  ({ manager } = await staffFor(m.outlet.id));
  asha = await student(`asha${n}@example.com`, staffApp);
});

/** A collected (or cancelled) wallet order through the real flow. */
async function order(
  agent: Agent,
  lines: { id: string; price: number; qty?: number }[],
  until: 'COMPLETED' | 'CANCELLED' = 'COMPLETED',
  outletId = m.outlet.id,
) {
  await fund(agent, 10_000);
  for (const l of lines) await addToCart(agent, l.id, l.qty ?? 1);
  const total = lines.reduce((s, l) => s + l.price * (l.qty ?? 1), 0);
  const o = (await placeOrder(agent, 'WALLET', total).expect(201)).body.order as { id: string };
  if (until === 'CANCELLED') await cancel(agent, o.id).expect(200);
  else
    for (const to of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED'])
      await transition(manager, outletId, o.id, to).expect(200);
  return o;
}

/** A published (or hidden) review from a new student, tied to a real collected order. */
async function review(itemId: string, rating: number, orderId: string, status = 'PUBLISHED') {
  n += 1;
  const user = await prisma.user.create({
    data: { email: `r${n}-${Math.random()}@example.com`, emailVerified: true, displayName: 'R' },
  });
  const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: itemId } });
  await prisma.foodReview.create({
    data: {
      userId: user.id,
      menuItemId: itemId,
      outletId: item.outletId,
      orderId,
      rating,
      status: status as 'PUBLISHED' | 'HIDDEN',
      ...(status === 'HIDDEN' && { moderatedById: user.id, moderatedAt: new Date() }),
    },
  });
}

describe('search', () => {
  it('matches dish, category and outlet names case-insensitively and in part', async () => {
    const other = await makeOutlet({ name: 'Paneer Palace', status: 'OPEN' });
    const wraps = await makeCategory(other.id, 'Wraps');
    await makeItem(other.id, wraps.id, { name: 'Tikka Roll', pricePaise: 9000 });
    await makeItem(m.outlet.id, m.category.id, { name: 'Paneer Puff', pricePaise: 4000 });

    expect(names(await campus('?q=PANEER').expect(200)).sort()).toEqual([
      'Paneer Puff',
      'Tikka Roll',
    ]);
    expect(names(await campus('?q=rap').expect(200))).toEqual(['Tikka Roll']); // category "Wraps"
    expect(names(await campus('?q=haI').expect(200))).toEqual(['Chai']);
    // The outlet menu searches its dishes and categories (not other outlets).
    expect(names(await outletMenu('?q=snack').expect(200)).sort()).toEqual([
      'Chai',
      'Paneer Puff',
      'Puff',
    ]);
    const none = await campus('?q=sushi').expect(200);
    expect(none.body).toMatchObject({ items: [], total: 0, hasMore: false });
  });

  it('rejects invalid parameters', async () => {
    await campus('?sort=cheapest').expect(400);
    await campus('?outletId=nope').expect(400);
    await campus('?pageSize=500').expect(400);
    await campus('?page=0').expect(400);
    await campus(`?q=${'x'.repeat(61)}`).expect(400);
    await outletMenu('?inStock=maybe').expect(400);
  });
});

describe('price sorting', () => {
  it('orders by current price both ways, with sold-out dishes after orderable ones and stable ties', async () => {
    await makeItem(m.outlet.id, m.category.id, { name: 'Bun', pricePaise: 2000 }); // same as Chai
    const samosa = await makeItem(m.outlet.id, m.category.id, { name: 'Samosa', pricePaise: 1000 });
    await prisma.menuItem.update({ where: { id: samosa.id }, data: { isAvailable: false } });
    // A price change applies at once: sorting uses live prices, not old orders.
    await order(asha, [{ id: m.puff.id, price: 3500 }]);
    await prisma.menuItem.update({ where: { id: m.puff.id }, data: { pricePaise: 1500 } });

    expect(names(await outletMenu('?sort=price-asc').expect(200))).toEqual([
      'Puff',
      'Bun',
      'Chai',
      'Samosa',
    ]);
    expect(names(await outletMenu('?sort=price-desc').expect(200))).toEqual([
      'Bun',
      'Chai',
      'Puff',
      'Samosa',
    ]);
    // In stock only drops the sold-out dish.
    expect(names(await outletMenu('?sort=price-asc&inStock=true').expect(200))).toEqual([
      'Puff',
      'Bun',
      'Chai',
    ]);
    const prices = (await outletMenu('?sort=price-asc').expect(200)).body.items.map(
      (i: { pricePaise: number }) => i.pricePaise,
    );
    expect(prices.every(Number.isInteger)).toBe(true);
  });
});

describe('popular', () => {
  it('counts distinct collected orders in 30 days, ignoring cancelled and old orders', async () => {
    const samosa = await makeItem(m.outlet.id, m.category.id, { name: 'Samosa', pricePaise: 1000 });
    const ben = await student(`ben${n}@example.com`, staffApp);
    const cy = await student(`cy${n}@example.com`, staffApp);
    for (const who of [asha, ben, cy]) await order(who, [{ id: m.puff.id, price: 3500, qty: 2 }]);
    await order(asha, [{ id: m.chai.id, price: 2000 }]);
    // Cancelled orders never count; nor do orders older than the window.
    for (const who of [asha, ben, cy])
      await order(who, [{ id: samosa.id, price: 1000 }], 'CANCELLED');
    const old = await order(ben, [{ id: m.chai.id, price: 2000 }]);
    await prisma.order.update({
      where: { id: old.id },
      data: { placedAt: new Date(Date.now() - 40 * 86_400_000) },
    });

    const res = await outletMenu('?sort=popular').expect(200);
    expect(names(res)).toEqual(['Puff', 'Chai', 'Samosa']);
    expect(res.body.items.map((i: { orders30d: number }) => i.orders30d)).toEqual([3, 1, 0]);
    // A label only with enough real orders.
    expect(res.body.items.map((i: { popular: boolean }) => i.popular)).toEqual([
      true,
      false,
      false,
    ]);
    expect(res.body.popularWindowDays).toBe(30);
    // An order moving through several statuses counts once: 2 puffs in one order = 1.
    expect(res.body.items[0].orders30d).toBe(3);
  });
});

describe('highest rated', () => {
  it('ranks by a Bayesian average, keeps the real average for display, and puts unrated last', async () => {
    const roll = await makeItem(m.outlet.id, m.category.id, { name: 'Roll', pricePaise: 5000 });
    await makeItem(m.outlet.id, m.category.id, { name: 'Bun', pricePaise: 1500 });
    const o = await order(asha, [{ id: m.chai.id, price: 2000 }]);
    // Chai: one perfect review. Puff: ten reviews averaging 4.6. Roll: one 5★ but hidden.
    await review(m.chai.id, 5, o.id);
    for (const r of [5, 5, 5, 5, 5, 5, 4, 4, 4, 4]) await review(m.puff.id, r, o.id);
    await review(roll.id, 5, o.id, 'HIDDEN');

    const res = await outletMenu('?sort=highest-rated').expect(200);
    // Ten reviews at 4.6 rank above a single 5★ (fewer than 3 reviews rank after);
    // hidden reviews don't count, so Roll is unrated and last.
    expect(names(res)).toEqual(['Puff', 'Chai', 'Bun', 'Roll']);
    expect(res.body.items[0].rating).toEqual({ average: 4.6, count: 10 });
    expect(res.body.items[1].rating).toEqual({ average: 5, count: 1 });
    expect(res.body.items[3].rating).toEqual({ average: null, count: 0 });
    // The legacy name still works.
    expect(names(await outletMenu('?sort=rating').expect(200))).toEqual(names(res));
  });

  it('bayesianScore pulls few reviews towards the campus mean', () => {
    expect(bayesianScore(5, 1, 4)).toBeCloseTo(4.25);
    expect(bayesianScore(46, 10, 4)).toBeCloseTo(4.4615, 3);
    expect(bayesianScore(0, 0, 3.5)).toBe(3.5);
  });
});

describe('quick reorder', () => {
  it('puts the student’s own recent and repeated dishes first, with their history', async () => {
    const samosa = await makeItem(m.outlet.id, m.category.id, { name: 'Samosa', pricePaise: 1000 });
    const p1 = await order(asha, [{ id: m.puff.id, price: 3500 }]);
    const p2 = await order(asha, [{ id: m.puff.id, price: 3500 }]);
    await order(asha, [{ id: samosa.id, price: 1000 }]);
    await order(asha, [{ id: m.chai.id, price: 2000 }], 'CANCELLED');
    // Puff twice, 20 days ago; samosa once, today.
    for (const id of [p1.id, p2.id]) {
      await prisma.order.update({
        where: { id },
        data: { placedAt: new Date(Date.now() - 20 * 86_400_000) },
      });
    }
    const res = await outletMenu('?sort=quick-reorder', asha).expect(200);
    // Samosa: 1 + 3·1 = 4; puff: 2 + 3·0.37 ≈ 3.1; chai (cancelled only) after.
    expect(names(res)).toEqual(['Samosa', 'Puff', 'Chai']);
    expect(res.body.items[0].mine).toMatchObject({ orders: 1 });
    expect(res.body.items[1].mine).toMatchObject({ orders: 2 });
    expect(res.body.items[2].mine).toBeNull();
    expect(res.body.quickReorder).toEqual({ signedIn: true, hasHistory: true, windowDays: 90 });
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(reorderScore(1, 0)).toBe(4);
  });

  it('never uses another student’s history, and degrades gracefully when signed out or new', async () => {
    await order(asha, [{ id: m.puff.id, price: 3500 }]);
    const ben = await student(`ben${n}@example.com`, staffApp);
    const benView = await outletMenu('?sort=quick-reorder', ben).expect(200);
    expect(benView.body.quickReorder).toEqual({
      signedIn: true,
      hasHistory: false,
      windowDays: 90,
    });
    expect(benView.body.items.every((i: { mine: unknown }) => i.mine === null)).toBe(true);
    expect(names(benView)).toEqual(['Chai', 'Puff']); // normal fallback order (by name)

    const signedOut = await outletMenu('?sort=quick-reorder').expect(200);
    expect(signedOut.body.quickReorder).toMatchObject({ signedIn: false, hasHistory: false });
    expect(names(signedOut)).toHaveLength(2);
  });
});

describe('combining and paging', () => {
  it('applies outlet, category, search, dietary and sort together on the campus menu', async () => {
    const palace = await makeOutlet({ name: 'Central Food Atrium', status: 'OPEN' });
    const mains = await makeCategory(palace.id, 'Mains');
    const drinks = await makeCategory(palace.id, 'Drinks');
    const tikka = await makeItem(palace.id, mains.id, {
      name: 'Paneer Tikka Wrap',
      pricePaise: 9000,
    });
    const butter = await makeItem(palace.id, mains.id, {
      name: 'Paneer Butter Masala',
      pricePaise: 12000,
    });
    await makeItem(palace.id, drinks.id, { name: 'Paneer Shake', pricePaise: 6000 });
    await makeItem(m.outlet.id, m.category.id, { name: 'Paneer Puff', pricePaise: 4000 });
    await prisma.menuItem.update({ where: { id: butter.id }, data: { dietary: 'VEG' } });
    await prisma.menuItem.update({ where: { id: tikka.id }, data: { dietary: 'VEG' } });
    const o = await order(asha, [{ id: m.chai.id, price: 2000 }]);
    for (const r of [4, 4, 4]) await review(tikka.id, r, o.id);
    for (const r of [5, 5, 5]) await review(butter.id, r, o.id);

    const res = await campus(
      `?outletId=${palace.id}&category=${mains.id}&q=paneer&dietary=VEG&sort=highest-rated`,
    ).expect(200);
    expect(names(res)).toEqual(['Paneer Butter Masala', 'Paneer Tikka Wrap']);
    expect(res.body.items[0].outlet.name).toBe('Central Food Atrium');
    expect(res.body.filters.categories.map((c: { name: string }) => c.name)).toEqual([
      'Drinks',
      'Mains',
    ]);
    expect(res.body.total).toBe(2);
  });

  it('pages with stable order and no overlaps', async () => {
    for (let i = 0; i < 7; i++) {
      await makeItem(m.outlet.id, m.category.id, { name: `Same ${i}`, pricePaise: 1000 });
    }
    const pages = [];
    for (let page = 1; page <= 3; page++) {
      pages.push(await campus(`?sort=price-asc&pageSize=4&page=${page}`).expect(200));
    }
    expect(pages[0]!.body).toMatchObject({ total: 9, page: 1, pageSize: 4, hasMore: true });
    expect(pages[2]!.body.hasMore).toBe(false);
    const all = pages.flatMap((p) => names(p));
    expect(all).toEqual([
      'Same 0',
      'Same 1',
      'Same 2',
      'Same 3',
      'Same 4',
      'Same 5',
      'Same 6',
      'Chai',
      'Puff',
    ]);
    // Same request twice: same order.
    expect(names(await campus('?sort=price-asc&pageSize=4&page=2').expect(200))).toEqual(
      names(pages[1]!),
    );
  });

  it('never shows hidden dishes, categories or outlets', async () => {
    const gone = await makeItem(m.outlet.id, m.category.id, { name: 'Gone', pricePaise: 1000 });
    await prisma.menuItem.update({ where: { id: gone.id }, data: { isActive: false } });
    const archived = await makeOutlet({ name: 'Archived Annex', status: 'OPEN' });
    const cat = await makeCategory(archived.id, 'Food');
    await makeItem(archived.id, cat.id, { name: 'Ghost Roll', pricePaise: 1000 });
    await prisma.outlet.update({ where: { id: archived.id }, data: { isActive: false } });
    const res = await campus('?sort=popular').expect(200);
    expect(names(res).sort()).toEqual(['Chai', 'Puff']);
    expect(res.body.filters.outlets.map((o: { name: string }) => o.name)).toEqual([
      'Night Owl Café',
    ]);
  });
});
