import type { Database, DbClient } from '../../lib/prisma.js';
import type { StockAdjustmentType } from '../../generated/prisma/enums.js';
import { asDate, dayOf, dayRange, istDayStart, todayIst, weekdayOf } from './dates.js';

/*
 * Demand history. Each (outlet, item, IST collection day) row is RECOMPUTED from the source of
 * truth — order lines and the stock ledger — and upserted. Nothing is incremented, so an order
 * moving through its lifecycle, a retried job or two workers running at once can never count
 * anything twice: the last computation simply wins with the same numbers.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

interface OrderLineAgg {
  outletId: string;
  menuItemId: string;
  day: Date;
  bucket: 'CANCELLED' | 'REJECTED' | 'FULFILLED' | 'NO_SHOW' | 'OPEN';
  timing: 'IMMEDIATE' | 'SCHEDULED';
  units: number;
  valuePaise: number;
}

interface LedgerAgg {
  menuItemId: string;
  day: Date;
  type: StockAdjustmentType;
  units: number;
}

interface LedgerEvent {
  menuItemId: string;
  type: StockAdjustmentType;
  previousQuantity: number | null;
  resultingQuantity: number | null;
  createdAt: Date;
}

/** Units on orders for each item and collection day, split by what happened to the order. */
async function orderLines(db: DbClient, outletId: string | null, from: string, to: string) {
  return db.$queryRaw<OrderLineAgg[]>`
    WITH cancelled_by AS (
      SELECT DISTINCT ON (h."orderId") h."orderId", h."actorRole"
      FROM "OrderStatusHistory" h
      WHERE h."toStatus" = 'CANCELLED'
      ORDER BY h."orderId", h."createdAt" DESC
    )
    SELECT o."outletId", oi."menuItemId", o."pickupDay" AS day,
      CASE
        WHEN o.status = 'CANCELLED' AND c."actorRole" = 'STUDENT' THEN 'CANCELLED'
        WHEN o.status IN ('CANCELLED', 'REJECTED') THEN 'REJECTED'
        WHEN o.status = 'COMPLETED' THEN 'FULFILLED'
        WHEN o.status = 'NO_SHOW' THEN 'NO_SHOW'
        ELSE 'OPEN'
      END AS bucket,
      o.timing::text AS timing,
      SUM(oi.quantity)::int AS units,
      SUM(oi."lineTotalPaise")::int AS "valuePaise"
    FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    LEFT JOIN cancelled_by c ON c."orderId" = o.id
    WHERE o."pickupDay" BETWEEN ${from}::date AND ${to}::date
      AND (${outletId}::uuid IS NULL OR o."outletId" = ${outletId}::uuid)
    GROUP BY 1, 2, 3, 4, 5`;
}

/** Stock ledger movements per item and IST day. */
async function ledgerByDay(db: DbClient, outletId: string | null, from: string, to: string) {
  return db.$queryRaw<LedgerAgg[]>`
    SELECT a."menuItemId",
      (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date AS day,
      a.type, SUM(ABS(a."quantityChange"))::int AS units
    FROM "StockAdjustment" a
    WHERE a.type IN ('ORDER_DEDUCTION', 'ORDER_RESTORE', 'RESTOCK', 'REMOVAL')
      AND (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date
          BETWEEN ${from}::date AND ${to}::date
      AND (${outletId}::uuid IS NULL OR a."outletId" = ${outletId}::uuid)
    GROUP BY 1, 2, 3`;
}

interface StockState {
  tracked: boolean;
  quantity: number | null;
  soldOut: boolean;
}

const unavailable = (s: StockState) => s.soldOut || (s.tracked && (s.quantity ?? 0) <= 0);

function apply(state: StockState, e: LedgerEvent): StockState {
  switch (e.type) {
    case 'TRACKING_ENABLED':
      return { ...state, tracked: true, quantity: e.resultingQuantity ?? state.quantity };
    case 'TRACKING_DISABLED':
      return { ...state, tracked: false, quantity: null };
    case 'MARKED_SOLD_OUT':
      return { ...state, soldOut: true };
    case 'MARKED_AVAILABLE':
      return { ...state, soldOut: false };
    case 'THRESHOLD_CHANGED':
      return state;
    default:
      return e.resultingQuantity === null ? state : { ...state, quantity: e.resultingQuantity };
  }
}

