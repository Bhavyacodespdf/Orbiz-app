import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { buildTestApp, devLogin, testConfig } from '../../tests/helpers.js';
import { app, fund, key, post, student, type Agent } from '../../tests/commerce.js';
import { rechargeProviderFor } from '../payments/providers.js';
import { creditBalance, debitBalance, ensureWallet, refundToBalance } from './wallet.service.js';

// Numbers refer to the "Wallet and payment tests" list in the project brief.

let s: Agent;
beforeEach(async () => {
  await resetDatabase();
  s = await student();
});

const balance = async (agent: Agent) =>
  (await agent.get('/api/v1/wallet').expect(200)).body.wallet.balancePaise as number;

function startRecharge(agent: Agent, amountPaise: number, idempotencyKey = key()) {
  return post(agent, '/wallet/recharges', { amountPaise }, idempotencyKey);
}
const settle = (agent: Agent, id: string, outcome: string) =>
  post(agent, `/payments/mock/${id}/outcome`, { outcome });

describe('wallet basics', () => {
  it('creates the wallet once when a new user’s first requests arrive together', async () => {
    const fresh = await student('first.visit@example.com');
    const results = await Promise.all([
      fresh.get('/api/v1/wallet'),
      fresh.get('/api/v1/wallet/transactions'),
      fresh.get('/api/v1/wallet/points'),
      fresh.get('/api/v1/wallet'),
      fresh.get('/api/v1/cart'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'first.visit@example.com' },
    });
    expect(await prisma.wallet.count({ where: { userId: user.id } })).toBe(1);
  });

  it('#1 a new wallet starts at the approved ₹0 and reports simulated recharge limits', async () => {
    const { wallet } = (await s.get('/api/v1/wallet').expect(200)).body;
    expect(wallet).toMatchObject({
      balancePaise: 0,
      currency: 'INR',
      recharge: {
        available: true,
        mode: 'MOCK',
        isSimulated: true,
        minPaise: 9900, // ₹99: the business minimum, above the configured ₹10
        maxPaise: 200000,
        maxBalancePaise: 500000,
      },
    });
  });

  it('requires sign-in', async () => {
    await request(app).get('/api/v1/wallet').expect(401);
  });

  it('#8 offers no way for a student to set a balance or write the ledger', async () => {
    const write = (method: 'patch' | 'put' | 'post', url: string) =>
      s[method](url).set('X-Requested-With', 'CampusCart').send({ balancePaise: 999999 });
    await write('patch', '/api/v1/wallet').expect(404);
    await write('put', '/api/v1/wallet').expect(404);
    await write('post', '/api/v1/wallet/transactions').expect(404);
    await post(s, '/wallet/recharges', { amountPaise: 50000, balancePaise: 999999 }, key()).expect(
      400,
    );
    expect(await balance(s)).toBe(0);
  });
});

