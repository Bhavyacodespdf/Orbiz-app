import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { addToCart, fund, menu, placeOrder, student, type Agent } from '../../tests/commerce.js';
import { staffApp, staffFor, transition } from '../../tests/staff.js';
import { noopPublisher } from '../../realtime/publisher.js';
import { transitionOrder } from '../orders/transitions.js';
import { AppError } from '../../lib/errors.js';
import { autoAcceptSweep, decideAutoAccept } from './autoaccept.service.js';

let m: Awaited<ReturnType<typeof menu>>;
let manager: Agent;
let cashier: Agent;
let n = 0;

const settings = (mode: 'MANUAL' | 'AUTO', extra: object = {}) =>
  manager
    .put(`/api/v1/staff/outlets/${m.outlet.id}/kitchen/settings`)
    .set('X-Requested-With', 'CampusCart')
    .send({
      kitchenParallelOrders: 1,
      autoAcceptMode: mode,
      autoAcceptMaxWaitMinutes: 30,
      ...extra,
    });

beforeEach(async () => {
  await resetDatabase();
  n += 1;
  m = await menu();
  ({ manager, cashier } = await staffFor(m.outlet.id));
  await manager
    .patch(`/api/v1/staff/outlets/${m.outlet.id}/kitchen/items/${m.chai.id}`)
    .set('X-Requested-With', 'CampusCart')
    .send({ prepMinutes: 5 })
    .expect(200);
});

async function place(method: 'WALLET' | 'COUNTER' = 'WALLET') {
  const s = await student(`aa${n}-${Math.random()}@example.com`, staffApp);
  if (method === 'WALLET') await fund(s, 10_000);
  await addToCart(s, m.chai.id);
  return (await placeOrder(s, method, 2000).expect(201)).body.order as {
    id: string;
    status: string;
  };
}
const statusOf = async (id: string) =>
  (await prisma.order.findUniqueOrThrow({ where: { id } })).status;
const decision = (orderId: string) => prisma.autoAcceptDecision.findUnique({ where: { orderId } });

describe('manual mode (the default)', () => {
  it('leaves every order for staff, exactly as before', async () => {
    const o = await place();
    expect(await statusOf(o.id)).toBe('PLACED');
    expect(await decision(o.id)).toBeNull();
    expect(await autoAcceptSweep(prisma, noopPublisher)).toBe(0);
    expect(
      (await prisma.outlet.findUniqueOrThrow({ where: { id: m.outlet.id } })).autoAcceptMode,
    ).toBe('MANUAL');
  });
});

