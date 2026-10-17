import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import {
  addToCart,
  key,
  menu,
  placeOrder,
  post,
  student,
  type Agent,
} from '../../tests/commerce.js';
import { assign, makeCategory, makeItem, makeOutlet } from '../../tests/fixtures.js';
import { signIn, staffApp, staffFor, transition } from '../../tests/staff.js';
import { aggregateDemand } from './demand.service.js';
import { generateForecastRun } from './forecast.service.js';
import { generatePlan, transitionPlan } from './plan.service.js';
import { runPlanningJobs } from './planning.jobs.js';
import { activePolicy, rewardOf } from './policy.js';
import { setActivePolicy, trainPolicy } from './train.js';
import { addDays, asDate, dayOf, dayRange, nextMonday, todayIst } from './dates.js';

let m: Awaited<ReturnType<typeof menu>>;
let manager: Agent;
let cashier: Agent;
let shopperId: string;
let pickup = 0;

const send = (
  agent: Agent,
  method: 'get' | 'post' | 'patch',
  url: string,
  body?: object,
  idem?: string,
) => {
  const req = agent[method](`/api/v1/staff/outlets/${m.outlet.id}/planning${url}`).set(
    'X-Requested-With',
    'CampusCart',
  );
  if (idem) req.set('Idempotency-Key', idem);
  return body ? req.send(body) : req;
};

beforeEach(async () => {
  await resetDatabase();
  m = await menu(); // Night Owl Café: Chai ₹20 (handmade, not counted), Puff ₹35 (packaged, counted)
  ({ manager, cashier } = await staffFor(m.outlet.id));
  await student('shopper@example.com');
  shopperId = (await prisma.user.findUniqueOrThrow({ where: { email: 'shopper@example.com' } })).id;
  await prisma.menuItem.update({ where: { id: m.puff.id }, data: { fulfillmentType: 'PACKAGED' } });
  await prisma.menuItem.update({ where: { id: m.chai.id }, data: { fulfillmentType: 'HANDMADE' } });
  await manager
    .post(`/api/v1/staff/outlets/${m.outlet.id}/inventory/${m.puff.id}/tracking`)
    .set('X-Requested-With', 'CampusCart')
    .send({ enabled: true, quantity: 18 })
    .expect(200);
});

type Status = 'COMPLETED' | 'PLACED' | 'CANCELLED' | 'REJECTED';

/**
 * Test fixture: an order for a past (or today's) collection day, written straight to the
 * database the way checkout would leave it. Quantities over 10 become several orders.
 */
async function pastOrder(
  day: string,
  itemId: string,
  quantity: number,
  status: Status = 'COMPLETED',
  outletId = m.outlet.id,
) {
  const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: itemId } });
  for (let left = quantity; left > 0; left -= 10) {
    const q = Math.min(10, left);
    pickup += 1;
    await prisma.order.create({
      data: {
        userId: shopperId,
        outletId,
        pickupDay: asDate(day),
        pickupNumber: pickup,
        pickupCode: `T-${pickup}`,
        status,
        paymentMethod: 'COUNTER',
        paymentStatus:
          status === 'COMPLETED' ? 'PAID' : status === 'PLACED' ? 'PENDING_COUNTER' : 'VOID',
        subtotalPaise: item.pricePaise * q,
        totalPaise: item.pricePaise * q,
        idempotencyKey: randomUUID(),
        items: {
          create: [
            {
              menuItemId: itemId,
              name: item.name,
              unitPricePaise: item.pricePaise,
              quantity: q,
              lineTotalPaise: item.pricePaise * q,
            },
          ],
        },
        history: {
          create: [
            { toStatus: 'PLACED', actorRole: 'STUDENT' },
            ...(status === 'PLACED'
              ? []
              : [
                  {
                    toStatus: status,
                    actorRole: status === 'CANCELLED' ? ('STUDENT' as const) : ('POS' as const),
                  },
                ]),
          ],
        },
      },
    });
  }
}

/** Steady history: `perDay` puffs and chais on every day of the last `days` days. */
async function steadyHistory(
  days: number,
  perDay: { puff: number; chai: number },
  until = todayIst(),
) {
  for (const day of dayRange(addDays(until, -days), addDays(until, -1))) {
    await pastOrder(day, m.puff.id, perDay.puff);
    await pastOrder(day, m.chai.id, perDay.chai);
  }
}

const demandRow = (itemId: string, day: string) =>
  prisma.demandDaily.findUniqueOrThrow({
    where: {
      outletId_menuItemId_businessDate: {
        outletId: m.outlet.id,
        menuItemId: itemId,
        businessDate: asDate(day),
      },
    },
  });

