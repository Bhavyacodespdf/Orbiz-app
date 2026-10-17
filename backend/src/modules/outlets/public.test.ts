import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { buildTestApp } from '../../tests/helpers.js';
import { makeCategory, makeItem, makeOutlet } from '../../tests/fixtures.js';

beforeEach(resetDatabase);
const api = () => request(buildTestApp());

describe('GET /outlets', () => {
  it('works on an empty database', async () => {
    const res = await api().get('/api/v1/outlets').expect(200);
    expect(res.body).toEqual({ outlets: [] });
  });

  it('lists active outlets without sign-in, open first, and hides archived outlets', async () => {
    await makeOutlet({ name: 'A Closed', status: 'CLOSED' });
    await makeOutlet({ name: 'B Open', status: 'OPEN' });
    await makeOutlet({ name: 'C Archived', isActive: false });
    const res = await api().get('/api/v1/outlets').expect(200);
    expect(res.body.outlets.map((o: { name: string }) => o.name)).toEqual(['B Open', 'A Closed']);
    expect(res.body.outlets[0]).toMatchObject({
      status: 'OPEN',
      acceptingOrders: true,
      isSample: false,
    });
    expect(res.body.outlets[1].acceptingOrders).toBe(false);
    expect(res.body.outlets[0]).not.toHaveProperty('isActive');
  });

  it('searches outlet names and visible menu item names, case-insensitively', async () => {
    const cafe = await makeOutlet({ name: 'Night Owl Café' });
    const grill = await makeOutlet({ name: 'Grill House' });
    const cat = await makeCategory(grill.id);
    await makeItem(grill.id, cat.id, { name: 'Masala Dosa' });
    const hidden = await makeOutlet({ name: 'Other' });
    const hiddenCat = await makeCategory(hidden.id);
    await makeItem(hidden.id, hiddenCat.id, { name: 'Secret dosa', isActive: false });

    const byName = await api().get('/api/v1/outlets?q=night owl').expect(200);
    expect(byName.body.outlets.map((o: { id: string }) => o.id)).toEqual([cafe.id]);
    const byItem = await api().get('/api/v1/outlets?q=DOSA').expect(200);
    expect(byItem.body.outlets.map((o: { id: string }) => o.id)).toEqual([grill.id]);
  });

  it('rejects over-long search text', async () => {
    await api()
      .get(`/api/v1/outlets?q=${'x'.repeat(61)}`)
      .expect(400);
  });
});

describe('GET /outlets/:slug and /menu', () => {
  it('returns 404 for unknown or archived outlets', async () => {
    const archived = await makeOutlet({ isActive: false });
    await api().get('/api/v1/outlets/nope').expect(404);
    await api().get(`/api/v1/outlets/${archived.slug}`).expect(404);
    await api().get(`/api/v1/outlets/${archived.slug}/menu`).expect(404);
  });

  it('returns the menu with prices from the database, sold-out items flagged, hidden items omitted', async () => {
    const outlet = await makeOutlet();
    const drinks = await makeCategory(outlet.id, 'Drinks', 1);
    const snacks = await makeCategory(outlet.id, 'Snacks', 0);
    const retired = await makeCategory(outlet.id, 'Retired', 2);
    await makeItem(outlet.id, retired.id, { name: 'In retired category' });
    await prisma.menuCategory.update({ where: { id: retired.id }, data: { isActive: false } });
    await makeItem(outlet.id, drinks.id, { name: 'Chai', pricePaise: 2000 });
    await makeItem(outlet.id, snacks.id, { name: 'Samosa', pricePaise: 1500, isAvailable: false });
    await makeItem(outlet.id, snacks.id, { name: 'Old item', isActive: false });

    const res = await api().get(`/api/v1/outlets/${outlet.slug}/menu`).expect(200);
    expect(res.body.categories.map((c: { name: string }) => c.name)).toEqual(['Snacks', 'Drinks']);
    expect(res.body.items).toEqual([
      expect.objectContaining({
        name: 'Samosa',
        pricePaise: 1500,
        isAvailable: false,
        categoryId: snacks.id,
      }),
      expect.objectContaining({
        name: 'Chai',
        pricePaise: 2000,
        isAvailable: true,
        categoryId: drinks.id,
      }),
    ]);
    expect(res.body.items[0]).not.toHaveProperty('isActive');
  });

  it('filters by search text, category and dietary type on the server', async () => {
    const outlet = await makeOutlet();
    const rolls = await makeCategory(outlet.id, 'Rolls');
    const drinks = await makeCategory(outlet.id, 'Drinks');
    await makeItem(outlet.id, rolls.id, { name: 'Paneer roll', dietary: 'VEG' });
    await makeItem(outlet.id, rolls.id, { name: 'Chicken roll', dietary: 'NON_VEG' });
    await makeItem(outlet.id, rolls.id, {
      name: 'Egg roll',
      dietary: 'EGG',
      description: 'double egg',
    });
    await makeItem(outlet.id, drinks.id, { name: 'Lime soda', dietary: 'VEG' });

    const names = async (query: string) =>
      (await api().get(`/api/v1/outlets/${outlet.slug}/menu?${query}`).expect(200)).body.items
        .map((i: { name: string }) => i.name)
        .sort();

    expect(await names('dietary=VEG')).toEqual(['Lime soda', 'Paneer roll']);
    expect(await names(`category=${drinks.id}`)).toEqual(['Lime soda']);
    expect(await names('q=ROLL')).toEqual(['Chicken roll', 'Egg roll', 'Paneer roll']);
    expect(await names('q=double')).toEqual(['Egg roll']);
    expect(await names(`q=roll&dietary=VEG&category=${rolls.id}`)).toEqual(['Paneer roll']);
  });

  it('validates filters', async () => {
    const outlet = await makeOutlet();
    await api().get(`/api/v1/outlets/${outlet.slug}/menu?dietary=VEGAN`).expect(400);
    await api().get(`/api/v1/outlets/${outlet.slug}/menu?category=not-a-uuid`).expect(400);
  });
});
