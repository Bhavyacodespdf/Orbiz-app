import type { Database } from '../../lib/prisma.js';
import type { ForecastConfidence } from '../../generated/prisma/enums.js';
import { aggregateDemand, demandOf } from './demand.service.js';
import { addDays, asDate, dayOf, dayRange, daysBetween, todayIst, weekdayOf } from './dates.js';
import {
  CONFIDENCE_RULES,
  FORECAST_MODEL,
  FORECAST_MODEL_VERSION,
  HISTORY_DAYS,
  INTERVAL_Z,
  LEVEL_DAYS,
  LEVEL_HALF_LIFE_DAYS,
  MIN_WEEKDAY_OBSERVATIONS,
  WEEKDAY_FACTOR_BOUNDS,
} from './planning.rules.js';

/*
 * Baseline forecaster: demand(day) = level × weekdayFactor(weekday).
 *   - level: exponentially weighted mean of recent de-seasonalised daily demand
 *   - weekdayFactor: that weekday's mean ÷ the overall mean (needs ≥2 observations)
 * It only reads demand rows strictly BEFORE the as-of date, so nothing from the future leaks in.
 * Days when the item was sold out (sales understate demand) and days the outlet had no orders at
 * all (probably closed) are left out of the estimates and reported.
 */

export interface HistoryDay {
  date: string;
  demand: number;
  censored: boolean;
  outletActive: boolean;
  wasted: number;
}

export interface DayForecast {
  date: string;
  quantity: number;
  lower: number;
  upper: number;
  /** Standard deviation used for the interval (null = too little history to estimate). */
  sigma: number | null;
}

export interface ItemFeatures {
  asOfDate: string;
  historyFrom: string;
  historyTo: string;
  observedDays: number;
  usableDays: number;
  censoredDays: number;
  inactiveDays: number;
  sameWeekdayDays: Record<string, number>;
  level: number;
  overallMean: number;
  weekdayFactors: number[];
  sigma: number | null;
  last7Demand: number;
  last28Demand: number;
  stockoutRate: number;
  wastedLast28: number;
  /** How the estimate was made when the item has no usable history of its own. */
  fallback: 'NONE' | 'CENSORED_ONLY' | 'CATEGORY_AVERAGE' | 'NO_HISTORY';
}

export interface ItemForecast {
  confidence: ForecastConfidence;
  features: ItemFeatures;
  days: DayForecast[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const clamp = (n: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, n));

/** Pure: forecasts one item for `targets` from its history (already restricted to < asOf). */
export function forecastItem(
  history: HistoryDay[],
  asOf: string,
  targets: string[],
  peerDailyMean: number | null,
): ItemForecast {
  const historyFrom = addDays(asOf, -HISTORY_DAYS);
  const inWindow = history.filter((h) => h.date >= historyFrom && h.date < asOf);
  const usable = inWindow.filter((h) => h.outletActive && !h.censored);
  const censored = inWindow.filter((h) => h.censored);
  const inactive = inWindow.filter((h) => !h.outletActive && !h.censored);

  const overallMean = mean(usable.map((h) => h.demand));
  const counts = [0, 0, 0, 0, 0, 0, 0];
  const sums = [0, 0, 0, 0, 0, 0, 0];
  for (const h of usable) {
    counts[weekdayOf(h.date)]! += 1;
    sums[weekdayOf(h.date)]! += h.demand;
  }
  const factors = counts.map((n, w) =>
    n >= MIN_WEEKDAY_OBSERVATIONS && overallMean > 0
      ? clamp(sums[w]! / n / overallMean, WEEKDAY_FACTOR_BOUNDS)
      : 1,
  );

  // Recent level on de-seasonalised demand, weighted towards recent days.
  const levelFrom = addDays(asOf, -LEVEL_DAYS);
  let wSum = 0;
  let vSum = 0;
  for (const h of usable) {
    if (h.date < levelFrom) continue;
    const age = daysBetween(h.date, asOf);
    const w = 0.5 ** (age / LEVEL_HALF_LIFE_DAYS);
    wSum += w;
    vSum += w * (h.demand / factors[weekdayOf(h.date)]!);
  }
  let level = wSum > 0 ? vSum / wSum : overallMean;
  let fallback: ItemFeatures['fallback'] = 'NONE';
  if (usable.length === 0) {
    if (censored.length > 0) {
      // Only sold-out days: their sales are a lower bound on demand, so use them as such.
      level = mean(censored.map((h) => h.demand));
      fallback = 'CENSORED_ONLY';
    } else if (peerDailyMean !== null) {
      level = peerDailyMean;
      fallback = 'CATEGORY_AVERAGE';
    } else {
      level = 0;
      fallback = 'NO_HISTORY';
    }
  }

  const residuals = usable.map((h) => h.demand / factors[weekdayOf(h.date)]! - level);
  const sigma =
    usable.length >= 2
      ? Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / (usable.length - 1))
      : null;

