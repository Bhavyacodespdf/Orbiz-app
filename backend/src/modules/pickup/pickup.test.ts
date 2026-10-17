import { createHash } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { addToCart, fund, menu, placeOrder, student, type Agent } from '../../tests/commerce.js';
import { assign, makeOutlet } from '../../tests/fixtures.js';
import { signIn, staffApp, staffFor, transition, transitionDirect } from '../../tests/staff.js';
import {
  hashCode,
  isWeakCode,
  newNumericCode,
  seal,
  tokenFromQr,
  unseal,
} from './pickup.crypto.js';
import { issueCredential, STAFF_FAILURE_LIMIT } from './pickup.service.js';

let m: Awaited<ReturnType<typeof menu>>;
let manager: Agent;
let cashier: Agent;
let asha: Agent;
let n = 0;

const api = (agent: Agent, method: 'get' | 'post', url: string, body?: object) => {
  const req = agent[method](`/api/v1${url}`).set('X-Requested-With', 'CampusCart');
  return body ? req.send(body) : req;
};
const staffUrl = (outletId = m.outlet.id) => `/staff/outlets/${outletId}/pickup`;
const verify = (agent: Agent, body: object, outletId = m.outlet.id) =>
  api(agent, 'post', `${staffUrl(outletId)}/verify`, body);
const confirm = (agent: Agent, challengeToken: string, outletId = m.outlet.id) =>
  api(agent, 'post', `${staffUrl(outletId)}/confirm`, { challengeToken });

beforeEach(async () => {
  await resetDatabase();
  n += 1;
  m = await menu(); // Night Owl Café: Chai ₹20, Puff ₹35
  ({ manager, cashier } = await staffFor(m.outlet.id));
  asha = await student(`asha${n}@example.com`, staffApp);
});

async function walletOrder(agent = asha, until: 'PLACED' | 'PREPARING' | 'READY' = 'READY') {
  await fund(agent, 10_000);
  await addToCart(agent, m.chai.id, 2);
  const order = (await placeOrder(agent, 'WALLET', 4000).expect(201)).body.order as {
    id: string;
    pickupCode: string;
  };
  const steps = {
    PLACED: [],
    PREPARING: ['ACCEPTED', 'PREPARING'],
    READY: ['ACCEPTED', 'PREPARING', 'READY'],
  }[until];
  for (const to of steps) await transition(cashier, m.outlet.id, order.id, to).expect(200);
  return order;
}
const pickupOf = async (agent: Agent, orderId: string) =>
  (await api(agent, 'get', `/orders/${orderId}/pickup`).expect(200)).body.pickup;

