/*
 * Kitchen timing rules — deterministic and documented (docs/kitchen-queue.md). No machine
 * learning: configured preparation times, exponential moving averages of real observations, and
 * a list scheduler over the outlet's parallel kitchen capacity.
 */

const MINUTE_MS = 60_000;

/** Used only when a dish has neither enough history nor a configured time (flagged to managers). */
export const DEFAULT_PREP_MINUTES = 10;
/** A dish's learned time is used once it has this many valid observations. */
export const MIN_OBSERVATIONS = 5;
/**
 * EMA weight of each new observation. 0.2 ≈ the last ~10 orders matter most: responsive to real
 * changes (new cook, new recipe) while one odd order moves the estimate by at most 20 %.
 */
export const EMA_ALPHA = 0.2;
/** Observations outside these bounds are impossible or broken and are ignored. */
export const MIN_VALID_SECONDS = 30;
export const MAX_VALID_SECONDS = 4 * 60 * 60;
/** A single observation counts at most this many times the current estimate (or 1/this). */
export const OUTLIER_CLAMP = 3;
/**
 * Order composition: the longest unit sets the pace and every other unit adds this share of its
 * own time (dishes in one order partly overlap). The outlet calibration below corrects any
 * systematic error in this assumption from real outcomes.
 */
export const OVERLAP_SHARE = 0.5;
/** Outlet calibration (actual ÷ estimated) is applied once it has this many observations. */
export const MIN_CALIBRATION_OBSERVATIONS = 5;
export const CALIBRATION_BOUNDS = [0.5, 3] as const;
/** "Almost ready": estimated remaining preparation time at or below this. */
export const ALMOST_READY_MINUTES = 2;
/** Tell the student when their estimated ready time moves by at least this much … */
export const ETA_NOTICE_MINUTES = 5;
/** … at most this many times per order. */
export const MAX_ETA_NOTICES = 2;
/** A preparing order this many minutes past its estimate is "delayed" (staff are told once). */
export const DELAY_MINUTES = 5;
/** Show a range (± median absolute error) only after this many evaluated predictions. */
export const RANGE_MIN_EVALUATED = 10;
/** The range uses predictions from this many recent days. */
export const RANGE_WINDOW_DAYS = 14;
/** Identifies how an estimate was produced (stored with every prediction). */
export const ESTIMATOR_VERSION = 'baseline-v1';

export type EstimateSource = 'HISTORY' | 'CONFIGURED' | 'DEFAULT';

/** Estimator hierarchy: enough history → configured time → documented default. */
export function dishEstimate(
  configuredMinutes: number | null,
  stat: { emaSeconds: number; observations: number } | null,
): { minutes: number; source: EstimateSource } {
  if (stat && stat.observations >= MIN_OBSERVATIONS) {
    return { minutes: stat.emaSeconds / 60, source: 'HISTORY' };
  }
  if (configuredMinutes !== null) return { minutes: configuredMinutes, source: 'CONFIGURED' };
  return { minutes: DEFAULT_PREP_MINUTES, source: 'DEFAULT' };
}

/** longest unit + OVERLAP_SHARE × (all other units). */
export function orderBaseMinutes(lines: { minutes: number; quantity: number }[]): number {
  if (lines.length === 0) return 0;
  const units = lines.flatMap((l) => Array.from({ length: l.quantity }, () => l.minutes));
  const longest = Math.max(...units);
  const total = units.reduce((s, u) => s + u, 0);
  return longest + OVERLAP_SHARE * (total - longest);
}

/** The outlet correction factor, once it is supported by enough observations. */
export function calibration(stat: { calibrationFactor: number; observations: number } | null) {
  return stat && stat.observations >= MIN_CALIBRATION_OBSERVATIONS ? stat.calibrationFactor : 1;
}

/** A real duration if it's plausible, else null (ignored, logged by the caller). */
export function validDuration(startedAt: Date | null, readyAt: Date | null): number | null {
  if (!startedAt || !readyAt) return null;
  const seconds = (readyAt.getTime() - startedAt.getTime()) / 1000;
  return seconds >= MIN_VALID_SECONDS && seconds <= MAX_VALID_SECONDS ? seconds : null;
}