describe('demand history', () => {
  it('counts each order once whatever happens to it, and re-running changes nothing', async () => {
    const today = todayIst();
    const a = await student('a@example.com');
    const b = await student('b@example.com');
    const c = await student('c@example.com');
    await addToCart(a, m.chai.id, 2);
    await placeOrder(a, 'COUNTER', 4000).expect(201); // stays open
    await addToCart(b, m.chai.id, 1);
    const cancelled = (await placeOrder(b, 'COUNTER', 2000).expect(201)).body.order;
    await post(b, `/orders/${cancelled.id}/cancel`, {}).expect(200); // student withdraws
    await addToCart(c, m.chai.id, 3);
    const rejected = (await placeOrder(c, 'COUNTER', 6000).expect(201)).body.order;
    await transition(manager, m.outlet.id, rejected.id, 'REJECTED', 'Out of milk').expect(200);

    await aggregateDemand(prisma, { from: today, to: today });
    await Promise.all([1, 2, 3].map(() => aggregateDemand(prisma, { from: today, to: today })));
    expect(await demandRow(m.chai.id, today)).toMatchObject({
      unitsOrdered: 6,
      unitsCancelled: 1,
      unitsRejected: 3,
      unitsOpen: 2,
      unitsFulfilled: 0,
      unitsImmediate: 6,
      demandValuePaise: 10_000,
    });
    expect(await prisma.demandDaily.count({ where: { menuItemId: m.chai.id } })).toBe(1);
  });

  it('keeps each outlet’s history separate', async () => {
    const other = await makeOutlet({ name: 'Canteen' });
    const cat = await makeCategory(other.id, 'Meals');
    const thali = await makeItem(other.id, cat.id, { name: 'Thali', pricePaise: 6000 });
    const yesterday = addDays(todayIst(), -1);
    await prisma.menuItem.updateMany({
      data: { createdAt: new Date(Date.now() - 10 * 86_400_000) },
    });
    await pastOrder(yesterday, m.chai.id, 4);
    await pastOrder(yesterday, thali.id, 9, 'COMPLETED', other.id);
    await aggregateDemand(prisma, { from: yesterday, to: yesterday });
    expect((await demandRow(m.chai.id, yesterday)).unitsOrdered).toBe(4);
    expect(
      (await prisma.demandDaily.findFirstOrThrow({ where: { outletId: other.id } })).unitsOrdered,
    ).toBe(9);
    expect(
      await prisma.demandDaily.count({ where: { outletId: m.outlet.id, menuItemId: thali.id } }),
    ).toBe(0);
  });

  it('flags a sold-out day instead of treating it as plain low demand', async () => {
    const today = todayIst();
    const s = await student('s@example.com');
    await manager
      .post(`/api/v1/staff/outlets/${m.outlet.id}/inventory/${m.puff.id}/adjustments`)
      .set('X-Requested-With', 'CampusCart')
      .send({ type: 'COUNT_SET', quantity: 2, expectedQuantity: 18 })
      .expect(200);
    await addToCart(s, m.puff.id, 2);
    await placeOrder(s, 'COUNTER', 7000).expect(201); // takes the last 2
    await new Promise((r) => setTimeout(r, 1100));
    await aggregateDemand(prisma, { from: today, to: today });
    const row = await demandRow(m.puff.id, today);
    expect(row.unitsDeducted).toBe(2);
    expect(row.closingStock).toBe(0);
    expect(row.censored).toBe(true);
    expect(row.stockoutMinutes).toBeGreaterThan(0);
  });
});

describe('forecasts', () => {
  it('stores every run as a new version and only uses days before the as-of date', async () => {
    await prisma.menuItem.updateMany({
      data: { createdAt: new Date(Date.now() - 40 * 86_400_000) },
    });
    await steadyHistory(28, { puff: 6, chai: 10 });
    const weekStart = nextMonday(todayIst());
    const first = await generateForecastRun(prisma, {
      outletId: m.outlet.id,
      weekStart,
      trigger: 'MANUAL',
    });
    // Lots of orders today must not change a forecast made today.
    await pastOrder(todayIst(), m.puff.id, 30);
    const second = await generateForecastRun(prisma, {
      outletId: m.outlet.id,
      weekStart,
      trigger: 'MANUAL',
    });
    expect(second.id).not.toBe(first.id);
    expect(dayOf(second.historyTo)).toBe(addDays(todayIst(), -1));
    const q = async (runId: string) =>
      (
        await prisma.forecast.findMany({
          where: { runId, menuItemId: m.puff.id },
          orderBy: { targetDate: 'asc' },
        })
      ).map((f) => f.quantity);
    expect(await q(second.id)).toEqual(await q(first.id));
    expect((await q(first.id))[0]).toBeCloseTo(6, 0);
    expect(await prisma.forecastRun.count()).toBe(2);
    const days = dayRange(todayIst(), addDays(weekStart, 6)).length;
    expect(await prisma.forecast.count({ where: { runId: first.id } })).toBe(2 * days);
  });
});

