import request from 'supertest';
import { buildTestApp, devLogin, testConfig } from './helpers.js';
import { assign } from './fixtures.js';
import { prisma } from '../lib/prisma.js';
import { unseal } from '../modules/pickup/pickup.crypto.js';
import type { Agent } from './commerce.js';

/** Staff allowlists used by order/real-time tests. */
export const staffConfig = testConfig({
  PAYMENT_MOCK_ENABLED: 'true',
  MANAGER_ALLOWED_EMAILS: 'manager@example.com,other.manager@example.com',
  POS_ALLOWED_EMAILS: 'cashier@example.com',
});
export const staffApp = buildTestApp({ config: staffConfig });

export async function signIn(email: string, app = staffApp): Promise<Agent> {
  const agent = request.agent(app);
  await devLogin(agent, email);
  return agent;
}

export async function staffFor(outletId: string, app = staffApp) {
  const manager = await signIn('manager@example.com', app);
  const cashier = await signIn('cashier@example.com', app);
  await assign('manager@example.com', outletId, 'MANAGER');
  await assign('cashier@example.com', outletId, 'POS');
  return { manager, cashier };
}

type Res = request.Response;
type Pending = Promise<Res> & { expect(status: number): Promise<Res> };

/** Like supertest's .expect(status) for a request made of several calls. */
function pending(result: PromiseLike<Res>): Pending {
  const promise = Promise.resolve(result);
  return Object.assign(promise, {
    expect: (status: number) =>
      promise.then((res) => {
        if (res.status !== status) {
          throw new Error(`expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
        }
        return res;
      }),
  });
}

const rawTransition = (
  agent: Agent,
  outletId: string,
  orderId: string,
  to: string,
  reason?: string,
) =>
  agent
    .post(`/api/v1/staff/outlets/${outletId}/orders/${orderId}/transition`)
    .set('X-Requested-With', 'CampusCart')
    .send(reason === undefined ? { to } : { to, reason });

/**
 * The real handover: the student's numeric code (read the way the student's app gets it) is
 * verified by `agent`, then explicitly confirmed. With no active code (order not READY) it falls
 * back to the plain transition request, so tests see the real refusal.
 */
export async function handOver(agent: Agent, outletId: string, orderId: string): Promise<Res> {
  const credential = await prisma.pickupCredential.findFirst({
    where: { orderId, status: 'ACTIVE' },
  });
  if (!credential) return rawTransition(agent, outletId, orderId, 'COMPLETED');
  const { code } = unseal(credential.sealed, orderId);
  const verified = await agent
    .post(`/api/v1/staff/outlets/${outletId}/pickup/verify`)
    .set('X-Requested-With', 'CampusCart')
    .send({ method: 'CODE', code });
  if (verified.status !== 200) return verified;
  return agent
    .post(`/api/v1/staff/outlets/${outletId}/pickup/confirm`)
    .set('X-Requested-With', 'CampusCart')
    .send({ challengeToken: verified.body.challengeToken });
}

/** Moves an order on. COMPLETED goes through pickup verification, as it must in the app. */
export const transition = (
  agent: Agent,
  outletId: string,
  orderId: string,
  to: string,
  reason?: string,
): Pending =>
  pending(
    to === 'COMPLETED'
      ? handOver(agent, outletId, orderId)
      : rawTransition(agent, outletId, orderId, to, reason),
  );

/** The generic transition endpoint, even for COMPLETED (to prove it refuses the handover). */
export const transitionDirect = (
  agent: Agent,
  outletId: string,
  orderId: string,
  to: string,
  reason?: string,
) => rawTransition(agent, outletId, orderId, to, reason);

export const cancel = (agent: Agent, orderId: string, reason?: string) =>
  agent
    .post(`/api/v1/orders/${orderId}/cancel`)
    .set('X-Requested-With', 'CampusCart')
    .send(reason === undefined ? {} : { reason });