/**
 * The item's stock state before its first ledger entry, inferred from that history (the first
 * tracking/availability event says what came before it); with no history, the item's current
 * state is the only evidence.
 */
function initialState(
  events: LedgerEvent[],
  item: { trackInventory: boolean; stockQuantity: number | null; isAvailable: boolean },
): StockState {
  const firstTracking = events.find(
    (e) => e.type === 'TRACKING_ENABLED' || e.type === 'TRACKING_DISABLED',
  );
  const firstQuantity = events.find((e) => e.previousQuantity !== null);
  const firstAvailability = events.find(
    (e) => e.type === 'MARKED_SOLD_OUT' || e.type === 'MARKED_AVAILABLE',
  );
  const tracked = firstTracking
    ? firstTracking.type === 'TRACKING_DISABLED'
    : firstQuantity
      ? true
      : item.trackInventory;
  return {
    tracked,
    quantity: tracked ? (firstQuantity?.previousQuantity ?? item.stockQuantity ?? 0) : null,
    soldOut: firstAvailability ? firstAvailability.type === 'MARKED_AVAILABLE' : !item.isAvailable,
  };
}

interface DayStock {
  openingStock: number | null;
  closingStock: number | null;
  stockoutMinutes: number;
}

/** Replays one item's ledger to get, per IST day, opening/closing stock and stockout minutes. */
export function stockByDay(
  events: LedgerEvent[],
  item: { trackInventory: boolean; stockQuantity: number | null; isAvailable: boolean },
  days: string[],
  now: Date,
): Map<string, DayStock> {
  const result = new Map<string, DayStock>();
  let state = initialState(events, item);
  let i = 0;
  for (const day of days) {
    const start = istDayStart(day).getTime();
    const end = Math.min(start + DAY_MS, now.getTime());
    while (i < events.length && events[i]!.createdAt.getTime() < start) {
      state = apply(state, events[i]!);
      i += 1;
    }
    const opening = state.tracked ? state.quantity : null;
    let cursor = start;
    let downMs = 0;
    while (i < events.length && events[i]!.createdAt.getTime() < end) {
      const at = events[i]!.createdAt.getTime();
      if (unavailable(state)) downMs += at - cursor;
      cursor = at;
      state = apply(state, events[i]!);
      i += 1;
    }
    if (end > cursor && unavailable(state)) downMs += end - cursor;
    result.set(day, {
      openingStock: opening,
      closingStock: state.tracked ? state.quantity : null,
      // Any unavailability at all counts (rounded up), so a brief stockout still flags the day.
      stockoutMinutes: Math.min(1440, Math.ceil(downMs / MINUTE_MS)),
    });
  }
  return result;
}

export interface AggregateResult {
  from: string;
  to: string;
  rows: number;
}

/**
 * Recomputes demand rows for every item of the outlet(s) for IST days `from`…`to` (capped at
 * today; today's row is provisional and is never used for forecasting, which only reads days
 * before the as-of date).
 */