describe('weekly stock plans', () => {
  it('generates, versions, overrides, submits, approves and records restocks through the ledger', async () => {
    await prisma.menuItem.updateMany({
      data: { createdAt: new Date(Date.now() - 40 * 86_400_000) },
    });
    await steadyHistory(28, { puff: 6, chai: 10 });
    const weekStart = nextMonday(todayIst());

    const v1 = (await send(cashier, 'post', '/plans', { weekStart }).expect(201)).body.plan;
    expect(v1).toMatchObject({ version: 1, status: 'DRAFT', policy: { name: 'baseline' } });
    const puff = v1.items.find((i: { menuItem: { id: string } }) => i.menuItem.id === m.puff.id);
    expect(puff).toMatchObject({
      tracked: true,
      currentStock: 18,
      action: 'MEDIUM',
      expectedIncoming: 0,
    });
    expect(puff.forecastUnits).toBeGreaterThan(35);
    expect(puff.recommendedQty).toBe(puff.finalQty);
    expect(puff.recommendedQty).toBeGreaterThan(0);
    expect(puff.explanation.join(' ')).toMatch(/Forecast .* for the week/);
    const chai = v1.items.find((i: { menuItem: { id: string } }) => i.menuItem.id === m.chai.id);
    expect(chai).toMatchObject({ tracked: false, currentStock: null });
    expect(chai.explanation.join(' ')).toMatch(/isn’t counted/);

    const v2 = (await send(cashier, 'post', '/plans', { weekStart }).expect(201)).body.plan;
    expect(v2.version).toBe(2);
    expect((await prisma.stockPlan.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe(
      'SUPERSEDED',
    );
    const p = v2.items.find((i: { menuItem: { id: string } }) => i.menuItem.id === m.puff.id);

    await send(cashier, 'patch', `/plans/${v2.id}/items/${p.id}`, { finalQty: 5 }).expect(400);
    const edited = (
      await send(cashier, 'patch', `/plans/${v2.id}/items/${p.id}`, {
        finalQty: 5,
        reason: 'Exam week, campus is quiet',
      }).expect(200)
    ).body.plan;
    const ep = edited.items.find((i: { id: string }) => i.id === p.id);
    expect(ep).toMatchObject({
      finalQty: 5,
      overridden: true,
      overrideReason: 'Exam week, campus is quiet',
      recommendedQty: p.recommendedQty,
    });
    expect(edited.revisions.map((r: { kind: string }) => r.kind)).toEqual(['CREATED', 'OVERRIDE']);

    await send(cashier, 'post', `/plans/${v2.id}/approve`).expect(403);
    await send(cashier, 'post', `/plans/${v2.id}/submit`).expect(200);
    const approved = (await send(manager, 'post', `/plans/${v2.id}/approve`).expect(200)).body.plan;
    expect(approved.status).toBe('APPROVED');
    await send(manager, 'post', `/plans/${v2.id}/approve`).expect(409);
    await send(cashier, 'patch', `/plans/${v2.id}/items/${p.id}`, {
      finalQty: 9,
      reason: 'late change',
    }).expect(409);
    await send(cashier, 'post', '/plans', { weekStart }).expect(409);

    // Experience records: frozen state + action, no outcome yet.
    const decisions = await prisma.planningDecision.findMany();
    expect(decisions).toHaveLength(2);
    const d = decisions.find((x) => x.menuItemId === m.puff.id)!;
    expect(d).toMatchObject({
      status: 'PENDING',
      action: 'MEDIUM',
      approvedQty: 5,
      recommendedQty: p.recommendedQty,
      reward: null,
      demandUnits: null,
    });
    expect(Object.keys(d.state as object)).not.toContain('demandUnits');

    // Restocks: only counted items; retries with the same key restock once.
    const c = v2.items.find((i: { menuItem: { id: string } }) => i.menuItem.id === m.chai.id);
    expect(
      (
        await send(
          cashier,
          'post',
          `/plans/${v2.id}/items/${c.id}/replenishments`,
          { quantity: 5 },
          key(),
        ).expect(409)
      ).body.error.code,
    ).toBe('NOT_TRACKED');
    const k = key();
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        send(cashier, 'post', `/plans/${v2.id}/items/${p.id}/replenishments`, { quantity: 4 }, k),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    await send(
      cashier,
      'post',
      `/plans/${v2.id}/items/${p.id}/replenishments`,
      { quantity: 1 },
      key(),
    ).expect(201);
    expect(
      (await prisma.menuItem.findUniqueOrThrow({ where: { id: m.puff.id } })).stockQuantity,
    ).toBe(23);
    const linked = await prisma.stockAdjustment.findMany({ where: { planItemId: p.id } });
    expect(
      linked.map((a) => [a.type, a.quantityChange, a.previousQuantity, a.resultingQuantity]),
    ).toEqual([
      ['RESTOCK', 4, 18, 22],
      ['RESTOCK', 1, 22, 23],
    ]);
    const after = (await send(cashier, 'get', `/plans/${v2.id}`).expect(200)).body.plan;
    expect(after.items.find((i: { id: string }) => i.id === p.id).replenishedQty).toBe(5);

    await send(cashier, 'post', `/plans/${v2.id}/complete`).expect(200);
    const csv = await send(cashier, 'get', `/plans/${v2.id}/export.csv`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('"Puff"');
  });

  it('refuses weeks that aren’t a future Monday within 4 weeks', async () => {
    const today = todayIst();
    await send(cashier, 'post', '/plans', { weekStart: addDays(nextMonday(today), 1) }).expect(400);
    await send(cashier, 'post', '/plans', { weekStart: addDays(nextMonday(today), -7) }).expect(
      400,
    );
    await send(cashier, 'post', '/plans', { weekStart: addDays(nextMonday(today), 28) }).expect(
      400,
    );
    await send(cashier, 'post', '/plans', { weekStart: '2026-02-30' }).expect(400);
  });

  it('is only for staff assigned to the outlet', async () => {
    const other = await makeOutlet({ name: 'Canteen' });
    const outsider = await signIn('other.manager@example.com');
    await assign('other.manager@example.com', other.id, 'MANAGER');
    await send(outsider, 'get', '/overview').expect(403);
    await send(outsider, 'post', '/plans', { weekStart: nextMonday(todayIst()) }).expect(403);
    const s = await signIn('student2@example.com', staffApp);
    await send(s, 'get', '/overview').expect(403);
    const overview = (await send(cashier, 'get', '/overview').expect(200)).body;
    expect(overview).toMatchObject({
      role: 'POS',
      plan: null,
      policy: { name: 'baseline', learned: false },
    });
    // A plan from another outlet can't be read through this one.
    await prisma.menuItem.updateMany({
      data: { createdAt: new Date(Date.now() - 10 * 86_400_000) },
    });
    const otherCat = await makeCategory(other.id, 'Meals');
    await makeItem(other.id, otherCat.id, { name: 'Thali' });
    const otherPlan = await generatePlan(prisma, {
      outletId: other.id,
      weekStart: nextMonday(todayIst()),
      actor: {
        userId: (
          await prisma.user.findUniqueOrThrow({ where: { email: 'other.manager@example.com' } })
        ).id,
        role: 'MANAGER',
      },
    });
    await send(manager, 'get', `/plans/${otherPlan.id}`).expect(404);
  });

  it('pages through historical demand and caps the range', async () => {
    await prisma.menuItem.updateMany({
      data: { createdAt: new Date(Date.now() - 40 * 86_400_000) },
    });
    await steadyHistory(5, { puff: 2, chai: 3 });
    await aggregateDemand(prisma, { from: addDays(todayIst(), -5), to: addDays(todayIst(), -1) });
    const from = addDays(todayIst(), -5);
    const to = addDays(todayIst(), -1);
    const first = (await send(cashier, 'get', `/demand?from=${from}&to=${to}&limit=4`).expect(200))
      .body;
    expect(first.days).toHaveLength(4);
    const second = (
      await send(
        cashier,
        'get',
        `/demand?from=${from}&to=${to}&limit=100&cursor=${first.nextCursor}`,
      ).expect(200)
    ).body;
    expect(first.days.length + second.days.length).toBe(10);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.days, ...second.days].map(
          (d: { date: string; menuItemId: string }) => d.date + d.menuItemId,
        ),
      ).size,
    ).toBe(10);
    await send(cashier, 'get', `/demand?from=2026-01-01&to=2026-12-31`).expect(400);
  });
});

