import request from 'supertest';
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
import { makeCategory, makeItem, makeOutlet, assign } from '../../tests/fixtures.js';
import { cancel, signIn, staffApp, staffFor, transition } from '../../tests/staff.js';
import { publicName } from './reviews.service.js';
import { roundRating, summarize } from './ratings.js';

let m: Awaited<ReturnType<typeof menu>>;
let manager: Agent;
let cashier: Agent;
let asha: Agent;
let ben: Agent;
let n = 0;

const api = (
  agent: Agent,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  url: string,
  body?: object,
) => {
  const req = agent[method](`/api/v1${url}`).set('X-Requested-With', 'CampusCart');
  return body ? req.send(body) : req;
};
const anon = () => request(staffApp);

beforeEach(async () => {
  await resetDatabase();
  n += 1;
  m = await menu(); // Night Owl Café: Chai ₹20, Puff ₹35
  ({ manager, cashier } = await staffFor(m.outlet.id));
  asha = await student(`asha${n}@example.com`, staffApp);
  ben = await student(`ben${n}@example.com`, staffApp);
});

/** Places a wallet order for the item and walks it to the given status. */
async function order(
  agent: Agent,
  itemId: string,
  pricePaise: number,
  until: 'PLACED' | 'READY' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' = 'COMPLETED',
  outletId = m.outlet.id,
) {
  await fund(agent, 10_000);
  await addToCart(agent, itemId);
  const o = (await placeOrder(agent, 'WALLET', pricePaise).expect(201)).body.order as {
    id: string;
  };
  if (until === 'REJECTED') {
    await transition(manager, outletId, o.id, 'REJECTED', 'Out of stock').expect(200);
  } else if (until === 'CANCELLED') {
    await cancel(agent, o.id).expect(200);
  } else {
    const path = ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED'];
    const steps = path.slice(0, until === 'PLACED' ? 0 : path.indexOf(until) + 1);
    for (const to of steps) await transition(manager, outletId, o.id, to).expect(200);
  }
  return o;
}

const review = (agent: Agent, itemId: string, body: object) =>
  api(agent, 'post', `/menu-items/${itemId}/reviews`, body);
const ratings = async (itemId: string) =>
  (await anon().get(`/api/v1/menu-items/${itemId}/ratings`).expect(200)).body.rating;

