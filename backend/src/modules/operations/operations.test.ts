import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
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
import { staffApp, staffFor, transition } from '../../tests/staff.js';
import { noopPublisher } from '../../realtime/publisher.js';
import {
  runOperations,
  sendAlmostReady,
  sendDelayAlerts,
  sendScheduledReminders,
} from './operations.service.js';

let m: Awaited<ReturnType<typeof menu>>;
let manager: Agent;
let cashier: Agent;
let s: Agent;
let n = 0;

const MIN = 60_000;
const send = (agent: Agent, method: 'put' | 'patch', url: string, body: object) =>
  agent[method](`/api/v1${url}`).set('X-Requested-With', 'CampusCart').send(body);

beforeEach(async () => {
  await resetDatabase();
  n += 1;
  m = await menu();
  ({ manager, cashier } = await staffFor(m.outlet.id));
  s = await student(`ops${n}@example.com`, staffApp);
  await send(manager, 'put', `/staff/outlets/${m.outlet.id}/schedule`, {
    leadMinutes: 30,
    slotMinutes: 15,
    daysAhead: 2,
    slotCapacity: null,
    hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      opensMinute: 0,
      closesMinute: 1440,
    })),
  }).expect(200);
});

async function preparing(agent = s) {
  await fund(agent, 10_000);
  await addToCart(agent, m.chai.id);
  const o = (await placeOrder(agent, 'WALLET', 2000).expect(201)).body.order as { id: string };
  for (const to of ['ACCEPTED', 'PREPARING'])
    await transition(cashier, m.outlet.id, o.id, to).expect(200);
  return o;
}
const setEstimate = (orderId: string, readyInMinutes: number) =>
  prisma.orderEstimate.update({
    where: { orderId },
    data: { predictedReadyAt: new Date(Date.now() + readyInMinutes * MIN) },
  });
const count = (type: string) => prisma.notification.count({ where: { type: type as never } });

describe('almost-ready alerts', () => {
  it('fires once when a preparing order is about 2 minutes away, even with repeated or parallel runs', async () => {
    const o = await preparing();
    await setEstimate(o.id, 10);
    expect(await sendAlmostReady(prisma, new Date())).toBe(0); // not yet
    await setEstimate(o.id, 1.5);
    await Promise.all([1, 2, 3].map(() => sendAlmostReady(prisma, new Date())));
    await sendAlmostReady(prisma, new Date()); // a "restarted worker"
    expect(await count('ORDER_ALMOST_READY')).toBe(1);
    const note = await prisma.notification.findFirstOrThrow({
      where: { type: 'ORDER_ALMOST_READY' },
    });
    expect(note.body).toMatch(/may be ready in about 2 minutes \(an estimate\)/);
  });

  it('is skipped once the order is actually ready; READY comes from the real transition', async () => {
    const o = await preparing();
    await transition(cashier, m.outlet.id, o.id, 'READY').expect(200);
    expect(await count('ORDER_READY')).toBe(1);
    // A stale estimate row (e.g. left by a crash) must not produce an alert for a ready order.
    await prisma.orderEstimate.create({
      data: {
        orderId: o.id,
        outletId: m.outlet.id,
        ordersAhead: 0,
        prepMinutes: 5,
        predictedReadyAt: new Date(),
        version: 'test',
      },
    });
    expect(await sendAlmostReady(prisma, new Date())).toBe(0);
    expect(await count('ORDER_ALMOST_READY')).toBe(0);
  });

  it('is skipped for a cancelled order', async () => {
    const o = await preparing();
    await setEstimate(o.id, 1);
    await transition(manager, m.outlet.id, o.id, 'CANCELLED', 'Kitchen fire drill').expect(200);
    expect(await sendAlmostReady(prisma, new Date())).toBe(0);
  });
});

describe('scheduled reminders', () => {
  async function scheduledOrder() {
    await fund(s, 10_000);
    await post(s, '/cart/items', { menuItemId: m.chai.id, quantity: 1 }).expect(200);
    const { body } = await s.get(`/api/v1/outlets/${m.outlet.slug}/slots`).expect(200);
    const slot = body.days.flatMap((d: { slots: { startsAt: string }[] }) => d.slots)[0].startsAt;
    const res = await post(
      s,
      '/orders',
      { paymentMethod: 'WALLET', expectedTotalPaise: 3000, scheduledFor: slot },
      key(),
    ).expect(201);
    return res.body.order as { id: string };
  }
  const slotIn = (orderId: string, minutes: number) =>
    prisma.order.update({
      where: { id: orderId },
      data: { scheduledFor: new Date(Date.now() + minutes * MIN) },
    });

  it('reminds once before the scheduled slot, never after it, and never changes the order', async () => {
    const o = await scheduledOrder();
    await slotIn(o.id, 30);
    expect(await sendScheduledReminders(prisma, new Date())).toBe(0);
    await slotIn(o.id, 8);
    await sendScheduledReminders(prisma, new Date());
    await sendScheduledReminders(prisma, new Date());
    expect(await count('SCHEDULED_PICKUP_SOON')).toBe(1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(order.status).toBe('PLACED');
    expect(order.paymentStatus).toBe('PAID');
  });

  it('warns a ready scheduled order before the no-show deadline, without processing a no-show', async () => {
    const o = await scheduledOrder();
    await slotIn(o.id, 5); // close enough for the kitchen to start
    for (const to of ['ACCEPTED', 'PREPARING', 'READY'])
      await transition(cashier, m.outlet.id, o.id, to).expect(200);
    await slotIn(o.id, -7); // deadline = slot + 10 min → 3 min left
    await runOperations(prisma, noopPublisher);
    await runOperations(prisma, noopPublisher);
    expect(await count('PICKUP_DEADLINE_SOON')).toBe(1);
    // The reminder changed nothing: no-shows stay with the no-show worker.
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: o.id },
      include: { noShow: true },
    });
    expect(order.status).toBe('READY');
    expect(order.noShow).toBeNull();
  });

  it('sends nothing for orders that are already collected', async () => {
    const o = await scheduledOrder();
    await slotIn(o.id, 5);
    for (const to of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) {
      await transition(cashier, m.outlet.id, o.id, to).expect(200);
    }
    await slotIn(o.id, 4);
    expect(await sendScheduledReminders(prisma, new Date())).toBe(0);
  });
});

describe('delay alerts', () => {
  it('tells staff once about an order well past its estimate, and managers about a backlog', async () => {
    const orders = [];
    for (let i = 0; i < 3; i++)
      orders.push(await preparing(await student(`d${n}-${i}@example.com`, staffApp)));
    for (const o of orders) await setEstimate(o.id, -10);
    await sendDelayAlerts(prisma, new Date());
    await sendDelayAlerts(prisma, new Date());
    expect(await count('STAFF_ORDER_DELAYED')).toBe(6); // 3 orders × (manager + cashier)
    expect(await count('MANAGER_QUEUE_DELAYS')).toBe(1);
  });
});

describe('the sweep', () => {
  it('keeps going when one step fails and recalculates outlets with kitchen work', async () => {
    const o = await preparing();
    await prisma.orderEstimate.delete({ where: { orderId: o.id } });
    const results = await runOperations(prisma, noopPublisher);
    expect(results['queue recalculation']).toBe(1);
    expect(await prisma.orderEstimate.count({ where: { orderId: o.id } })).toBe(1);
  });
});
