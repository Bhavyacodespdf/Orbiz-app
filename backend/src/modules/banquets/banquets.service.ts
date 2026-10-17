import { randomBytes } from 'node:crypto';
import type { Database, DbClient } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import type { BanquetEventType, BanquetStatus, Role } from '../../generated/prisma/enums.js';
import { istDayOf, istMidnight, weekdayOf } from '../scheduling/slots.js';

/*
 * Banquet bookings: a student asks an outlet to cater an event. The request is checked against
 * the outlet's banquet settings (enabled, guests, notice, events at once) and pickup hours, then a
 * manager confirms or rejects it. Prices are a frozen ESTIMATE — nothing is charged here.
 *
 *   PENDING_CONFIRMATION ─► CONFIRMED ─► COMPLETED
 *            │                  │
 *            ├─► REJECTED       └─► CANCELLED (host, before it starts)
 *            └─► CANCELLED
 */

export const MAX_DAYS_AHEAD = 90;
export const MAX_MENU_LINES = 30;
const DAY_MS = 86_400_000;
const ACTIVE: BanquetStatus[] = ['PENDING_CONFIRMATION', 'CONFIRMED'];

type Tx = DbClient;

export interface BookingRequest {
  outletId: string;
  name: string;
  eventType: BanquetEventType;
  startsAt: Date;
  durationMinutes: number;
  guestCount: number;
  dietaryNotes?: string;
  instructions?: string;
  contactPhone?: string | null;
  items: { menuItemId: string; quantity: number }[];
}

/** Venues taking banquet requests, with their rules and hours (for the planning form). */
export async function listVenues(db: Database) {
  const settings = await db.banquetSettings.findMany({
    where: { enabled: true, outlet: { isActive: true } },
    include: { outlet: { include: { hours: { orderBy: { weekday: 'asc' } } } } },
    orderBy: { outlet: { name: 'asc' } },
  });
  return settings.map((s) => ({
    outletId: s.outletId,
    name: s.outlet.name,
    slug: s.outlet.slug,
    location: s.outlet.location,
    maxGuests: s.maxGuests,
    minNoticeDays: s.minNoticeDays,
    hours: s.outlet.hours.map((h) => ({
      weekday: h.weekday,
      opensMinute: h.opensMinute,
      closesMinute: h.closesMinute,
    })),
  }));
}

/** Prices the menu package from the live menu (outlet's own, visible dishes only). */
async function priceItems(tx: Tx, outletId: string, items: BookingRequest['items']) {
  if (items.length === 0) throw new AppError(400, 'NO_MENU', 'Choose at least one dish.');
  if (new Set(items.map((i) => i.menuItemId)).size !== items.length) {
    throw new AppError(400, 'DUPLICATE_ITEMS', 'Each dish can only appear once.');
  }
  const menu = await tx.menuItem.findMany({
    where: { id: { in: items.map((i) => i.menuItemId) }, outletId },
    include: { category: true },
  });
  const lines = items.map((i) => {
    const m = menu.find((x) => x.id === i.menuItemId);
    if (!m || !m.isActive || !m.category.isActive) {
      throw new AppError(
        409,
        'ITEM_UNAVAILABLE',
        'A chosen dish isn’t on this outlet’s menu any more.',
        {
          menuItemId: i.menuItemId,
        },
      );
    }
    return {
      menuItemId: m.id,
      name: m.name,
      unitPricePaise: m.pricePaise,
      quantity: i.quantity,
      lineTotalPaise: m.pricePaise * i.quantity,
    };
  });
  const totalPaise = lines.reduce((a, l) => a + l.lineTotalPaise, 0);
  return { lines, totalPaise };
}

export async function quote(
  db: Database,
  outletId: string,
  guestCount: number,
  items: BookingRequest['items'],
) {
  const { lines, totalPaise } = await priceItems(db, outletId, items);
  return { lines, totalPaise, perGuestPaise: Math.round(totalPaise / guestCount) };
}

