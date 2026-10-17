import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { makeOutlet } from '../../tests/fixtures.js';
import { addToCart, fund, menu, placeOrder, student, type Agent } from '../../tests/commerce.js';
import { cancel, signIn, staffApp, staffFor, transition } from '../../tests/staff.js';
import { allowedNextStatuses } from './transitions.js';

let m: Awaited<ReturnType<typeof menu>>;
let s: Agent;
let manager: Agent;
let cashier: Agent;

beforeEach(async () => {
  await resetDatabase();
  m = await menu();
  s = await student('student@example.com', staffApp);
  ({ manager, cashier } = await staffFor(m.outlet.id));
});

async function walletOrder() {
  await fund(s, 10000);
  await addToCart(s, m.chai.id); // ₹20
  return (await placeOrder(s, 'WALLET', 2000).expect(201)).body.order as { id: string };
}
async function counterOrder() {
  await addToCart(s, m.chai.id);
  return (await placeOrder(s, 'COUNTER', 2000).expect(201)).body.order as { id: string };
}
const balance = async () =>
  (await s.get('/api/v1/wallet').expect(200)).body.wallet.balancePaise as number;

describe('status transitions', () => {
  it('walks the happy path and records every step in the history', async () => {
    const order = await walletOrder();
    for (const to of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) {
      await transition(cashier, m.outlet.id, order.id, to).expect(200);
    }
    const { body } = await s.get(`/api/v1/orders/${order.id}`).expect(200);
    expect(body.order.status).toBe('COMPLETED');
    expect(body.order.version).toBe(5);
    expect(body.order.statusHistory.map((h: { toStatus: string }) => h.toStatus)).toEqual([
      'PLACED',
      'ACCEPTED',
      'PREPARING',
      'READY',
      'COMPLETED',
    ]);
    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId: order.id, actorRole: 'POS' },
    });
    expect(history).toHaveLength(4);
  });

  it.each([
    ['PLACED', 'PREPARING'],
    ['PLACED', 'READY'],
    ['PLACED', 'COMPLETED'],
  ])('rejects the invalid jump %s → %s', async (_from, to) => {
    const order = await walletOrder();
    const res = await transition(manager, m.outlet.id, order.id, to);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { from: 'PLACED', to },
    });
  });

  it('cannot move a finished order', async () => {
    const order = await walletOrder();
    await transition(manager, m.outlet.id, order.id, 'REJECTED', 'Out of milk').expect(200);
    expect((await transition(manager, m.outlet.id, order.id, 'ACCEPTED')).body.error.code).toBe(
      'INVALID_TRANSITION',
    );
  });

  it('lets only managers reject or cancel, and requires a reason', async () => {
    const order = await walletOrder();
    expect((await transition(cashier, m.outlet.id, order.id, 'REJECTED', 'Busy')).status).toBe(403);
    expect((await transition(manager, m.outlet.id, order.id, 'REJECTED')).body.error.code).toBe(
      'REASON_REQUIRED',
    );
    expect(
      (await transition(manager, m.outlet.id, order.id, 'REJECTED', ' ')).body.error.code,
    ).toBe('REASON_REQUIRED');
    await transition(manager, m.outlet.id, order.id, 'REJECTED', 'Out of milk').expect(200);
  });

  it('keeps staff to their own outlet and students out of the staff API', async () => {
    const order = await walletOrder();
    const other = await makeOutlet();
    // Assigned elsewhere only → forbidden here.
    await transition(manager, other.id, order.id, 'ACCEPTED').expect(403);
    const outsider = await signIn('other.manager@example.com');
    await transition(outsider, m.outlet.id, order.id, 'ACCEPTED').expect(403);
    await transition(s, m.outlet.id, order.id, 'ACCEPTED').expect(403);
    // Staff of another outlet asking through their own outlet's URL: not found.
    const { assign } = await import('../../tests/fixtures.js');
    await assign('other.manager@example.com', other.id, 'MANAGER');
    await transition(outsider, other.id, order.id, 'ACCEPTED').expect(404);
  });

  it('allows only one of two simultaneous conflicting changes', async () => {
    const order = await walletOrder();
    const [a, b] = await Promise.all([
      transition(cashier, m.outlet.id, order.id, 'ACCEPTED'),
      transition(manager, m.outlet.id, order.id, 'REJECTED', 'Closing early'),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(['ORDER_CHANGED', 'INVALID_TRANSITION']).toContain(loser.body.error.code);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: order.id } })).toBe(2);
  });

  it('will not complete a counter order until payment is recorded', async () => {
    const order = await counterOrder();
    for (const to of ['ACCEPTED', 'PREPARING', 'READY'])
      await transition(cashier, m.outlet.id, order.id, to).expect(200);
    const res = await transition(cashier, m.outlet.id, order.id, 'COMPLETED');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_REQUIRED');
  });

  it('reports the next steps each role may take', () => {
    expect(allowedNextStatuses('PLACED', ['POS'])).toEqual(['ACCEPTED']);
    expect(allowedNextStatuses('PLACED', ['MANAGER'])).toEqual(['ACCEPTED', 'REJECTED']);
    expect(allowedNextStatuses('PREPARING', ['MANAGER', 'POS'])).toEqual(['READY', 'CANCELLED']);
    expect(allowedNextStatuses('COMPLETED', ['MANAGER'])).toEqual([]);
  });
});

