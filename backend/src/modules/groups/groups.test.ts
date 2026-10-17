import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { fund, key, menu, student, type Agent } from '../../tests/commerce.js';
import { makeCategory, makeItem, makeOutlet } from '../../tests/fixtures.js';
import { staffFor, transition } from '../../tests/staff.js';
import { splitAmount } from '../../lib/allocation.js';

let m: Awaited<ReturnType<typeof menu>>;
let host: Agent;
let bee: Agent;
let cee: Agent;
let n = 0;

const send = (
  agent: Agent,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  url: string,
  body?: object,
  idem?: string,
) => {
  const req = agent[method](`/api/v1/groups${url}`).set('X-Requested-With', 'CampusCart');
  if (idem) req.set('Idempotency-Key', idem);
  return body ? req.send(body) : req;
};
const balance = async (agent: Agent) =>
  (await agent.get('/api/v1/wallet').expect(200)).body.wallet.balancePaise as number;

beforeEach(async () => {
  await resetDatabase();
  m = await menu(); // Night Owl Café: Chai ₹20, Puff ₹35
  n += 1;
  host = await student(`host${n}@example.com`);
  bee = await student(`bee${n}@example.com`);
  cee = await student(`cee${n}@example.com`);
});

async function newGroup(extra: object = {}) {
  const res = await send(host, 'post', '', {
    name: 'Project lunch',
    outletId: m.outlet.id,
    ...extra,
  }).expect(201);
  return res.body.group as { id: string; code: string; me: { memberId: string } };
}
async function joined(extra: object = {}) {
  const g = await newGroup(extra);
  await send(bee, 'post', '/join', { code: g.code }).expect(200);
  await send(cee, 'post', '/join', { code: g.code }).expect(200);
  return g;
}
const view = async (agent: Agent, id: string) =>
  (await send(agent, 'get', `/${id}`).expect(200)).body.group;
const add = (agent: Agent, id: string, itemId: string, quantity: number) =>
  send(agent, 'put', `/${id}/items/${itemId}`, { quantity });

