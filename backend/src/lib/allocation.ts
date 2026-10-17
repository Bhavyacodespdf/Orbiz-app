/*
 * Splitting an amount between people, in integer paise. Every method returns amounts that add
 * up EXACTLY to the total; leftover paise from rounding go to people in the given order (which
 * callers keep deterministic), so the same inputs always give the same result.
 */

export type SplitMethod = 'BY_DISH' | 'EQUAL' | 'PERCENTAGE' | 'CUSTOM';

export interface SplitPerson {
  id: string;
  /** BY_DISH: the value of this person's own items. */
  ownPaise?: number;
  /** PERCENTAGE: basis points (100 = 1%). */
  percentBps?: number | null;
  /** CUSTOM: the amount this person pays. */
  customPaise?: number | null;
}

export type SplitResult =
  | { ok: true; amounts: { id: string; amountPaise: number }[] }
  | { ok: false; code: string; message: string; details: Record<string, unknown> };

export const formatRupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export function splitAmount(
  method: SplitMethod,
  totalPaise: number,
  people: SplitPerson[],
): SplitResult {
  if (people.length === 0) {
    return {
      ok: false,
      code: 'NO_PARTICIPANTS',
      message: 'There is nobody to split between.',
      details: {},
    };
  }
  if (!Number.isInteger(totalPaise) || totalPaise < 0) {
    return {
      ok: false,
      code: 'INVALID_TOTAL',
      message: 'The total must be a whole number of paise.',
      details: {},
    };
  }

  if (method === 'BY_DISH') {
    const sum = people.reduce((a, p) => a + (p.ownPaise ?? 0), 0);
    if (sum !== totalPaise) {
      return {
        ok: false,
        code: 'BY_DISH_MISMATCH',
        message: 'Item totals don’t add up to the bill.',
        details: { totalPaise, allocatedPaise: sum },
      };
    }
    return { ok: true, amounts: people.map((p) => ({ id: p.id, amountPaise: p.ownPaise ?? 0 })) };
  }

  if (method === 'EQUAL') {
    const base = Math.floor(totalPaise / people.length);
    const extra = totalPaise - base * people.length; // < people.length
    return {
      ok: true,
      amounts: people.map((p, i) => ({ id: p.id, amountPaise: base + (i < extra ? 1 : 0) })),
    };
  }

  if (method === 'PERCENTAGE') {
    const missing = people.filter((p) => p.percentBps === null || p.percentBps === undefined);
    const totalBps = people.reduce((a, p) => a + (p.percentBps ?? 0), 0);
    if (missing.length > 0 || totalBps !== 10_000) {
      return {
        ok: false,
        code: 'PERCENTAGES_MUST_TOTAL_100',
        message: `Percentages must add up to exactly 100% (they add up to ${(totalBps / 100).toFixed(2)}%).`,
        details: { totalBps, missing: missing.map((p) => p.id) },
      };
    }
    // Largest remainder: floor every share, then hand out the leftover paise to the
    // largest fractional parts (ties in the given order).
    const raw = people.map((p, i) => ({ i, id: p.id, exact: totalPaise * p.percentBps! }));
    const amounts = raw.map((r) => Math.floor(r.exact / 10_000));
    let left = totalPaise - amounts.reduce((a, b) => a + b, 0);
    const order = [...raw].sort((a, b) => (b.exact % 10_000) - (a.exact % 10_000) || a.i - b.i);
    for (const r of order) {
      if (left === 0) break;
      amounts[r.i]! += 1;
      left -= 1;
    }
    return { ok: true, amounts: people.map((p, i) => ({ id: p.id, amountPaise: amounts[i]! })) };
  }

  const missing = people.filter((p) => p.customPaise === null || p.customPaise === undefined);
  const allocated = people.reduce((a, p) => a + (p.customPaise ?? 0), 0);
  if (missing.length > 0 || allocated !== totalPaise) {
    return {
      ok: false,
      code: 'CUSTOM_AMOUNTS_MISMATCH',
      message:
        missing.length > 0
          ? 'Enter an amount for everyone.'
          : `Custom amounts add up to ${formatRupees(allocated)}, not ${formatRupees(totalPaise)} (${allocated > totalPaise ? 'over' : 'short'} by ${formatRupees(Math.abs(totalPaise - allocated))}).`,
      details: {
        totalPaise,
        allocatedPaise: allocated,
        differencePaise: totalPaise - allocated,
        missing: missing.map((p) => p.id),
      },
    };
  }
  return { ok: true, amounts: people.map((p) => ({ id: p.id, amountPaise: p.customPaise! })) };
}
