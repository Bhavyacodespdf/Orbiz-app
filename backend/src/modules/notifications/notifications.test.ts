import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { addToCart, fund, menu, placeOrder, student, type Agent } from '../../tests/commerce.js';
import { staffApp, staffFor, transition, cancel } from '../../tests/staff.js';
import { noopPublisher, type RealtimePublisher } from '../../realtime/publisher.js';
import { dispatchPending, MAX_DELIVERY_ATTEMPTS, notify } from './notifications.service.js';

let m: Awaited<ReturnType<typeof menu>>;
let manager: Agent;
let cashier: Agent;
let asha: Agent;
let ashaId: string;
let n = 0;

const api = (agent: Agent, method: 'get' | 'post', url: string, body?: object) => {
  const req = agent[method](`/api/v1${url}`).set('X-Requested-With', 'CampusCart');
  return body ? req.send(body) : req;
};

beforeEach(async () => {
  await resetDatabase();
  n += 1;
  m = await menu();
  ({ manager, cashier } = await staffFor(m.outlet.id));
  asha = await student(`asha${n}@example.com`, staffApp);
  ashaId = (await api(asha, 'get', '/auth/me').expect(200)).body.user.id;
});

async function placed(agent = asha) {
  await fund(agent, 10_000);
  await addToCart(agent, m.chai.id);
  return (await placeOrder(agent, 'WALLET', 2000).expect(201)).body.order as {
    id: string;
    pickupCode: string;
  };
}
const typesFor = async (userId: string) =>
  (await prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })).map(
    (x) => x.type,
  );

/** A publisher that records live deliveries (and can be told to fail). */
function recorder(fail = false) {
  const sent: { userId: string; id: string }[] = [];
  const publisher: RealtimePublisher = {
    ...noopPublisher,
    notificationCreated(userId, notification) {
      if (fail) throw new Error('socket down');
      sent.push({ userId, id: notification.id });
    },
  };
  return { sent, publisher };
}

