import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { buildTestApp, devLogin, testConfig } from './helpers.js';
import { makeCategory, makeItem, makeOutlet } from './fixtures.js';

export const config = testConfig({ PAYMENT_MOCK_ENABLED: 'true' });
export const app = buildTestApp({ config });
export type Agent = ReturnType<typeof request.agent>;

export async function student(email = 'student@example.com', target = app): Promise<Agent> {
  const agent = request.agent(target);
  await devLogin(agent, email);
  return agent;
}

export const key = () => `test-${randomUUID()}`;

export const post = (agent: Agent, url: string, body: object, idempotencyKey?: string) => {
  const req = agent.post(`/api/v1${url}`).set('X-Requested-With', 'CampusCart');
  if (idempotencyKey) req.set('Idempotency-Key', idempotencyKey);
  return req.send(body);
};

/** Funds a wallet through the real recharge flow (simulated success), as a student would. */
export async function fund(agent: Agent, amountPaise: number) {
  const created = await post(agent, '/wallet/recharges', { amountPaise }, key()).expect(201);
  await post(agent, `/payments/mock/${created.body.recharge.id}/outcome`, {
    outcome: 'SUCCESS',
  }).expect(200);
}

export async function menu() {
  const outlet = await makeOutlet({ name: 'Night Owl Café', status: 'OPEN' });
  const category = await makeCategory(outlet.id, 'Snacks');
  const chai = await makeItem(outlet.id, category.id, { name: 'Chai', pricePaise: 2000 });
  const puff = await makeItem(outlet.id, category.id, { name: 'Puff', pricePaise: 3500 });
  return { outlet, category, chai, puff };
}

export async function addToCart(agent: Agent, menuItemId: string, quantity = 1) {
  return post(agent, '/cart/items', { menuItemId, quantity }).expect(200);
}

export function placeOrder(
  agent: Agent,
  paymentMethod: 'WALLET' | 'COUNTER',
  expectedTotalPaise: number,
  idempotencyKey = key(),
) {
  return post(agent, '/orders', { paymentMethod, expectedTotalPaise }, idempotencyKey);
}