/**
 * EMA update with outlier clamping: the observation is limited to [prev/3, prev×3] first, so one
 * data error can't permanently distort the estimate. The first observation starts the average
 * (seeded from `seed`, e.g. the configured time, when available).
 */
export function emaUpdate(previous: number | null, observation: number): number {
  if (previous === null) return observation;
  const clamped = Math.min(
    previous * OUTLIER_CLAMP,
    Math.max(previous / OUTLIER_CLAMP, observation),
  );
  return EMA_ALPHA * clamped + (1 - EMA_ALPHA) * previous;
}

export function clampCalibration(factor: number) {
  return Math.min(CALIBRATION_BOUNDS[1], Math.max(CALIBRATION_BOUNDS[0], factor));
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export interface QueueOrder {
  id: string;
  status: 'PLACED' | 'ACCEPTED' | 'PREPARING';
  placedAt: Date;
  scheduledFor: Date | null;
  /** When preparation started (PREPARING only), from status history. */
  prepStartedAt: Date | null;
  /** Estimated preparation minutes for this order (base × calibration). */
  minutes: number;
}

export interface Scheduled {
  /** 0 = being prepared now; 1 = next; … */
  position: number;
  ordersAhead: number;
  startAt: Date;
  readyAt: Date;
}

/**
 * Deterministic list scheduling over `slots` parallel kitchen places:
 *  1. Orders being prepared hold a slot until started + minutes (at least "now").
 *  2. Waiting orders (placed/accepted) are served in order of (key time, placed time, id), where
 *     the key time is when the order was placed for "order now", and for a scheduled order the
 *     time it should start so it's ready for its slot (scheduledFor − minutes) — so a scheduled
 *     order placed yesterday doesn't jump ahead of today's immediate orders.
 *  3. Each takes the earliest-free slot, starting no earlier than its release time.
 * Ready orders aren't kitchen work and aren't scheduled.
 */
export function scheduleQueue(orders: QueueOrder[], slots: number, now: Date) {
  const result = new Map<string, Scheduled>();
  const nowMs = now.getTime();
  const free: number[] = [];

  const preparing = orders
    .filter((o) => o.status === 'PREPARING')
    .sort(
      (a, b) =>
        (a.prepStartedAt?.getTime() ?? 0) - (b.prepStartedAt?.getTime() ?? 0) ||
        a.id.localeCompare(b.id),
    );
  for (const o of preparing) {
    const started = o.prepStartedAt?.getTime() ?? nowMs;
    const readyMs = Math.max(nowMs, started + o.minutes * MINUTE_MS);
    result.set(o.id, {
      position: 0,
      ordersAhead: 0,
      startAt: new Date(started),
      readyAt: new Date(readyMs),
    });
    free.push(readyMs);
  }
  while (free.length < slots) free.push(nowMs);
  free.sort((a, b) => a - b);
  // More orders in progress than configured slots: conservatively, waiting orders get only
  // `slots` places, freed by the latest-finishing orders in progress.
  if (free.length > slots) free.splice(0, free.length - slots);

  const release = (o: QueueOrder) =>
    o.scheduledFor ? Math.max(nowMs, o.scheduledFor.getTime() - o.minutes * MINUTE_MS) : nowMs;
  const keyTime = (o: QueueOrder) =>
    o.scheduledFor ? o.scheduledFor.getTime() - o.minutes * MINUTE_MS : o.placedAt.getTime();
  const waiting = orders
    .filter((o) => o.status !== 'PREPARING')
    .sort(
      (a, b) =>
        keyTime(a) - keyTime(b) ||
        a.placedAt.getTime() - b.placedAt.getTime() ||
        a.id.localeCompare(b.id),
    );

  waiting.forEach((o, index) => {
    // Earliest-free slot (free is kept sorted).
    const slotFree = free.shift()!;
    const startMs = Math.max(slotFree, release(o));
    const readyMs = startMs + o.minutes * MINUTE_MS;
    result.set(o.id, {
      position: index + 1,
      ordersAhead: preparing.length + index,
      startAt: new Date(startMs),
      readyAt: new Date(readyMs),
    });
    // Insert the slot's next free time keeping the list sorted.
    const at = free.findIndex((t) => t > readyMs);
    free.splice(at === -1 ? free.length : at, 0, readyMs);
  });
  return result;
}

/** Median of positive numbers (null when empty). */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
