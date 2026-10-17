import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayRange,
  istDayStart,
  mondayOf,
  nextMonday,
  todayIst,
  weekdayOf,
} from './dates.js';
import { stockByDay } from './demand.service.js';
import { forecastItem, metricsOf, type HistoryDay } from './forecast.service.js';
import { computeLine } from './plan.service.js';
import { candidatesFor, chooseAction, replayReward, rewardOf, stateBucket } from './policy.js';
import { evaluatePolicy, learnTable, splitByTime, type TrainingExample } from './train.js';

const AS_OF = '2026-10-19'; // a Monday

/** n days of history before AS_OF; demand by weekday from `pattern` (Mon…Sun). */
function history(days: number, pattern: number[], tweak: (h: HistoryDay) => HistoryDay = (h) => h) {
  return dayRange(addDays(AS_OF, -days), addDays(AS_OF, -1)).map((date) =>
    tweak({
      date,
      demand: pattern[weekdayOf(date)]!,
      censored: false,
      outletActive: true,
      wasted: 0,
    }),
  );
}

describe('business dates (IST, Monday weeks)', () => {
  it('works out weekdays, Mondays and IST day boundaries', () => {
    expect(weekdayOf('2026-10-19')).toBe(0); // Monday
    expect(weekdayOf('2026-10-25')).toBe(6); // Sunday
    expect(mondayOf('2026-10-25')).toBe('2026-10-19');
    expect(nextMonday('2026-10-19')).toBe('2026-10-26');
    expect(nextMonday('2026-10-25')).toBe('2026-10-26');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    // 00:00 IST is 18:30 UTC the day before.
    expect(istDayStart('2026-10-19').toISOString()).toBe('2026-10-18T18:30:00.000Z');
    // 23:59 UTC on the 18th is already the 19th in IST.
    expect(todayIst(new Date('2026-10-18T19:00:00Z'))).toBe('2026-10-19');
  });
});

describe('stock timeline from the ledger', () => {
  const item = { trackInventory: true, stockQuantity: 0, isAvailable: true };
  const at = (iso: string) => new Date(iso);

  it('measures stockout minutes and opening/closing stock per IST day', () => {
    const events = [
      // 06:00 IST on the 19th: 3 sold → 0 left; 12:00 IST restocked to 10.
      {
        menuItemId: 'i',
        type: 'ORDER_DEDUCTION' as const,
        previousQuantity: 3,
        resultingQuantity: 0,
        createdAt: at('2026-10-19T00:30:00Z'),
      },
      {
        menuItemId: 'i',
        type: 'RESTOCK' as const,
        previousQuantity: 0,
        resultingQuantity: 10,
        createdAt: at('2026-10-19T06:30:00Z'),
      },
    ];
    const days = stockByDay(
      events,
      item,
      ['2026-10-18', '2026-10-19', '2026-10-20'],
      at('2026-10-21T00:00:00Z'),
    );
    expect(days.get('2026-10-18')).toEqual({
      openingStock: 3,
      closingStock: 3,
      stockoutMinutes: 0,
    });
    expect(days.get('2026-10-19')).toEqual({
      openingStock: 3,
      closingStock: 10,
      stockoutMinutes: 360,
    });
    expect(days.get('2026-10-20')).toEqual({
      openingStock: 10,
      closingStock: 10,
      stockoutMinutes: 0,
    });
  });

  it('counts a manual "sold out" as unavailable, and an uncounted item has no stock figures', () => {
    const events = [
      {
        menuItemId: 'i',
        type: 'MARKED_SOLD_OUT' as const,
        previousQuantity: null,
        resultingQuantity: null,
        createdAt: at('2026-10-19T12:30:00Z'),
      },
    ];
    const days = stockByDay(
      events,
      { trackInventory: false, stockQuantity: null, isAvailable: false },
      ['2026-10-19'],
      at('2026-10-21T00:00:00Z'),
    );
    // From 18:00 IST to midnight.
    expect(days.get('2026-10-19')).toEqual({
      openingStock: null,
      closingStock: null,
      stockoutMinutes: 360,
    });
  });
});