describe('creating and joining', () => {
  it('creates a group with an unguessable code and lets others join with it', async () => {
    const g = await newGroup({ description: 'Lab 3', maxMembers: 4 });
    expect(g.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    // Codes are accepted however they're typed.
    const pretty = `${g.code.slice(0, 5).toLowerCase()}-${g.code.slice(5)}`;
    const joinedView = (await send(bee, 'post', '/join', { code: pretty }).expect(200)).body.group;
    expect(joinedView.me.role).toBe('MEMBER');
    expect(joinedView.members.map((x: { role: string }) => x.role)).toEqual(['HOST', 'MEMBER']);
    // Joining twice is harmless.
    await send(bee, 'post', '/join', { code: g.code }).expect(200);
    expect(await prisma.groupMember.count({ where: { groupId: g.id } })).toBe(2);
    expect((await send(bee, 'get', '').expect(200)).body.groups).toEqual([
      expect.objectContaining({ id: g.id, role: 'MEMBER', memberCount: 2, status: 'ACTIVE' }),
    ]);
  });

  it('refuses wrong, expired and full codes, removed members and outsiders', async () => {
    const g = await newGroup({ maxMembers: 2 });
    expect(
      (await send(bee, 'post', '/join', { code: 'WRONGCODE9' }).expect(404)).body.error.code,
    ).toBe('INVALID_JOIN_CODE');
    await send(bee, 'post', '/join', { code: g.code }).expect(200);
    expect((await send(cee, 'post', '/join', { code: g.code }).expect(409)).body.error.code).toBe(
      'GROUP_FULL',
    );
    // Outsiders can't see it, or act on it.
    await send(cee, 'get', `/${g.id}`).expect(404);
    await add(cee, g.id, m.chai.id, 1).expect(404);
    // Removed members can't come back.
    const beeMember = (await view(host, g.id)).members.find(
      (x: { role: string }) => x.role === 'MEMBER',
    );
    await send(host, 'delete', `/${g.id}/members/${beeMember.id}`).expect(200);
    expect((await send(bee, 'post', '/join', { code: g.code }).expect(403)).body.error.code).toBe(
      'REMOVED_FROM_GROUP',
    );
    await send(bee, 'get', `/${g.id}`).expect(404);

    const later = await newGroup();
    await prisma.groupTray.update({
      where: { id: later.id },
      data: { joinClosesAt: new Date(Date.now() - 1000) },
    });
    expect(
      (await send(cee, 'post', '/join', { code: later.code }).expect(410)).body.error.code,
    ).toBe('JOIN_CODE_EXPIRED');
  });

  it('only the host changes settings, removes people or sets the split', async () => {
    const g = await joined();
    await send(bee, 'patch', `/${g.id}`, { name: 'Mine now' }).expect(403);
    await send(bee, 'put', `/${g.id}/allocation`, { mode: 'EQUAL' }).expect(403);
    const hostMember = (await view(bee, g.id)).members.find(
      (x: { role: string }) => x.role === 'HOST',
    );
    await send(bee, 'delete', `/${g.id}/members/${hostMember.id}`).expect(403);
    await send(host, 'patch', `/${g.id}`, { name: 'Renamed', maxMembers: 5 }).expect(200);
    await send(host, 'patch', `/${g.id}`, { maxMembers: 2 }).expect(409);
  });
});

describe('the shared tray', () => {
  it('records who added what at live prices, and checks quantities and stock on the server', async () => {
    const g = await joined();
    await add(host, g.id, m.chai.id, 2).expect(200);
    await add(bee, g.id, m.puff.id, 1).expect(200);
    await add(bee, g.id, m.chai.id, 11).expect(400);
    const other = await makeOutlet({ name: 'Canteen' });
    const thali = await makeItem(other.id, (await makeCategory(other.id, 'Meals')).id, {
      name: 'Thali',
    });
    expect((await add(bee, g.id, thali.id, 1).expect(409)).body.error.code).toBe(
      'ITEM_UNAVAILABLE',
    );
    await prisma.menuItem.update({
      where: { id: m.puff.id },
      data: { trackInventory: true, stockQuantity: 3 },
    });
    expect((await add(cee, g.id, m.puff.id, 3).expect(409)).body.error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: { available: 2 },
    });
    await add(cee, g.id, m.puff.id, 2).expect(200);

    const v = await view(cee, g.id);
    expect(v.tray).toMatchObject({
      subtotalPaise: 4000 + 3500 + 7000,
      totalPaise: 14_500,
      itemCount: 5,
    });
    expect(v.members.map((x: { itemsTotalPaise: number }) => x.itemsTotalPaise)).toEqual([
      4000, 3500, 7000,
    ]);
    // Removing works; quantity 0 removes.
    await add(cee, g.id, m.puff.id, 0).expect(200);
    expect((await view(cee, g.id)).tray.subtotalPaise).toBe(7500);
  });

  it('refuses a stale total at checkout when a price changed', async () => {
    const g = await joined();
    await add(host, g.id, m.chai.id, 2).expect(200);
    await prisma.menuItem.update({ where: { id: m.chai.id }, data: { pricePaise: 2500 } });
    const res = await send(host, 'post', `/${g.id}/checkout`, { expectedTotalPaise: 4000 }).expect(
      409,
    );
    expect(res.body.error).toMatchObject({ code: 'PRICE_CHANGED', details: { totalPaise: 5000 } });
    expect(await prisma.groupSettlement.count()).toBe(0);
  });
});

