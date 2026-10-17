import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as connect, type Socket } from 'socket.io-client';
import { prisma, resetDatabase } from '../tests/db.js';
import { createApp } from '../app.js';
import { createSocketServer } from './socket-server.js';
import { createDeferredPublisher } from './publisher.js';
import { FRONTEND } from '../tests/helpers.js';
import { staffConfig, transition, cancel } from '../tests/staff.js';
import { assign, makeCategory, makeItem, makeOutlet } from '../tests/fixtures.js';
import { lifecycle, openPollWith, vote } from '../tests/polls.js';
import { addToCart, fund, key, menu, placeOrder, post, type Agent } from '../tests/commerce.js';
import { revokeRole } from '../modules/users/roles.service.js';

// A real HTTP + Socket.IO server on a random port, with real sessions and database.

let server: Server;
let baseUrl: string;
let realtime: ReturnType<typeof createSocketServer>;
const sockets: Socket[] = [];

beforeAll(async () => {
  // Same wiring as server.ts: Express first, Socket.IO attached afterwards.
  const deferred = createDeferredPublisher();
  server = createServer(
    createApp({ db: prisma, config: staffConfig, google: null, realtime: deferred.publisher }),
  );
  realtime = createSocketServer(server, prisma, staffConfig, { sessionRecheckMs: 150 });
  deferred.connect(realtime.publisher);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await realtime.close();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(resetDatabase);
afterEach(() => {
  for (const s of sockets.splice(0)) s.disconnect();
});

async function login(email: string): Promise<{ agent: Agent; cookie: string }> {
  const agent = request.agent(server);
  const res = await agent
    .post('/api/v1/auth/dev-login')
    .set('X-Requested-With', 'CampusCart')
    .send({ email })
    .expect(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[])
    .find((c) => c.startsWith('cc_session='))!
    .split(';')[0]!;
  return { agent, cookie };
}

function open(
  cookie?: string,
  origin = FRONTEND,
  transports: ('websocket' | 'polling')[] = ['websocket'],
): Socket {
  const socket = connect(baseUrl, {
    transports,
    forceNew: true,
    reconnection: false,
    extraHeaders: { origin, ...(cookie && { cookie }) },
  });
  sockets.push(socket);
  return socket;
}

/** Connects and waits until the server has put the socket in its rooms. */
async function live(cookie: string) {
  const socket = open(cookie);
  const events: { name: string; payload: Record<string, unknown> }[] = [];
  socket.onAny((name, payload) => events.push({ name, payload }));
  await new Promise<void>((resolve, reject) => {
    socket.once('ready', () => resolve());
    socket.once('connect_error', reject);
  });
  return { socket, events };
}

const connectError = (socket: Socket) =>
  new Promise<string>((resolve) => socket.once('connect_error', (err) => resolve(err.message)));

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Timed out waiting for event');
    await settle(20);
  }
}

describe('socket authentication', () => {
  it('rejects connections without a session', async () => {
    expect(await connectError(open())).toBe('UNAUTHENTICATED');
  });

  it('rejects an invalid or logged-out session', async () => {
    expect(await connectError(open('cc_session=forged-token'))).toBe('UNAUTHENTICATED');
  });

  it('rejects connections from another website (cross-site WebSocket hijacking)', async () => {
    const { cookie } = await login('student@example.com');
    expect(await connectError(open(cookie, 'https://evil.example'))).toBe('ORIGIN_NOT_ALLOWED');
  });
});

describe('transports', () => {
  it('works over HTTP long-polling as well as WebSocket, without breaking the REST API', async () => {
    const owner = await login('student@example.com');
    const socket = open(owner.cookie, FRONTEND, ['polling']);
    await new Promise<void>((resolve, reject) => {
      socket.once('ready', () => resolve());
      socket.once('connect_error', reject);
    });
    // Several polling round-trips, then make sure the server is still healthy.
    await settle(300);
    await owner.agent.get('/api/v1/health').expect(200);
    expect(socket.connected).toBe(true);
  });
});