const overlapping = (
  tx: Tx,
  outletId: string,
  startsAt: Date,
  endsAt: Date,
  statuses: BanquetStatus[],
  excludeId?: string,
) =>
  tx.banquetBooking.count({
    where: {
      outletId,
      status: { in: statuses },
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
  });

const lockOutletBanquets = (tx: Tx, outletId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`banquet:${outletId}`}))`;

/** Checks a request against the outlet's rules. Throws a 400/409 with the reason. */
async function validateRequest(tx: Tx, req: BookingRequest, now: Date) {
  const settings = await tx.banquetSettings.findUnique({
    where: { outletId: req.outletId },
    include: { outlet: { include: { hours: true } } },
  });
  if (!settings || !settings.enabled || !settings.outlet.isActive) {
    throw new AppError(409, 'BANQUETS_UNAVAILABLE', 'This outlet isn’t taking banquet bookings.');
  }
  if (req.guestCount > settings.maxGuests) {
    throw new AppError(
      409,
      'TOO_MANY_GUESTS',
      `${settings.outlet.name} can cater for at most ${settings.maxGuests} guests.`,
      {
        maxGuests: settings.maxGuests,
      },
    );
  }
  const earliest = now.getTime() + settings.minNoticeDays * DAY_MS;
  if (req.startsAt.getTime() < earliest) {
    throw new AppError(
      409,
      'TOO_SOON',
      `Book at least ${settings.minNoticeDays} day${settings.minNoticeDays === 1 ? '' : 's'} ahead.`,
      {
        minNoticeDays: settings.minNoticeDays,
      },
    );
  }
  if (req.startsAt.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY_MS) {
    throw new AppError(409, 'TOO_FAR', `Book at most ${MAX_DAYS_AHEAD} days ahead.`);
  }
  // Within the outlet's pickup hours on that IST day, start to finish.
  const day = istDayOf(req.startsAt.getTime());
  const startMinute = Math.round((req.startsAt.getTime() - istMidnight(day)) / 60_000);
  const endMinute = startMinute + req.durationMinutes;
  const hours = settings.outlet.hours.find((h) => h.weekday === weekdayOf(day));
  if (!hours || startMinute < hours.opensMinute || endMinute > hours.closesMinute) {
    throw new AppError(
      409,
      'OUTSIDE_HOURS',
      'The event must start and finish within the outlet’s hours that day.',
      {
        hours: hours ? { opensMinute: hours.opensMinute, closesMinute: hours.closesMinute } : null,
      },
    );
  }
  const endsAt = new Date(req.startsAt.getTime() + req.durationMinutes * 60_000);
  const clashes = await overlapping(tx, req.outletId, req.startsAt, endsAt, ACTIVE);
  if (clashes >= settings.maxConcurrentEvents) {
    throw new AppError(
      409,
      'SLOT_UNAVAILABLE',
      'Another event is already booked at that time. Try a different time.',
    );
  }
  return { settings, endsAt };
}

export async function createBooking(
  db: Database,
  params: BookingRequest & { hostUserId: string; expectedTotalPaise: number; now?: Date },
) {
  const now = params.now ?? new Date();
  return db.$transaction(async (tx) => {
    await lockOutletBanquets(tx, params.outletId);
    const { endsAt } = await validateRequest(tx, params, now);
    const { lines, totalPaise } = await priceItems(tx, params.outletId, params.items);
    if (totalPaise !== params.expectedTotalPaise) {
      throw new AppError(
        409,
        'PRICE_CHANGED',
        'Prices changed since you looked. Please review the estimate.',
        { totalPaise },
      );
    }
    const booking = await tx.banquetBooking.create({
      data: {
        outletId: params.outletId,
        hostUserId: params.hostUserId,
        name: params.name,
        eventType: params.eventType,
        startsAt: params.startsAt,
        endsAt,
        guestCount: params.guestCount,
        dietaryNotes: params.dietaryNotes ?? '',
        instructions: params.instructions ?? '',
        contactPhone: params.contactPhone ?? null,
        estimatedTotalPaise: totalPaise,
        perGuestPaise: Math.round(totalPaise / params.guestCount),
        passToken: randomBytes(24).toString('base64url'),
        items: { create: lines.map((l) => ({ ...l, outletId: params.outletId })) },
        history: {
          create: {
            toStatus: 'PENDING_CONFIRMATION',
            actorUserId: params.hostUserId,
            actorRole: 'STUDENT',
          },
        },
      },
    });
    return booking.id;
  });
}

const bookingInclude = {
  outlet: { select: { id: true, name: true, location: true } },
  host: { select: { displayName: true } },
  items: true,
  history: {
    orderBy: { createdAt: 'asc' as const },
    include: { actor: { select: { displayName: true } } },
  },
};

type BookingRow = NonNullable<Awaited<ReturnType<typeof loadBooking>>>;
const loadBooking = (db: DbClient, where: { id: string } | { passToken: string }) =>
  db.banquetBooking.findUnique({ where, include: bookingInclude });

/** Public shape; the pass token is only ever included for the host. */
export function toBooking(
  b: BookingRow,
  opts: { includeToken?: boolean; includeContact?: boolean } = {},
) {
  return {
    id: b.id,
    name: b.name,
    eventType: b.eventType,
    status: b.status,
    outlet: b.outlet,
    host: b.host.displayName,
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    guestCount: b.guestCount,
    dietaryNotes: b.dietaryNotes,
    instructions: b.instructions,
    contactPhone: opts.includeContact ? b.contactPhone : null,
    estimatedTotalPaise: b.estimatedTotalPaise,
    perGuestPaise: b.perGuestPaise,
    items: b.items.map((i) => ({
      menuItemId: i.menuItemId,
      name: i.name,
      unitPricePaise: i.unitPricePaise,
      quantity: i.quantity,
      lineTotalPaise: i.lineTotalPaise,
    })),
    decisionReason: b.decisionReason,
    decidedAt: b.decidedAt?.toISOString() ?? null,
    history: b.history.map((h) => ({
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      actor: h.actor.displayName,
      actorRole: h.actorRole,
      reason: h.reason,
      at: h.createdAt.toISOString(),
    })),
    createdAt: b.createdAt.toISOString(),
    ...(opts.includeToken ? { passToken: b.passToken } : {}),
  };
}

export async function listMyBookings(db: Database, userId: string) {
  const rows = await db.banquetBooking.findMany({
    where: { hostUserId: userId },
    include: bookingInclude,
    orderBy: { startsAt: 'desc' },
    take: 50,
  });
  return rows.map((b) => toBooking(b, { includeContact: true }));
}

/** The host's own booking; anyone else gets 404. */
export async function getMyBooking(
  db: Database,
  bookingId: string,
  userId: string,
  includeToken = false,
) {
  const b = await loadBooking(db, { id: bookingId });
  if (!b || b.hostUserId !== userId) throw notFound('Booking not found');
  return toBooking(b, { includeToken, includeContact: true });
}

async function transition(
  db: Database,
  params: {
    bookingId: string;
    from: BanquetStatus[];
    to: BanquetStatus;
    actor: { userId: string; role: Role };
    reason?: string;
    scope: { hostUserId: string } | { outletId: string };
    check?: (
      tx: Tx,
      booking: { id: string; outletId: string; startsAt: Date; endsAt: Date },
    ) => Promise<void>;
  },
) {
  return db.$transaction(async (tx) => {
    const booking = await tx.banquetBooking.findFirst({
      where: { id: params.bookingId, ...params.scope },
    });
    if (!booking) throw notFound('Booking not found');
    await lockOutletBanquets(tx, booking.outletId);
    if (!params.from.includes(booking.status)) {
      throw new AppError(
        409,
        'INVALID_BOOKING_TRANSITION',
        `A ${booking.status.toLowerCase().replace('_', ' ')} booking can’t be ${params.to.toLowerCase()}.`,
        {
          status: booking.status,
        },
      );
    }
    await params.check?.(tx, booking);
    const { count } = await tx.banquetBooking.updateMany({
      where: { id: booking.id, version: booking.version, status: booking.status },
      data: {
        status: params.to,
        version: { increment: 1 },
        ...(params.to === 'CONFIRMED' || params.to === 'REJECTED'
          ? {
              decidedByUserId: params.actor.userId,
              decidedAt: new Date(),
              decisionReason: params.reason ?? null,
            }
          : {}),
        ...(params.to === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
        ...(params.to === 'COMPLETED' ? { completedAt: new Date() } : {}),
      },
    });
    if (count === 0)
      throw new AppError(
        409,
        'BOOKING_CHANGED',
        'This booking just changed. Reload and try again.',
      );
    await tx.banquetStatusHistory.create({
      data: {
        bookingId: booking.id,
        fromStatus: booking.status,
        toStatus: params.to,
        actorUserId: params.actor.userId,
        actorRole: params.actor.role,
        reason: params.reason ?? null,
      },
    });
    if (params.actor.role !== 'STUDENT') {
      await recordAudit(tx, {
        actor: { type: 'USER', userId: params.actor.userId },
        action: `BANQUET_${params.to}`,
        entityType: 'BanquetBooking',
        entityId: booking.id,
        metadata: { from: booking.status, reason: params.reason ?? null },
      });
    }
    return { outletId: booking.outletId, hostUserId: booking.hostUserId };
  });
}

export const cancelBooking = (db: Database, bookingId: string, userId: string, reason?: string) =>
  transition(db, {
    bookingId,
    from: ['PENDING_CONFIRMATION', 'CONFIRMED'],
    to: 'CANCELLED',
    actor: { userId, role: 'STUDENT' },
    reason,
    scope: { hostUserId: userId },
    check: async (_tx, b) => {
      if (b.startsAt.getTime() <= Date.now())
        throw new AppError(409, 'EVENT_STARTED', 'The event has already started.');
    },
  });

/** Manager decisions. Confirming re-checks clashes against already-confirmed events. */
export function decideBooking(
  db: Database,
  params: {
    outletId: string;
    bookingId: string;
    managerUserId: string;
    decision: 'confirm' | 'reject' | 'complete';
    reason?: string;
  },
) {
  const actor = { userId: params.managerUserId, role: 'MANAGER' as const };
  const scope = { outletId: params.outletId };
  if (params.decision === 'reject') {
    if (!params.reason || params.reason.trim().length < 3) {
      throw new AppError(400, 'REASON_REQUIRED', 'Tell the host why the booking can’t go ahead.');
    }
    return transition(db, {
      bookingId: params.bookingId,
      from: ['PENDING_CONFIRMATION'],
      to: 'REJECTED',
      actor,
      reason: params.reason,
      scope,
    });
  }
  if (params.decision === 'complete') {
    return transition(db, {
      bookingId: params.bookingId,
      from: ['CONFIRMED'],
      to: 'COMPLETED',
      actor,
      scope,
      check: async (_tx, b) => {
        if (b.startsAt.getTime() > Date.now())
          throw new AppError(409, 'EVENT_NOT_STARTED', 'The event hasn’t started yet.');
      },
    });
  }
  return transition(db, {
    bookingId: params.bookingId,
    from: ['PENDING_CONFIRMATION'],
    to: 'CONFIRMED',
    actor,
    reason: params.reason,
    scope,
    check: async (tx, b) => {
      if (b.startsAt.getTime() <= Date.now())
        throw new AppError(409, 'EVENT_STARTED', 'This event’s time has passed.');
      const settings = await tx.banquetSettings.findUnique({ where: { outletId: b.outletId } });
      const confirmed = await overlapping(
        tx,
        b.outletId,
        b.startsAt,
        b.endsAt,
        ['CONFIRMED'],
        b.id,
      );
      if (confirmed >= (settings?.maxConcurrentEvents ?? 1)) {
        throw new AppError(
          409,
          'SLOT_UNAVAILABLE',
          'Another confirmed event already fills that time.',
        );
      }
    },
  });
}

export async function listOutletBookings(db: Database, outletId: string, status?: BanquetStatus) {
  const rows = await db.banquetBooking.findMany({
    where: { outletId, ...(status ? { status } : {}) },
    include: bookingInclude,
    orderBy: { startsAt: 'asc' },
    take: 100,
  });
  return rows.map((b) => toBooking(b, { includeContact: true }));
}

/**
 * Staff check a pass: the token must belong to THIS outlet. Valid only while CONFIRMED. The
 * token is never echoed back.
 */
export async function verifyPass(db: Database, outletId: string, token: string) {
  const b = await loadBooking(db, { passToken: token });
  if (!b || b.outletId !== outletId) throw notFound('No booking matches that pass at this outlet.');
  return { valid: b.status === 'CONFIRMED', booking: toBooking(b, { includeContact: true }) };
}

export async function getSettings(db: Database, outletId: string) {
  const s = await db.banquetSettings.findUnique({ where: { outletId } });
  return s ?? { outletId, enabled: false, maxGuests: 40, minNoticeDays: 2, maxConcurrentEvents: 1 };
}

export async function saveSettings(
  db: Database,
  params: {
    outletId: string;
    userId: string;
    enabled: boolean;
    maxGuests: number;
    minNoticeDays: number;
    maxConcurrentEvents: number;
  },
) {
  const { outletId, userId, ...values } = params;
  return db.$transaction(async (tx) => {
    const saved = await tx.banquetSettings.upsert({
      where: { outletId },
      create: { outletId, updatedByUserId: userId, ...values },
      update: { updatedByUserId: userId, ...values },
    });
    await recordAudit(tx, {
      actor: { type: 'USER', userId },
      action: 'BANQUET_SETTINGS_CHANGED',
      entityType: 'Outlet',
      entityId: outletId,
      metadata: values,
    });
    return saved;
  });
}