describe('order lifecycle notifications', () => {
  it('records one notification per committed status change, linked to the order, without secrets', async () => {
    const order = await placed();
    for (const to of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) {
      await transition(cashier, m.outlet.id, order.id, to).expect(200);
    }
    // COLLECTED and REVIEW_PROMPT are written together (same instant): compare them as a set.
    const types = await typesFor(ashaId);
    expect(types.slice(0, 4)).toEqual([
      'ORDER_PLACED',
      'ORDER_ACCEPTED',
      'ORDER_PREPARING',
      'ORDER_READY',
    ]);
    expect([...types.slice(4)].sort()).toEqual(['ORDER_COLLECTED', 'REVIEW_PROMPT']);
    const rows = await prisma.notification.findMany({ where: { userId: ashaId } });
    expect(rows.every((r) => r.link === `/orders/${order.id}` && r.entityId === order.id)).toBe(
      true,
    );
    expect(rows.find((r) => r.type === 'ORDER_READY')!.title).toBe(
      `Order ${order.pickupCode} is ready`,
    );
    // The pickup code is never in a notification.
    const credential = await prisma.pickupCredential.findFirstOrThrow({
      where: { orderId: order.id },
    });
    const { unseal } = await import('../pickup/pickup.crypto.js');
    const { code } = unseal(credential.sealed, order.id);
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it('creates nothing when the change rolls back', async () => {
    const order = await placed();
    // Rejecting without a reason is refused: no notification either.
    await transition(manager, m.outlet.id, order.id, 'REJECTED').expect(400);
    expect(await typesFor(ashaId)).toEqual(['ORDER_PLACED']);
    // A checkout that fails (not enough money) leaves no "placed" notification behind.
    const ben = await student(`ben${n}@example.com`, staffApp);
    const benId = (await api(ben, 'get', '/auth/me').expect(200)).body.user.id;
    await addToCart(ben, m.chai.id);
    await placeOrder(ben, 'WALLET', 2000).expect(409);
    expect(await typesFor(benId)).toEqual([]);
  });

  it('says what happened and what was refunded on rejection and cancellation', async () => {
    const a = await placed();
    await transition(manager, m.outlet.id, a.id, 'REJECTED', 'Out of milk').expect(200);
    const rejected = await prisma.notification.findFirstOrThrow({
      where: { type: 'ORDER_REJECTED' },
    });
    expect(rejected.body).toContain('Out of milk');
    expect(rejected.body).toContain('₹20 was refunded');
    const b = await placed();
    await cancel(asha, b.id).expect(200);
    const cancelled = await prisma.notification.findFirstOrThrow({
      where: { type: 'ORDER_CANCELLED' },
    });
    expect(cancelled.title).toBe(`You cancelled Order ${b.pickupCode}`);
  });

  it('never duplicates a logical event', async () => {
    const order = await placed();
    const input = {
      userId: ashaId,
      type: 'ORDER_READY' as const,
      title: 'x',
      body: 'y',
      dedupeKey: `order:${order.id}:READY`,
    };
    await notify(prisma, input);
    await notify(prisma, input);
    await Promise.all([notify(prisma, input), notify(prisma, input)]);
    expect(await prisma.notification.count({ where: { type: 'ORDER_READY' } })).toBe(1);
  });

  it('tells the outlet’s staff once per window when capacity is full', async () => {
    const shoppers = [];
    for (let i = 0; i < 10; i++) shoppers.push(await student(`cap${n}-${i}@example.com`, staffApp));
    for (const s of shoppers) {
      await addToCart(s, m.chai.id);
      await placeOrder(s, 'COUNTER', 2000).expect(201);
    }
    for (const who of ['late1', 'late2']) {
      const s = await student(`${who}-${n}@example.com`, staffApp);
      await addToCart(s, m.chai.id);
      await placeOrder(s, 'COUNTER', 2000).expect(429);
    }
    await new Promise((r) => setTimeout(r, 100));
    const notes = await prisma.notification.findMany({ where: { type: 'STAFF_CAPACITY_FULL' } });
    expect(notes).toHaveLength(2); // manager + cashier, once each
  });
});

describe('inbox API', () => {
  it('lists the user’s own notifications, newest first, with unread counts and paging', async () => {
    const order = await placed();
    for (const to of ['ACCEPTED', 'PREPARING'])
      await transition(cashier, m.outlet.id, order.id, to).expect(200);
    const all = await api(asha, 'get', '/me/notifications?limit=2').expect(200);
    expect(all.body.unread).toBe(3);
    expect(all.body.notifications.map((x: { type: string }) => x.type)).toEqual([
      'ORDER_PREPARING',
      'ORDER_ACCEPTED',
    ]);
    const next = await api(
      asha,
      'get',
      `/me/notifications?limit=2&cursor=${all.body.nextCursor}`,
    ).expect(200);
    expect(next.body.notifications.map((x: { type: string }) => x.type)).toEqual(['ORDER_PLACED']);
    expect(next.body.nextCursor).toBeNull();

    const first = all.body.notifications[0].id;
    await api(asha, 'post', `/me/notifications/${first}/read`).expect(200);
    expect((await api(asha, 'get', '/me/notifications/unread-count').expect(200)).body.unread).toBe(
      2,
    );
    const unread = await api(asha, 'get', '/me/notifications?filter=unread').expect(200);
    expect(unread.body.notifications).toHaveLength(2);
    await api(asha, 'post', '/me/notifications/read-all').expect(200);
    expect((await api(asha, 'get', '/me/notifications/unread-count').expect(200)).body.unread).toBe(
      0,
    );
  });

  it('keeps inboxes private', async () => {
    await placed();
    const mine = (await api(asha, 'get', '/me/notifications').expect(200)).body.notifications[0].id;
    const ben = await student(`ben${n}@example.com`, staffApp);
    expect((await api(ben, 'get', '/me/notifications').expect(200)).body.notifications).toEqual([]);
    await api(ben, 'post', `/me/notifications/${mine}/read`).expect(404);
    await request(staffApp).get('/api/v1/me/notifications').expect(401);
    expect(
      (await prisma.notification.findUniqueOrThrow({ where: { id: mine } })).readAt,
    ).toBeNull();
  });
});

describe('delivery', () => {
  const seed = (count: number) =>
    notify(
      prisma,
      Array.from({ length: count }, (_, i) => ({
        userId: ashaId,
        type: 'ORDER_PLACED' as const,
        title: `Order ${i}`,
        body: 'placed',
        dedupeKey: `test:${i}`,
      })),
    );

  it('delivers committed notifications live once, even with several dispatchers', async () => {
    await seed(2);
    const { sent, publisher } = recorder();
    await Promise.all([1, 2, 3].map(() => dispatchPending(prisma, publisher)));
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((s) => s.id)).size).toBe(2);
    expect(await prisma.notification.count({ where: { deliveryStatus: 'DELIVERED' } })).toBe(2);
    // Nothing left to send.
    await dispatchPending(prisma, publisher);
    expect(sent).toHaveLength(2);
  });

  it('retries failed live delivery with backoff, then marks it failed and tells managers', async () => {
    const order = await placed();
    await new Promise((r) => setTimeout(r, 200)); // let the request's own delivery finish
    await prisma.notification.updateMany({
      data: { deliveryStatus: 'PENDING', deliveryAttempts: 0, nextAttemptAt: null },
    });
    const { publisher } = recorder(true);
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      await dispatchPending(prisma, publisher);
      const row = await prisma.notification.findFirstOrThrow({ where: { type: 'ORDER_PLACED' } });
      expect(row.deliveryAttempts).toBe(i + 1);
      // Make the backoff elapse for the next round.
      await prisma.notification.updateMany({
        where: { id: row.id, deliveryStatus: 'PENDING' },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
    }
    const row = await prisma.notification.findFirstOrThrow({ where: { type: 'ORDER_PLACED' } });
    expect(row).toMatchObject({ deliveryStatus: 'FAILED', lastError: 'socket down' });
    // Still in the inbox: offline delivery doesn't depend on the socket.
    const inbox = await api(asha, 'get', '/me/notifications').expect(200);
    expect(
      inbox.body.notifications.some((x: { entity: { id: string } }) => x.entity.id === order.id),
    ).toBe(true);
    const managerNotes = await prisma.notification.findMany({
      where: { type: 'MANAGER_DELIVERY_FAILURES' },
    });
    expect(managerNotes).toHaveLength(1);
  });
});
