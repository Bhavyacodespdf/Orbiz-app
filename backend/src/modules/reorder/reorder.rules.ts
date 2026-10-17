/*
 * Quick Reorder: the deterministic rules behind "Your favourite combos". No machine learning —
 * a documented scoring formula over the student's own completed orders (docs/quick-reorder.md).
 *
 * Candidates (from COMPLETED, non-group orders in the last HISTORY_WINDOW_DAYS days):
 *   BASKET  the exact same set of dishes ordered at least MIN_SUPPORT times (2+ dishes)
 *   PAIR    two dishes ordered together in at least MIN_SUPPORT orders
 *   SINGLE  one dish ordered in at least MIN_SUPPORT orders ("your usual …")
 *
 *   score = (W_SUPPORT·support + W_RECENCY·recency + W_FREQUENCY·itemFrequency)
 *           × (AVAILABILITY_FLOOR + (1 − AVAILABILITY_FLOOR)·availableShare)
 *
 *   support        orders that contained the whole candidate
 *   recency        e^(−days since the latest such order / RECENCY_HALF_LIFE_DAYS·ln2)  (1 → today)
 *   itemFrequency  mean share of the student's orders containing each dish (0–1)
 *   availableShare dishes that can be added right now ÷ dishes in the candidate
 *
 * Candidates with no available dish are dropped, so an unavailable dish can't dominate.
 */

export const HISTORY_WINDOW_DAYS = 90;
export const HISTORY_ORDER_LIMIT = 200;
export const MIN_SUPPORT = 2;
export const MAX_SUGGESTIONS = 6;
export const RECENCY_HALF_LIFE_DAYS = 14;
export const W_SUPPORT = 2;
export const W_RECENCY = 3;
export const W_FREQUENCY = 1;
export const AVAILABILITY_FLOOR = 0.25;

/** Popular fallback: aggregate over every student, never shown for fewer than 3 students. */
export const POPULAR_WINDOW_DAYS = 30;
export const POPULAR_MIN_STUDENTS = 3;

export const MAX_SAVED_COMBOS = 12;
export const MAX_COMBO_LINES = 20;

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;

export type MealTime = 'breakfast' | 'lunch' | 'snack' | 'dinner' | 'late-night';
const WEEKDAYS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
];

/** Campus time (IST): breakfast before 11, lunch 11–16, snack 16–19, dinner 19–23, then late night. */
export function mealTimeOf(date: Date): MealTime {
  const hour = new Date(date.getTime() + IST_OFFSET_MS).getUTCHours();
  if (hour >= 5 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 16) return 'lunch';
  if (hour >= 16 && hour < 19) return 'snack';
  if (hour >= 19 && hour < 23) return 'dinner';
  return 'late-night';
}

export const weekdayOf = (date: Date) => new Date(date.getTime() + IST_OFFSET_MS).getUTCDay();

/** "Your previous lunch" — for a Quick Reorder card. */
export const previousMealLabel = (date: Date) => `Your previous ${mealTimeOf(date)}`;

/** "Masala chai + Veg puff", or "Masala chai, Veg puff + 2 more". */
export function comboName(names: string[]): string {
  if (names.length <= 2) return names.join(' + ');
  return `${names[0]}, ${names[1]} + ${names.length - 2} more`;
}

export const recencyScore = (daysAgo: number) =>
  Math.exp((-Math.max(0, daysAgo) * Math.LN2) / RECENCY_HALF_LIFE_DAYS);

export function comboScore(input: {
  support: number;
  daysSinceLast: number;
  itemFrequency: number;
  availableShare: number;
}): number {
  const base =
    W_SUPPORT * input.support +
    W_RECENCY * recencyScore(input.daysSinceLast) +
    W_FREQUENCY * input.itemFrequency;
  return base * (AVAILABILITY_FLOOR + (1 - AVAILABILITY_FLOOR) * input.availableShare);
}

export interface HistoryOrder {
  id: string;
  outletId: string;
  placedAt: Date;
  lines: { menuItemId: string; name: string; quantity: number }[];
}

export type CandidateKind = 'BASKET' | 'PAIR' | 'SINGLE';