  const sameWeekday = (w: number) => counts[w]!;
  const minTargetWeekday = Math.min(...targets.map((d) => sameWeekday(weekdayOf(d))));
  const confidence: ForecastConfidence =
    usable.length === 0
      ? censored.length > 0
        ? 'LOW'
        : 'NONE'
      : usable.length >= CONFIDENCE_RULES.HIGH.usableDays &&
          minTargetWeekday >= CONFIDENCE_RULES.HIGH.sameWeekday
        ? 'HIGH'
        : usable.length >= CONFIDENCE_RULES.MEDIUM.usableDays
          ? 'MEDIUM'
          : 'LOW';

  const days = targets.map((date) => {
    const f = factors[weekdayOf(date)]!;
    const quantity = round2(Math.max(0, level * f));
    const s = sigma === null ? null : round2(sigma * f);
    return {
      date,
      quantity,
      lower: s === null ? 0 : round2(Math.max(0, Math.min(quantity, quantity - INTERVAL_Z * s))),
      upper: s === null ? round2(quantity * 2) : round2(quantity + INTERVAL_Z * s),
      sigma: s,
    };
  });

  const last = (n: number) =>
    inWindow.filter((h) => h.date >= addDays(asOf, -n)).reduce((a, h) => a + h.demand, 0);
  return {
    confidence,
    days,
    features: {
      asOfDate: asOf,
      historyFrom,
      historyTo: addDays(asOf, -1),
      observedDays: inWindow.length,
      usableDays: usable.length,
      censoredDays: censored.length,
      inactiveDays: inactive.length,
      sameWeekdayDays: Object.fromEntries(counts.map((n, w) => [String(w), n])),
      level: round2(level),
      overallMean: round2(overallMean),
      weekdayFactors: factors.map(round2),
      sigma: sigma === null ? null : round2(sigma),
      last7Demand: last(7),
      last28Demand: last(28),
      stockoutRate: inWindow.length ? round2(censored.length / inWindow.length) : 0,
      wastedLast28: inWindow
        .filter((h) => h.date >= addDays(asOf, -28))
        .reduce((a, h) => a + h.wasted, 0),
      fallback,
    },
  };
}

/**
 * Forecasts every active item of the outlet for each day from the as-of date (today, IST) to the
 * end of the target week, and stores the run. Demand rows are refreshed first, up to yesterday.
 */
export async function generateForecastRun(
  db: Database,
  params: {
    outletId: string;
    weekStart: string;
    trigger: 'MANUAL' | 'AUTO';
    userId?: string | null;
    now?: Date;
  },
) {
  const now = params.now ?? new Date();
  const asOf = todayIst(now);
  const historyFrom = addDays(asOf, -HISTORY_DAYS);
  const weekEnd = addDays(params.weekStart, 6);
  await aggregateDemand(db, {
    from: historyFrom,
    to: addDays(asOf, -1),
    outletId: params.outletId,
    now,
  });

  const [items, rows] = await Promise.all([
    db.menuItem.findMany({
      where: { outletId: params.outletId, isActive: true },
      select: { id: true, categoryId: true },
      orderBy: { id: 'asc' },
    }),
    db.demandDaily.findMany({
      // Strictly before the as-of date: the run can't see the day it is made on, or later.
      where: {
        outletId: params.outletId,
        businessDate: { gte: asDate(historyFrom), lt: asDate(asOf) },
      },
      orderBy: { businessDate: 'asc' },
    }),
  ]);

  const historyOf = new Map<string, HistoryDay[]>();
  for (const r of rows) {
    const h = historyOf.get(r.menuItemId) ?? [];
    h.push({
      date: dayOf(r.businessDate),
      demand: demandOf(r),
      censored: r.censored,
      outletActive: r.outletActive,
      wasted: r.unitsWasted,
    });
    historyOf.set(r.menuItemId, h);
  }
  // Category peers: the mean daily demand of other items in the same category (usable days).
  const peerMean = (itemId: string, categoryId: string) => {
    const peers = items.filter((i) => i.categoryId === categoryId && i.id !== itemId);
    const means = peers
      .map((p) => (historyOf.get(p.id) ?? []).filter((h) => h.outletActive && !h.censored))
      .filter((h) => h.length > 0)
      .map((h) => mean(h.map((d) => d.demand)));
    return means.length ? mean(means) : null;
  };

  const targets = dayRange(asOf, weekEnd);
  const run = await db.forecastRun.create({
    data: {
      outletId: params.outletId,
      weekStart: asDate(params.weekStart),
      asOfDate: asDate(asOf),
      historyFrom: asDate(historyFrom),
      historyTo: asDate(addDays(asOf, -1)),
      model: FORECAST_MODEL,
      modelVersion: FORECAST_MODEL_VERSION,
      trigger: params.trigger,
      createdByUserId: params.userId ?? null,
    },
  });
  const forecasts = items.flatMap((item) => {
    const f = forecastItem(
      historyOf.get(item.id) ?? [],
      asOf,
      targets,
      peerMean(item.id, item.categoryId),
    );
    return f.days.map((d) => ({
      runId: run.id,
      outletId: params.outletId,
      menuItemId: item.id,
      targetDate: asDate(d.date),
      horizonDays: daysBetween(asOf, d.date),
      quantity: d.quantity,
      lower: d.lower,
      upper: d.upper,
      confidence: f.confidence,
      features: { ...f.features, sigmaDay: d.sigma },
    }));
  });
  if (forecasts.length) await db.forecast.createMany({ data: forecasts });
  return run;
}