describe('room privacy', () => {
  it('sends order events only to the owner and that outlet’s assigned staff (#17 for orders)', async () => {
    const m = await menu();
    const other = await makeOutlet({ name: 'Elsewhere' });
    const owner = await login('student@example.com');
    const bystander = await login('other@example.com');
    const manager = await login('manager@example.com');
    const otherManager = await login('other.manager@example.com');
    const cashier = await login('cashier@example.com'); // POS role, but not assigned here
    await assign('manager@example.com', m.outlet.id, 'MANAGER');
    await assign('other.manager@example.com', other.id, 'MANAGER');

    const [ownerLive, bystanderLive, managerLive, otherLive, cashierLive] = await Promise.all([
      live(owner.cookie),
      live(bystander.cookie),
      live(manager.cookie),
      live(otherManager.cookie),
      live(cashier.cookie),
    ]);

    await addToCart(owner.agent, m.chai.id);
    const { order } = (await placeOrder(owner.agent, 'COUNTER', 2000).expect(201)).body;

    await until(() => managerLive.events.some((e) => e.name === 'order.created'));
    await transition(manager.agent, m.outlet.id, order.id, 'ACCEPTED').expect(200);
    await until(() =>
      ownerLive.events.some((e) => e.name === 'order.updated' && e.payload.status === 'ACCEPTED'),
    );
    await settle();

    expect(managerLive.events.find((e) => e.name === 'order.created')!.payload).toMatchObject({
      orderId: order.id,
      outletId: m.outlet.id,
      pickupCode: 'N-001',
      status: 'PLACED',
      version: 1,
    });
    // Minimal payloads: no items, prices, names or contact details.
    expect(
      Object.keys(ownerLive.events.find((e) => e.name === 'order.updated')!.payload).sort(),
    ).toEqual(
      [
        'orderId',
        'outletId',
        'paymentStatus',
        'pickupCode',
        'status',
        'updatedAt',
        'version',
      ].sort(),
    );
    for (const outsider of [bystanderLive, otherLive, cashierLive]) {
      expect(outsider.events.filter((e) => e.name.startsWith('order.'))).toEqual([]);
    }
  });

  it('#17 sends wallet events only to the wallet owner', async () => {
    const owner = await login('student@example.com');
    const bystander = await login('other@example.com');
    const [ownerLive, bystanderLive] = await Promise.all([
      live(owner.cookie),
      live(bystander.cookie),
    ]);

    const r = await post(owner.agent, '/wallet/recharges', { amountPaise: 9900 }, key()).expect(
      201,
    );
    await post(owner.agent, `/payments/mock/${r.body.recharge.id}/outcome`, {
      outcome: 'SUCCESS',
    }).expect(200);
    await until(() => ownerLive.events.filter((e) => e.name === 'wallet.updated').length >= 2);
    await settle();
    expect(ownerLive.events.find((e) => e.name === 'wallet.updated')!.payload).toEqual({
      reason: 'RECHARGE',
    });
    expect(JSON.stringify(ownerLive.events)).not.toMatch(/balance/i);
    expect(bystanderLive.events.filter((e) => e.name === 'wallet.updated')).toEqual([]);
  });

  it('ignores any attempt by a client to join someone else’s room', async () => {
    const owner = await login('student@example.com');
    const snoop = await login('other@example.com');
    const ownerUser = await prisma.user.findUniqueOrThrow({
      where: { email: 'student@example.com' },
    });
    const [ownerLive, snoopLive] = await Promise.all([live(owner.cookie), live(snoop.cookie)]);
    for (const event of ['join', 'subscribe', 'joinRoom']) {
      snoopLive.socket.emit(event, `user:${ownerUser.id}`);
      snoopLive.socket.emit(event, { room: `user:${ownerUser.id}` });
    }
    await settle(100);
    await post(owner.agent, '/wallet/recharges', { amountPaise: 9900 }, key()).expect(201);
    await until(() => ownerLive.events.some((e) => e.name === 'wallet.updated'));
    await settle();
    expect(snoopLive.events.filter((e) => e.name === 'wallet.updated')).toEqual([]);
  });
});