export interface Candidate {
  key: string;
  kind: CandidateKind;
  outletId: string;
  /** Dishes with the quantities from the most recent matching order. */
  lines: { menuItemId: string; name: string; quantity: number }[];
  support: number;
  lastOrderedAt: Date;
  itemFrequency: number;
  /** e.g. "lunch" when ≥ 2/3 of the matching orders were at that meal time. */
  usualMealTime: MealTime | null;
  /** e.g. "Tuesdays" when ≥ 2 matching orders and ≥ 2/3 of them were on that weekday. */
  usualWeekday: string | null;
}

function dominant<T>(values: T[]): T | null {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best !== null && bestCount >= 2 && bestCount / values.length >= 2 / 3 ? best : null;
}

/**
 * Mines BASKET, PAIR and SINGLE candidates from the student's orders. Pure and deterministic:
 * the same orders always give the same candidates in the same order.
 */
export function mineCandidates(orders: HistoryOrder[]): Candidate[] {
  const total = orders.length;
  if (total === 0) return [];
  // Newest first, so the first match of a candidate holds its latest quantities.
  const sorted = [...orders].sort(
    (a, b) => b.placedAt.getTime() - a.placedAt.getTime() || a.id.localeCompare(b.id),
  );
  const ordersWithItem = new Map<string, number>();
  for (const o of sorted) {
    for (const id of new Set(o.lines.map((l) => l.menuItemId))) {
      ordersWithItem.set(id, (ordersWithItem.get(id) ?? 0) + 1);
    }
  }

  type Acc = { kind: CandidateKind; outletId: string; matches: HistoryOrder[]; ids: string[] };
  const acc = new Map<string, Acc>();
  const note = (kind: CandidateKind, ids: string[], order: HistoryOrder) => {
    const key = `${kind}:${order.outletId}:${ids.join(',')}`;
    const entry = acc.get(key) ?? { kind, outletId: order.outletId, matches: [], ids };
    entry.matches.push(order);
    acc.set(key, entry);
  };
  for (const o of sorted) {
    const ids = [...new Set(o.lines.map((l) => l.menuItemId))].sort();
    if (ids.length >= 2) note('BASKET', ids, o);
    for (let i = 0; i < ids.length; i++) {
      note('SINGLE', [ids[i]!], o);
      for (let j = i + 1; j < ids.length; j++) note('PAIR', [ids[i]!, ids[j]!], o);
    }
  }

  const candidates: Candidate[] = [];
  for (const [key, a] of acc) {
    if (a.matches.length < MIN_SUPPORT) continue;
    const latest = a.matches[0]!;
    const lines = a.ids.map((id) => {
      const line = latest.lines.find((l) => l.menuItemId === id)!;
      return { menuItemId: id, name: line.name, quantity: line.quantity };
    });
    lines.sort((x, y) => x.name.localeCompare(y.name) || x.menuItemId.localeCompare(y.menuItemId));
    candidates.push({
      key,
      kind: a.kind,
      outletId: a.outletId,
      lines,
      support: a.matches.length,
      lastOrderedAt: latest.placedAt,
      itemFrequency:
        a.ids.reduce((s, id) => s + (ordersWithItem.get(id) ?? 0) / total, 0) / a.ids.length,
      usualMealTime: dominant(a.matches.map((m) => mealTimeOf(m.placedAt))),
      usualWeekday: (() => {
        const d = dominant(a.matches.map((m) => weekdayOf(m.placedAt)));
        return d === null ? null : WEEKDAYS[d]!;
      })(),
    });
  }

  // Drop candidates that add nothing new (see below).
  return candidates
    .filter(
      (c) =>
        !candidates.some((other) => {
          if (other === c || other.outletId !== c.outletId) return false;
          const covers = c.lines.every((l) =>
            other.lines.some((x) => x.menuItemId === l.menuItemId),
          );
          if (!covers) return false;
          // A larger combo seen just as often makes this one redundant…
          if (other.lines.length > c.lines.length) return other.support === c.support;
          // …and the same dishes as a whole basket and as a pair are shown once.
          return (
            other.support > c.support ||
            (other.support === c.support && other.kind === 'BASKET' && c.kind === 'PAIR')
          );
        }),
    )
    .sort((a, b) => a.key.localeCompare(b.key));
}

export const daysBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / DAY_MS;

/** "Ordered together 4 times in the last 90 days" — only ever from counted records. */
export function explain(c: Pick<Candidate, 'kind' | 'support'>): string {
  const times = `${c.support} times in the last ${HISTORY_WINDOW_DAYS} days`;
  return c.kind === 'SINGLE' ? `Ordered ${times}` : `Ordered together ${times}`;
}
