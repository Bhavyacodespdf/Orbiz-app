import { randomInt } from 'node:crypto';
import { notify } from '../notifications/notifications.service.js';
import { placedNotice } from '../notifications/order-notices.js';
import type { Database, DbClient } from '../../lib/prisma.js';
import { isUniqueViolation } from '../../lib/prisma.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { splitAmount, type SplitMethod } from '../../lib/allocation.js';
import type { AllocationMode } from '../../generated/prisma/enums.js';
import { debitBalance, ensureWallet, refundToBalance } from '../wallet/wallet.service.js';
import { deductForOrder } from '../inventory/inventory.service.js';
import { hasStockFor, inStock } from '../inventory/stock.js';
import { claimOrderCapacity } from '../capacity/capacity.service.js';
import { ORDER_CAPACITY_PER_WINDOW } from '../capacity/capacity.rules.js';
import { formatPickupCode, istDay, nextPickupNumber } from '../orders/pickup.js';

/*
 * Group trays: several students fill one tray at one outlet, agree how to split the bill, each
 * pays their own share from their own wallet to CampusCart, and only then is ONE order placed.
 *
 *   ACTIVE ── checkout (host) ──► CHECKOUT ── every share paid ──► ORDERED
 *     ▲                              │
 *     └──────── reopen (host) ───────┤   (reopen / cancel refund every paid share)
 *   CANCELLED ◄──────────────────────┘
 *
 * Prices and the split are frozen at checkout (GroupSettlement) and never recalculated.
 * Every change locks the group row, so concurrent edits, payments and checkouts serialise.
 */

export const MAX_ITEM_QUANTITY = 10;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LENGTH = 10;

/** 10 characters from 31 → ~8 × 10¹⁴ codes; joining is also rate-limited. */
export function newJoinCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}
export const normaliseCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

type Tx = DbClient;