describe('delivery guarantees', () => {
  it('emits only after the change is committed: the database already shows it', async () => {
    const m = await menu();
    const owner = await login('student@example.com');
    const manager = await login('manager@example.com');
    await assign('manager@example.com', m.outlet.id, 'MANAGER');
    await fund(owner.agent, 9900);
    await addToCart(owner.agent, m.chai.id);
    const { order } = (await placeOrder(owner.agent, 'WALLET', 2000).expect(201)).body;

    const ownerLive = await live(owner.cookie);
    const seenInDb: string[] = [];
    ownerLive.socket.on('order.updated', async (payload: { orderId: string; status: string }) => {
      const row = await prisma.order.findUniqueOrThrow({ where: { id: payload.orderId } });
      seenInDb.push(`${payload.status}=${row.status}`);
    });
    await transition(manager.agent, m.outlet.id, order.id, 'REJECTED', 'Out of milk').expect(200);
    await until(
      () => seenInDb.length === 1 && ownerLive.events.some((e) => e.name === 'wallet.updated'),
    );
    expect(seenInDb).toEqual(['REJECTED=REJECTED']);
    expect(ownerLive.events.find((e) => e.name === 'wallet.updated')!.payload).toEqual({
      reason: 'REFUND',
    });
  });

  it('sends nothing when a request fails', async () => {
    const m = await menu();
    const owner = await login('student@example.com');
    const manager = await login('manager@example.com');
    await assign('manager@example.com', m.outlet.id, 'MANAGER');
    await addToCart(owner.agent, m.chai.id);
    const managerLive = await live(manager.cookie);
    const ownerLive = await live(owner.cookie);
    await placeOrder(owner.agent, 'WALLET', 2000).expect(409); // insufficient balance
    await settle();
    expect(managerLive.events.filter((e) => e.name === 'order.created')).toEqual([]);
    expect(ownerLive.events.filter((e) => e.name.startsWith('order.'))).toEqual([]);
  });

  it('recovers missed changes after reconnecting by reading the persisted state', async () => {
    const m = await menu();
    const owner = await login('student@example.com');
    const manager = await login('manager@example.com');
    await assign('manager@example.com', m.outlet.id, 'MANAGER');
    await addToCart(owner.agent, m.chai.id);
    const { order } = (await placeOrder(owner.agent, 'COUNTER', 2000).expect(201)).body;

    const first = await live(owner.cookie);
    first.socket.disconnect();
    await transition(manager.agent, m.outlet.id, order.id, 'ACCEPTED').expect(200); // missed while offline
    const again = await live(owner.cookie);
    expect(again.events.filter((e) => e.name === 'order.updated')).toEqual([]);
    const restored = await owner.agent.get(`/api/v1/orders/${order.id}`).expect(200);
    expect(restored.body.order).toMatchObject({ status: 'ACCEPTED', version: 2 });
  });
});

describe('ending live connections', () => {
  it('disconnects the session’s sockets on logout', async () => {
    const owner = await login('student@example.com');
    const ownerLive = await live(owner.cookie);
    const disconnected = new Promise((resolve) => ownerLive.socket.once('disconnect', resolve));
    await owner.agent.post('/api/v1/auth/logout').set('X-Requested-With', 'CampusCart').expect(204);
    await disconnected;
    expect(ownerLive.events.some((e) => e.name === 'session.revoked')).toBe(true);
  });

  it('disconnects staff whose role is revoked elsewhere (e.g. via the CLI)', async () => {
    const m = await menu();
    const manager = await login('manager@example.com');
    await assign('manager@example.com', m.outlet.id, 'MANAGER');
    const managerLive = await live(manager.cookie);
    const disconnected = new Promise((resolve) => managerLive.socket.once('disconnect', resolve));
    await revokeRole(prisma, {
      email: 'manager@example.com',
      role: 'MANAGER',
      actor: { type: 'CLI' },
      reason: 'Left',
    });
    await disconnected;
  });

  it('student cancel notifies staff and the owner', async () => {
    const m = await menu();
    const owner = await login('student@example.com');
    const manager = await login('manager@example.com');
    await assign('manager@example.com', m.outlet.id, 'MANAGER');
    await addToCart(owner.agent, m.chai.id);
    const { order } = (await placeOrder(owner.agent, 'COUNTER', 2000).expect(201)).body;
    const managerLive = await live(manager.cookie);
    await cancel(owner.agent, order.id).expect(200);
    await until(() =>
      managerLive.events.some(
        (e) => e.name === 'order.updated' && e.payload.status === 'CANCELLED',
      ),
    );
  });
});

