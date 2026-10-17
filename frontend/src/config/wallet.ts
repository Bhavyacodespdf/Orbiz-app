/**
 * Quick-pick recharge amounts (in paise): the ₹99 minimum and the four amounts that
 * earn bonus points. Limits, bonuses and validation all come from the backend; these
 * are only shortcuts.
 */
export const RECHARGE_PRESETS_PAISE = [9_900, 50_000, 100_000, 130_000, 150_000] as const;
