import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { menu, student, type Agent } from '../../tests/commerce.js';
import { assign, makeOutlet } from '../../tests/fixtures.js';
import { signIn, staffFor } from '../../tests/staff.js';
import { istDayOf, istMidnight } from '../scheduling/slots.js';

let m: Awaited<ReturnType<typeof menu>>;
let manager: Agent;
let cashier: Agent;
let host: Agent;
let n = 0;

const at = (daysAhead: number, hour: number) => {
  const day = istDayOf(Date.now() + daysAhead * 86_400_000);
  return new Date(istMidnight(day) + hour * 3_600_000).toISOString();
};
const staff = (agent: Agent, method: 'get' | 'put' | 'post', url: string, body?: object) => {
  const req = agent[method](`/api/v1/staff/outlets/${m.outlet.id}${url}`).set(
    'X-Requested-With',
    'CampusCart',
  );
  return body ? req.send(body) : req;
};
const send = (agent: Agent, method: 'get' | 'post', url: string, body?: object) => {
  const req = agent[method](`/api/v1/banquets${url}`).set('X-Requested-With', 'CampusCart');
  return body ? req.send(body) : req;
};

beforeEach(async () => {
  await resetDatabase();
  n += 1;
  m = await menu(); // Chai ₹20, Puff ₹35
  ({ manager, cashier } = await staffFor(m.outlet.id));
  host = await student(`host${n}@example.com`);
  await staff(manager, 'put', '/schedule', {
    leadMinutes: 30,
    slotMinutes: 15,
    daysAhead: 2,
    slotCapacity: null,
    hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      opensMinute: 9 * 60,
      closesMinute: 21 * 60,
    })),
  }).expect(200);
});

const enable = (extra: object = {}) =>
  staff(manager, 'put', '/banquets/settings', {
    enabled: true,
    maxGuests: 30,
    minNoticeDays: 2,
    maxConcurrentEvents: 1,
    ...extra,
  });

const request = (extra: object = {}) => ({
  outletId: m.outlet.id,
  name: 'ML club meetup',
  eventType: 'CLUB_EVENT',
  startsAt: at(5, 12),
  durationMinutes: 120,
  guestCount: 10,
  dietaryNotes: '3 vegan',
  items: [
    { menuItemId: m.puff.id, quantity: 10 },
    { menuItemId: m.chai.id, quantity: 10 },
  ],
  expectedTotalPaise: 55_000,
  ...extra,
});

