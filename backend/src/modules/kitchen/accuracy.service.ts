import type { Database } from '../../lib/prisma.js';
import type { PredictionKind } from '../../generated/prisma/enums.js';
import { DELAY_MINUTES, median } from './kitchen.rules.js';

/*
 * How good are the estimates? Only predictions that have an actual READY time count; missing
 * outcomes are never treated as zero error. Absolute error = |predicted ready − actual ready|.
 */

const DAY_MS = 86_400_000;
/** Below this many evaluated predictions the dashboard says there isn't enough data. */
export const MIN_EVALUATED = 5;
/** "Within tolerance" = within this many minutes. */
export const TOLERANCE_MINUTES = 3;

const istDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);

function summarize(errorsMinutes: number[]) {
  if (errorsMinutes.length === 0) {
    return {
      evaluated: 0,
      meanAbsErrorMinutes: null,
      medianAbsErrorMinutes: null,
      withinTolerancePct: null,
    };
  }
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    evaluated: errorsMinutes.length,
    meanAbsErrorMinutes: round(errorsMinutes.reduce((s, e) => s + e, 0) / errorsMinutes.length),
    medianAbsErrorMinutes: round(median(errorsMinutes)!),
    withinTolerancePct: Math.round(
      (errorsMinutes.filter((e) => e <= TOLERANCE_MINUTES).length / errorsMinutes.length) * 100,
    ),
  };
}

export async function estimateAccuracy(
  db: Database,
  outletId: string,
  days: number,
  now = new Date(),
) {
  const since = new Date(now.getTime() - days * DAY_MS);
  const [predictions, decisions, placed] = await Promise.all([
    db.orderPrediction.findMany({
      where: { outletId, predictedAt: { gte: since }, actualReadyAt: { not: null } },
      select: {
        kind: true,
        predictedAt: true,
        predictedReadyAt: true,
        actualReadyAt: true,
        absErrorSeconds: true,
      },
    }),
    db.autoAcceptDecision.groupBy({
      by: ['outcome'],
      where: { outletId, decidedAt: { gte: since } },
      _count: { _all: true },
    }),
    db.order.findMany({
      where: { outletId, placedAt: { gte: since } },
      select: { placedAt: true },
    }),
  ]);

  const byKind = (kind: PredictionKind) =>
    summarize(predictions.filter((p) => p.kind === kind).map((p) => p.absErrorSeconds! / 60));
  const atAccept = byKind('AT_ACCEPT');
  const atPrepStart = byKind('AT_PREP_START');
  const late = predictions.filter(
    (p) =>
      p.kind === 'AT_PREP_START' &&
      p.actualReadyAt!.getTime() - p.predictedReadyAt.getTime() > DELAY_MINUTES * 60_000,
  ).length;

  const dayMap = new Map<string, { orders: number; errors: number[] }>();
  for (const o of placed) {
    const d = istDay(o.placedAt);
    dayMap.set(d, {
      orders: (dayMap.get(d)?.orders ?? 0) + 1,
      errors: dayMap.get(d)?.errors ?? [],
    });
  }
  for (const p of predictions.filter((x) => x.kind === 'AT_PREP_START')) {
    const d = istDay(p.predictedAt);
    const entry = dayMap.get(d) ?? { orders: 0, errors: [] };
    entry.errors.push(p.absErrorSeconds! / 60);
    dayMap.set(d, entry);
  }

  return {
    days,
    since: since.toISOString(),
    toleranceMinutes: TOLERANCE_MINUTES,
    enoughData: atAccept.evaluated + atPrepStart.evaluated >= MIN_EVALUATED,
    /** Accepted → ready: includes waiting in the queue. */
    acceptToReady: atAccept,
    /** Preparation started → ready: the cooking itself. */
    prepStartToReady: atPrepStart,
    lateOrders: late,
    lateThresholdMinutes: DELAY_MINUTES,
    perDay: [...dayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day, ordersPlaced: v.orders, ...summarize(v.errors) })),
    autoAccept: Object.fromEntries(decisions.map((d) => [d.outcome, d._count._all])) as Partial<
      Record<'ACCEPTED' | 'MANUAL_REVIEW' | 'ALREADY_HANDLED', number>
    >,
  };
}