describe('allocation formulas', () => {
  it('splits exactly, with deterministic rounding', () => {
    const three = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(splitAmount('EQUAL', 10_000, three)).toEqual({
      ok: true,
      amounts: [
        { id: 'a', amountPaise: 3334 },
        { id: 'b', amountPaise: 3333 },
        { id: 'c', amountPaise: 3333 },
      ],
    });
    const pct = splitAmount('PERCENTAGE', 10_001, [
      { id: 'a', percentBps: 3333 },
      { id: 'b', percentBps: 3333 },
      { id: 'c', percentBps: 3334 },
    ]);
    expect(pct.ok && pct.amounts.map((x) => x.amountPaise)).toEqual([3333, 3333, 3335]);
    expect(pct.ok && pct.amounts.reduce((s, x) => s + x.amountPaise, 0)).toBe(10_001);
    expect(
      splitAmount('PERCENTAGE', 100, [
        { id: 'a', percentBps: 5000 },
        { id: 'b', percentBps: 4999 },
      ]),
    ).toMatchObject({ ok: false, code: 'PERCENTAGES_MUST_TOTAL_100' });
    expect(
      splitAmount('CUSTOM', 1000, [
        { id: 'a', customPaise: 600 },
        { id: 'b', customPaise: 300 },
      ]),
    ).toMatchObject({
      ok: false,
      code: 'CUSTOM_AMOUNTS_MISMATCH',
      details: { differencePaise: 100 },
    });
    expect(
      splitAmount('BY_DISH', 900, [
        { id: 'a', ownPaise: 600 },
        { id: 'b', ownPaise: 300 },
      ]),
    ).toMatchObject({ ok: true });
  });

  it('applies each formula to the live tray and freezes it at checkout', async () => {
    const g = await joined();
    await add(host, g.id, m.chai.id, 1).expect(200); // 2000
    await add(bee, g.id, m.puff.id, 2).expect(200); // 7000
    await add(cee, g.id, m.chai.id, 1).expect(200); // 2000 → 11000
    const v = await view(host, g.id);
    const [h, b, c] = v.members.map((x: { id: string }) => x.id);
    expect(v.allocationPreview.amounts.map((x: { amountPaise: number }) => x.amountPaise)).toEqual([
      2000, 7000, 2000,
    ]);

    await send(host, 'put', `/${g.id}/allocation`, { mode: 'EQUAL' }).expect(200);
    expect(
      (await view(bee, g.id)).allocationPreview.amounts.map(
        (x: { amountPaise: number }) => x.amountPaise,
      ),
    ).toEqual([3667, 3667, 3666]);

    expect(
      (
        await send(host, 'put', `/${g.id}/allocation`, {
          mode: 'PERCENTAGE',
          percents: { [h]: 5000, [b]: 3000, [c]: 1000 },
        }).expect(400)
      ).body.error.code,
    ).toBe('PERCENTAGES_MUST_TOTAL_100');
    await send(host, 'put', `/${g.id}/allocation`, {
      mode: 'PERCENTAGE',
      percents: { [h]: 5000, [b]: 3000, [c]: 2000 },
    }).expect(200);
    expect(
      (await view(bee, g.id)).allocationPreview.amounts.map(
        (x: { amountPaise: number }) => x.amountPaise,
      ),
    ).toEqual([5500, 3300, 2200]);

    const bad = await send(host, 'put', `/${g.id}/allocation`, {
      mode: 'CUSTOM',
      amounts: { [h]: 5000, [b]: 5000, [c]: 0 },
    }).expect(400);
    expect(bad.body.error).toMatchObject({
      code: 'CUSTOM_AMOUNTS_MISMATCH',
      details: { differencePaise: 1000 },
    });
    await send(host, 'put', `/${g.id}/allocation`, {
      mode: 'CUSTOM',
      amounts: { [h]: 6000, [b]: 5000, [c]: 0 },
    }).expect(200);

    await send(host, 'post', `/${g.id}/checkout`, { expectedTotalPaise: 11_000 }).expect(200);
    const locked = await view(cee, g.id);
    expect(locked.status).toBe('CHECKOUT');
    expect(
      locked.settlement.shares.map((s: { amountDuePaise: number; status: string }) => [
        s.amountDuePaise,
        s.status,
      ]),
    ).toEqual([
      [6000, 'UNPAID'],
      [5000, 'UNPAID'],
      [0, 'NOTHING_DUE'],
    ]);
    // Frozen: a later price change doesn't touch what anyone owes, and the tray is locked.
    await prisma.menuItem.update({ where: { id: m.chai.id }, data: { pricePaise: 9900 } });
    expect((await view(cee, g.id)).settlement.totalPaise).toBe(11_000);
    expect((await add(cee, g.id, m.chai.id, 2).expect(409)).body.error.code).toBe('GROUP_LOCKED');
    const revisions = await prisma.groupEvent.findMany({
      where: { groupId: g.id, kind: 'ALLOCATION_CHANGED' },
    });
    expect(revisions).toHaveLength(3);
  });
});