describe('student cancellation', () => {
  it('lets the student cancel their own PLACED order', async () => {
    const order = await counterOrder();
    const res = await cancel(s, order.id).expect(200);
    expect(res.body.order).toMatchObject({ status: 'CANCELLED', paymentStatus: 'VOID' });
  });

  it('refuses once the outlet has accepted, and for other students', async () => {
    const order = await counterOrder();
    const other = await student('other@example.com', staffApp);
    await cancel(other, order.id).expect(404);
    await transition(cashier, m.outlet.id, order.id, 'ACCEPTED').expect(200);
    const res = await cancel(s, order.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TOO_LATE_TO_CANCEL');
  });
});

describe('refunds (#15, #16)', () => {
  it('#15 refunds a rejected wallet order with a separate ledger entry, keeping the original debit', async () => {
    const order = await walletOrder();
    expect(await balance()).toBe(8000);
    const res = await transition(manager, m.outlet.id, order.id, 'REJECTED', 'Out of milk').expect(
      200,
    );
    expect(res.body.order).toMatchObject({
      status: 'REJECTED',
      paymentStatus: 'REFUNDED',
      cancelReason: 'Out of milk',
    });
    expect(await balance()).toBe(10000);

    const rows = await prisma.walletTransaction.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => [r.type, r.direction, r.amountPaise, r.status])).toEqual([
      ['ORDER_DEBIT', 'DEBIT', 2000, 'COMPLETED'],
      ['REFUND', 'CREDIT', 2000, 'COMPLETED'],
    ]);
    expect(rows[1]!.reversesTransactionId).toBe(rows[0]!.id);
    expect(rows[1]!.balanceAfterPaise).toBe(10000);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'ORDER_REJECTED' } });
    expect(audit.metadata).toMatchObject({ reason: 'Out of milk', refundedPaise: 2000 });
  });

  it('refunds when a manager cancels after accepting, and when the student cancels', async () => {
    const a = await walletOrder();
    await transition(cashier, m.outlet.id, a.id, 'ACCEPTED').expect(200);
    await transition(manager, m.outlet.id, a.id, 'CANCELLED', 'Gas ran out').expect(200);
    const b = await walletOrder();
    await cancel(s, b.id).expect(200);
    expect(await prisma.walletTransaction.count({ where: { type: 'REFUND' } })).toBe(2);
    expect(await balance()).toBe(20000);
  });

  it('#16 can never refund the same order twice, even under concurrent attempts', async () => {
    const order = await walletOrder();
    const attempts = await Promise.all([
      transition(manager, m.outlet.id, order.id, 'REJECTED', 'Duplicate 1'),
      transition(manager, m.outlet.id, order.id, 'REJECTED', 'Duplicate 2'),
      cancel(s, order.id),
    ]);
    expect(attempts.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await prisma.walletTransaction.count({ where: { type: 'REFUND' } })).toBe(1);
    expect(await balance()).toBe(10000);
  });

  it('does not refund after READY (no transition exists) and voids unpaid counter orders without touching the wallet', async () => {
    const order = await walletOrder();
    for (const to of ['ACCEPTED', 'PREPARING', 'READY'])
      await transition(manager, m.outlet.id, order.id, to).expect(200);
    expect(
      (await transition(manager, m.outlet.id, order.id, 'CANCELLED', 'Too late')).body.error.code,
    ).toBe('INVALID_TRANSITION');

    const counter = await counterOrder();
    await transition(manager, m.outlet.id, counter.id, 'REJECTED', 'Closing').expect(200);
    expect((await s.get(`/api/v1/orders/${counter.id}`)).body.order.paymentStatus).toBe('VOID');
    expect(await prisma.walletTransaction.count({ where: { type: 'REFUND' } })).toBe(0);
  });

  it('refunds even when it takes the balance above the recharge cap', async () => {
    const order = await walletOrder(); // balance ₹80
    await prisma.wallet.updateMany({ data: { balancePaise: 499000 } }); // test setup only: near the ₹5,000 cap
    await transition(manager, m.outlet.id, order.id, 'REJECTED', 'Closing').expect(200);
    expect(await balance()).toBe(501000);
  });
});