describe('outcomes, rewards and the learning safeguards', () => {
  it('compares forecasts with what happened and scores each approved decision once', async () => {
    const realToday = todayIst();
    const past = new Date(Date.now() - 21 * 86_400_000);
    const pastDay = todayIst(past);
    await prisma.menuItem.updateMany({
      data: { createdAt: new Date(Date.now() - 80 * 86_400_000) },
    });
    await steadyHistory(28, { puff: 6, chai: 10 }, pastDay);
    const weekStart = nextMonday(pastDay);
    const managerId = (
      await prisma.user.findUniqueOrThrow({ where: { email: 'manager@example.com' } })
    ).id;
    const plan = await generatePlan(prisma, {
      outletId: m.outlet.id,
      weekStart,
      actor: { userId: managerId, role: 'MANAGER' },
      now: past,
    });
    await transitionPlan(prisma, {
      outletId: m.outlet.id,
      planId: plan.id,
      action: 'approve',
      actor: { userId: managerId, role: 'MANAGER' },
      now: past,
    });
    // What actually happened that week: 8 puffs a day were sold, chai as before.
    for (const day of dayRange(weekStart, addDays(weekStart, 6))) {
      await pastOrder(day, m.puff.id, 8);
      await pastOrder(day, m.chai.id, 10);
    }
    expect(weekStart < realToday).toBe(true);

    await runPlanningJobs(prisma);
    const puffDecision = await prisma.planningDecision.findFirstOrThrow({
      where: { menuItemId: m.puff.id },
    });
    expect(puffDecision).toMatchObject({
      status: 'FINALIZED',
      demandUnits: 56,
      fulfilledUnits: 56,
      stockoutDays: 0,
      wastedUnits: 0,
    });
    expect(puffDecision.reward).toBe(
      rewardOf({ fulfilled: 56, estimatedLost: 0, wasted: 0, leftover: puffDecision.leftoverUnits })
        .reward,
    );
    const chaiDecision = await prisma.planningDecision.findFirstOrThrow({
      where: { menuItemId: m.chai.id },
    });
    expect(chaiDecision).toMatchObject({
      status: 'EXCLUDED',
      excludeReason: 'STOCK_NOT_COUNTED',
      reward: null,
    });

    const finishedPlan = await prisma.stockPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(finishedPlan.outcome).toMatchObject({ demandUnits: 126 });
    const weekForecasts = await prisma.forecast.findMany({
      where: {
        menuItemId: m.puff.id,
        targetDate: { gte: asDate(weekStart), lte: asDate(addDays(weekStart, 6)) },
      },
    });
    expect(weekForecasts.every((f) => f.actualDemand === 8 && f.absError !== null)).toBe(true);
    const run = await prisma.forecastRun.findFirstOrThrow({ where: { id: plan.forecastRun.id } });
    expect(run.evaluation).toMatchObject({
      totalActual: expect.any(Number),
      mae: expect.any(Number),
    });

    // Running again (or twice at once) changes nothing.
    const finalizedAt = puffDecision.finalizedAt;
    await Promise.all([runPlanningJobs(prisma), runPlanningJobs(prisma)]);
    expect(
      (await prisma.planningDecision.findFirstOrThrow({ where: { menuItemId: m.puff.id } }))
        .finalizedAt,
    ).toEqual(finalizedAt);
    expect(await prisma.planningJobRun.count({ where: { job: 'demand-backfill' } })).toBe(1);

    const evaluation = (await send(cashier, 'get', '/evaluation').expect(200)).body;
    expect(evaluation.policy.inUse).toMatchObject({ name: 'baseline', learned: false });
    expect(evaluation.policy.decisions).toMatchObject({ FINALIZED: 1, EXCLUDED: 1 });
  });

  it('refuses to train or activate a policy without enough real outcomes, and keeps the baseline', async () => {
    const { policy, activated } = await trainPolicy(prisma, { activate: true });
    expect(activated).toBe(false);
    expect(policy.status).toBe('REJECTED');
    expect(policy.evaluation).toMatchObject({ verdict: 'INSUFFICIENT_DATA', usableDecisions: 0 });
    await expect(setActivePolicy(prisma, policy.version)).rejects.toThrow(
      /only a validated policy/,
    );
    expect(await activePolicy(prisma)).toMatchObject({ name: 'baseline', table: null });
  });
});
