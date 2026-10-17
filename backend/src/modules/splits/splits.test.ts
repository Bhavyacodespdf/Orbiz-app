import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { fund, key, student, type Agent } from '../../tests/commerce.js';

let owner: Agent;
let ravi: Agent;
let meera: Agent;
let n = 0;
const email = (who: string) => `${who}${n}@example.com`;

const send = (
  agent: Agent,
  method: 'get' | 'post' | 'patch',
  url: string,
  body?: object,
  idem?: string,
) => {
  const req = agent[method](`/api/v1/splits${url}`).set('X-Requested-With', 'CampusCart');
  if (idem) req.set('Idempotency-Key', idem);
  return body ? req.send(body) : req;
};
const balance = async (agent: Agent) =>
  (await agent.get('/api/v1/wallet').expect(200)).body.wallet.balancePaise as number;

beforeEach(async () => {
  await resetDatabase();
  n += 1;
  owner = await student(email('owner'));
  ravi = await student(email('ravi'));
  meera = await student(email('meera'));
});

const base = (extra: object = {}) => ({
  title: 'Canteen dinner',
  totalPaise: 1000,
  expenseDate: '2026-10-16',
  method: 'EQUAL',
  participants: [{ email: email('owner') }, { email: email('ravi') }, { email: email('meera') }],
  ...extra,
});
const create = async (extra: object = {}) =>
  (await send(owner, 'post', '', base(extra)).expect(201)).body.split;

describe('creating splits', () => {
  it('splits equally to the paisa, with the owner’s own share already covered', async () => {
    const split = await create();
    expect(
      split.participants.map((p: { amountDuePaise: number; status: string }) => [
        p.amountDuePaise,
        p.status,
      ]),
    ).toEqual([
      [334, 'OWNER'],
      [333, 'UNPAID'],
      [333, 'UNPAID'],
    ]);
    expect(split.totalOutstandingPaise).toBe(666);
    expect(split.myShare).toBeNull();
    const asRavi = (await send(ravi, 'get', `/${split.id}`).expect(200)).body.split;
    expect(asRavi.myShare).toEqual({
      amountDuePaise: 333,
      amountPaidPaise: 0,
      outstandingPaise: 333,
      status: 'UNPAID',
    });
  });

  it('supports percentages and custom amounts, and refuses ones that don’t add up', async () => {
    const pct = await create({
      method: 'PERCENTAGE',
      participants: [
        { email: email('owner'), percentBps: 5000 },
        { email: email('ravi'), percentBps: 3000 },
        { email: email('meera'), percentBps: 2000 },
      ],
    });
    expect(pct.participants.map((p: { amountDuePaise: number }) => p.amountDuePaise)).toEqual([
      500, 300, 200,
    ]);
    const bad = await send(
      owner,
      'post',
      '',
      base({
        method: 'PERCENTAGE',
        participants: [
          { email: email('ravi'), percentBps: 5000 },
          { email: email('meera'), percentBps: 4000 },
        ],
      }),
    ).expect(400);
    expect(bad.body.error.code).toBe('PERCENTAGES_MUST_TOTAL_100');
    const custom = await send(
      owner,
      'post',
      '',
      base({
        method: 'CUSTOM',
        participants: [
          { email: email('ravi'), customAmountPaise: 600 },
          { email: email('meera'), customAmountPaise: 300 },
        ],
      }),
    ).expect(400);
    expect(custom.body.error).toMatchObject({
      code: 'CUSTOM_AMOUNTS_MISMATCH',
      details: { differencePaise: 100 },
    });
    // Without the owner: the others cover everything.
    const others = await create({
      method: 'CUSTOM',
      participants: [
        { email: email('ravi'), customAmountPaise: 700 },
        { email: email('meera'), customAmountPaise: 300 },
      ],
    });
    expect(others.totalOutstandingPaise).toBe(1000);
  });

  it('validates participants on the server', async () => {
    const unknown = await send(
      owner,
      'post',
      '',
      base({ participants: [{ email: email('ravi') }, { email: 'nobody@example.com' }] }),
    ).expect(400);
    expect(unknown.body.error).toMatchObject({
      code: 'UNKNOWN_PARTICIPANTS',
      details: { emails: ['nobody@example.com'] },
    });
    await send(
      owner,
      'post',
      '',
      base({ participants: [{ email: email('ravi') }, { email: email('ravi').toUpperCase() }] }),
    ).expect(400);
    await send(owner, 'post', '', base({ participants: [{ email: email('owner') }] })).expect(400);
    await send(owner, 'post', '', base({ totalPaise: 12.5 })).expect(400);
  });
});

