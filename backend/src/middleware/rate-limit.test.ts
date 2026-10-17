import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resetDatabase } from '../tests/db.js';
import { buildTestApp, devLogin, testConfig } from '../tests/helpers.js';
import { key } from '../tests/commerce.js';

beforeEach(resetDatabase);

describe('money action rate limit', () => {
  it('limits recharges and orders per user, without limiting reads or other users', async () => {
    const app = buildTestApp({
      config: testConfig({ PAYMENT_MOCK_ENABLED: 'true', MONEY_RATE_LIMIT_PER_MIN: '2' }),
    });
    const a = request.agent(app);
    const b = request.agent(app);
    await devLogin(a, 'a@example.com');
    await devLogin(b, 'b@example.com');

    const recharge = (agent: typeof a) =>
      agent
        .post('/api/v1/wallet/recharges')
        .set('X-Requested-With', 'CampusCart')
        .set('Idempotency-Key', key())
        .send({ amountPaise: 9900 }); // ₹99, the minimum

    expect((await recharge(a)).status).toBe(201);
    expect((await recharge(a)).status).toBe(201);
    const blocked = await recharge(a);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');

    // The same user's checkout shares the money-action budget.
    const order = await a
      .post('/api/v1/orders')
      .set('X-Requested-With', 'CampusCart')
      .set('Idempotency-Key', key())
      .send({ paymentMethod: 'COUNTER', expectedTotalPaise: 100 });
    expect(order.status).toBe(429);

    // Reads still work, and another student is unaffected.
    await a.get('/api/v1/orders').expect(200);
    expect((await recharge(b)).status).toBe(201);
  });
});