export async function aggregateDemand(
  db: Database,
  params: { from: string; to: string; outletId?: string; now?: Date },
): Promise<AggregateResult> {
  const now = params.now ?? new Date();
  const to = params.to > todayIst(now) ? todayIst(now) : params.to;
  const from = params.from;
  if (from > to) return { from, to, rows: 0 };
  const outletId = params.outletId ?? null;

  const items = await db.menuItem.findMany({
    where: outletId ? { outletId } : {},
    select: {
      id: true,
      outletId: true,
      categoryId: true,
      fulfillmentType: true,
      trackInventory: true,
      stockQuantity: true,
      isAvailable: true,
      createdAt: true,
    },
  });
  if (items.length === 0) return { from, to, rows: 0 };

  const [lines, ledger, events] = await Promise.all([
    orderLines(db, outletId, from, to),
    ledgerByDay(db, outletId, from, to),
    db.stockAdjustment.findMany({
      where: {
        ...(outletId ? { outletId } : {}),
        createdAt: { lt: new Date(istDayStart(to).getTime() + DAY_MS) },
      },
      select: {
        menuItemId: true,
        type: true,
        previousQuantity: true,
        resultingQuantity: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  ]);

  const key = (itemId: string, day: string) => `${itemId}|${day}`;
  const orderAgg = new Map<string, OrderLineAgg[]>();
  const activeOutletDays = new Set<string>();
  for (const line of lines) {
    const k = key(line.menuItemId, dayOf(line.day));
    orderAgg.set(k, [...(orderAgg.get(k) ?? []), line]);
    activeOutletDays.add(`${line.outletId}|${dayOf(line.day)}`);
  }
  const ledgerAgg = new Map<string, Partial<Record<StockAdjustmentType, number>>>();
  for (const l of ledger) {
    const k = key(l.menuItemId, dayOf(l.day));
    ledgerAgg.set(k, { ...(ledgerAgg.get(k) ?? {}), [l.type]: l.units });
  }
  const eventsByItem = new Map<string, LedgerEvent[]>();
  for (const e of events)
    eventsByItem.set(e.menuItemId, [...(eventsByItem.get(e.menuItemId) ?? []), e]);

  const computedAt = now;
  const rows = [];
  for (const item of items) {
    // No rows before the item existed: those days say nothing about its demand.
    const firstDay = todayIst(item.createdAt) > from ? todayIst(item.createdAt) : from;
    if (firstDay > to) continue;
    const days = dayRange(firstDay, to);
    const stock = stockByDay(eventsByItem.get(item.id) ?? [], item, days, now);
    for (const day of days) {
      const ls = orderAgg.get(key(item.id, day)) ?? [];
      const sum = (pick: (l: OrderLineAgg) => boolean) =>
        ls.filter(pick).reduce((n, l) => n + l.units, 0);
      const moves = ledgerAgg.get(key(item.id, day)) ?? {};
      const s = stock.get(day)!;
      rows.push({
        outletId: item.outletId,
        menuItemId: item.id,
        businessDate: asDate(day),
        weekday: weekdayOf(day),
        unitsOrdered: sum(() => true),
        unitsCancelled: sum((l) => l.bucket === 'CANCELLED'),
        unitsRejected: sum((l) => l.bucket === 'REJECTED'),
        unitsFulfilled: sum((l) => l.bucket === 'FULFILLED'),
        unitsNoShow: sum((l) => l.bucket === 'NO_SHOW'),
        unitsOpen: sum((l) => l.bucket === 'OPEN'),
        unitsScheduled: sum((l) => l.timing === 'SCHEDULED'),
        unitsImmediate: sum((l) => l.timing === 'IMMEDIATE'),
        demandValuePaise: ls
          .filter((l) => l.bucket !== 'CANCELLED')
          .reduce((n, l) => n + l.valuePaise, 0),
        unitsDeducted: moves.ORDER_DEDUCTION ?? 0,
        unitsRestored: moves.ORDER_RESTORE ?? 0,
        unitsReplenished: moves.RESTOCK ?? 0,
        unitsWasted: moves.REMOVAL ?? 0,
        openingStock: s.openingStock === null ? null : Math.max(0, s.openingStock),
        closingStock: s.closingStock === null ? null : Math.max(0, s.closingStock),
        stockoutMinutes: s.stockoutMinutes,
        censored: s.stockoutMinutes > 0,
        outletActive: activeOutletDays.has(`${item.outletId}|${day}`),
        categoryId: item.categoryId,
        fulfillmentType: item.fulfillmentType,
        computedAt,
      });
    }
  }

  // Upsert in batches; each row is the complete recomputation for its key.
  for (let i = 0; i < rows.length; i += 200) {
    await db.$transaction(
      rows.slice(i, i + 200).map((row) =>
        db.demandDaily.upsert({
          where: {
            outletId_menuItemId_businessDate: {
              outletId: row.outletId,
              menuItemId: row.menuItemId,
              businessDate: row.businessDate,
            },
          },
          create: row,
          update: row,
        }),
      ),
    );
  }
  return { from, to, rows: rows.length };
}

/** The earliest IST day with any order or stock movement (where a full backfill starts). */
export async function earliestActivityDay(db: Database): Promise<string | null> {
  const [order, adjustment] = await Promise.all([
    db.order.findFirst({ orderBy: { pickupDay: 'asc' }, select: { pickupDay: true } }),
    db.stockAdjustment.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);
  const days = [
    order ? dayOf(order.pickupDay) : null,
    adjustment ? todayIst(adjustment.createdAt) : null,
  ].filter((d): d is string => d !== null);
  return days.length ? days.sort()[0]! : null;
}

/** Demand as the forecaster sees it: ordered minus what the student withdrew. */
export const demandOf = (row: { unitsOrdered: number; unitsCancelled: number }) =>
  row.unitsOrdered - row.unitsCancelled;
