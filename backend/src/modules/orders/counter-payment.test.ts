import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import {
  addToCart,
  fund,
  menu,
  placeOrder,
  post,
  student,
  type Agent,
} from '../../tests/commerce.js';
import { staffApp, staffFor, transition } from '../../tests/staff.js';

// Test #20 in the brief: only authorised POS users can record counter payments.

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

async function counterOrder() {
  await addToCart(s, m.chai.id, 2); // ₹40
  return (await placeOrder(s, 'COUNTER', 4000).expect(201)).body.order as { id: string };
}

const pay = (agent: Agent, orderId: string, amountPaise = 4000, outletId = m.outlet.id) =>
  post(agent, `/staff/outlets/${outletId}/orders/${orderId}/counter-payment`, { amountPaise });

describe('recording a counter payment', () => {
  it('lets assigned POS staff record the exact total once, then complete the order', async () => {
    const order = await counterOrder();
    await transition(cashier, m.outlet.id, order.id, 'ACCEPTED').expect(200);

    const res = await pay(cashier, order.id).expect(200);
    expect(res.body.order).toMatchObject({
      paymentStatus: 'PAID',
      counterPayment: { amountPaise: 4000 },
    });

    const row = await prisma.counterPayment.findUniqueOrThrow({ where: { orderId: order.id } });
    const cashierUser = await prisma.user.findUniqueOrThrow({
      where: { email: 'cashier@example.com' },
    });
    expect(row).toMatchObject({ amountPaise: 4000, recordedById: cashierUser.id });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'COUNTER_PAYMENT_RECORDED' },
    });
    expect(audit).toMatchObject({ actorUserId: cashierUser.id, entityId: order.id });

    for (const to of ['PREPARING', 'READY', 'COMPLETED'])
      await transition(cashier, m.outlet.id, order.id, to).expect(200);

    const detail = await manager
      .get(`/api/v1/staff/outlets/${m.outlet.id}/orders/${order.id}`)
      .expect(200);
    expect(detail.body.order.counterPayment).toMatchObject({
      amountPaise: 4000,
      recordedBy: 'cashier',
    });
    // The student sees it as paid, without the cashier's identity.
    const mine = await s.get(`/api/v1/orders/${order.id}`).expect(200);
    expect(mine.body.order.counterPayment).toEqual({
      amountPaise: 4000,
      recordedAt: expect.any(String),
    });
  });

  it('#20 is refused for managers, students and POS staff of other outlets', async () => {
    const order = await counterOrder();
    await transition(cashier, m.outlet.id, order.id, 'ACCEPTED').expect(200);
    expect((await pay(manager, order.id)).status).toBe(403);
    expect((await pay(s, order.id)).status).toBe(403);
    expect(
      (
        await s
          .post(`/api/v1/orders/${order.id}/counter-payment`)
          .set('X-Requested-With', 'CampusCart')
          .send({ amountPaise: 4000 })
      ).status,
    ).toBe(404);
    expect(await prisma.counterPayment.count()).toBe(0);
  });

  it('can never be recorded twice, even concurrently', async () => {
    const order = await counterOrder();
    await transition(cashier, m.outlet.id, order.id, 'ACCEPTED').expect(200);
    const results = await Promise.all([
      pay(cashier, order.id),
      pay(cashier, order.id),
      pay(cashier, order.id),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await prisma.counterPayment.count()).toBe(1);
    expect((await pay(cashier, order.id)).body.error.code).toBe('ALREADY_PAID');
  });

  it('requires the exact order total', async () => {
    const order = await counterOrder();
    await transition(cashier, m.outlet.id, order.id, 'ACCEPTED').expect(200);
    const res = await pay(cashier, order.id, 3000);
    expect(res.body.error).toMatchObject({
      code: 'AMOUNT_MISMATCH',
      details: { totalPaise: 4000 },
    });
    await pay(cashier, order.id, 40.5).expect(400);
  });

  it('refuses before acceptance, for wallet orders, and for cancelled orders', async () => {
    const placed = await counterOrder();
    expect((await pay(cashier, placed.id)).body.error.code).toBe('ORDER_NOT_ACCEPTED');

    await transition(manager, m.outlet.id, placed.id, 'REJECTED', 'Closing').expect(200);
    expect((await pay(cashier, placed.id)).body.error.code).toBe('ORDER_NOT_PAYABLE');

    await fund(s, 10000);
    await addToCart(s, m.chai.id);
    const wallet = (await placeOrder(s, 'WALLET', 2000).expect(201)).body.order;
    await transition(cashier, m.outlet.id, wallet.id, 'ACCEPTED').expect(200);
    expect((await pay(cashier, wallet.id, 2000)).body.error.code).toBe('NOT_COUNTER_ORDER');
  });

  it('blocks cancelling an order once it has been paid at the counter', async () => {
    const order = await counterOrder();
    await transition(cashier, m.outlet.id, order.id, 'ACCEPTED').expect(200);
    await pay(cashier, order.id).expect(200);
    expect(
      (await transition(manager, m.outlet.id, order.id, 'CANCELLED', 'Changed mind')).body.error
        .code,
    ).toBe('COUNTER_PAID');
  });

  it('tells POS staff when they can record payment', async () => {
    const order = await counterOrder();
    const url = `/api/v1/staff/outlets/${m.outlet.id}/orders/${order.id}`;
    expect((await cashier.get(url)).body.order.canRecordPayment).toBe(false); // not accepted yet
    await transition(cashier, m.outlet.id, order.id, 'ACCEPTED').expect(200);
    expect((await cashier.get(url)).body.order.canRecordPayment).toBe(true);
    expect((await manager.get(url)).body.order.canRecordPayment).toBe(false); // managers don't take cash
  });
});