describe('planning an event', () => {
  it('needs the outlet to take banquets; only its manager can turn them on', async () => {
    expect((await send(host, 'post', '', request()).expect(409)).body.error.code).toBe(
      'BANQUETS_UNAVAILABLE',
    );
    await staff(cashier, 'put', '/banquets/settings', {
      enabled: true,
      maxGuests: 30,
      minNoticeDays: 2,
      maxConcurrentEvents: 1,
    }).expect(403);
    await enable().expect(200);
    expect((await send(host, 'get', '/venues').expect(200)).body.venues).toEqual([
      expect.objectContaining({ outletId: m.outlet.id, maxGuests: 30, minNoticeDays: 2 }),
    ]);
  });

  it('prices the package on the server and saves a snapshot that later price changes don’t touch', async () => {
    await enable().expect(200);
    const q = (
      await send(host, 'post', '/quote', {
        outletId: m.outlet.id,
        guestCount: 10,
        items: request().items,
      }).expect(200)
    ).body.quote;
    expect(q).toMatchObject({ totalPaise: 55_000, perGuestPaise: 5500 });
    const booking = (await send(host, 'post', '', request()).expect(201)).body.booking;
    expect(booking).toMatchObject({
      status: 'PENDING_CONFIRMATION',
      estimatedTotalPaise: 55_000,
      perGuestPaise: 5500,
      guestCount: 10,
    });
    expect(booking.passToken).toBeUndefined();
    await prisma.menuItem.update({ where: { id: m.puff.id }, data: { pricePaise: 9900 } });
    const again = (await send(host, 'get', `/${booking.id}`).expect(200)).body.booking;
    expect(again.estimatedTotalPaise).toBe(55_000);
    expect(again.items.find((i: { name: string }) => i.name === 'Puff').unitPricePaise).toBe(3500);
    // The old total is now stale.
    expect(
      (await send(host, 'post', '', request({ startsAt: at(6, 12) })).expect(409)).body.error.code,
    ).toBe('PRICE_CHANGED');
  });

  it('checks notice, guests, hours and clashing bookings', async () => {
    await enable().expect(200);
    expect(
      (await send(host, 'post', '', request({ startsAt: at(1, 12) })).expect(409)).body.error.code,
    ).toBe('TOO_SOON');
    expect(
      (await send(host, 'post', '', request({ guestCount: 31 })).expect(409)).body.error.code,
    ).toBe('TOO_MANY_GUESTS');
    expect(
      (await send(host, 'post', '', request({ startsAt: at(5, 20) })).expect(409)).body.error.code,
    ).toBe('OUTSIDE_HOURS');
    await send(host, 'post', '', request()).expect(201);
    const other = await student(`other${n}@example.com`);
    expect(
      (await send(other, 'post', '', request({ startsAt: at(5, 13) })).expect(409)).body.error.code,
    ).toBe('SLOT_UNAVAILABLE');
    await send(other, 'post', '', request({ startsAt: at(5, 14) })).expect(201); // right after
    // Two at once can't both take the last place.
    const racers = await Promise.all(
      [1, 2].map(async (i) =>
        send(await student(`r${i}${n}@example.com`), 'post', '', request({ startsAt: at(6, 10) })),
      ),
    );
    expect(racers.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});

describe('confirming, passes and permissions', () => {
  it('lets only the outlet’s manager decide, and validates the event pass on the server', async () => {
    await enable().expect(200);
    const booking = (await send(host, 'post', '', request()).expect(201)).body.booking;
    await staff(cashier, 'post', `/banquets/${booking.id}/confirm`, {}).expect(403);
    await staff(host, 'post', `/banquets/${booking.id}/confirm`, {}).expect(403);
    expect(
      (await staff(manager, 'post', `/banquets/${booking.id}/reject`, {}).expect(400)).body.error
        .code,
    ).toBe('REASON_REQUIRED');
    await staff(manager, 'post', `/banquets/${booking.id}/confirm`, {}).expect(200);
    await staff(manager, 'post', `/banquets/${booking.id}/confirm`, {}).expect(409);
    expect((await send(host, 'get', `/${booking.id}`).expect(200)).body.booking.status).toBe(
      'CONFIRMED',
    );

    // The pass: the host gets the token; nobody else can read the booking or its pass.
    const pass = (await send(host, 'get', `/${booking.id}/pass`).expect(200)).body.booking;
    expect(pass.passToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const other = await student(`nosy${n}@example.com`);
    await send(other, 'get', `/${booking.id}`).expect(404);
    await send(other, 'get', `/${booking.id}/pass`).expect(404);
    // Staff of this outlet can verify it; another outlet's staff can't.
    const check = (await staff(cashier, 'get', `/banquets/pass/${pass.passToken}`).expect(200))
      .body;
    expect(check).toMatchObject({
      valid: true,
      booking: { id: booking.id, name: 'ML club meetup' },
    });
    expect(check.booking.passToken).toBeUndefined();
    const elsewhere = await makeOutlet({ name: 'Canteen' });
    const otherManager = await signIn('other.manager@example.com');
    await assign('other.manager@example.com', elsewhere.id, 'MANAGER');
    await otherManager
      .get(`/api/v1/staff/outlets/${elsewhere.id}/banquets/pass/${pass.passToken}`)
      .expect(404);
    await otherManager.get(`/api/v1/staff/outlets/${m.outlet.id}/banquets`).expect(403);
    await staff(cashier, 'get', '/banquets/pass/not-a-real-token-at-all-xx').expect(404);

    // Cancelled → the pass is no longer valid.
    await send(host, 'post', `/${booking.id}/cancel`, {}).expect(200);
    expect(
      (await staff(cashier, 'get', `/banquets/pass/${pass.passToken}`).expect(200)).body.valid,
    ).toBe(false);
  });

  it('records every status change with who made it', async () => {
    await enable().expect(200);
    const booking = (await send(host, 'post', '', request()).expect(201)).body.booking;
    await staff(manager, 'post', `/banquets/${booking.id}/reject`, {
      reason: 'Kitchen fully booked',
    }).expect(200);
    const b = (await send(host, 'get', `/${booking.id}`).expect(200)).body.booking;
    expect(b).toMatchObject({ status: 'REJECTED', decisionReason: 'Kitchen fully booked' });
    expect(
      b.history.map((h: { toStatus: string; actorRole: string }) => [h.toStatus, h.actorRole]),
    ).toEqual([
      ['PENDING_CONFIRMATION', 'STUDENT'],
      ['REJECTED', 'MANAGER'],
    ]);
    await send(host, 'post', `/${booking.id}/cancel`, {}).expect(409);
    await staff(manager, 'post', `/banquets/${booking.id}/complete`, {}).expect(409);
  });
});