/**
 * Fills in actual demand for forecasts whose day has passed, then summarises each run whose
 * days are all evaluated. Sold-out days and days the outlet had no orders are excluded from the
 * error metrics (their "actual" isn't true demand) and counted separately.
 */
export async function evaluateForecasts(db: Database, now = new Date()) {
  const today = todayIst(now);
  const due = await db.forecast.findMany({
    where: { evaluatedAt: null, targetDate: { lt: asDate(today) } },
    select: { id: true, outletId: true, menuItemId: true, targetDate: true, quantity: true },
    take: 5000,
  });
  if (due.length === 0) return { evaluated: 0, runsSummarised: await summariseRuns(db, now) };

  // Make sure the demand rows for those days are current.
  const outlets = [...new Set(due.map((d) => d.outletId))];
  const minDay = dayOf(
    due.reduce((m, d) => (d.targetDate < m ? d.targetDate : m), due[0]!.targetDate),
  );
  for (const outletId of outlets) {
    await aggregateDemand(db, { from: minDay, to: addDays(today, -1), outletId, now });
  }
  const actuals = await db.demandDaily.findMany({
    where: {
      outletId: { in: outlets },
      businessDate: { gte: asDate(minDay), lt: asDate(today) },
    },
  });
  const actualOf = new Map(actuals.map((a) => [`${a.menuItemId}|${dayOf(a.businessDate)}`, a]));
  let evaluated = 0;
  for (const f of due) {
    const a = actualOf.get(`${f.menuItemId}|${dayOf(f.targetDate)}`);
    const actual = a ? demandOf(a) : 0;
    const { count } = await db.forecast.updateMany({
      where: { id: f.id, evaluatedAt: null },
      data: {
        actualDemand: actual,
        actualCensored: a ? a.censored || !a.outletActive : false,
        absError: round2(Math.abs(f.quantity - actual)),
        evaluatedAt: now,
      },
    });
    evaluated += count;
  }
  return { evaluated, runsSummarised: await summariseRuns(db, now) };
}

export interface ForecastMetrics {
  evaluatedForecasts: number;
  excludedForecasts: number;
  totalActual: number;
  totalForecast: number;
  /** Mean absolute error, units per item-day. */
  mae: number | null;
  /** Σ|error| ÷ Σactual; null when there was no actual demand (undefined, not 0 or ∞). */
  wape: number | null;
  /** Mean (forecast − actual): positive = over-forecasting. */
  bias: number | null;
}

export function metricsOf(
  rows: { quantity: number; actualDemand: number | null; actualCensored: boolean | null }[],
): ForecastMetrics {
  const used = rows.filter((r) => r.actualDemand !== null && !r.actualCensored);
  const totalActual = used.reduce((a, r) => a + r.actualDemand!, 0);
  const totalForecast = round2(used.reduce((a, r) => a + r.quantity, 0));
  const absSum = used.reduce((a, r) => a + Math.abs(r.quantity - r.actualDemand!), 0);
  return {
    evaluatedForecasts: used.length,
    excludedForecasts: rows.length - used.length,
    totalActual,
    totalForecast,
    mae: used.length ? round2(absSum / used.length) : null,
    wape: totalActual > 0 ? round2(absSum / totalActual) : null,
    bias: used.length ? round2((totalForecast - totalActual) / used.length) : null,
  };
}

async function summariseRuns(db: Database, now: Date) {
  const runs = await db.forecastRun.findMany({
    where: { evaluatedAt: null, forecasts: { none: { evaluatedAt: null } } },
    select: { id: true },
    take: 200,
  });
  let done = 0;
  for (const run of runs) {
    const rows = await db.forecast.findMany({
      where: { runId: run.id },
      select: { quantity: true, actualDemand: true, actualCensored: true },
    });
    const { count } = await db.forecastRun.updateMany({
      where: { id: run.id, evaluatedAt: null },
      data: { evaluation: { ...metricsOf(rows) }, evaluatedAt: now },
    });
    done += count;
  }
  return done;
}
