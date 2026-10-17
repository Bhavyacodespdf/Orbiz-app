import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { createApp } from '../../app.js';
import { devLogin, testConfig } from '../../tests/helpers.js';
import { makeCategory, makeItem, makeOutlet } from '../../tests/fixtures.js';
import { key, type Agent } from '../../tests/commerce.js';
import type { ComboAdvisor } from './surprise.ai.js';
import { loadHistory } from './surprise.service.js';

/** A stand-in AI provider for tests. No real AI service is ever called. */
let advise: (body: unknown) => Promise<unknown> = async () => undefined;
const fakeAdvisor: ComboAdvisor = { name: 'test-double', suggest: (req) => advise(req) };

const config = testConfig({ PAYMENT_MOCK_ENABLED: 'true' });
const app = createApp({ db: prisma, config, google: null });
const aiApp = createApp({ db: prisma, config, google: null, comboAdvisor: fakeAdvisor });

let w: Awaited<ReturnType<typeof world>>;
let s: Agent;

async function world() {
  const canteen = await makeOutlet({ name: 'Canteen' });
  const cafe = await makeOutlet({ name: 'Cafe' });
  const closed = await makeOutlet({ name: 'Late Bar', status: 'CLOSED' });
  const meals = await makeCategory(canteen.id, 'Meals');
  const drinks = await makeCategory(canteen.id, 'Hot drinks');
  const snacks = await makeCategory(canteen.id, 'Snacks');
  const hidden = await makeCategory(canteen.id, 'Hidden');
  await prisma.menuCategory.update({ where: { id: hidden.id }, data: { isActive: false } });
  const cafeDrinks = await makeCategory(cafe.id, 'Coffee');
  const lateDrinks = await makeCategory(closed.id, 'Drinks');
  const item = (
    outletId: string,
    categoryId: string,
    name: string,
    pricePaise: number,
    extra = {},
  ) => makeItem(outletId, categoryId, { name, pricePaise, ...extra });
  return {
    canteen,
    cafe,
    closed,
    thali: await item(canteen.id, meals.id, 'Veg thali', 12_000),
    biryani: await item(canteen.id, meals.id, 'Chicken biryani', 15_000, { dietary: 'NON_VEG' }),
    curry: await item(canteen.id, meals.id, 'Mystery curry', 10_000, { dietary: null }),
    chai: await item(canteen.id, drinks.id, 'Chai', 2_000),
    coffee: await item(canteen.id, drinks.id, 'Cold coffee', 6_000),
    samosa: await item(canteen.id, snacks.id, 'Samosa', 1_500),
    eggPuff: await item(canteen.id, snacks.id, 'Egg puff', 3_000, { dietary: 'EGG' }),
    soldOut: await item(canteen.id, snacks.id, 'Sold-out pakora', 1_000, { isAvailable: false }),
    retired: await item(canteen.id, snacks.id, 'Retired roll', 1_000, { isActive: false }),
    secret: await item(canteen.id, hidden.id, 'Hidden special', 1_000),
    latte: await item(cafe.id, cafeDrinks.id, 'Latte', 9_000),
    lassi: await item(closed.id, lateDrinks.id, 'Lassi', 1_000),
  };
}

beforeEach(async () => {
  await resetDatabase();
  advise = async () => undefined;
  w = await world();
  s = request.agent(app);
  await devLogin(s, 'student@example.com');
});

type Prefs = {
  budgetPaise?: unknown;
  mood?: string;
  diet?: string;
  outletId?: string | null;
  avoidItemIds?: string[];
};
const generate = (agent: Agent, prefs: Prefs = {}) =>
  agent
    .post('/api/v1/surprise-meal/generate')
    .set('X-Requested-With', 'CampusCart')
    .send({ budgetPaise: 20_000, mood: 'FEAST', diet: 'ANY', outletId: null, ...prefs });