async function lockGroup(tx: Tx, groupId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "GroupTray" WHERE id = ${groupId}::uuid FOR UPDATE`;
  if (rows.length === 0) throw notFound('Group not found');
  return tx.groupTray.findUniqueOrThrow({ where: { id: groupId }, include: { outlet: true } });
}

/** The caller's ACTIVE membership; anyone else gets 404 (a group's existence isn't revealed). */
async function requireMember(tx: Tx, groupId: string, userId: string) {
  const member = await tx.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });
  if (!member || member.status !== 'ACTIVE') throw notFound('Group not found');
  return member;
}

function requireHost(member: { role: string }) {
  if (member.role !== 'HOST') throw forbidden('Only the group’s host can do that.');
}

function requireStatus(group: { status: string }, ...allowed: string[]) {
  if (!allowed.includes(group.status)) {
    throw new AppError(
      409,
      'GROUP_LOCKED',
      group.status === 'CHECKOUT'
        ? 'The tray is locked for payment. The host can reopen it to make changes.'
        : `This group is ${group.status.toLowerCase()}.`,
      { status: group.status },
    );
  }
}

const event = (
  tx: Tx,
  groupId: string,
  kind: string,
  actorUserId: string | null,
  details?: object,
) =>
  tx.groupEvent.create({
    data: {
      groupId,
      kind,
      actorUserId,
      details: details ? JSON.parse(JSON.stringify(details)) : undefined,
    },
  });

/** Host first, then by when people joined: the fixed order used for rounding. */
const memberOrder = <T extends { role: string; joinedAt: Date; id: string }>(members: T[]) =>
  [...members].sort(
    (a, b) =>
      (a.role === 'HOST' ? 0 : 1) - (b.role === 'HOST' ? 0 : 1) ||
      a.joinedAt.getTime() - b.joinedAt.getTime() ||
      a.id.localeCompare(b.id),
  );

const itemInclude = {
  menuItem: { include: { category: true } },
} as const;

/** Live tray: current prices and availability (before checkout). */
async function liveTray(tx: Tx, groupId: string) {
  const [members, items] = await Promise.all([
    tx.groupMember.findMany({
      where: { groupId, status: 'ACTIVE' },
      include: { user: { select: { displayName: true, avatarUrl: true } } },
    }),
    tx.groupItem.findMany({
      where: { groupId },
      include: itemInclude,
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const ordered = memberOrder(members);
  const totalsByItem = new Map<string, number>();
  for (const i of items)
    totalsByItem.set(i.menuItemId, (totalsByItem.get(i.menuItemId) ?? 0) + i.quantity);
  const lines = items.map((i) => {
    const m = i.menuItem;
    const problem =
      !m.isActive || !m.category.isActive
        ? 'NOT_ON_MENU'
        : !inStock(m)
          ? 'SOLD_OUT'
          : !hasStockFor(m, totalsByItem.get(i.menuItemId)!)
            ? 'NOT_ENOUGH_STOCK'
            : null;
    return {
      id: i.id,
      memberId: i.memberId,
      menuItemId: i.menuItemId,
      name: m.name,
      unitPricePaise: m.pricePaise,
      quantity: i.quantity,
      lineTotalPaise: m.pricePaise * i.quantity,
      problem,
      menuItem: m,
    };
  });
  const subtotalPaise = lines.reduce((a, l) => a + l.lineTotalPaise, 0);
  return { members: ordered, lines, subtotalPaise };
}

function allocationFor(
  mode: AllocationMode,
  totalPaise: number,
  members: { id: string; percentBps: number | null; customAmountPaise: number | null }[],
  ownByMember: Map<string, number>,
) {
  return splitAmount(
    mode as SplitMethod,
    totalPaise,
    members.map((m) => ({
      id: m.id,
      ownPaise: ownByMember.get(m.id) ?? 0,
      percentBps: m.percentBps,
      customPaise: m.customAmountPaise,
    })),
  );
}

// ─── Reading ────────────────────────────────────────────────────────────────

export async function getGroup(db: Database, groupId: string, userId: string) {
  const me = await requireMember(db, groupId, userId);
  const group = await db.groupTray.findUniqueOrThrow({
    where: { id: groupId },
    include: {
      outlet: { select: { id: true, name: true, slug: true, status: true, isActive: true } },
      host: { select: { id: true, displayName: true } },
      order: { select: { id: true, status: true, pickupCode: true, paymentStatus: true } },
      events: {
        orderBy: { createdAt: 'desc' },
        take: 30,
        include: { actor: { select: { displayName: true } } },
      },
    },
  });
  const tray = await liveTray(db, groupId);
  const ownByMember = new Map<string, number>();
  for (const l of tray.lines)
    ownByMember.set(l.memberId, (ownByMember.get(l.memberId) ?? 0) + l.lineTotalPaise);
  const preview =
    group.status === 'ACTIVE' && tray.subtotalPaise > 0
      ? allocationFor(group.allocationMode, tray.subtotalPaise, tray.members, ownByMember)
      : null;

  const settlement = await db.groupSettlement.findFirst({
    where: { groupId, status: { not: 'VOID' } },
    include: {
      lines: true,
      shares: { include: { user: { select: { displayName: true } } } },
    },
  });

  const ranks = new Map(
    (
      (settlement?.inputs as { memberOrder?: string[] } | null)?.memberOrder ??
      tray.members.map((m) => m.id)
    ).map((id, i) => [id, i]),
  );
  const memberRank = (id: string) => ranks.get(id) ?? Number.MAX_SAFE_INTEGER;

  return {
    id: group.id,
    code: group.code,
    name: group.name,
    description: group.description,
    status: group.status,
    outlet: group.outlet,
    host: group.host,
    maxMembers: group.maxMembers,
    joinClosesAt: group.joinClosesAt?.toISOString() ?? null,
    allocationMode: group.allocationMode,
    version: group.version,
    createdAt: group.createdAt.toISOString(),
    checkoutAt: group.checkoutAt?.toISOString() ?? null,
    orderedAt: group.orderedAt?.toISOString() ?? null,
    cancelledAt: group.cancelledAt?.toISOString() ?? null,
    cancelReason: group.cancelReason,
    order: group.order,
    me: { memberId: me.id, role: me.role },
    members: tray.members.map((m) => ({
      id: m.id,
      userId: m.userId,
      displayName: m.user.displayName,
      avatarUrl: m.user.avatarUrl,
      role: m.role,
      joinedAt: m.joinedAt.toISOString(),
      percentBps: m.percentBps,
      customAmountPaise: m.customAmountPaise,
      items: tray.lines.filter((l) => l.memberId === m.id).map(({ menuItem: _m, ...l }) => l),
      itemsTotalPaise: ownByMember.get(m.id) ?? 0,
    })),
    tray: {
      subtotalPaise: tray.subtotalPaise,
      // No taxes, fees or group discounts exist in CampusCart (decision Q7), so total = subtotal.
      totalPaise: tray.subtotalPaise,
      itemCount: tray.lines.reduce((a, l) => a + l.quantity, 0),
      problems: tray.lines
        .filter((l) => l.problem)
        .map((l) => ({ menuItemId: l.menuItemId, name: l.name, problem: l.problem })),
    },
    allocationPreview: preview,
    settlement: settlement && {
      id: settlement.id,
      version: settlement.version,
      status: settlement.status,
      mode: settlement.mode,
      subtotalPaise: settlement.subtotalPaise,
      totalPaise: settlement.totalPaise,
      createdAt: settlement.createdAt.toISOString(),
      lines: settlement.lines.map((l) => ({
        memberId: l.memberId,
        menuItemId: l.menuItemId,
        name: l.name,
        unitPricePaise: l.unitPricePaise,
        quantity: l.quantity,
        lineTotalPaise: l.lineTotalPaise,
      })),
      // In the group's fixed order (host first, then by joining), as used for rounding.
      shares: [...settlement.shares]
        .sort((a, b) => memberRank(a.memberId) - memberRank(b.memberId) || a.id.localeCompare(b.id))
        .map((s) => ({
          id: s.id,
          memberId: s.memberId,
          userId: s.userId,
          displayName: s.user.displayName,
          amountDuePaise: s.amountDuePaise,
          ownItemsPaise: s.ownItemsPaise,
          amountPaidPaise: s.amountPaidPaise,
          outstandingPaise: s.status === 'UNPAID' ? s.amountDuePaise - s.amountPaidPaise : 0,
          status: s.status,
          method: s.paymentTransactionId ? 'WALLET' : null,
          transactionId: s.userId === userId ? s.paymentTransactionId : null,
          paidAt: s.paidAt?.toISOString() ?? null,
          refundedAt: s.refundedAt?.toISOString() ?? null,
        })),
    },
    events: group.events.map((e) => ({
      id: e.id,
      kind: e.kind,
      actor: e.actor?.displayName ?? null,
      details: e.details,
      at: e.createdAt.toISOString(),
    })),
  };
}
export type GroupView = Awaited<ReturnType<typeof getGroup>>;

/** The caller's groups, newest first, with what they owe. */
export async function listGroups(db: Database, userId: string) {
  const memberships = await db.groupMember.findMany({
    where: { userId, status: 'ACTIVE' },
    include: {
      group: {
        include: {
          outlet: { select: { name: true } },
          _count: { select: { members: { where: { status: 'ACTIVE' } } } },
          settlements: {
            where: { status: { not: 'VOID' } },
            include: { shares: { where: { userId } } },
          },
        },
      },
    },
    orderBy: { joinedAt: 'desc' },
    take: 50,
  });
  return memberships.map(({ group, role }) => {
    const share = group.settlements[0]?.shares[0];
    return {
      id: group.id,
      name: group.name,
      outlet: group.outlet.name,
      status: group.status,
      role,
      memberCount: group._count.members,
      myShare: share ? { amountDuePaise: share.amountDuePaise, status: share.status } : null,
      createdAt: group.createdAt.toISOString(),
    };
  });
}

// ─── Creating, joining, members ─────────────────────────────────────────────

export async function createGroup(
  db: Database,
  input: {
    userId: string;
    name: string;
    description?: string;
    outletId: string;
    maxMembers: number;
    joinClosesAt?: Date | null;
    allocationMode: AllocationMode;
  },
) {
  const outlet = await db.outlet.findFirst({ where: { id: input.outletId, isActive: true } });
  if (!outlet)
    throw new AppError(400, 'INVALID_OUTLET', 'Choose an outlet that is open on CampusCart.');
  if (input.joinClosesAt && input.joinClosesAt.getTime() <= Date.now()) {
    throw new AppError(400, 'INVALID_EXPIRY', 'The joining deadline must be in the future.');
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const group = await db.$transaction(async (tx) => {
        const g = await tx.groupTray.create({
          data: {
            code: newJoinCode(),
            name: input.name,
            description: input.description ?? '',
            outletId: outlet.id,
            hostUserId: input.userId,
            maxMembers: input.maxMembers,
            joinClosesAt: input.joinClosesAt ?? null,
            allocationMode: input.allocationMode,
          },
        });
        await tx.groupMember.create({
          data: { groupId: g.id, userId: input.userId, role: 'HOST' },
        });
        await event(tx, g.id, 'CREATED', input.userId, {
          outlet: outlet.name,
          allocationMode: input.allocationMode,
        });
        return g;
      });
      return group.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error; // a code collision: try another code
    }
  }
  throw new AppError(503, 'CODE_UNAVAILABLE', 'Could not create a join code. Please try again.');
}

/** Joins with a code. Codes are matched exactly; unknown codes and private groups look the same. */
export async function joinGroup(db: Database, rawCode: string, userId: string) {
  const code = normaliseCode(rawCode);
  return db.$transaction(async (tx) => {
    const found = await tx.groupTray.findUnique({ where: { code }, select: { id: true } });
    if (!found)
      throw new AppError(404, 'INVALID_JOIN_CODE', 'That join code doesn’t match a group.');
    const group = await lockGroup(tx, found.id);
    const existing = await tx.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId } },
    });
    if (existing?.status === 'ACTIVE') return group.id;
    if (existing?.status === 'REMOVED') {
      throw new AppError(403, 'REMOVED_FROM_GROUP', 'The host removed you from this group.');
    }
    if (group.status !== 'ACTIVE') {
      throw new AppError(409, 'GROUP_NOT_JOINABLE', 'This group is no longer taking new members.');
    }
    if (group.joinClosesAt && group.joinClosesAt.getTime() <= Date.now()) {
      throw new AppError(410, 'JOIN_CODE_EXPIRED', 'This join code has expired.');
    }
    const count = await tx.groupMember.count({ where: { groupId: group.id, status: 'ACTIVE' } });
    if (count >= group.maxMembers) throw new AppError(409, 'GROUP_FULL', 'This group is full.');
    if (existing) {
      await tx.groupMember.update({
        where: { id: existing.id },
        data: {
          status: 'ACTIVE',
          leftAt: null,
          joinedAt: new Date(),
          percentBps: null,
          customAmountPaise: null,
        },
      });
    } else {
      await tx.groupMember.create({ data: { groupId: group.id, userId, role: 'MEMBER' } });
    }
    await tx.groupTray.update({ where: { id: group.id }, data: { version: { increment: 1 } } });
    await event(tx, group.id, 'JOINED', userId);
    return group.id;
  });
}

export async function updateGroup(
  db: Database,
  params: {
    groupId: string;
    userId: string;
    name?: string;
    description?: string;
    maxMembers?: number;
    joinClosesAt?: Date | null;
  },
) {
  await db.$transaction(async (tx) => {
    const group = await lockGroup(tx, params.groupId);
    requireHost(await requireMember(tx, group.id, params.userId));
    requireStatus(group, 'ACTIVE');
    if (params.maxMembers !== undefined) {
      const count = await tx.groupMember.count({ where: { groupId: group.id, status: 'ACTIVE' } });
      if (params.maxMembers < count) {
        throw new AppError(409, 'TOO_FEW_PLACES', `The group already has ${count} members.`);
      }
    }
    if (params.joinClosesAt && params.joinClosesAt.getTime() <= Date.now()) {
      throw new AppError(400, 'INVALID_EXPIRY', 'The joining deadline must be in the future.');
    }
    const { groupId: _g, userId: _u, ...changes } = params;
    await tx.groupTray.update({
      where: { id: group.id },
      data: { ...changes, version: { increment: 1 } },
    });
    await event(tx, group.id, 'SETTINGS_CHANGED', params.userId, changes);
  });
}

/** The host removes a member, or a member leaves. Their items leave the tray with them. */
export async function removeMember(
  db: Database,
  params: { groupId: string; userId: string; memberId: string },
) {
  return db.$transaction(async (tx) => {
    const group = await lockGroup(tx, params.groupId);
    const me = await requireMember(tx, group.id, params.userId);
    const target = await tx.groupMember.findFirst({
      where: { id: params.memberId, groupId: group.id, status: 'ACTIVE' },
    });
    if (!target) throw notFound('Member not found');
    const leaving = target.id === me.id;
    if (!leaving) requireHost(me);
    if (target.role === 'HOST') {
      throw new AppError(
        409,
        'HOST_CANNOT_LEAVE',
        'The host can’t leave. Cancel the group instead.',
      );
    }
    requireStatus(group, 'ACTIVE');
    await tx.groupItem.deleteMany({ where: { memberId: target.id } });
    await tx.groupMember.update({
      where: { id: target.id },
      data: {
        status: leaving ? 'LEFT' : 'REMOVED',
        leftAt: new Date(),
        percentBps: null,
        customAmountPaise: null,
      },
    });
    await tx.groupTray.update({ where: { id: group.id }, data: { version: { increment: 1 } } });
    await event(tx, group.id, leaving ? 'LEFT' : 'REMOVED', params.userId, {
      memberUserId: target.userId,
    });
    return target.userId;
  });
}

// ─── The tray ───────────────────────────────────────────────────────────────

/** Sets the caller's quantity of a dish (0 removes it). Server-side menu, price and stock checks. */
export async function setMyItem(
  db: Database,
  params: { groupId: string; userId: string; menuItemId: string; quantity: number },
) {
  await db.$transaction(async (tx) => {
    const group = await lockGroup(tx, params.groupId);
    const me = await requireMember(tx, group.id, params.userId);
    requireStatus(group, 'ACTIVE');
    const existing = await tx.groupItem.findUnique({
      where: { memberId_menuItemId: { memberId: me.id, menuItemId: params.menuItemId } },
    });
    if (params.quantity === 0) {
      if (existing) await tx.groupItem.delete({ where: { id: existing.id } });
    } else {
      const item = await tx.menuItem.findFirst({
        where: { id: params.menuItemId, outletId: group.outletId },
        include: { category: true },
      });
      if (!item || !item.isActive || !item.category.isActive) {
        throw new AppError(409, 'ITEM_UNAVAILABLE', 'That dish isn’t on this outlet’s menu.');
      }
      if (!inStock(item)) throw new AppError(409, 'ITEM_UNAVAILABLE', `${item.name} is sold out.`);
      const others = await tx.groupItem.aggregate({
        where: { groupId: group.id, menuItemId: item.id, NOT: { memberId: me.id } },
        _sum: { quantity: true },
      });
      const wanted = (others._sum.quantity ?? 0) + params.quantity;
      if (!hasStockFor(item, wanted)) {
        const left = Math.max(0, (item.stockQuantity ?? 0) - (others._sum.quantity ?? 0));
        throw new AppError(
          409,
          'INSUFFICIENT_STOCK',
          `Only ${left} more ${item.name} available for this group.`,
          {
            available: left,
          },
        );
      }
      await tx.groupItem.upsert({
        where: { memberId_menuItemId: { memberId: me.id, menuItemId: item.id } },
        create: {
          groupId: group.id,
          memberId: me.id,
          menuItemId: item.id,
          outletId: group.outletId,
          quantity: params.quantity,
        },
        update: { quantity: params.quantity },
      });
    }
    await tx.groupTray.update({ where: { id: group.id }, data: { version: { increment: 1 } } });
  });
}

/**
 * The host chooses how the bill is split. Percentages must total 100% and custom amounts the
 * current tray total; the server rechecks both against the live tray at checkout.
 */
export async function setAllocation(
  db: Database,
  params: {
    groupId: string;
    userId: string;
    mode: AllocationMode;
    percents?: Record<string, number>;
    amounts?: Record<string, number>;
  },
) {
  await db.$transaction(async (tx) => {
    const group = await lockGroup(tx, params.groupId);
    requireHost(await requireMember(tx, group.id, params.userId));
    requireStatus(group, 'ACTIVE');
    const tray = await liveTray(tx, group.id);
    const ids = new Set(tray.members.map((m) => m.id));
    const inputs =
      params.mode === 'PERCENTAGE'
        ? params.percents
        : params.mode === 'CUSTOM'
          ? params.amounts
          : undefined;
    if (inputs) {
      const unknown = Object.keys(inputs).filter((id) => !ids.has(id));
      if (unknown.length > 0)
        throw new AppError(400, 'UNKNOWN_MEMBERS', 'Some of those people aren’t in the group.', {
          unknown,
        });
      const people = tray.members.map((m) => ({
        id: m.id,
        percentBps: params.mode === 'PERCENTAGE' ? (inputs[m.id] ?? null) : null,
        customPaise: params.mode === 'CUSTOM' ? (inputs[m.id] ?? null) : null,
      }));
      const check = splitAmount(params.mode as SplitMethod, tray.subtotalPaise, people);
      if (!check.ok) throw new AppError(400, check.code, check.message, check.details);
    }
    const before = {
      mode: group.allocationMode,
      inputs: Object.fromEntries(
        tray.members.map((m) => [
          m.id,
          { percentBps: m.percentBps, customAmountPaise: m.customAmountPaise },
        ]),
      ),
    };
    for (const m of tray.members) {
      await tx.groupMember.update({
        where: { id: m.id },
        data: {
          percentBps: params.mode === 'PERCENTAGE' ? inputs![m.id]! : null,
          customAmountPaise: params.mode === 'CUSTOM' ? inputs![m.id]! : null,
        },
      });
    }
    await tx.groupTray.update({
      where: { id: group.id },
      data: { allocationMode: params.mode, version: { increment: 1 } },
    });
    await event(tx, group.id, 'ALLOCATION_CHANGED', params.userId, {
      from: before,
      to: { mode: params.mode, inputs: inputs ?? null, trayTotalPaise: tray.subtotalPaise },
    });
  });
}

// ─── Checkout, payment, order ───────────────────────────────────────────────

/**
 * The host locks the tray: prices are re-read from the menu, availability re-checked, the
 * split computed and frozen. `expectedTotalPaise` must match what the host was shown.
 */
export async function startCheckout(
  db: Database,
  params: { groupId: string; userId: string; expectedTotalPaise: number },
) {
  await db.$transaction(async (tx) => {
    const group = await lockGroup(tx, params.groupId);
    requireHost(await requireMember(tx, group.id, params.userId));
    if (group.status === 'CHECKOUT') {
      // A repeated confirmation (double-click, retry) for the same total is harmless.
      const live = await tx.groupSettlement.findFirst({
        where: { groupId: group.id, status: 'OPEN' },
      });
      if (live && live.totalPaise === params.expectedTotalPaise) return;
    }
    requireStatus(group, 'ACTIVE');
    if (!group.outlet.isActive || group.outlet.status !== 'OPEN') {
      throw new AppError(
        409,
        'OUTLET_NOT_ACCEPTING',
        `${group.outlet.name} isn’t taking orders right now.`,
      );
    }
    const tray = await liveTray(tx, group.id);
    if (tray.lines.length === 0) throw new AppError(409, 'TRAY_EMPTY', 'The tray is empty.');
    const problems = tray.lines.filter((l) => l.problem);
    if (problems.length > 0) {
      throw new AppError(
        409,
        'ITEMS_UNAVAILABLE',
        'Some dishes are no longer available. Remove them to continue.',
        {
          items: problems.map((l) => ({
            menuItemId: l.menuItemId,
            name: l.name,
            problem: l.problem,
          })),
        },
      );
    }
    if (tray.subtotalPaise !== params.expectedTotalPaise) {
      throw new AppError(
        409,
        'PRICE_CHANGED',
        'Prices changed since you last looked. Please review the tray.',
        {
          totalPaise: tray.subtotalPaise,
        },
      );
    }
    const ownByMember = new Map<string, number>();
    for (const l of tray.lines)
      ownByMember.set(l.memberId, (ownByMember.get(l.memberId) ?? 0) + l.lineTotalPaise);
    const split = allocationFor(
      group.allocationMode,
      tray.subtotalPaise,
      tray.members,
      ownByMember,
    );
    if (!split.ok) throw new AppError(400, split.code, split.message, split.details);

    const last = await tx.groupSettlement.findFirst({
      where: { groupId: group.id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const settlement = await tx.groupSettlement.create({
      data: {
        groupId: group.id,
        version: (last?.version ?? 0) + 1,
        mode: group.allocationMode,
        inputs: {
          memberOrder: tray.members.map((m) => m.id),
          percents: Object.fromEntries(tray.members.map((m) => [m.id, m.percentBps])),
          customAmounts: Object.fromEntries(tray.members.map((m) => [m.id, m.customAmountPaise])),
        },
        subtotalPaise: tray.subtotalPaise,
        totalPaise: tray.subtotalPaise,
        createdByUserId: params.userId,
        lines: {
          create: tray.lines.map((l) => ({
            memberId: l.memberId,
            menuItemId: l.menuItemId,
            name: l.name,
            unitPricePaise: l.unitPricePaise,
            quantity: l.quantity,
            lineTotalPaise: l.lineTotalPaise,
          })),
        },
        shares: {
          create: split.amounts.map((a) => ({
            memberId: a.id,
            userId: tray.members.find((m) => m.id === a.id)!.userId,
            amountDuePaise: a.amountPaise,
            ownItemsPaise: ownByMember.get(a.id) ?? 0,
            status: a.amountPaise === 0 ? ('NOTHING_DUE' as const) : ('UNPAID' as const),
          })),
        },
      },
    });
    await tx.groupTray.update({
      where: { id: group.id },
      data: { status: 'CHECKOUT', checkoutAt: new Date(), version: { increment: 1 } },
    });
    await event(tx, group.id, 'CHECKOUT_STARTED', params.userId, {
      settlementVersion: settlement.version,
      mode: group.allocationMode,
      totalPaise: tray.subtotalPaise,
      shares: split.amounts,
    });
  });
}

/**
 * A member pays their own share from their own wallet, to CampusCart. One payment per share
 * (the ledger key is per share), so retries and double-clicks can never charge twice.
 */
export async function payMyShare(db: Database, params: { groupId: string; userId: string }) {
  return db.$transaction(async (tx) => {
    const group = await lockGroup(tx, params.groupId);
    const me = await requireMember(tx, group.id, params.userId);
    // The live checkout: still being paid, or already turned into the order.
    const settlement = await tx.groupSettlement.findFirst({
      where: { groupId: group.id, status: { not: 'VOID' } },
    });
    const share = settlement
      ? await tx.groupShare.findUnique({
          where: { settlementId_memberId: { settlementId: settlement.id, memberId: me.id } },
        })
      : null;
    if (share && share.status !== 'UNPAID') return { paid: false, alreadySettled: true };
    if (group.status !== 'CHECKOUT' || !settlement || settlement.status !== 'OPEN' || !share) {
      throw new AppError(409, 'NOTHING_TO_PAY', 'There’s no payment due for this group right now.');
    }
    const wallet = await ensureWallet(tx, params.userId);
    const balanceAfter = await debitBalance(tx, wallet.id, share.amountDuePaise);
    if (balanceAfter === null) {
      const current = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      throw new AppError(
        409,
        'INSUFFICIENT_BALANCE',
        'Your wallet balance is too low for your share.',
        {
          balancePaise: current.balancePaise,
          amountPaise: share.amountDuePaise,
          shortfallPaise: share.amountDuePaise - current.balancePaise,
        },
      );
    }
    const now = new Date();
    const payment = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'GROUP_SHARE_PAYMENT',
        direction: 'DEBIT',
        amountPaise: share.amountDuePaise,
        balanceAfterPaise: balanceAfter,
        status: 'COMPLETED',
        completedAt: now,
        idempotencyKey: `group-share:${share.id}`,
        description: `Your share of group “${group.name}” at ${group.outlet.name}`,
        isSimulated: true,
      },
    });
    await tx.groupShare.update({
      where: { id: share.id },
      data: {
        status: 'PAID',
        amountPaidPaise: share.amountDuePaise,
        paymentTransactionId: payment.id,
        paidAt: now,
      },
    });
    await tx.groupTray.update({ where: { id: group.id }, data: { version: { increment: 1 } } });
    await event(tx, group.id, 'SHARE_PAID', params.userId, { amountPaise: share.amountDuePaise });
    const unpaid = await tx.groupShare.count({
      where: { settlementId: settlement.id, status: 'UNPAID' },
    });
    return { paid: true, alreadySettled: false, allPaid: unpaid === 0 };
  });
}

/**
 * Places the group's ONE order once every share is paid, through the same steps as a normal
 * checkout: outlet open, capacity, pickup number, stock taken atomically. Uses the prices frozen
 * at checkout (what members paid). If it can't be placed (sold out, outlet closed, full), nothing
 * changes: the host can retry or reopen the tray, which refunds everyone.
 */
export async function placeGroupOrder(
  db: Database,
  params: { groupId: string; actorUserId: string | null; capacityLimit?: number },
) {
  return db.$transaction(async (tx) => {
    const group = await lockGroup(tx, params.groupId);
    if (params.actorUserId) requireHost(await requireMember(tx, group.id, params.actorUserId));
    if (group.status === 'ORDERED') return { orderId: group.orderId!, created: false };
    requireStatus(group, 'CHECKOUT');
    const settlement = await tx.groupSettlement.findFirstOrThrow({
      where: { groupId: group.id, status: 'OPEN' },
      include: { lines: true, shares: true },
    });
    if (settlement.shares.some((s) => s.status === 'UNPAID')) {
      throw new AppError(
        409,
        'SHARES_UNPAID',
        'Everyone has to pay their share before the order is placed.',
      );
    }
    const outlet = group.outlet;
    if (!outlet.isActive || outlet.status !== 'OPEN') {
      throw new AppError(
        409,
        'OUTLET_NOT_ACCEPTING',
        `${outlet.name} isn’t taking orders right now.`,
      );
    }
    // One order line per dish (members' quantities combined), at the frozen prices.
    const byItem = new Map<
      string,
      { menuItemId: string; name: string; unitPricePaise: number; quantity: number }
    >();
    for (const l of settlement.lines) {
      const e = byItem.get(l.menuItemId) ?? {
        menuItemId: l.menuItemId,
        name: l.name,
        unitPricePaise: l.unitPricePaise,
        quantity: 0,
      };
      e.quantity += l.quantity;
      byItem.set(l.menuItemId, e);
    }
    const lines = [...byItem.values()].map((l) => ({
      ...l,
      lineTotalPaise: l.unitPricePaise * l.quantity,
    }));
    const items = await tx.menuItem.findMany({
      where: { id: { in: lines.map((l) => l.menuItemId) }, outletId: outlet.id },
      include: { category: true },
    });
    const gone = lines.filter((l) => {
      const m = items.find((i) => i.id === l.menuItemId);
      return !m || !m.isActive || !m.category.isActive || !inStock(m);
    });
    if (gone.length > 0) {
      throw new AppError(
        409,
        'ITEMS_UNAVAILABLE',
        'Some dishes sold out after checkout. The host can reopen the tray (everyone is refunded).',
        {
          items: gone.map((l) => ({ menuItemId: l.menuItemId, name: l.name })),
        },
      );
    }
    const day = istDay();
    const pickupNumber = await nextPickupNumber(tx, outlet.id, day);
    const order = await tx.order.create({
      data: {
        userId: group.hostUserId,
        outletId: outlet.id,
        pickupDay: new Date(`${day}T00:00:00Z`),
        pickupNumber,
        pickupCode: formatPickupCode(outlet.name, pickupNumber),
        status: 'PLACED',
        paymentMethod: 'GROUP',
        paymentStatus: 'PAID',
        subtotalPaise: settlement.totalPaise,
        totalPaise: settlement.totalPaise,
        idempotencyKey: `group:${group.id}:${settlement.version}`,
        items: { create: lines },
        history: {
          create: {
            toStatus: 'PLACED',
            actorUserId: group.hostUserId,
            actorRole: 'STUDENT',
            reason: `Group order “${group.name}”`,
          },
        },
      },
    });
    await claimOrderCapacity(tx, {
      outletId: outlet.id,
      orderId: order.id,
      limit: params.capacityLimit ?? ORDER_CAPACITY_PER_WINDOW,
    });
    await notify(
      tx,
      placedNotice({
        id: order.id,
        userId: group.hostUserId,
        pickupCode: order.pickupCode,
        outletName: outlet.name,
      }),
    );
    await deductForOrder(tx, {
      orderId: order.id,
      lines,
      items,
      actor: { userId: group.hostUserId, role: 'STUDENT' },
    });
    await tx.groupSettlement.update({ where: { id: settlement.id }, data: { status: 'ORDERED' } });
    await tx.groupTray.update({
      where: { id: group.id },
      data: {
        status: 'ORDERED',
        orderId: order.id,
        orderedAt: new Date(),
        version: { increment: 1 },
      },
    });
    await event(tx, group.id, 'ORDER_PLACED', params.actorUserId, {
      orderId: order.id,
      pickupCode: order.pickupCode,
    });
    return { orderId: order.id, created: true };
  });
}

/** Refunds every paid share of a settlement (each payment reversed once, cap ignored like refunds). */
async function refundShares(tx: Tx, settlementId: string, label: string) {
  const shares = await tx.groupShare.findMany({
    where: { settlementId, status: 'PAID' },
    include: { paymentTransaction: true },
  });
  const now = new Date();
  for (const s of shares) {
    const payment = s.paymentTransaction!;
    const balanceAfter = await refundToBalance(tx, payment.walletId, s.amountPaidPaise);
    const refund = await tx.walletTransaction.create({
      data: {
        walletId: payment.walletId,
        type: 'REFUND',
        direction: 'CREDIT',
        amountPaise: s.amountPaidPaise,
        balanceAfterPaise: balanceAfter,
        status: 'COMPLETED',
        completedAt: now,
        reversesTransactionId: payment.id,
        idempotencyKey: `group-share-refund:${s.id}`,
        description: `Refund of your group share (${label})`,
        isSimulated: payment.isSimulated,
      },
    });
    await tx.groupShare.update({
      where: { id: s.id },
      data: { status: 'REFUNDED', refundTransactionId: refund.id, refundedAt: now },
    });
  }
  return shares.map((s) => s.userId);
}

/** Host: unlock the tray to change it. Every paid share is refunded; the checkout is kept as history. */
export async function reopenGroup(db: Database, params: { groupId: string; userId: string }) {
  return db.$transaction(async (tx) => {
    const group = await lockGroup(tx, params.groupId);
    requireHost(await requireMember(tx, group.id, params.userId));
    requireStatus(group, 'CHECKOUT');
    const settlement = await tx.groupSettlement.findFirstOrThrow({
      where: { groupId: group.id, status: 'OPEN' },
    });
    const refunded = await refundShares(tx, settlement.id, `“${group.name}” was reopened`);
    await tx.groupSettlement.update({
      where: { id: settlement.id },
      data: { status: 'VOID', voidReason: 'Reopened by the host', voidedAt: new Date() },
    });
    await tx.groupTray.update({
      where: { id: group.id },
      data: { status: 'ACTIVE', checkoutAt: null, version: { increment: 1 } },
    });
    await event(tx, group.id, 'REOPENED', params.userId, { refundedMembers: refunded.length });
    return refunded;
  });
}

export async function cancelGroup(
  db: Database,
  params: { groupId: string; userId: string; reason?: string },
) {
  return db.$transaction(async (tx) => {
    const group = await lockGroup(tx, params.groupId);
    requireHost(await requireMember(tx, group.id, params.userId));
    requireStatus(group, 'ACTIVE', 'CHECKOUT');
    let refunded: string[] = [];
    const settlement = await tx.groupSettlement.findFirst({
      where: { groupId: group.id, status: 'OPEN' },
    });
    if (settlement) {
      refunded = await refundShares(tx, settlement.id, `“${group.name}” was cancelled`);
      await tx.groupSettlement.update({
        where: { id: settlement.id },
        data: { status: 'VOID', voidReason: 'Group cancelled', voidedAt: new Date() },
      });
    }
    await tx.groupTray.update({
      where: { id: group.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: params.reason ?? null,
        version: { increment: 1 },
      },
    });
    await event(tx, group.id, 'CANCELLED', params.userId, {
      reason: params.reason ?? null,
      refundedMembers: refunded.length,
    });
    return refunded;
  });
}

/**
 * Called from the order lifecycle when a group order is rejected or cancelled: each member gets
 * their own share back (instead of the single refund a normal order gets). Returns who was paid.
 */
export async function refundGroupOrder(tx: Tx, orderId: string, label: string) {
  const group = await tx.groupTray.findUnique({ where: { orderId } });
  if (!group) return [];
  const settlement = await tx.groupSettlement.findFirst({
    where: { groupId: group.id, status: 'ORDERED' },
  });
  if (!settlement) return [];
  const refunded = await refundShares(tx, settlement.id, label);
  await tx.groupTray.update({ where: { id: group.id }, data: { version: { increment: 1 } } });
  await event(tx, group.id, 'ORDER_REFUNDED', null, {
    orderId,
    label,
    refundedMembers: refunded.length,
  });
  return refunded;
}

/** User IDs of the group's active members (for live updates). */
export async function memberUserIds(db: DbClient, groupId: string) {
  const members = await db.groupMember.findMany({
    where: { groupId, status: 'ACTIVE' },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}