describe('baseline forecaster', () => {
  const week = [
    '2026-10-26',
    '2026-10-27',
    '2026-10-28',
    '2026-10-29',
    '2026-10-30',
    '2026-10-31',
    '2026-11-01',
  ];

  it('learns the weekday pattern and is confident with 8 steady weeks', () => {
    const f = forecastItem(history(56, [10, 10, 10, 10, 20, 5, 5]), AS_OF, week, null);
    expect(f.confidence).toBe('HIGH');
    const byDay = Object.fromEntries(f.days.map((d) => [weekdayOf(d.date), d.quantity]));
    expect(byDay[4]).toBeCloseTo(20, 0); // Friday
    expect(byDay[5]).toBeCloseTo(5, 0); // Saturday
    expect(byDay[0]).toBeCloseTo(10, 0);
    for (const d of f.days) {
      expect(d.lower).toBeLessThanOrEqual(d.quantity);
      expect(d.upper).toBeGreaterThanOrEqual(d.quantity);
    }
  });

  it('does not treat sold-out days as zero demand', () => {
    // Every Friday sold out early with only 2 sales; real Friday demand elsewhere is 20.
    const h = history(56, [10, 10, 10, 10, 20, 10, 10], (d) =>
      weekdayOf(d.date) === 4 && d.date > addDays(AS_OF, -15)
        ? { ...d, demand: 2, censored: true }
        : d,
    );
    const f = forecastItem(h, AS_OF, week, null);
    expect(f.features.censoredDays).toBe(2);
    expect(f.days.find((d) => weekdayOf(d.date) === 4)!.quantity).toBeGreaterThan(15);
  });

  it('ignores days the outlet had no orders at all (probably closed)', () => {
    const h = history(28, [10, 10, 10, 10, 10, 10, 10], (d) =>
      weekdayOf(d.date) === 6 ? { ...d, demand: 0, outletActive: false } : d,
    );
    const f = forecastItem(h, AS_OF, week, null);
    expect(f.features.inactiveDays).toBe(4);
    expect(f.days.find((d) => weekdayOf(d.date) === 6)!.quantity).toBeCloseTo(10, 0);
  });

  it('never uses history on or after the as-of date (no leakage)', () => {
    const past = history(28, [5, 5, 5, 5, 5, 5, 5]);
    const future = dayRange(AS_OF, addDays(AS_OF, 10)).map((date) => ({
      date,
      demand: 500,
      censored: false,
      outletActive: true,
      wasted: 0,
    }));
    const a = forecastItem(past, AS_OF, week, null);
    const b = forecastItem([...past, ...future], AS_OF, week, null);
    expect(b.days).toEqual(a.days);
    expect(b.features).toEqual(a.features);
  });

  it('falls back for new items and marks them low or no confidence', () => {
    const peer = forecastItem([], AS_OF, week, 7);
    expect(peer.confidence).toBe('NONE');
    expect(peer.features.fallback).toBe('CATEGORY_AVERAGE');
    expect(peer.days[0]!.quantity).toBe(7);
    const none = forecastItem([], AS_OF, week, null);
    expect(none.features.fallback).toBe('NO_HISTORY');
    expect(none.days.every((d) => d.quantity === 0)).toBe(true);
    const thin = forecastItem(history(3, [4, 4, 4, 4, 4, 4, 4]), AS_OF, week, null);
    expect(thin.confidence).toBe('LOW');
  });

  it('reports MAE and WAPE, leaving out censored days and WAPE undefined with no demand', () => {
    expect(
      metricsOf([
        { quantity: 10, actualDemand: 8, actualCensored: false },
        { quantity: 4, actualDemand: 6, actualCensored: false },
        { quantity: 9, actualDemand: 1, actualCensored: true },
      ]),
    ).toMatchObject({ evaluatedForecasts: 2, excludedForecasts: 1, mae: 2, wape: 0.29, bias: 0 });
    expect(metricsOf([{ quantity: 2, actualDemand: 0, actualCensored: false }])).toMatchObject({
      wape: null,
      mae: 2,
    });
  });
});