describe('verified-purchase eligibility', () => {
  it('lets a student rate a dish from a collected order, marked as a verified purchase', async () => {
    await order(asha, m.chai.id, 2000);
    const mine = await api(asha, 'get', `/menu-items/${m.chai.id}/my-review`).expect(200);
    expect(mine.body).toEqual({ eligible: true, review: null });

    const res = await review(asha, m.chai.id, {
      rating: 4,
      body: '  Strong and gingery  ',
      taste: 'GREAT',
      value: 'OKAY',
    }).expect(201);
    expect(res.body.review).toMatchObject({
      rating: 4,
      body: 'Strong and gingery',
      feedback: { taste: 'GREAT', portion: null, freshness: null, value: 'OKAY' },
      verifiedPurchase: true,
      status: 'PUBLISHED',
      isMine: true,
      edited: false,
    });
    expect(res.body.rating).toMatchObject({ average: 4, count: 1 });

    const row = await prisma.foodReview.findFirstOrThrow();
    expect(row.outletId).toBe(m.outlet.id);
    expect(row.verifiedPurchase).toBe(true);
  });

  it('requires sign-in', async () => {
    await anon()
      .post(`/api/v1/menu-items/${m.chai.id}/reviews`)
      .set('X-Requested-With', 'CampusCart')
      .send({ rating: 5 })
      .expect(401);
    await anon().get(`/api/v1/menu-items/${m.chai.id}/my-review`).expect(401);
    await anon().get('/api/v1/me/reviews').expect(401);
  });

  it('refuses dishes the student never bought, or bought in a different order', async () => {
    await review(asha, m.chai.id, { rating: 5 }).expect(403);
    await order(asha, m.puff.id, 3500);
    // Bought a puff, not chai.
    const res = await review(asha, m.chai.id, { rating: 5 }).expect(403);
    expect(res.body.error.code).toBe('NOT_ELIGIBLE');
    expect((await api(asha, 'get', `/menu-items/${m.chai.id}/my-review`)).body.eligible).toBe(
      false,
    );
  });

  it('refuses orders that are not collected: placed, ready, rejected, cancelled', async () => {
    for (const until of ['PLACED', 'READY', 'REJECTED', 'CANCELLED'] as const) {
      await resetDatabase();
      m = await menu();
      ({ manager, cashier } = await staffFor(m.outlet.id));
      const s = await student(`s-${until}-${n}@example.com`, staffApp);
      await order(s, m.chai.id, 2000, until);
      const res = await review(s, m.chai.id, { rating: 5 });
      expect(res.status, until).toBe(403);
    }
    expect(await prisma.foodReview.count()).toBe(0);
  });

  it('refuses a counter order that is ready but unpaid', async () => {
    await addToCart(asha, m.chai.id);
    const o = (await placeOrder(asha, 'COUNTER', 2000).expect(201)).body.order;
    for (const to of ['ACCEPTED', 'PREPARING', 'READY']) {
      await transition(cashier, m.outlet.id, o.id, to).expect(200);
    }
    // Ready but never paid or collected.
    await review(asha, m.chai.id, { rating: 3 }).expect(403);
  });

  it('never accepts another student’s purchase or a client-supplied verified flag', async () => {
    await order(asha, m.chai.id, 2000);
    // Ben didn't buy it; extra fields (order id, verified flag) are rejected outright.
    await review(ben, m.chai.id, { rating: 5 }).expect(403);
    const sneaky = await review(ben, m.chai.id, {
      rating: 5,
      verifiedPurchase: true,
      orderId: (await prisma.order.findFirstOrThrow()).id,
    }).expect(400);
    expect(sneaky.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.foodReview.count()).toBe(0);
  });

  it('counts a group member only for the dishes they put on the tray', async () => {
    const group = (
      await api(asha, 'post', '/groups', { name: 'Lunch', outletId: m.outlet.id }).expect(201)
    ).body.group;
    await api(ben, 'post', '/groups/join', { code: group.code }).expect(200);
    await api(asha, 'put', `/groups/${group.id}/items/${m.puff.id}`, {
      quantity: 1,
    }).expect(200);
    await api(ben, 'put', `/groups/${group.id}/items/${m.chai.id}`, {
      quantity: 1,
    }).expect(200);
    for (const a of [asha, ben]) await fund(a, 10_000);
    await api(asha, 'post', `/groups/${group.id}/checkout`, { expectedTotalPaise: 5500 }).expect(
      200,
    );
    for (const a of [asha, ben]) {
      await a
        .post(`/api/v1/groups/${group.id}/shares/mine/pay`)
        .set('X-Requested-With', 'CampusCart')
        .set('Idempotency-Key', key())
        .send({})
        .expect(201);
    }
    const o = await prisma.order.findFirstOrThrow({ where: { paymentMethod: 'GROUP' } });
    // Not collected yet: nobody qualifies.
    await review(ben, m.chai.id, { rating: 5 }).expect(403);
    for (const to of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) {
      await transition(manager, m.outlet.id, o.id, to).expect(200);
    }
    await review(ben, m.chai.id, { rating: 5 }).expect(201);
    await review(ben, m.puff.id, { rating: 5 }).expect(403);
    // The host owns the order but only added the puff.
    await review(asha, m.puff.id, { rating: 4 }).expect(201);
    await review(asha, m.chai.id, { rating: 4 }).expect(403);
  });
});