describe('mock recharge', () => {
  it('records a PENDING attempt and ledger row first, crediting nothing yet', async () => {
    const res = await startRecharge(s, 50000).expect(201);
    expect(res.body.recharge).toMatchObject({
      status: 'PENDING',
      provider: 'MOCK',
      isSimulated: true,
      amountPaise: 50000,
    });
    expect(res.body.nextAction).toEqual({ type: 'MOCK_SIMULATOR' });
    expect(await balance(s)).toBe(0);
    const { transactions } = (await s.get('/api/v1/wallet/transactions').expect(200)).body;
    expect(transactions).toEqual([
      expect.objectContaining({
        type: 'RECHARGE',
        status: 'PENDING',
        balanceAfterPaise: null,
        isSimulated: true,
      }),
    ]);
  });

  it('#3 a successful recharge credits exactly once: ₹100 + ₹500 = ₹600', async () => {
    await fund(s, 10000);
    const r = await startRecharge(s, 50000).expect(201);
    const done = await settle(s, r.body.recharge.id, 'SUCCESS').expect(200);
    expect(done.body).toMatchObject({
      changed: true,
      recharge: { status: 'SUCCEEDED' },
      wallet: { balancePaise: 60000 },
    });
    const [latest] = (await s.get('/api/v1/wallet/transactions').expect(200)).body.transactions;
    expect(latest).toMatchObject({
      status: 'COMPLETED',
      amountPaise: 50000,
      balanceAfterPaise: 60000,
      direction: 'CREDIT',
    });
    expect(latest.description).toMatch(/simulated/i);
  });

  it.each([
    ['FAILURE', 'FAILED'],
    ['CANCEL', 'CANCELLED'],
  ])('#4/#5 outcome %s leaves the balance unchanged (₹100 stays ₹100)', async (outcome, status) => {
    await fund(s, 10000);
    const r = await startRecharge(s, 50000).expect(201);
    const res = await settle(s, r.body.recharge.id, outcome).expect(200);
    expect(res.body.recharge.status).toBe(status);
    expect(await balance(s)).toBe(10000);
    const [latest] = (await s.get('/api/v1/wallet/transactions').expect(200)).body.transactions;
    expect(latest).toMatchObject({ status, balanceAfterPaise: null });
  });

  it('#6 a repeated start request with the same key returns the same attempt', async () => {
    const k = key();
    const first = await startRecharge(s, 50000, k).expect(201);
    const second = await startRecharge(s, 50000, k).expect(200);
    expect(second.body.recharge.id).toBe(first.body.recharge.id);
    expect(await prisma.paymentAttempt.count()).toBe(1);
    const misuse = await startRecharge(s, 70000, k);
    expect(misuse.status).toBe(409);
    expect(misuse.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('#6 repeating the outcome cannot credit twice, and a settled attempt cannot be changed', async () => {
    const r = await startRecharge(s, 50000).expect(201);
    await settle(s, r.body.recharge.id, 'SUCCESS').expect(200);
    const again = await settle(s, r.body.recharge.id, 'SUCCESS').expect(200);
    expect(again.body.changed).toBe(false);
    const flip = await settle(s, r.body.recharge.id, 'FAILURE').expect(200);
    expect(flip.body).toMatchObject({ changed: false, recharge: { status: 'SUCCEEDED' } });
    expect(await balance(s)).toBe(50000);
    expect(await prisma.walletTransaction.count({ where: { status: 'COMPLETED' } })).toBe(1);
  });

  it('#7 concurrent duplicate processing credits once', async () => {
    const r = await startRecharge(s, 50000).expect(201);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => settle(s, r.body.recharge.id, 'SUCCESS')),
    );
    expect(results.every((x) => x.status === 200)).toBe(true);
    expect(results.filter((x) => x.body.changed)).toHaveLength(1);
    expect(await balance(s)).toBe(50000);
  });

  it('expires recharges that are not completed in time, without crediting', async () => {
    const r = await startRecharge(s, 50000).expect(201);
    await prisma.paymentAttempt.update({
      where: { id: r.body.recharge.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const got = await s.get(`/api/v1/wallet/recharges/${r.body.recharge.id}`).expect(200);
    expect(got.body.recharge.status).toBe('EXPIRED');
    const late = await settle(s, r.body.recharge.id, 'SUCCESS').expect(200);
    expect(late.body.changed).toBe(false);
    expect(await balance(s)).toBe(0);
  });

  it('validates amounts and the wallet cap on the server', async () => {
    expect((await startRecharge(s, 9800)).body.error.code).toBe('AMOUNT_OUT_OF_RANGE'); // below ₹99
    expect((await startRecharge(s, 9950)).body.error.code).toBe('AMOUNT_NOT_WHOLE_RUPEES'); // ₹99.50
    expect((await startRecharge(s, 200100)).body.error.code).toBe('AMOUNT_OUT_OF_RANGE'); // above ₹2,000
    await post(s, '/wallet/recharges', { amountPaise: 10.5 }, key()).expect(400);
    await post(s, '/wallet/recharges', { amountPaise: '500' }, key()).expect(400);
    await post(s, '/wallet/recharges', { amountPaise: -100 }, key()).expect(400);

    await fund(s, 200000);
    await fund(s, 200000); // ₹4,000
    const over = await startRecharge(s, 150000); // would be ₹5,500 > ₹5,000 cap
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('WALLET_LIMIT');
  });

  it('requires an Idempotency-Key header', async () => {
    const res = await post(s, '/wallet/recharges', { amountPaise: 50000 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('privacy', () => {
  it('#2/#9 a student cannot read or settle anything belonging to another student', async () => {
    const r = await startRecharge(s, 50000).expect(201);
    await settle(s, r.body.recharge.id, 'SUCCESS').expect(200);
    const txnId = (await s.get('/api/v1/wallet/transactions').expect(200)).body.transactions[0].id;

    const other = await student('other@example.com');
    expect((await other.get('/api/v1/wallet/transactions').expect(200)).body.transactions).toEqual(
      [],
    );
    await other.get(`/api/v1/wallet/transactions/${txnId}`).expect(404);
    await other.get(`/api/v1/wallet/recharges/${r.body.recharge.id}`).expect(404);

    const r2 = await startRecharge(s, 20000).expect(201);
    await settle(other, r2.body.recharge.id, 'SUCCESS').expect(404);
    expect(await balance(other)).toBe(0);
    expect(await balance(s)).toBe(50000);
  });
});

describe('persistence and pagination', () => {
  it('#18 a fresh session (refresh, other device) sees the persisted balance', async () => {
    await fund(s, 30000);
    const again = request.agent(app);
    await devLogin(again, 'student@example.com');
    expect(await balance(again)).toBe(30000);
  });

  it('pages through history newest first without gaps or repeats', async () => {
    for (const amount of [9900, 10000, 10100, 10200, 10300]) await fund(s, amount);
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const query: Record<string, string | number> = cursor ? { limit: 2, cursor } : { limit: 2 };
      const page: request.Response = await s
        .get('/api/v1/wallet/transactions')
        .query(query)
        .expect(200);
      seen.push(...page.body.transactions.map((t: { amountPaise: number }) => t.amountPaise));
      cursor = page.body.nextCursor as string | null;
    } while (cursor);
    expect(seen).toEqual([10300, 10200, 10100, 10000, 9900]);
  });
});

describe('mock mode safety', () => {
  it('#21 is never selected in production, and its routes do not exist when disabled', async () => {
    expect(
      rechargeProviderFor({
        ...testConfig({ PAYMENT_MOCK_ENABLED: 'true' }),
        NODE_ENV: 'production',
      }),
    ).toBeNull();

    const off = buildTestApp({ config: testConfig({ PAYMENT_MOCK_ENABLED: 'false' }) });
    const agent = request.agent(off);
    await devLogin(agent, 'student@example.com');
    const start = await post(agent, '/wallet/recharges', { amountPaise: 50000 }, key());
    expect(start.status).toBe(503);
    expect(start.body.error.code).toBe('RECHARGE_UNAVAILABLE');
    await post(agent, `/payments/mock/${crypto.randomUUID()}/outcome`, {
      outcome: 'SUCCESS',
    }).expect(404);
    expect((await agent.get('/api/v1/wallet').expect(200)).body.wallet.recharge.available).toBe(
      false,
    );
  });

  it('#22 every simulated credit is labelled as simulated, never as a real transfer', async () => {
    await fund(s, 10000);
    const rows = await prisma.walletTransaction.findMany();
    const attempts = await prisma.paymentAttempt.findMany();
    expect(rows.every((t) => t.isSimulated && /simulated/i.test(t.description))).toBe(true);
    expect(
      attempts.every(
        (a) => a.isSimulated && a.provider === 'MOCK' && a.providerReference.startsWith('mock_'),
      ),
    ).toBe(true);
  });
});

describe('balance primitives (database level)', () => {
  it('#11 concurrent debits can never overspend: only as many succeed as the balance allows', async () => {
    const user = await prisma.user.findFirstOrThrow();
    const wallet = await ensureWallet(prisma, user.id);
    await prisma.$transaction((tx) => creditBalance(tx, wallet.id, 10000, 500000));

    // 10 parallel debits of ₹30 against a ₹100 balance: exactly 3 can succeed.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        prisma.$transaction((tx) => debitBalance(tx, wallet.id, 3000)),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(3);
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balancePaise).toBe(
      1000,
    );
  });

  it('the database itself rejects a negative balance', async () => {
    const user = await prisma.user.findFirstOrThrow();
    const wallet = await ensureWallet(prisma, user.id);
    await expect(
      prisma.wallet.update({ where: { id: wallet.id }, data: { balancePaise: -1 } }),
    ).rejects.toThrow();
  });

  it('stamps updatedAt in UTC on credit, debit and refund, whatever the session time zone', async () => {
    const user = await prisma.user.findFirstOrThrow();
    const wallet = await ensureWallet(prisma, user.id);
    const updatedAt = async () =>
      (await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).updatedAt.getTime();

    await prisma.$transaction((tx) => creditBalance(tx, wallet.id, 10000, 500000));
    expect(Math.abs((await updatedAt()) - Date.now())).toBeLessThan(5000);
    await prisma.$transaction((tx) => debitBalance(tx, wallet.id, 3000));
    expect(Math.abs((await updatedAt()) - Date.now())).toBeLessThan(5000);
    await prisma.$transaction((tx) => refundToBalance(tx, wallet.id, 3000));
    expect(Math.abs((await updatedAt()) - Date.now())).toBeLessThan(5000);
  });
});