describe('order history', () => {
  it('lists the student’s own active and past orders, newest first, with pagination', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) ids.push((await counterOrder()).id);
    await cancel(s, ids[0]!).expect(200);

    const active = await s.get('/api/v1/orders?view=active&limit=1').expect(200);
    expect(active.body.orders).toHaveLength(1);
    expect(active.body.orders[0]).toMatchObject({
      id: ids[2],
      status: 'PLACED',
      itemCount: 1,
      totalPaise: 2000,
    });
    const next = await s
      .get(`/api/v1/orders?view=active&limit=1&cursor=${active.body.nextCursor}`)
      .expect(200);
    expect(next.body.orders[0].id).toBe(ids[1]);
    expect(next.body.nextCursor).toBeNull();

    const past = await s.get('/api/v1/orders?view=past').expect(200);
    expect(past.body.orders.map((o: { id: string }) => o.id)).toEqual([ids[0]]);

    const other = await student('other@example.com', staffApp);
    expect((await other.get('/api/v1/orders').expect(200)).body.orders).toEqual([]);
  });

  it('gives staff a first-come-first-served queue with only the customer’s display name', async () => {
    await counterOrder();
    const res = await cashier.get(`/api/v1/staff/outlets/${m.outlet.id}/orders`).expect(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].customer).toEqual({ displayName: 'student' });
    expect(JSON.stringify(res.body)).not.toContain('student@example.com');

    const detail = await manager
      .get(`/api/v1/staff/outlets/${m.outlet.id}/orders/${res.body.orders[0].id}`)
      .expect(200);
    expect(detail.body.order.allowedNextStatuses).toEqual(['ACCEPTED', 'REJECTED']);
  });
});

describe('who acted', () => {
  it('records the least-privileged role that allowed the step for someone holding both', async () => {
    const { assign } = await import('../../tests/fixtures.js');
    const { grantRole } = await import('../users/roles.service.js');
    const { staffConfig } = await import('../../tests/staff.js');
    // cashier@ holds POS; give the manager@ account POS as well so it holds both.
    await grantRole(prisma, {
      email: 'manager@example.com',
      role: 'POS',
      actor: { type: 'CLI' },
      lists: { ...staffConfig, POS_ALLOWED_EMAILS: ['manager@example.com'] },
    });
    await assign('manager@example.com', m.outlet.id, 'POS');
    const both = await signIn('manager@example.com');
    const order = await walletOrder();
    await transition(both, m.outlet.id, order.id, 'ACCEPTED').expect(200);
    await transition(both, m.outlet.id, order.id, 'CANCELLED', 'Out of stock').expect(200);
    const roles = await prisma.orderStatusHistory.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
      select: { toStatus: true, actorRole: true },
    });
    expect(roles).toEqual([
      { toStatus: 'PLACED', actorRole: 'STUDENT' },
      { toStatus: 'ACCEPTED', actorRole: 'POS' },
      { toStatus: 'CANCELLED', actorRole: 'MANAGER' },
    ]);
  });
});