describe('access changes while connected (Phase 7)', () => {
  async function adminAgent() {
    const admin = await login('admin@example.com');
    const { grantRole } = await import('../modules/users/roles.service.js');
    await grantRole(prisma, {
      email: 'admin@example.com',
      role: 'ADMIN',
      actor: { type: 'CLI' },
      lists: staffConfig,
    });
    return admin;
  }

  it('starts sending an outlet’s orders as soon as an admin assigns the manager — no reconnect', async () => {
    const m = await menu();
    const admin = await adminAgent();
    const manager = await login('manager@example.com');
    const owner = await login('student@example.com');
    const managerLive = await live(manager.cookie);

    await post(admin.agent, `/admin/outlets/${m.outlet.id}/staff`, {
      email: 'manager@example.com',
      role: 'MANAGER',
    }).expect(201);
    await until(() => managerLive.events.some((e) => e.name === 'access.changed'));

    await addToCart(owner.agent, m.chai.id);
    await placeOrder(owner.agent, 'COUNTER', 2000).expect(201);
    await until(() => managerLive.events.some((e) => e.name === 'order.created'));
  });

  it('stops sending an outlet’s orders as soon as the assignment is removed', async () => {
    const m = await menu();
    const admin = await adminAgent();
    const manager = await login('manager@example.com');
    const owner = await login('student@example.com');
    const assignment = await assign('manager@example.com', m.outlet.id, 'MANAGER');
    const managerLive = await live(manager.cookie);

    await admin.agent
      .delete(`/api/v1/admin/outlets/${m.outlet.id}/staff/${assignment.id}`)
      .set('X-Requested-With', 'CampusCart')
      .expect(204);
    await until(() => managerLive.events.some((e) => e.name === 'access.changed'));

    await addToCart(owner.agent, m.chai.id);
    await placeOrder(owner.agent, 'COUNTER', 2000).expect(201);
    await settle();
    expect(managerLive.events.filter((e) => e.name === 'order.created')).toEqual([]);
  });

  it('disconnects a user immediately when an admin revokes their role', async () => {
    const admin = await adminAgent();
    const manager = await login('manager@example.com');
    const managerLive = await live(manager.cookie);
    const disconnected = new Promise((resolve) => managerLive.socket.once('disconnect', resolve));
    const managerUser = await prisma.user.findUniqueOrThrow({
      where: { email: 'manager@example.com' },
    });
    await post(admin.agent, `/admin/users/${managerUser.id}/roles/MANAGER/revoke`, {
      reason: 'Left the team',
    }).expect(200);
    await disconnected;
    expect(managerLive.events.some((e) => e.name === 'session.revoked')).toBe(true);
  });
});