const swap = (agent: Agent, body: Record<string, unknown>) =>
  agent
    .post('/api/v1/surprise-meal/swap')
    .set('X-Requested-With', 'CampusCart')
    .send({ budgetPaise: 20_000, mood: 'FEAST', diet: 'ANY', outletId: null, ...body });
const idsOf = (combo: { items: { id: string }[] }) => combo.items.map((i) => i.id);
const unorderable = () => [w.soldOut.id, w.retired.id, w.secret.id, w.lassi.id];

describe('generating a combo', () => {
  it('returns real, orderable dishes within the budget, with database prices', async () => {
    for (let i = 0; i < 15; i++) {
      const { body } = await generate(s, { budgetPaise: 14_000 }).expect(200);
      const combo = body.combo;
      expect(combo.totalPaise).toBeLessThanOrEqual(14_000);
      expect(combo.remainingPaise).toBe(14_000 - combo.totalPaise);
      expect(combo.itemCount).toBe(combo.items.length);
      expect(combo.source).toBe('RULES');
      for (const item of combo.items) {
        const row = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
        expect(item.pricePaise).toBe(row.pricePaise);
        expect(item.name).toBe(row.name);
        expect(row.outletId).toBe(combo.outlet.id);
      }
      expect(idsOf(combo).some((id) => unorderable().includes(id))).toBe(false);
    }
  });

  it.each([[-100], [0], [4_900], [100_100], [9_950], ['20000'], [null], [12.5]])(
    'rejects the budget %j',
    async (budgetPaise) => {
      const res = await generate(s, { budgetPaise });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  it('rejects unknown moods, diets and extra fields such as a student id', async () => {
    await generate(s, { mood: 'SPICY' }).expect(400);
    await generate(s, { diet: 'VEGAN' }).expect(400);
    await s
      .post('/api/v1/surprise-meal/generate')
      .set('X-Requested-With', 'CampusCart')
      .send({ budgetPaise: 20_000, mood: 'FEAST', diet: 'ANY', outletId: null, studentId: 'x' })
      .expect(400);
  });

  it('keeps Veg combos strictly vegetarian: no egg, non-veg or unclassified dishes', async () => {
    for (let i = 0; i < 15; i++) {
      const { body } = await generate(s, { diet: 'VEG', budgetPaise: 40_000 }).expect(200);
      expect(body.combo.items.every((d: { dietary: string }) => d.dietary === 'VEG')).toBe(true);
    }
  });

  it('gives Non-veg combos a non-veg dish and never an unclassified one', async () => {
    for (let i = 0; i < 15; i++) {
      const { body } = await generate(s, { diet: 'NON_VEG', budgetPaise: 30_000 }).expect(200);
      const dietary = body.combo.items.map((d: { dietary: string | null }) => d.dietary);
      expect(dietary).toContain('NON_VEG');
      expect(dietary).not.toContain(null);
    }
    const tooCheap = await generate(s, { diet: 'NON_VEG', budgetPaise: 10_000 }).expect(200);
    expect(tooCheap.body.combo).toBeNull();
    expect(tooCheap.body.reason).toMatchObject({ code: 'BUDGET_TOO_LOW', cheapestPaise: 15_000 });
  });

  it('respects the chosen outlet, and with all outlets still builds from one open outlet', async () => {
    for (let i = 0; i < 10; i++) {
      const cafe = await generate(s, { outletId: w.cafe.id }).expect(200);
      expect(cafe.body.combo.outlet.id).toBe(w.cafe.id);
      expect(idsOf(cafe.body.combo)).toEqual([w.latte.id]);

      const any = await generate(s).expect(200);
      expect([w.canteen.id, w.cafe.id]).toContain(any.body.combo.outlet.id);
      expect(idsOf(any.body.combo)).not.toContain(w.lassi.id);
    }
    const closed = await generate(s, { outletId: w.closed.id }).expect(200);
    expect(closed.body).toMatchObject({ combo: null, reason: { code: 'OUTLET_NOT_ACCEPTING' } });
    await generate(s, { outletId: '00000000-0000-4000-8000-000000000000' }).expect(404);
  });

  it('explains an empty menu and a budget that is too small', async () => {
    const empty = await makeOutlet({ name: 'Empty' });
    const res = await generate(s, { outletId: empty.id }).expect(200);
    expect(res.body).toMatchObject({ combo: null, reason: { code: 'NO_MATCHING_DISHES' } });

    const low = await generate(s, { outletId: w.cafe.id, budgetPaise: 5_000 }).expect(200);
    expect(low.body.reason).toMatchObject({ code: 'BUDGET_TOO_LOW', cheapestPaise: 9_000 });
    expect(low.body.reason.message).toContain('₹90');
  });

  it('is honest that nutrition and prep times are not recorded', async () => {
    const { body } = await generate(s, { mood: 'HIGH_PROTEIN' }).expect(200);
    expect(body.combo.nutrition).toEqual({
      available: false,
      note: expect.stringContaining('aren’t recorded'),
    });
    expect(body.notices[0]).toContain('Protein isn’t recorded');
    expect(JSON.stringify(body)).not.toMatch(/calories"|protein"|prepMinutes/i);
  });

  it('works for a student with no order history', async () => {
    const newcomer = request.agent(app);
    await devLogin(newcomer, 'newcomer@example.com');
    const { body } = await generate(newcomer).expect(200);
    expect(body.combo.items.length).toBeGreaterThan(0);
    expect(body.combo.reasons.join(' ')).not.toContain('ordered before');
  });
});

describe('order history stays private', () => {
  it('reads only the signed-in student’s own orders', async () => {
    const other = await prisma.user.create({
      data: { email: 'other@example.com', emailVerified: true, displayName: 'Other' },
    });
    await prisma.order.create({
      data: {
        userId: other.id,
        outletId: w.canteen.id,
        pickupDay: new Date('2026-10-16T00:00:00Z'),
        pickupNumber: 1,
        pickupCode: 'C-001',
        paymentMethod: 'COUNTER',
        paymentStatus: 'PENDING_COUNTER',
        subtotalPaise: 3_000,
        totalPaise: 3_000,
        idempotencyKey: 'k1',
        items: {
          create: {
            menuItemId: w.eggPuff.id,
            name: 'Egg puff',
            unitPricePaise: 3_000,
            quantity: 1,
            lineTotalPaise: 3_000,
          },
        },
      },
    });
    const me = await prisma.user.findUniqueOrThrow({ where: { email: 'student@example.com' } });
    expect((await loadHistory(prisma, me.id)).itemCounts.size).toBe(0);
    expect((await loadHistory(prisma, other.id)).itemCounts.get(w.eggPuff.id)).toBe(1);

    for (let i = 0; i < 5; i++) {
      const { body } = await generate(s, { budgetPaise: 8_000, mood: 'QUICK_BITE' }).expect(200);
      expect(body.combo.reasons.join(' ')).not.toContain('ordered before');
    }
  });
});

describe('AI suggestions are validated and optional', () => {
  const aiAgent = async () => {
    const agent = request.agent(aiApp);
    await devLogin(agent, 'student@example.com');
    return agent;
  };

  it('uses a valid AI pick, but with database names and prices', async () => {
    advise = async () => ({
      itemIds: [w.thali.id, w.chai.id],
      explanation: 'A hearty thali and chai.',
      prices: { [w.thali.id]: 100 },
      totalPaise: 100,
      names: ['Lobster'],
    });
    const { body } = await generate(await aiAgent()).expect(200);
    expect(body.combo.source).toBe('AI');
    expect(
      body.combo.items.map((i: { name: string; pricePaise: number }) => [i.name, i.pricePaise]),
    ).toEqual([
      ['Veg thali', 12_000],
      ['Chai', 2_000],
    ]);
    expect(body.combo.totalPaise).toBe(14_000);
    expect(body.combo.reasons[0]).toBe('A hearty thali and chai.');
  });

  it.each([
    ['an invented dish', () => ({ itemIds: [w.thali.id, '00000000-0000-4000-8000-00000000beef'] })],
    ['a sold-out dish', () => ({ itemIds: [w.soldOut.id] })],
    ['a dish from a closed outlet', () => ({ itemIds: [w.lassi.id] })],
    ['an over-budget combo', () => ({ itemIds: [w.thali.id, w.coffee.id, w.biryani.id] })],
    ['malformed text', () => 'thali + chai please'],
  ])('falls back to the rules engine for %s', async (_label, reply) => {
    advise = async () => reply();
    const { body } = await generate(await aiAgent()).expect(200);
    expect(body.combo.source).toBe('RULES');
    expect(body.combo.totalPaise).toBeLessThanOrEqual(20_000);
    expect(idsOf(body.combo)).not.toContain('00000000-0000-4000-8000-00000000beef');
    expect(idsOf(body.combo).some((id) => unorderable().includes(id))).toBe(false);
  });

  it('ignores a dietary-breaking or wrong-outlet AI pick', async () => {
    advise = async () => ({ itemIds: [w.eggPuff.id] });
    const veg = await generate(await aiAgent(), { diet: 'VEG' }).expect(200);
    expect(veg.body.combo.source).toBe('RULES');
    expect(idsOf(veg.body.combo)).not.toContain(w.eggPuff.id);

    advise = async () => ({ itemIds: [w.chai.id] });
    const cafe = await generate(await aiAgent(), { outletId: w.cafe.id }).expect(200);
    expect(cafe.body.combo.source).toBe('RULES');
    expect(cafe.body.combo.outlet.id).toBe(w.cafe.id);
  });

  it('falls back when the provider times out or fails', async () => {
    advise = () => new Promise(() => {});
    const started = Date.now();
    const slow = await generate(await aiAgent()).expect(200);
    expect(slow.body.combo.source).toBe('RULES');
    expect(Date.now() - started).toBeLessThan(5_000);

    advise = async () => {
      throw new Error('provider down');
    };
    expect((await generate(await aiAgent()).expect(200)).body.combo.source).toBe('RULES');
  });

  it('reports that no AI provider is configured by default', async () => {
    const { body } = await s.get('/api/v1/surprise-meal/options').expect(200);
    expect(body).toMatchObject({
      aiAvailable: false,
      budget: { minPaise: 5_000, maxPaise: 100_000 },
    });
    expect(body.budget.presets.map((p: { budgetPaise: number }) => p.budgetPaise)).toEqual([
      8_000, 14_000, 20_000, 30_000,
    ]);
  });
});

describe('swapping a dish', () => {
  it('replaces only that dish, within what the others leave of the budget', async () => {
    for (let i = 0; i < 10; i++) {
      const { body } = await swap(s, {
        budgetPaise: 15_000,
        itemIds: [w.thali.id, w.chai.id],
        replaceItemId: w.chai.id,
      }).expect(200);
      expect(body.swapped).toBe(true);
      const ids = idsOf(body.combo);
      expect(ids[0]).toBe(w.thali.id);
      expect(ids[1]).not.toBe(w.chai.id);
      expect(body.combo.totalPaise).toBeLessThanOrEqual(15_000);
      expect(body.combo.items[1].pricePaise).toBeLessThanOrEqual(3_000);
    }
  });

  it('keeps the original dish when no alternative fits, and explains why', async () => {
    const { body } = await swap(s, {
      budgetPaise: 9_000,
      outletId: w.cafe.id,
      itemIds: [w.latte.id],
      replaceItemId: w.latte.id,
    }).expect(200);
    expect(body.swapped).toBe(false);
    expect(idsOf(body.combo)).toEqual([w.latte.id]);
    expect(body.message).toContain('Latte');
  });

  it('refuses a combo that no longer holds (sold out, over budget, or another outlet)', async () => {
    await prisma.menuItem.update({ where: { id: w.chai.id }, data: { isAvailable: false } });
    const sold = await swap(s, { itemIds: [w.thali.id, w.chai.id], replaceItemId: w.thali.id });
    expect(sold.status).toBe(409);
    expect(sold.body.error.code).toBe('COMBO_OUT_OF_DATE');

    const over = await swap(s, {
      budgetPaise: 10_000,
      itemIds: [w.thali.id],
      replaceItemId: w.thali.id,
    });
    expect(over.body.error.code).toBe('COMBO_OUT_OF_DATE');
    const mixed = await swap(s, { itemIds: [w.thali.id, w.latte.id], replaceItemId: w.thali.id });
    expect(mixed.body.error.code).toBe('COMBO_OUT_OF_DATE');
    await swap(s, { itemIds: [w.thali.id], replaceItemId: w.chai.id }).expect(400);
  });
});

describe('adding a combo to the cart', () => {
  const addCombo = (agent: Agent, body: Record<string, unknown>, idempotencyKey = key()) =>
    agent
      .post('/api/v1/cart/combo')
      .set('X-Requested-With', 'CampusCart')
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
  const comboOf = (...items: { id: string; pricePaise: number }[]) => ({
    items: items.map((i) => ({ menuItemId: i.id, quantity: 1 })),
    expectedTotalPaise: items.reduce((sum, i) => sum + i.pricePaise, 0),
  });
  const cartLines = async () =>
    prisma.cartItem.findMany({
      select: { menuItemId: true, quantity: true },
      orderBy: { menuItemId: 'asc' },
    });

  it('adds every dish in one go and returns the server-priced cart', async () => {
    const res = await addCombo(s, comboOf(w.thali, w.chai)).expect(201);
    expect(res.body).toMatchObject({ added: true, cart: { totalPaise: 14_000, itemCount: 2 } });
  });

  it('refuses changed prices or unavailable dishes and adds nothing', async () => {
    const combo = comboOf(w.thali, w.chai);
    await prisma.menuItem.update({ where: { id: w.chai.id }, data: { pricePaise: 2_500 } });
    const changed = await addCombo(s, combo).expect(409);
    expect(changed.body.error).toMatchObject({
      code: 'PRICE_CHANGED',
      details: { totalPaise: 14_500 },
    });

    await prisma.menuItem.update({ where: { id: w.thali.id }, data: { isAvailable: false } });
    const gone = await addCombo(s, comboOf(w.thali, { id: w.chai.id, pricePaise: 2_500 })).expect(
      409,
    );
    expect(gone.body.error).toMatchObject({
      code: 'ITEMS_UNAVAILABLE',
      details: { items: [{ name: 'Veg thali' }] },
    });
    expect(await cartLines()).toEqual([]);

    await addCombo(s, comboOf(w.latte, w.chai)).expect(400); // two outlets
  });

  it('adds a combo once, however many times the same request arrives', async () => {
    const idempotencyKey = key();
    const body = comboOf(w.thali, w.chai);
    const results = await Promise.all([1, 2, 3, 4].map(() => addCombo(s, body, idempotencyKey)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    await addCombo(s, body, idempotencyKey).expect(200);
    expect((await cartLines()).map((l) => l.quantity)).toEqual([1, 1]);
  });

  it('follows the one-outlet cart rule, replacing the cart only when asked', async () => {
    await addCombo(s, comboOf(w.latte)).expect(201);
    const conflict = await addCombo(s, comboOf(w.thali)).expect(409);
    expect(conflict.body.error.code).toBe('CART_OUTLET_CONFLICT');
    const replaced = await addCombo(s, { ...comboOf(w.thali), replaceCart: true }).expect(201);
    expect(replaced.body.cart.outlet.id).toBe(w.canteen.id);
    expect((await cartLines()).map((l) => l.menuItemId)).toEqual([w.thali.id]);
  });
});