describe('settling through the wallet', () => {
  it('moves exactly the amount paid from the payer’s wallet to the owner’s, partially then fully', async () => {
    const split = await create();
    await fund(ravi, 10_000);
    await send(ravi, 'post', `/${split.id}/settlements`, { amountPaise: 100 }, key()).expect(201);
    expect([await balance(ravi), await balance(owner)]).toEqual([9900, 100]);
    let mine = (await send(ravi, 'get', `/${split.id}`).expect(200)).body.split.myShare;
    expect(mine).toEqual({
      amountDuePaise: 333,
      amountPaidPaise: 100,
      outstandingPaise: 233,
      status: 'PARTIALLY_PAID',
    });
    expect(
      (
        await send(ravi, 'post', `/${split.id}/settlements`, { amountPaise: 234 }, key()).expect(
          409,
        )
      ).body.error,
    ).toMatchObject({
      code: 'OVERPAYMENT',
      details: { outstandingPaise: 233 },
    });
    await send(ravi, 'post', `/${split.id}/settlements`, { amountPaise: 233 }, key()).expect(201);
    mine = (await send(ravi, 'get', `/${split.id}`).expect(200)).body.split.myShare;
    expect(mine.status).toBe('PAID');
    expect(
      (await send(ravi, 'post', `/${split.id}/settlements`, { amountPaise: 1 }, key()).expect(409))
        .body.error.code,
    ).toBe('ALREADY_SETTLED');
    const ledger = await prisma.walletTransaction.findMany({
      where: { type: { in: ['PEER_TRANSFER_OUT', 'PEER_TRANSFER_IN'] } },
    });
    expect(
      ledger.filter((t) => t.type === 'PEER_TRANSFER_OUT').reduce((s, t) => s + t.amountPaise, 0),
    ).toBe(333);
    expect(
      ledger.filter((t) => t.type === 'PEER_TRANSFER_IN').reduce((s, t) => s + t.amountPaise, 0),
    ).toBe(333);
    // The owner can't "settle" their own share, and the split closes when everyone has paid.
    expect(
      (
        await send(owner, 'post', `/${split.id}/settlements`, { amountPaise: 100 }, key()).expect(
          409,
        )
      ).body.error.code,
    ).toBe('NOTHING_OWED');
    await fund(meera, 10_000);
    await send(meera, 'post', `/${split.id}/settlements`, { amountPaise: 333 }, key()).expect(201);
    expect((await send(owner, 'get', `/${split.id}`).expect(200)).body.split).toMatchObject({
      status: 'SETTLED',
      totalOutstandingPaise: 0,
    });
  });

  it('a retried or double-clicked payment moves money once', async () => {
    const split = await create();
    await fund(ravi, 10_000);
    const k = key();
    const results = await Promise.all(
      [1, 2, 3].map(() => send(ravi, 'post', `/${split.id}/settlements`, { amountPaise: 333 }, k)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(await balance(ravi)).toBe(10_000 - 333);
    expect(await prisma.peerSplitSettlement.count()).toBe(1);
    // Two different keys at once can't overpay either.
    const twice = await Promise.all(
      [1, 2].map(() =>
        send(meera, 'post', `/${split.id}/settlements`, { amountPaise: 333 }, key()),
      ),
    );
    expect(twice.every((r) => r.status === 409)).toBe(true); // meera has no money
    await fund(meera, 10_000);
    const race = await Promise.all(
      [1, 2].map(() =>
        send(meera, 'post', `/${split.id}/settlements`, { amountPaise: 333 }, key()),
      ),
    );
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await balance(meera)).toBe(10_000 - 333);
  });

  it('refuses when the payer can’t cover it or the owner’s wallet is full, moving nothing', async () => {
    const split = await create();
    expect(
      (
        await send(ravi, 'post', `/${split.id}/settlements`, { amountPaise: 333 }, key()).expect(
          409,
        )
      ).body.error.code,
    ).toBe('INSUFFICIENT_BALANCE');
    await fund(ravi, 10_000);
    await balance(owner); // creates the owner's wallet
    await prisma.wallet.updateMany({
      where: { user: { email: email('owner') } },
      data: { balancePaise: 499_900 },
    });
    expect(
      (
        await send(ravi, 'post', `/${split.id}/settlements`, { amountPaise: 333 }, key()).expect(
          409,
        )
      ).body.error.code,
    ).toBe('RECIPIENT_WALLET_FULL');
    expect(await balance(ravi)).toBe(10_000);
    expect(await prisma.peerSplitSettlement.count()).toBe(0);
  });

  it('keeps splits private to the people in them', async () => {
    const split = await create();
    const outsider = await student(email('outsider'));
    await fund(outsider, 10_000);
    await send(outsider, 'get', `/${split.id}`).expect(404);
    await send(outsider, 'post', `/${split.id}/settlements`, { amountPaise: 100 }, key()).expect(
      404,
    );
    expect((await send(outsider, 'get', '').expect(200)).body.splits).toEqual([]);
    // A participant sees only their own repayments; the owner sees all.
    await fund(ravi, 10_000);
    await fund(meera, 10_000);
    await send(ravi, 'post', `/${split.id}/settlements`, { amountPaise: 333 }, key()).expect(201);
    await send(meera, 'post', `/${split.id}/settlements`, { amountPaise: 100 }, key()).expect(201);
    expect(
      (await send(ravi, 'get', `/${split.id}`).expect(200)).body.split.settlements,
    ).toHaveLength(1);
    expect(
      (await send(owner, 'get', `/${split.id}`).expect(200)).body.split.settlements,
    ).toHaveLength(2);
    await send(ravi, 'patch', `/${split.id}`, { title: 'Mine' }).expect(404);
    await send(ravi, 'post', `/${split.id}/cancel`, {}).expect(404);
  });
});

describe('editing and cancelling', () => {
  it('lets the owner edit details only', async () => {
    const split = await create();
    await send(owner, 'patch', `/${split.id}`, {
      title: 'Dinner at Night Owl',
      dueDate: '2026-10-30',
    }).expect(200);
    await send(owner, 'patch', `/${split.id}`, { totalPaise: 5 }).expect(400);
  });

  it('cancelling sends every repayment back, keeping the history', async () => {
    const split = await create();
    await fund(ravi, 10_000);
    await send(ravi, 'post', `/${split.id}/settlements`, { amountPaise: 333 }, key()).expect(201);
    // The owner spent the money: cancelling is refused, nothing changes.
    await prisma.wallet.updateMany({
      where: { user: { email: email('owner') } },
      data: { balancePaise: 100 },
    });
    expect((await send(owner, 'post', `/${split.id}/cancel`, {}).expect(409)).body.error.code).toBe(
      'OWNER_BALANCE_TOO_LOW',
    );
    await prisma.wallet.updateMany({
      where: { user: { email: email('owner') } },
      data: { balancePaise: 333 },
    });
    const cancelled = (
      await send(owner, 'post', `/${split.id}/cancel`, { reason: 'Wrong amount' }).expect(200)
    ).body.split;
    expect(cancelled.status).toBe('CANCELLED');
    expect([await balance(ravi), await balance(owner)]).toEqual([10_000, 0]);
    const settlement = await prisma.peerSplitSettlement.findFirstOrThrow();
    expect(settlement.status).toBe('REVERSED');
    const reversals = await prisma.walletTransaction.findMany({ where: { type: 'REVERSAL' } });
    expect(reversals.map((r) => r.reversesTransactionId).sort()).toEqual(
      [settlement.creditTransactionId, settlement.debitTransactionId].sort(),
    );
    // Original transfers are untouched.
    expect(
      await prisma.walletTransaction.count({
        where: { type: { in: ['PEER_TRANSFER_OUT', 'PEER_TRANSFER_IN'] } },
      }),
    ).toBe(2);
    await send(ravi, 'post', `/${split.id}/settlements`, { amountPaise: 1 }, key()).expect(409);
    await send(owner, 'post', `/${split.id}/cancel`, {}).expect(409);
  });
});