describe('recommended quantity', () => {
  const features = forecastItem([], AS_OF, ['2026-10-26'], null).features;
  const days = (q: number, sigma: number | null, from = '2026-10-26') =>
    dayRange(from, '2026-11-01').map((date) => ({
      date,
      quantity: q,
      lower: 0,
      upper: q * 2,
      sigma,
    }));
  const base = {
    weekStart: '2026-10-26',
    confidence: 'HIGH' as const,
    features,
    tracked: true,
    expectedIncoming: 0,
    fulfillmentType: 'PACKAGED' as const,
  };

  it('is forecast + one safety buffer − stock on hand, as a whole number', () => {
    const line = computeLine({ ...base, forecasts: days(5, 2), currentStock: 18 });
    // Week forecast 35; σ(week) = √(7·2²) ≈ 5.29 → safety ⌈1.2816·5.29⌉ = 7; target 42.
    expect(line.forecastWeek).toBe(35);
    expect(line.safetyStock).toBe(7);
    expect(line.targetStock).toBe(42);
    expect(line.state.baselineNeed).toBe(24);
    expect(line.candidates).toEqual([
      { action: 'NONE', quantity: 0 },
      { action: 'SMALL', quantity: 12 },
      { action: 'MEDIUM', quantity: 24 },
      { action: 'LARGE', quantity: 36 },
    ]);
  });

  it('subtracts expected incoming stock and the sales expected before the week starts', () => {
    const withIncoming = computeLine({
      ...base,
      forecasts: days(5, 2),
      currentStock: 18,
      expectedIncoming: 10,
    });
    expect(withIncoming.state.baselineNeed).toBe(14);
    // Generated on Friday: Sat+Sun sell ~10 of the 18 first.
    const gap = [
      { date: '2026-10-24', quantity: 5, lower: 0, upper: 10, sigma: 2 },
      { date: '2026-10-25', quantity: 5, lower: 0, upper: 10, sigma: 2 },
    ];
    const early = computeLine({ ...base, forecasts: [...gap, ...days(5, 2)], currentStock: 18 });
    expect(early.projectedOpening).toBe(8);
    expect(early.state.baselineNeed).toBe(34);
  });

  it('never goes negative, uses a 20% buffer without variability data, and ignores stock it can’t count', () => {
    const plenty = computeLine({ ...base, forecasts: days(5, 2), currentStock: 500 });
    expect(plenty.state.baselineNeed).toBe(0);
    expect(plenty.candidates.every((c) => c.quantity === 0)).toBe(true);
    const thin = computeLine({
      ...base,
      confidence: 'LOW',
      forecasts: days(5, null),
      currentStock: 0,
    });
    expect(thin.safetyStock).toBe(7); // ⌈0.2 × 35⌉
    const uncounted = computeLine({
      ...base,
      tracked: false,
      forecasts: days(5, 2),
      currentStock: null,
    });
    expect(uncounted.projectedOpening).toBeNull();
    expect(uncounted.state.baselineNeed).toBe(42);
    const nothing = computeLine({ ...base, forecasts: days(0, null), currentStock: 0 });
    expect(nothing.safetyStock).toBe(0);
    expect(nothing.state.baselineNeed).toBe(0);
  });
});

describe('policy, reward and offline training', () => {
  const baseline = { name: 'baseline', version: '1.0.0', table: null };
  const state = { confidence: 'HIGH' as const, forecastWeek: 35, sigmaWeek: 5, baselineNeed: 24 };

  it('the baseline recommends the full need, and NONE when nothing is needed', () => {
    expect(chooseAction(baseline, state as never)).toBe('MEDIUM');
    expect(chooseAction(baseline, { ...state, baselineNeed: 0 } as never)).toBe('NONE');
    expect(
      chooseAction({ name: 'p', version: '1', table: { 'HIGH|STEADY': 'LARGE' } }, state as never),
    ).toBe('LARGE');
    expect(stateBucket(state)).toBe('HIGH|STEADY');
    expect(candidatesFor(10, 4).map((c) => c.quantity)).toEqual([0, 4, 4, 4]); // storage limit
  });

  it('scores fulfilled demand against lost sales, waste and leftovers (in units)', () => {
    expect(rewardOf({ fulfilled: 30, estimatedLost: 5, wasted: 2, leftover: 10 }).reward).toBe(17);
    expect(replayReward(5, 20, 30)).toEqual({ fulfilled: 25, reward: 15 });
    expect(replayReward(5, 40, 30)).toEqual({ fulfilled: 30, reward: 28.5 });
  });

  const example = (i: number, bucket: string, demand: number): TrainingExample => ({
    id: `d${i}`,
    periodStart: addDays('2026-01-05', 7 * Math.floor(i / 5)),
    bucket,
    opening: 0,
    demand,
    candidates: candidatesFor(20, 100_000),
  });

  it('learns a better action per state from replayed outcomes, and holds out the newest weeks', () => {
    // In ERRATIC states demand keeps exceeding the baseline need of 20.
    const examples = Array.from({ length: 60 }, (_, i) =>
      i % 2 ? example(i, 'MEDIUM|ERRATIC', 32) : example(i, 'HIGH|STEADY', 20),
    );
    const { train, holdout } = splitByTime(examples);
    expect(holdout.length).toBeGreaterThanOrEqual(10);
    expect(train.at(-1)!.periodStart < holdout[0]!.periodStart).toBe(true);
    const table = learnTable(train);
    expect(table['MEDIUM|ERRATIC']).toBe('LARGE');
    expect(table['HIGH|STEADY']).toBe('MEDIUM');
    const learned = evaluatePolicy(holdout, (e) => table[e.bucket] ?? 'MEDIUM');
    const base = evaluatePolicy(holdout, () => 'MEDIUM');
    expect(learned.meanReward).toBeGreaterThan(base.meanReward);
  });

  it('keeps the baseline for a state with too few examples', () => {
    expect(learnTable([example(1, 'LOW|UNKNOWN', 50), example(2, 'LOW|UNKNOWN', 50)])).toEqual({});
  });
});
