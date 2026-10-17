/*
 * Every number the planner uses, in one place. None of these are measured from data; they are
 * explicit, documented choices (see docs/stock-planning.md) that can be tuned.
 */

/** Forecasting model identity, stored on every forecast run. */
export const FORECAST_MODEL = 'weekday-ewma-baseline';
export const FORECAST_MODEL_VERSION = '1.0.0';

/** How far back the forecaster looks (days before the as-of date). */
export const HISTORY_DAYS = 56;
/** The recent level is an exponentially weighted mean over this many days… */
export const LEVEL_DAYS = 28;
/** …where a day's weight halves every this many days. */
export const LEVEL_HALF_LIFE_DAYS = 7;
/** A weekday needs at least this many usable days before its own pattern is trusted. */
export const MIN_WEEKDAY_OBSERVATIONS = 2;
/** Weekday factors are kept within these bounds so one odd day can't dominate. */
export const WEEKDAY_FACTOR_BOUNDS = [0.25, 3] as const;

/** Usable days of history needed for each confidence level (plus same-weekday days for HIGH). */
export const CONFIDENCE_RULES = {
  HIGH: { usableDays: 35, sameWeekday: 4 },
  MEDIUM: { usableDays: 14 },
  LOW: { usableDays: 1 },
} as const;

/** Prediction interval: ±z·σ, with z for an 80% two-sided interval. */
export const INTERVAL_Z = 1.2816;

/**
 * Safety stock = z · σ(week), z for a ~90% one-sided service level. When there's too little
 * history to estimate σ, a fraction of the forecast is used instead.
 */
export const SAFETY_Z = 1.2816;
export const FALLBACK_SAFETY_FRACTION = 0.2;

/** Planner weeks can be planned up to this many weeks ahead. */
export const MAX_WEEKS_AHEAD = 4;
/** Historical demand queries: at most this many days per request. */
export const MAX_HISTORY_RANGE_DAYS = 120;

/** Discrete actions: multiples of the baseline need (forecast + safety − on hand). */
export const ACTION_MULTIPLIERS = { NONE: 0, SMALL: 0.5, MEDIUM: 1, LARGE: 1.5 } as const;
export type ActionName = keyof typeof ACTION_MULTIPLIERS;
export const ACTIONS = Object.keys(ACTION_MULTIPLIERS) as ActionName[];

/**
 * Reward per decision, in UNITS (CampusCart stores no purchase costs, so nothing is in money):
 *   reward = fulfilled·1 − estimatedLost·2 − wasted·1 − leftover·0.1
 * A lost sale is weighted twice a fulfilled one because a sold-out item disappoints a student
 * and loses the sale; leftover stock is a small holding penalty, wastage a full one.
 */
export const REWARD_WEIGHTS = { fulfilled: 1, lost: 2, wasted: 1, leftover: 0.1 } as const;

/** Learned policies: name, minimum data and the bar they must clear on the holdout. */
export const POLICY_NAME = 'replenishment-bandit';
export const BASELINE_POLICY = { name: 'baseline', version: '1.0.0' } as const;
export const TRAINING_RULES = {
  minTrainDecisions: 40,
  minHoldoutDecisions: 10,
  holdoutFraction: 0.2,
  /** A state bucket needs this many examples before it may differ from the baseline. */
  minBucketSamples: 5,
  /** Mean holdout reward must beat the baseline by at least this fraction… */
  minRewardImprovement: 0.02,
  /** …without the service level (fulfilled ÷ demand) dropping by more than this. */
  maxServiceLevelDrop: 0.02,
} as const;