describe('Today’s Special poll events', () => {
  it('announces status changes to everyone, vote activity only to that outlet’s staff, and never voters', async () => {
    const outlet = await makeOutlet({ name: 'North Canteen' });
    const other = await makeOutlet({ name: 'South Café' });
    const category = await makeCategory(outlet.id, 'Mains');
    const wrap = await makeItem(outlet.id, category.id, { name: 'Paneer Wrap' });
    const burger = await makeItem(outlet.id, category.id, { name: 'Veg Burger' });

    const manager = await login('manager@example.com');
    const otherManager = await login('other.manager@example.com');
    const student = await login('student@example.com');
    await assign('manager@example.com', outlet.id, 'MANAGER');
    await assign('other.manager@example.com', other.id, 'MANAGER');
    const [managerLive, otherLive, studentLive] = await Promise.all([
      live(manager.cookie),
      live(otherManager.cookie),
      live(student.cookie),
    ]);
    const pollEvents = (l: { events: { name: string; payload: Record<string, unknown> }[] }) =>
      l.events.filter((e) => e.name === 'poll.updated').map((e) => e.payload);

    const { pollId, optionFor } = await openPollWith(manager.agent, outlet.id, [
      wrap.id,
      burger.id,
    ]);
    await until(() => pollEvents(studentLive).some((p) => p.status === 'OPEN'));
    const opened = pollEvents(studentLive).find((p) => p.status === 'OPEN')!;
    expect(Object.keys(opened).sort()).toEqual(['outletId', 'pollId', 'status', 'version']);
    expect(opened).toMatchObject({ pollId, outletId: outlet.id });

    // Drafting is staff-only news.
    expect(pollEvents(otherLive).filter((p) => p.status === 'DRAFT')).toEqual([]);

    const studentBefore = pollEvents(studentLive).length;
    const otherBefore = pollEvents(otherLive).length;
    const managerBefore = pollEvents(managerLive).length;
    await vote(student.agent, pollId, optionFor(wrap.id)).expect(200);
    await until(() => pollEvents(managerLive).length > managerBefore);
    await settle(200);
    expect(pollEvents(studentLive)).toHaveLength(studentBefore);
    expect(pollEvents(otherLive)).toHaveLength(otherBefore);
    const me = await prisma.user.findUniqueOrThrow({ where: { email: 'student@example.com' } });
    expect(JSON.stringify(managerLive.events)).not.toContain(me.id);

    await lifecycle(manager.agent, outlet.id, pollId, 'close').expect(200);
    await until(() => pollEvents(otherLive).some((p) => p.status === 'FINALIZED'));
    await until(() => pollEvents(studentLive).some((p) => p.status === 'FINALIZED'));
  });

  it('throttles vote-count hints to the outlet’s staff', async () => {
    const outlet = await makeOutlet();
    const category = await makeCategory(outlet.id);
    const a = await makeItem(outlet.id, category.id);
    const b = await makeItem(outlet.id, category.id);
    const manager = await login('manager@example.com');
    await assign('manager@example.com', outlet.id, 'MANAGER');
    const { pollId, optionFor } = await openPollWith(manager.agent, outlet.id, [a.id, b.id]);
    const managerLive = await live(manager.cookie);
    await settle(1100); // let the hint from creating the poll leave the throttle window

    const voters = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => login(`voter${n}@example.com`)));
    await Promise.all(voters.map((v) => vote(v.agent, pollId, optionFor(a.id)).expect(200)));
    await settle(300);
    const hints = () => managerLive.events.filter((e) => e.name === 'poll.updated').length;
    expect(hints()).toBeGreaterThanOrEqual(1);
    expect(hints()).toBeLessThanOrEqual(2);
    // The trailing hint arrives after the throttle window, so staff always end up current.
    await settle(1100);
    expect(hints()).toBe(2);
  });
});

describe('stock events', () => {
  it('tells connected students and staff when stock changes, with no quantities', async () => {
    const m = await menu();
    const manager = await login('manager@example.com');
    await assign('manager@example.com', m.outlet.id, 'MANAGER');
    const shopper = await login('student@example.com');
    const [studentLive, managerLive] = await Promise.all([
      live(shopper.cookie),
      live(manager.cookie),
    ]);
    const stockEvents = (l: { events: { name: string; payload: Record<string, unknown> }[] }) =>
      l.events.filter((e) => e.name === 'stock.updated').map((e) => e.payload);

    await post(manager.agent, `/staff/outlets/${m.outlet.id}/inventory/${m.chai.id}/tracking`, {
      enabled: true,
      quantity: 5,
      lowStockThreshold: 2,
    }).expect(200);
    await until(() => stockEvents(studentLive).length === 1);
    expect(stockEvents(studentLive)[0]).toEqual({
      outletId: m.outlet.id,
      menuItemIds: [m.chai.id],
    });

    // An order takes stock: everyone hears about it, again without numbers.
    await addToCart(shopper.agent, m.chai.id, 2);
    await placeOrder(shopper.agent, 'COUNTER', 4_000).expect(201);
    await until(() => stockEvents(managerLive).length >= 2);
    expect(JSON.stringify(studentLive.events)).not.toMatch(/stockQuantity|"quantity"/);
  });
});