describe('credentials', () => {
  it('generates random, non-weak codes of the configured length and 256-bit tokens', () => {
    const codes = new Set(Array.from({ length: 2000 }, () => newNumericCode(6)));
    expect([...codes].every((c) => /^\d{6}$/.test(c) && !isWeakCode(c))).toBe(true);
    expect(codes.size).toBeGreaterThan(1990); // ~1 collision expected at most
    expect(newNumericCode(8)).toMatch(/^\d{8}$/);
    for (const weak of ['000000', '111111', '123456', '987654', '890123']) {
      expect(isWeakCode(weak)).toBe(true);
    }
    expect(isWeakCode('480213')).toBe(false);
    expect(tokenFromQr('not a token')).toBeNull();
  });

  it('seals codes so only this order can open them, and hashes with a server key', () => {
    const sealed = seal({ code: '480213', token: 'x'.repeat(43) }, 'order-a');
    expect(sealed).not.toContain('480213');
    expect(unseal(sealed, 'order-a')).toEqual({ code: '480213', token: 'x'.repeat(43) });
    expect(() => unseal(sealed, 'order-b')).toThrow();
    // A keyed hash, not a plain one: the code alone doesn't reproduce it.
    expect(hashCode('480213')).not.toBe(createHash('sha256').update('code:480213').digest('hex'));
  });

  it('issues one credential when the order becomes READY, storing no plain code or token', async () => {
    const order = await walletOrder(asha, 'PREPARING');
    expect(await prisma.pickupCredential.count()).toBe(0);
    expect((await pickupOf(asha, order.id)).state).toBe('NOT_READY');

    await transition(cashier, m.outlet.id, order.id, 'READY').expect(200);
    const pickup = await pickupOf(asha, order.id);
    expect(pickup).toMatchObject({ state: 'ACTIVE', paymentDuePaise: 0 });
    expect(pickup.code).toMatch(/^\d{6}$/);
    expect(pickup.qrPayload).toMatch(/^CCPICKUP1\.[A-Za-z0-9_-]{43}$/);
    // The code is not the order number, ID or anything predictable.
    expect(pickup.code).not.toContain(order.pickupCode.replace(/\D/g, ''));

    const rows = await prisma.pickupCredential.findMany();
    expect(rows).toHaveLength(1);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(pickup.code);
    expect(stored).not.toContain(pickup.qrPayload.slice(10));
    const audit = await prisma.auditLog.findMany({ where: { action: 'PICKUP_CREDENTIAL_ISSUED' } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(pickup.code);
    // The student's view is never cached.
    const res = await api(asha, 'get', `/orders/${order.id}/pickup`).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('never gives two active orders at one outlet the same code (collision-safe issuance)', async () => {
    // Force collisions: many issuances at one outlet with a tiny patience for clashes.
    const orders = [];
    for (let i = 0; i < 4; i++)
      orders.push(await walletOrder(await student(`c${n}-${i}@example.com`, staffApp)));
    const codes = await Promise.all(
      orders.map(
        async (o) =>
          unseal(
            (await prisma.pickupCredential.findFirstOrThrow({ where: { orderId: o.id } })).sealed,
            o.id,
          ).code,
      ),
    );
    expect(new Set(codes).size).toBe(codes.length);
    // Re-issuing concurrently for every order still leaves exactly one active credential each.
    await Promise.all(
      orders.map((o) =>
        prisma.$transaction((tx) =>
          issueCredential(tx, {
            orderId: o.id,
            outletId: m.outlet.id,
            actor: { type: 'SYSTEM' },
            reason: 'REFRESH',
          }),
        ),
      ),
    );
    for (const o of orders) {
      expect(
        await prisma.pickupCredential.count({ where: { orderId: o.id, status: 'ACTIVE' } }),
      ).toBe(1);
    }
    const active = await prisma.pickupCredential.findMany({ where: { status: 'ACTIVE' } });
    expect(new Set(active.map((a) => a.codeHash)).size).toBe(active.length);
  });

  it('only the owner can see the code; staff and other students cannot', async () => {
    const order = await walletOrder();
    const ben = await student(`ben${n}@example.com`, staffApp);
    await api(ben, 'get', `/orders/${order.id}/pickup`).expect(404);
    await request(staffApp).get(`/api/v1/orders/${order.id}/pickup`).expect(401);
    const staffView = await api(
      cashier,
      'get',
      `/staff/outlets/${m.outlet.id}/orders/${order.id}`,
    ).expect(200);
    expect(JSON.stringify(staffView.body)).not.toContain((await pickupOf(asha, order.id)).code);
  });
});

describe('verify then confirm', () => {
  it('verifies a numeric code without releasing anything, then hands over on explicit confirmation', async () => {
    const order = await walletOrder();
    const { code } = await pickupOf(asha, order.id);
    const verified = await verify(cashier, { method: 'CODE', code }).expect(200);
    expect(verified.body).toMatchObject({
      canConfirm: true,
      order: {
        id: order.id,
        pickupCode: order.pickupCode,
        status: 'READY',
        items: [{ name: 'Chai', quantity: 2 }],
        customer: { displayName: expect.any(String) },
      },
    });
    // Minimal details only: no wallet, email or payment secrets.
    expect(JSON.stringify(verified.body)).not.toMatch(/@example\.com|balance/i);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      'READY',
    );

    const done = await confirm(cashier, verified.body.challengeToken).expect(200);
    expect(done.body).toMatchObject({
      alreadyConfirmed: false,
      order: { status: 'COMPLETED' },
      handover: { method: 'CODE', handedOverBy: expect.any(String) },
    });
    const handover = await prisma.orderHandover.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(handover).toMatchObject({ outletId: m.outlet.id, method: 'CODE' });
    expect(
      await prisma.pickupCredential.findFirstOrThrow({ where: { orderId: order.id } }),
    ).toMatchObject({
      status: 'REDEEMED',
      redeemedById: handover.staffUserId,
    });
    const history = await prisma.orderStatusHistory.findFirstOrThrow({
      where: { orderId: order.id, toStatus: 'COMPLETED' },
    });
    expect(history).toMatchObject({ fromStatus: 'READY', actorRole: 'POS' });
    const actions = (
      await prisma.auditLog.findMany({
        where: { entityId: order.id },
        orderBy: { createdAt: 'asc' },
      })
    ).map((a) => a.action);
    expect(actions).toEqual([
      'PICKUP_CREDENTIAL_ISSUED',
      'PICKUP_VERIFIED',
      'PICKUP_HANDOVER_CONFIRMED',
    ]);
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(code);

    // The student now sees "collected"; the code is gone for good.
    const after = await pickupOf(asha, order.id);
    expect(after).toEqual({ state: 'COLLECTED', collectedAt: handover.handedOverAt.toISOString() });
    await api(asha, 'post', `/orders/${order.id}/pickup/refresh`).expect(409);
  });

  it('verifies a scanned QR payload, and a reused QR says it was already collected', async () => {
    const order = await walletOrder();
    const { qrPayload: payload } = await pickupOf(asha, order.id);
    const verified = await verify(manager, { method: 'QR', payload }).expect(200);
    await confirm(manager, verified.body.challengeToken).expect(200);
    const again = await verify(cashier, { method: 'QR', payload }).expect(409);
    expect(again.body.error.code).toBe('PICKUP_ALREADY_COLLECTED');
    expect(again.body.error.message).toContain(order.pickupCode);
  });

  it('refuses the generic transition: READY → COMPLETED needs verification', async () => {
    const order = await walletOrder();
    const res = await transitionDirect(manager, m.outlet.id, order.id, 'COMPLETED').expect(409);
    expect(res.body.error.code).toBe('PICKUP_VERIFICATION_REQUIRED');
    // And staff don't see "Hand over" as a plain next step any more.
    const view = await api(
      cashier,
      'get',
      `/staff/outlets/${m.outlet.id}/orders/${order.id}`,
    ).expect(200);
    expect(view.body.order.allowedNextStatuses).toEqual([]);
  });

  it('rejects wrong, malformed, expired and revoked codes with safe messages', async () => {
    const order = await walletOrder();
    const { code, qrPayload: payload } = await pickupOf(asha, order.id);
    const wrong = code === '480213' ? '480214' : '480213';
    const res = await verify(cashier, { method: 'CODE', code: wrong }).expect(404);
    expect(res.body.error).toMatchObject({
      code: 'PICKUP_NO_MATCH',
      details: { attemptsLeft: STAFF_FAILURE_LIMIT - 1 },
    });
    await verify(cashier, { method: 'CODE', code: '12ab56' }).expect(404);
    await verify(cashier, { method: 'QR', payload: 'https://evil.example/x' }).expect(404);
    await api(cashier, 'post', `${staffUrl()}/verify`, { method: 'CODE' }).expect(400);

    await prisma.pickupCredential.updateMany({
      data: { createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await verify(cashier, { method: 'QR', payload }).expect(409);
    expect(expired.body.error.code).toBe('PICKUP_CODE_EXPIRED');
    // The student sees it expired and can get a fresh code; the old one stays dead.
    expect((await pickupOf(asha, order.id)).state).toBe('EXPIRED');
    const fresh = (await api(asha, 'post', `/orders/${order.id}/pickup/refresh`).expect(200)).body
      .pickup;
    expect(fresh.state).toBe('ACTIVE');
    expect(fresh.qrPayload).not.toBe(payload);
    await verify(cashier, { method: 'QR', payload }).expect(409);
    // The cashier has now failed 5 times (cooldown); a colleague serves the student.
    await verify(cashier, { method: 'CODE', code: fresh.code }).expect(429);
    const ok = await verify(manager, { method: 'CODE', code: fresh.code }).expect(200);
    await confirm(manager, ok.body.challengeToken).expect(200);
  });

  it('treats another outlet’s code as unknown and keeps staff to their own outlet', async () => {
    const order = await walletOrder();
    const { code, qrPayload: payload } = await pickupOf(asha, order.id);
    const other = await makeOutlet({ name: 'Juice Junction', status: 'OPEN' });
    const otherManager = await signIn('other.manager@example.com');
    await assign('other.manager@example.com', other.id, 'MANAGER');
    // At their own outlet: looks exactly like a wrong code (nothing about the other order).
    const qr = await verify(otherManager, { method: 'QR', payload }, other.id).expect(404);
    expect(qr.body.error.code).toBe('PICKUP_NO_MATCH');
    await verify(otherManager, { method: 'CODE', code }, other.id).expect(404);
    // At this outlet: not assigned.
    await verify(otherManager, { method: 'CODE', code }).expect(403);
    // Students and signed-out users can't verify at all.
    await verify(asha, { method: 'CODE', code }).expect(403);
    await request(staffApp)
      .post(`/api/v1${staffUrl()}/verify`)
      .set('X-Requested-With', 'CampusCart')
      .send({ method: 'CODE', code })
      .expect(401);
  });

  it('a challenge only works for the staff member and outlet it was issued to, and expires', async () => {
    const order = await walletOrder();
    const { code } = await pickupOf(asha, order.id);
    const verified = await verify(cashier, { method: 'CODE', code }).expect(200);
    const token = verified.body.challengeToken;
    const stolen = await confirm(manager, token).expect(404);
    expect(stolen.body.error.code).toBe('PICKUP_CHALLENGE_INVALID');
    await confirm(cashier, 'A'.repeat(43)).expect(404);
    await prisma.pickupVerification.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const late = await confirm(cashier, token).expect(409);
    expect(late.body.error.code).toBe('PICKUP_CHALLENGE_EXPIRED');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      'READY',
    );
  });

  it('refuses not-ready, cancelled and unpaid orders', async () => {
    // Not ready: no credential exists yet, so nothing can match.
    const preparing = await walletOrder(asha, 'PREPARING');
    expect((await pickupOf(asha, preparing.id)).state).toBe('NOT_READY');
    // Cancelled before ready: never had a code; ended orders show no code.
    const ben = await student(`ben${n}@example.com`, staffApp);
    const placed = await walletOrder(ben, 'PLACED');
    await api(ben, 'post', `/orders/${placed.id}/cancel`, {}).expect(200);
    expect((await pickupOf(ben, placed.id)).state).toBe('ENDED');

    // Counter order: verifies, but the handover waits for payment (existing rule).
    const cy = await student(`cy${n}@example.com`, staffApp);
    await addToCart(cy, m.chai.id);
    const counter = (await placeOrder(cy, 'COUNTER', 2000).expect(201)).body.order;
    for (const to of ['ACCEPTED', 'PREPARING', 'READY'])
      await transition(cashier, m.outlet.id, counter.id, to).expect(200);
    const { code, paymentDuePaise } = await pickupOf(cy, counter.id);
    expect(paymentDuePaise).toBe(2000);
    const verified = await verify(cashier, { method: 'CODE', code }).expect(200);
    expect(verified.body).toMatchObject({ canConfirm: false, order: { paymentDuePaise: 2000 } });
    const unpaid = await confirm(cashier, verified.body.challengeToken).expect(409);
    expect(unpaid.body.error.code).toBe('PAYMENT_REQUIRED');
    await api(
      cashier,
      'post',
      `/staff/outlets/${m.outlet.id}/orders/${counter.id}/counter-payment`,
      { amountPaise: 2000 },
    ).expect(200);
    await confirm(cashier, verified.body.challengeToken).expect(200);
  });
});

describe('duplicates and races', () => {
  it('two staff confirming at once: exactly one handover', async () => {
    const order = await walletOrder();
    const { code } = await pickupOf(asha, order.id);
    const a = await verify(cashier, { method: 'CODE', code }).expect(200);
    const b = await verify(manager, { method: 'CODE', code }).expect(200);
    const results = await Promise.all([
      confirm(cashier, a.body.challengeToken),
      confirm(manager, b.body.challengeToken),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('PICKUP_ALREADY_COLLECTED');
    expect(await prisma.orderHandover.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'PICKUP_HANDOVER_CONFIRMED' } })).toBe(1);
    expect(
      await prisma.orderStatusHistory.count({
        where: { orderId: order.id, toStatus: 'COMPLETED' },
      }),
    ).toBe(1);
  });

  it('a retried confirmation returns the same result without a second handover or audit entry', async () => {
    const order = await walletOrder();
    const { code } = await pickupOf(asha, order.id);
    const v = await verify(cashier, { method: 'CODE', code }).expect(200);
    const results = await Promise.all([1, 2, 3].map(() => confirm(cashier, v.body.challengeToken)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.filter((r) => r.body.alreadyConfirmed === false)).toHaveLength(1);
    expect(await prisma.orderHandover.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'PICKUP_HANDOVER_CONFIRMED' } })).toBe(1);
  });

  it('handover records cannot be changed or deleted', async () => {
    const order = await walletOrder();
    await transition(cashier, m.outlet.id, order.id, 'COMPLETED').expect(200);
    await expect(prisma.orderHandover.updateMany({ data: { method: 'QR' } })).rejects.toThrow(
      /cannot be changed/,
    );
    await expect(prisma.orderHandover.deleteMany()).rejects.toThrow(/cannot be changed/);
  });
});

describe('failed-attempt protection', () => {
  it('locks a staff member out after repeated wrong codes, even before a right one', async () => {
    const order = await walletOrder();
    const { code } = await pickupOf(asha, order.id);
    const wrong = (i: number) => String((Number(code) + 1 + i * 7919) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < STAFF_FAILURE_LIMIT; i++) {
      await verify(cashier, { method: 'CODE', code: wrong(i) }).expect(404);
    }
    const locked = await verify(cashier, { method: 'CODE', code }).expect(429);
    expect(locked.body.error).toMatchObject({ code: 'PICKUP_VERIFY_LOCKED' });
    expect(locked.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    // Another staff member at the outlet can still serve the student.
    await verify(manager, { method: 'CODE', code }).expect(200);
    const attempts = await prisma.pickupVerificationAttempt.groupBy({
      by: ['outcome'],
      _count: { _all: true },
    });
    expect(Object.fromEntries(attempts.map((a) => [a.outcome, a._count._all]))).toEqual({
      NO_MATCH: STAFF_FAILURE_LIMIT,
      LOCKED: 1,
      VERIFIED: 1,
    });
    expect(await prisma.auditLog.count({ where: { action: 'PICKUP_VERIFY_LOCKED' } })).toBe(1);
    // After the window the cooldown ends.
    await prisma.pickupVerificationAttempt.updateMany({
      data: { createdAt: new Date(Date.now() - 6 * 60_000) },
    });
    await verify(cashier, { method: 'CODE', code }).expect(200);
  });
});

describe('lifecycle', () => {
  it('issues a code for a READY order that predates pickup verification when the student opens it', async () => {
    const order = await walletOrder();
    await prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "action" LIKE 'PICKUP_%'`;
    await prisma.pickupCredential.deleteMany();
    const pickup = await pickupOf(asha, order.id);
    expect(pickup.state).toBe('ACTIVE');
    expect(await prisma.auditLog.count({ where: { action: 'PICKUP_CREDENTIAL_REISSUED' } })).toBe(
      1,
    );
    const v = await verify(cashier, { method: 'CODE', code: pickup.code }).expect(200);
    await confirm(cashier, v.body.challengeToken).expect(200);
  });

  it('the student cannot set their own order to collected', async () => {
    const order = await walletOrder();
    const { code } = await pickupOf(asha, order.id);
    await verify(asha, { method: 'CODE', code }).expect(403);
    await api(asha, 'post', `/orders/${order.id}/cancel`, {}).expect(409);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      'READY',
    );
  });
});