describe('auto mode', () => {
  it('accepts an eligible prepaid order right after checkout, recorded as automatic', async () => {
    await settings('AUTO').expect(200);
    const capacityBefore = await prisma.outletOrderAcceptance.count();
    const o = await place();
    expect(await statusOf(o.id)).toBe('ACCEPTED');
    expect(await decision(o.id)).toMatchObject({
      outcome: 'ACCEPTED',
      reasons: [],
      ruleVersion: 'auto-accept-v1',
    });
    const history = await prisma.orderStatusHistory.findFirstOrThrow({
      where: { orderId: o.id, toStatus: 'ACCEPTED' },
    });
    expect(history).toMatchObject({
      actorUserId: null,
      actorRole: null,
      reason: 'Accepted automatically (auto-accept-v1)',
    });
    expect(
      await prisma.auditLog.count({ where: { action: 'ORDER_AUTO_ACCEPTED', entityId: o.id } }),
    ).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'ORDER_ACCEPTED' } })).toBe(1);
    expect(
      await prisma.orderPrediction.count({ where: { orderId: o.id, kind: 'AT_ACCEPT' } }),
    ).toBe(1);
    // The rolling capacity was claimed once, at checkout — not again by accepting.
    expect(await prisma.outletOrderAcceptance.count()).toBe(capacityBefore + 1);
  });

  it('sends counter-paid orders to staff with the reason', async () => {
    await settings('AUTO').expect(200);
    const o = await place('COUNTER');
    expect(await statusOf(o.id)).toBe('PLACED');
    expect(await decision(o.id)).toMatchObject({
      outcome: 'MANUAL_REVIEW',
      reasons: ['PAYMENT_AT_COUNTER'],
    });
    const note = await prisma.notification.findFirstOrThrow({
      where: { type: 'STAFF_MANUAL_REVIEW' },
    });
    expect(note.body).toContain('paid at the counter');
  });

  it('sends orders to staff when the estimated wait is over the limit', async () => {
    await settings('AUTO', { autoAcceptMaxWaitMinutes: 5 }).expect(200);
    await place(); // 5 min, accepted
    const second = await place(); // would wait ~10 min
    expect(await statusOf(second.id)).toBe('PLACED');
    expect((await decision(second.id))!.reasons).toEqual(['QUEUE_TOO_LONG']);
  });

  it('re-checks the outlet and dishes at decision time (sweep after a crash)', async () => {
    const o = await place(); // placed while MANUAL: undecided
    await settings('AUTO').expect(200);
    await prisma.outlet.update({ where: { id: m.outlet.id }, data: { status: 'PAUSED' } });
    await prisma.menuItem.update({ where: { id: m.chai.id }, data: { isAvailable: false } });
    expect(await autoAcceptSweep(prisma, noopPublisher)).toBe(1);
    expect(await decision(o.id)).toMatchObject({
      outcome: 'MANUAL_REVIEW',
      reasons: ['OUTLET_NOT_OPEN', 'ITEM_NOT_AVAILABLE'],
    });
    expect(await statusOf(o.id)).toBe('PLACED');
  });

  it('decides each order once under concurrency, and yields to staff who acted first', async () => {
    const a = await place();
    const b = await place();
    await settings('AUTO').expect(200);
    const results = await Promise.all(
      [1, 2, 3].map(() => decideAutoAccept(prisma, noopPublisher, a.id)),
    );
    expect(results.filter((r) => r === 'ACCEPTED')).toHaveLength(1);
    expect(
      await prisma.orderStatusHistory.count({ where: { orderId: a.id, toStatus: 'ACCEPTED' } }),
    ).toBe(1);
    // Staff accept b first: the rules then do nothing to it.
    await transition(cashier, m.outlet.id, b.id, 'ACCEPTED').expect(200);
    expect(await decideAutoAccept(prisma, noopPublisher, b.id)).toBeNull();
    expect(
      await prisma.orderStatusHistory.count({ where: { orderId: b.id, toStatus: 'ACCEPTED' } }),
    ).toBe(1);
  });

  it('the kill switch stops it immediately', async () => {
    await settings('AUTO').expect(200);
    await settings('MANUAL').expect(200);
    const o = await place();
    expect(await statusOf(o.id)).toBe('PLACED');
    expect(await decision(o.id)).toBeNull();
  });

  it('alerts managers when orders keep falling back to staff', async () => {
    await settings('AUTO').expect(200);
    for (let i = 0; i < 3; i++) await place('COUNTER');
    expect(
      await prisma.notification.count({ where: { type: 'MANAGER_AUTO_ACCEPT_FAILURES' } }),
    ).toBe(1);
  });
});

describe('transaction safety', () => {
  it('rolls everything back when the in-transaction guard fails', async () => {
    const o = await place();
    const stockBefore = await prisma.stockAdjustment.count();
    await expect(
      transitionOrder(prisma, {
        orderId: o.id,
        to: 'ACCEPTED',
        actorRoles: [],
        actorUserId: o.id,
        scope: { outletId: m.outlet.id },
        system: {
          reason: 'test',
          ruleVersion: 'test',
          guard: async () => {
            throw new AppError(409, 'AUTO_ACCEPT_INELIGIBLE', 'no');
          },
        },
      }),
    ).rejects.toThrow('no');
    expect(await statusOf(o.id)).toBe('PLACED');
    expect(
      await prisma.orderStatusHistory.count({ where: { orderId: o.id, toStatus: 'ACCEPTED' } }),
    ).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'ORDER_AUTO_ACCEPTED' } })).toBe(0);
    expect(await prisma.notification.count({ where: { type: 'ORDER_ACCEPTED' } })).toBe(0);
    expect(await prisma.stockAdjustment.count()).toBe(stockBefore);
  });

  it('never lets the system actor do anything but accept a placed order', async () => {
    const o = await place();
    await expect(
      transitionOrder(prisma, {
        orderId: o.id,
        to: 'REJECTED',
        reason: 'nope',
        actorRoles: [],
        actorUserId: o.id,
        scope: { outletId: m.outlet.id },
        system: { reason: 'x', ruleVersion: 'x', guard: async () => undefined },
      }),
    ).rejects.toThrow();
    expect(await statusOf(o.id)).toBe('PLACED');
  });
});