describe('checkout, payments and the order', () => {
  async function readyToPay(mode: object = { mode: 'BY_DISH' }) {
    const g = await joined();
    await add(host, g.id, m.chai.id, 2).expect(200); // 4000
    await add(bee, g.id, m.puff.id, 1).expect(200); // 3500
    await add(cee, g.id, m.chai.id, 1).expect(200); // 2000 → 9500
    await send(host, 'put', `/${g.id}/allocation`, mode).expect(200);
    return g;
  }

  it('starts checkout once even when the host clicks repeatedly', async () => {
    const g = await readyToPay();
    const results = await Promise.all(
      [1, 2, 3].map(() => send(host, 'post', `/${g.id}/checkout`, { expectedTotalPaise: 9500 })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await prisma.groupSettlement.count({ where: { groupId: g.id } })).toBe(1);
    expect(await prisma.groupShare.count()).toBe(3);
    await send(bee, 'post', `/${g.id}/checkout`, { expectedTotalPaise: 9500 }).expect(403);
  });

  it('charges each member exactly their share once, then places one order with the combined dishes', async () => {
    const g = await readyToPay();
    await prisma.menuItem.update({
      where: { id: m.chai.id },
      data: { trackInventory: true, stockQuantity: 10 },
    });
    for (const a of [host, bee, cee]) await fund(a, 10_000);
    await send(host, 'post', `/${g.id}/checkout`, { expectedTotalPaise: 9500 }).expect(200);
    // Double-clicks and retries: one debit.
    const beePays = await Promise.all(
      [1, 2, 3].map(() => send(bee, 'post', `/${g.id}/shares/mine/pay`, {}, key())),
    );
    expect(beePays.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(await balance(bee)).toBe(10_000 - 3500);
    await send(host, 'post', `/${g.id}/shares/mine/pay`, {}, key()).expect(201);
    // Not everyone has paid: no order yet.
    expect(await prisma.order.count()).toBe(0);
    await send(host, 'post', `/${g.id}/order`).expect(409);
    const last = await send(cee, 'post', `/${g.id}/shares/mine/pay`, {}, key()).expect(201);
    expect(last.body.orderError).toBeNull();
    expect(last.body.group.status).toBe('ORDERED');

    const order = await prisma.order.findFirstOrThrow({ include: { items: true } });
    expect(order).toMatchObject({
      paymentMethod: 'GROUP',
      paymentStatus: 'PAID',
      totalPaise: 9500,
      status: 'PLACED',
    });
    expect(order.items.map((i) => [i.name, i.quantity, i.lineTotalPaise]).sort()).toEqual([
      ['Chai', 3, 6000],
      ['Puff', 1, 3500],
    ]);
    expect(
      (await prisma.menuItem.findUniqueOrThrow({ where: { id: m.chai.id } })).stockQuantity,
    ).toBe(7);
    // Ledger: one GROUP_SHARE_PAYMENT per member, adding up to the order total.
    const debits = await prisma.walletTransaction.findMany({
      where: { type: 'GROUP_SHARE_PAYMENT' },
    });
    expect(debits.map((d) => d.amountPaise).sort((a, b) => a - b)).toEqual([2000, 3500, 4000]);
    expect(debits.reduce((s, d) => s + d.amountPaise, 0)).toBe(order.totalPaise);
    expect([await balance(host), await balance(bee), await balance(cee)]).toEqual([
      6000, 6500, 8000,
    ]);
    // Paying again changes nothing.
    await send(cee, 'post', `/${g.id}/shares/mine/pay`, {}, key()).expect(200);
    expect(await prisma.walletTransaction.count({ where: { type: 'GROUP_SHARE_PAYMENT' } })).toBe(
      3,
    );
  });

  it('refuses a payment the wallet can’t cover, without charging anything', async () => {
    const g = await readyToPay();
    await send(host, 'post', `/${g.id}/checkout`, { expectedTotalPaise: 9500 }).expect(200);
    const res = await send(bee, 'post', `/${g.id}/shares/mine/pay`, {}, key()).expect(409);
    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      details: { shortfallPaise: 3500 },
    });
    expect(await prisma.walletTransaction.count({ where: { type: 'GROUP_SHARE_PAYMENT' } })).toBe(
      0,
    );
  });

  it('reopening refunds everyone who paid and unlocks the tray', async () => {
    const g = await readyToPay({ mode: 'EQUAL' });
    for (const a of [host, bee]) await fund(a, 10_000);
    await send(host, 'post', `/${g.id}/checkout`, { expectedTotalPaise: 9500 }).expect(200);
    await send(host, 'post', `/${g.id}/shares/mine/pay`, {}, key()).expect(201);
    await send(bee, 'post', `/${g.id}/shares/mine/pay`, {}, key()).expect(201);
    expect(await balance(host)).toBe(10_000 - 3167);
    await send(bee, 'post', `/${g.id}/reopen`).expect(403);
    const v = (await send(host, 'post', `/${g.id}/reopen`).expect(200)).body.group;
    expect(v.status).toBe('ACTIVE');
    expect(v.settlement).toBeNull();
    expect([await balance(host), await balance(bee)]).toEqual([10_000, 10_000]);
    const refunds = await prisma.walletTransaction.findMany({ where: { type: 'REFUND' } });
    expect(refunds).toHaveLength(2);
    expect(refunds.every((r) => r.reversesTransactionId !== null)).toBe(true);
    expect((await prisma.groupSettlement.findFirstOrThrow()).status).toBe('VOID');
    await add(cee, g.id, m.chai.id, 2).expect(200);
  });

  it('refunds every member’s share when the outlet rejects the group order', async () => {
    const g = await readyToPay();
    for (const a of [host, bee, cee]) await fund(a, 10_000);
    await send(host, 'post', `/${g.id}/checkout`, { expectedTotalPaise: 9500 }).expect(200);
    for (const a of [host, bee, cee])
      await send(a, 'post', `/${g.id}/shares/mine/pay`, {}, key()).expect(201);
    const order = await prisma.order.findFirstOrThrow();
    const { manager } = await staffFor(m.outlet.id);
    await transition(manager, m.outlet.id, order.id, 'REJECTED', 'Kitchen closed early').expect(
      200,
    );
    expect([await balance(host), await balance(bee), await balance(cee)]).toEqual([
      10_000, 10_000, 10_000,
    ]);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe(
      'REFUNDED',
    );
    const shares = await prisma.groupShare.findMany();
    expect(shares.every((s) => s.status === 'REFUNDED')).toBe(true);
    // Rejecting again can't refund twice.
    await transition(manager, m.outlet.id, order.id, 'REJECTED', 'again').expect(409);
    expect(await prisma.walletTransaction.count({ where: { type: 'REFUND' } })).toBe(3);
  });

  it('doesn’t let outsiders pay or see a group’s money', async () => {
    const g = await readyToPay();
    await send(host, 'post', `/${g.id}/checkout`, { expectedTotalPaise: 9500 }).expect(200);
    const outsider = await student(`out${n}@example.com`);
    await fund(outsider, 10_000);
    await send(outsider, 'post', `/${g.id}/shares/mine/pay`, {}, key()).expect(404);
    await send(outsider, 'get', `/${g.id}`).expect(404);
    expect(await balance(outsider)).toBe(10_000);
  });

  it('cancelling the group refunds paid shares', async () => {
    const g = await readyToPay();
    await fund(bee, 10_000);
    await send(host, 'post', `/${g.id}/checkout`, { expectedTotalPaise: 9500 }).expect(200);
    await send(bee, 'post', `/${g.id}/shares/mine/pay`, {}, key()).expect(201);
    await send(host, 'post', `/${g.id}/cancel`, { reason: 'Plans changed' }).expect(200);
    expect(await balance(bee)).toBe(10_000);
    expect((await view(bee, g.id)).status).toBe('CANCELLED');
    // Nothing is due any more (the share was refunded).
    expect(
      (await send(bee, 'post', `/${g.id}/shares/mine/pay`, {}, key()).expect(409)).body.error.code,
    ).toBe('NOTHING_TO_PAY');
  });
});