describe('validation and duplicates', () => {
  beforeEach(async () => {
    await order(asha, m.chai.id, 2000);
  });

  it('rejects ratings outside 1–5, fractions, long reviews and unknown feedback values', async () => {
    for (const rating of [0, 6, -1, 4.5, '5', null]) {
      const res = await review(asha, m.chai.id, { rating });
      expect(res.status, String(rating)).toBe(400);
    }
    await review(asha, m.chai.id, { rating: 4, body: 'x'.repeat(1001) }).expect(400);
    await review(asha, m.chai.id, { rating: 4, taste: 'AMAZING' }).expect(400);
    await review(asha, m.chai.id, {}).expect(400);
    expect(await prisma.foodReview.count()).toBe(0);
  });

  it('stores an empty or whitespace review as no text, and strips control characters', async () => {
    const res = await review(asha, m.chai.id, { rating: 3, body: '   ' }).expect(201);
    expect(res.body.review.body).toBeNull();
    const edited = await api(asha, 'patch', `/reviews/${res.body.review.id}`, {
      body: 'Nice\u0000 chai\u0007',
    }).expect(200);
    expect(edited.body.review.body).toBe('Nice chai');
  });

  it('allows one review per dish: a repeat or simultaneous submit creates nothing new', async () => {
    const first = await review(asha, m.chai.id, { rating: 4 }).expect(201);
    const again = await review(asha, m.chai.id, { rating: 2 }).expect(409);
    expect(again.body.error).toMatchObject({
      code: 'REVIEW_EXISTS',
      details: { reviewId: first.body.review.id },
    });
    // Buying it again doesn't add a second review either.
    await order(asha, m.chai.id, 2000);
    await review(asha, m.chai.id, { rating: 2 }).expect(409);
    expect(await prisma.foodReview.count()).toBe(1);
  });

  it('lets exactly one of several concurrent submits through', async () => {
    const results = await Promise.all(
      [5, 4, 3, 2].map((rating) => review(asha, m.chai.id, { rating })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(await prisma.foodReview.count()).toBe(1);
  });
});

describe('editing and deleting', () => {
  let reviewId: string;
  beforeEach(async () => {
    await order(asha, m.chai.id, 2000);
    reviewId = (await review(asha, m.chai.id, { rating: 5, body: 'Great' }).expect(201)).body.review
      .id;
  });

  it('updates the same record and lists it under my reviews', async () => {
    const before = await prisma.foodReview.findUniqueOrThrow({ where: { id: reviewId } });
    await new Promise((r) => setTimeout(r, 1100));
    const res = await api(asha, 'patch', `/reviews/${reviewId}`, {
      rating: 2,
      body: null,
      portion: 'POOR',
    }).expect(200);
    expect(res.body.review).toMatchObject({
      id: reviewId,
      rating: 2,
      body: null,
      feedback: { portion: 'POOR' },
      edited: true,
    });
    expect(await prisma.foodReview.count()).toBe(1);
    const after = await prisma.foodReview.findUniqueOrThrow({ where: { id: reviewId } });
    expect(after.createdAt).toEqual(before.createdAt);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());

    const mine = await api(asha, 'get', '/me/reviews').expect(200);
    expect(mine.body.total).toBe(1);
    expect(mine.body.reviews[0]).toMatchObject({
      id: reviewId,
      rating: 2,
      item: { id: m.chai.id, name: 'Chai' },
      outlet: { slug: m.outlet.slug, name: 'Night Owl Café' },
    });
  });

  it('refuses edits and deletes by anyone but the author (same 404 as a missing review)', async () => {
    await api(ben, 'patch', `/reviews/${reviewId}`, { rating: 1 }).expect(404);
    await api(ben, 'delete', `/reviews/${reviewId}`).expect(404);
    await api(manager, 'patch', `/reviews/${reviewId}`, { rating: 1 }).expect(404);
    await anon()
      .patch(`/api/v1/reviews/${reviewId}`)
      .set('X-Requested-With', 'CampusCart')
      .send({ rating: 1 })
      .expect(401);
    await api(asha, 'patch', `/reviews/${reviewId}`, { rating: 7 }).expect(400);
    await api(asha, 'patch', `/reviews/${reviewId}`, {}).expect(400);
    expect((await prisma.foodReview.findUniqueOrThrow({ where: { id: reviewId } })).rating).toBe(5);
  });

  it('deletes the author’s review, after which they may review again', async () => {
    await api(asha, 'delete', `/reviews/${reviewId}`).expect(204);
    await api(asha, 'delete', `/reviews/${reviewId}`).expect(404);
    expect(await ratings(m.chai.id)).toMatchObject({ average: null, count: 0 });
    await review(asha, m.chai.id, { rating: 3 }).expect(201);
  });
});

describe('rating summaries', () => {
  it('averages real reviews, with the star distribution, and follows edits and deletes', async () => {
    const people = [asha, ben, await student(`cy${n}@example.com`, staffApp)];
    const ids: string[] = [];
    for (const [i, rating] of [5, 4, 4].entries()) {
      await order(people[i]!, m.chai.id, 2000);
      ids.push((await review(people[i]!, m.chai.id, { rating }).expect(201)).body.review.id);
    }
    let r = await ratings(m.chai.id);
    expect(r.average).toBe(4.3); // 13 / 3 = 4.333…
    expect(r.count).toBe(3);
    expect(r.distribution).toEqual([
      { stars: 5, count: 1 },
      { stars: 4, count: 2 },
      { stars: 3, count: 0 },
      { stars: 2, count: 0 },
      { stars: 1, count: 0 },
    ]);

    await api(ben, 'patch', `/reviews/${ids[1]}`, { rating: 1 }).expect(200);
    r = await ratings(m.chai.id);
    expect(r).toMatchObject({ average: 3.3, count: 3 }); // 10 / 3
    expect(r.distribution.find((d: { stars: number }) => d.stars === 1).count).toBe(1);

    await api(asha, 'delete', `/reviews/${ids[0]}`).expect(204);
    expect(await ratings(m.chai.id)).toMatchObject({ average: 2.5, count: 2 });

    // The menu shows the same numbers.
    const menuRes = await anon().get(`/api/v1/outlets/${m.outlet.slug}/menu`).expect(200);
    const chai = menuRes.body.items.find((i: { id: string }) => i.id === m.chai.id);
    expect(chai.rating).toEqual({ average: 2.5, count: 2 });
    const puff = menuRes.body.items.find((i: { id: string }) => i.id === m.puff.id);
    expect(puff.rating).toEqual({ average: null, count: 0 });
  });

  it('rounds half up to one decimal and reports no average for unrated items', () => {
    expect(roundRating(4.25)).toBe(4.3);
    expect(roundRating(4.24)).toBe(4.2);
    expect(roundRating(4.35)).toBe(4.4);
    expect(summarize(0, 0)).toEqual({ average: null, count: 0 });
    expect(summarize(9, 2)).toEqual({ average: 4.5, count: 2 });
  });

  it('keeps ratings with the right item and outlet', async () => {
    const other = await makeOutlet({ name: 'Juice Junction', status: 'OPEN' });
    const cat = await makeCategory(other.id, 'Drinks');
    // Same dish name at another outlet: a different item with its own ratings.
    const otherChai = await makeItem(other.id, cat.id, { name: 'Chai', pricePaise: 2500 });
    await assign('manager@example.com', other.id, 'MANAGER');
    await order(asha, m.chai.id, 2000);
    await review(asha, m.chai.id, { rating: 5 }).expect(201);
    await order(ben, otherChai.id, 2500, 'COMPLETED', other.id);
    await review(ben, otherChai.id, { rating: 1 }).expect(201);
    // Asha bought chai at Night Owl, not at Juice Junction.
    await review(asha, otherChai.id, { rating: 5 }).expect(403);

    expect(await ratings(m.chai.id)).toMatchObject({ average: 5, count: 1 });
    expect(await ratings(otherChai.id)).toMatchObject({ average: 1, count: 1 });
    const own = await api(manager, 'get', `/staff/outlets/${m.outlet.id}/reviews/summary`).expect(
      200,
    );
    expect(own.body.summary).toMatchObject({ average: 5, total: 1 });
  });
});

describe('listing reviews', () => {
  it('pages and sorts published reviews, and shows only short names', async () => {
    const ratingsInOrder = [3, 5, 1, 4, 2];
    for (const [i, rating] of ratingsInOrder.entries()) {
      const s = await student(`p${i}-${n}@example.com`, staffApp);
      await prisma.user.updateMany({
        where: { email: `p${i}-${n}@example.com` },
        data: { displayName: `Person${i} Surname` },
      });
      await order(s, m.chai.id, 2000);
      await review(s, m.chai.id, { rating, body: `Review ${i}` }).expect(201);
      await new Promise((r) => setTimeout(r, 5));
    }
    const url = `/api/v1/menu-items/${m.chai.id}/reviews`;
    const recent = (await anon().get(`${url}?pageSize=2`).expect(200)).body;
    expect(recent).toMatchObject({ page: 1, pageSize: 2, total: 5, hasMore: true });
    expect(recent.reviews.map((r: { body: string }) => r.body)).toEqual(['Review 4', 'Review 3']);
    expect(recent.reviews[0].author).toBe('Person4 S.');
    expect(JSON.stringify(recent)).not.toContain('@example.com');

    const last = (await anon().get(`${url}?pageSize=2&page=3`).expect(200)).body;
    expect(last.reviews).toHaveLength(1);
    expect(last.hasMore).toBe(false);

    const highest = (await anon().get(`${url}?sort=highest`).expect(200)).body;
    expect(highest.reviews.map((r: { rating: number }) => r.rating)).toEqual([5, 4, 3, 2, 1]);
    const lowest = (await anon().get(`${url}?sort=lowest&pageSize=1`).expect(200)).body;
    expect(lowest.reviews[0].rating).toBe(1);

    await anon().get(`${url}?pageSize=500`).expect(400);
    await anon().get(`${url}?sort=random`).expect(400);
  });

  it('shows an empty list for an unrated dish and 404 for unknown or hidden dishes', async () => {
    const res = await anon().get(`/api/v1/menu-items/${m.puff.id}/reviews`).expect(200);
    expect(res.body).toMatchObject({ reviews: [], total: 0, hasMore: false });
    await anon().get('/api/v1/menu-items/not-a-uuid/reviews').expect(404);
    await anon().get(`/api/v1/menu-items/${crypto.randomUUID()}`).expect(404);
    await prisma.menuItem.update({ where: { id: m.puff.id }, data: { isActive: false } });
    await anon().get(`/api/v1/menu-items/${m.puff.id}`).expect(404);
  });

  it('returns the dish detail with its outlet and rating breakdown', async () => {
    const res = await anon().get(`/api/v1/menu-items/${m.chai.id}`).expect(200);
    expect(res.body.item).toMatchObject({
      id: m.chai.id,
      name: 'Chai',
      rating: { average: null, count: 0 },
    });
    expect(res.body.item.rating.distribution).toHaveLength(5);
    expect(res.body.outlet.slug).toBe(m.outlet.slug);
    expect(res.body.category.name).toBe('Snacks');
  });

  it('can sort the menu by rating without hiding anything', async () => {
    const chips = await makeItem(m.outlet.id, m.category.id, { name: 'Chips', pricePaise: 1000 });
    await order(asha, m.puff.id, 3500);
    await review(asha, m.puff.id, { rating: 5 }).expect(201);
    await order(ben, m.chai.id, 2000);
    await review(ben, m.chai.id, { rating: 2 }).expect(201);
    const res = await anon().get(`/api/v1/outlets/${m.outlet.slug}/menu?sort=rating`).expect(200);
    expect(res.body.items.map((i: { name: string }) => i.name)).toEqual(['Puff', 'Chai', 'Chips']);
    expect(res.body.items.find((i: { id: string }) => i.id === chips.id).rating.count).toBe(0);
  });
});

describe('reports and moderation', () => {
  let reviewId: string;
  beforeEach(async () => {
    await order(asha, m.chai.id, 2000);
    reviewId = (await review(asha, m.chai.id, { rating: 1, body: 'Rude words' }).expect(201)).body
      .review.id;
  });

  it('lets students report once; the manager hides it from lists and summaries', async () => {
    await api(asha, 'post', `/reviews/${reviewId}/report`, { reason: 'SPAM' }).expect(400);
    await api(ben, 'post', `/reviews/${reviewId}/report`, { reason: 'OFFENSIVE' }).expect(200);
    await api(ben, 'post', `/reviews/${reviewId}/report`, { reason: 'OFFENSIVE' }).expect(200);
    expect(await prisma.foodReviewReport.count()).toBe(1);

    const base = `/staff/outlets/${m.outlet.id}/reviews`;
    const reported = await api(manager, 'get', `${base}?filter=reported`).expect(200);
    expect(reported.body.reviews).toHaveLength(1);
    expect(reported.body.reviews[0]).toMatchObject({
      id: reviewId,
      openReports: 1,
      reportReasons: ['OFFENSIVE'],
    });

    await api(manager, 'post', `${base}/${reviewId}/hide`, {}).expect(400); // needs a reason
    await api(manager, 'post', `${base}/${reviewId}/hide`, { reason: 'Abusive language' }).expect(
      200,
    );
    expect(await ratings(m.chai.id)).toMatchObject({ average: null, count: 0 });
    const list = await anon().get(`/api/v1/menu-items/${m.chai.id}/reviews`).expect(200);
    expect(list.body.total).toBe(0);
    // The author still sees it, with the reason; editing doesn't republish it.
    const mine = await api(asha, 'get', '/me/reviews').expect(200);
    expect(mine.body.reviews[0]).toMatchObject({
      status: 'HIDDEN',
      moderationReason: 'Abusive language',
    });
    await api(asha, 'patch', `/reviews/${reviewId}`, { rating: 2 }).expect(200);
    expect((await prisma.foodReview.findUniqueOrThrow({ where: { id: reviewId } })).status).toBe(
      'HIDDEN',
    );
    expect(
      (await api(manager, 'get', `${base}?filter=reported`).expect(200)).body.reviews,
    ).toHaveLength(0);

    await api(manager, 'post', `${base}/${reviewId}/restore`, {}).expect(200);
    expect(await ratings(m.chai.id)).toMatchObject({ average: 2, count: 1 });
    const audit = await prisma.auditLog.findMany({
      where: { entityType: 'FoodReview' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual(['FOOD_REVIEW_HIDE', 'FOOD_REVIEW_RESTORE']);
  });

  it('“keep” closes reports without hiding', async () => {
    await api(ben, 'post', `/reviews/${reviewId}/report`, { reason: 'OTHER', note: 'meh' }).expect(
      200,
    );
    await api(manager, 'post', `/staff/outlets/${m.outlet.id}/reviews/${reviewId}/keep`).expect(
      200,
    );
    expect(await prisma.foodReviewReport.count({ where: { resolvedAt: null } })).toBe(0);
    expect(await ratings(m.chai.id)).toMatchObject({ count: 1 });
  });

  it('keeps POS staff, other outlets’ managers and students out of moderation', async () => {
    const base = `/staff/outlets/${m.outlet.id}/reviews`;
    await api(cashier, 'get', `${base}/summary`).expect(403);
    await api(cashier, 'post', `${base}/${reviewId}/hide`, { reason: 'x' }).expect(403);
    await api(asha, 'get', base).expect(403);

    const other = await makeOutlet({ name: 'Juice Junction' });
    const otherManager = await signIn('other.manager@example.com');
    await assign('other.manager@example.com', other.id, 'MANAGER');
    await api(otherManager, 'post', `${base}/${reviewId}/hide`, { reason: 'x' }).expect(403);
    // Their own outlet's URL can't reach this outlet's review either.
    await api(otherManager, 'post', `/staff/outlets/${other.id}/reviews/${reviewId}/hide`, {
      reason: 'x',
    }).expect(404);
    expect((await prisma.foodReview.findUniqueOrThrow({ where: { id: reviewId } })).status).toBe(
      'PUBLISHED',
    );
  });
});

describe('manager analytics', () => {
  it('summarises the outlet with per-dish trends and recent feedback, without emails', async () => {
    const people = [asha, ben, await student(`cy${n}@example.com`, staffApp)];
    for (const [i, rating] of [5, 3, 4].entries()) {
      await order(people[i]!, m.chai.id, 2000);
      await review(people[i]!, m.chai.id, { rating, body: i === 0 ? 'Lovely' : null }).expect(201);
    }
    // Two older chai reviews (40 days ago) were worse: chai is improving.
    await prisma.foodReview.updateMany({
      where: { rating: { in: [3] } },
      data: { createdAt: new Date(Date.now() - 40 * 86_400_000) },
    });
    const res = await api(manager, 'get', `/staff/outlets/${m.outlet.id}/reviews/summary`).expect(
      200,
    );
    const s = res.body.summary;
    expect(s).toMatchObject({ average: 4, total: 3, openReports: 0, trendWindowDays: 30 });
    expect(s.items[0]).toMatchObject({
      id: m.chai.id,
      name: 'Chai',
      average: 4,
      count: 3,
      recentAverage: 4.5,
      priorAverage: 3,
      trend: 'IMPROVING',
    });
    expect(s.recentFeedback).toHaveLength(1);
    expect(s.recentFeedback[0]).toMatchObject({ body: 'Lovely', item: { name: 'Chai' } });
    expect(JSON.stringify(s)).not.toContain('@example.com');
  });
});

describe('surprise meal', () => {
  it('shows real ratings on combo dishes', async () => {
    await order(asha, m.chai.id, 2000);
    await review(asha, m.chai.id, { rating: 4 }).expect(201);
    const res = await api(asha, 'post', '/surprise-meal/generate', {
      budgetPaise: 5500,
      mood: 'CAFE_TREAT',
      diet: 'ANY',
      outletId: m.outlet.id,
    });
    if (res.status === 200 && res.body.combo) {
      const chai = res.body.combo.items.find((i: { id: string }) => i.id === m.chai.id);
      if (chai) expect(chai.rating).toEqual({ average: 4, count: 1 });
      for (const item of res.body.combo.items) expect(item.rating).toBeDefined();
    } else {
      expect.fail(`generate failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
  });
});

describe('display names', () => {
  it('shortens names to first name and last initial', () => {
    expect(publicName('Asha Kumar')).toBe('Asha K.');
    expect(publicName('  Ravi  ')).toBe('Ravi');
    expect(publicName('Mary Ann de souza')).toBe('Mary S.');
    expect(publicName('')).toBe('Student');
  });
});
