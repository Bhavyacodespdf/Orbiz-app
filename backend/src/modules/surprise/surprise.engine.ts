import type { Dietary } from '../../generated/prisma/enums.js';
import {
  MOOD_PROFILES,
  categoryAffinity,
  isDrinkCategory,
  type Diet,
  type Mood,
} from './surprise.rules.js';

/*
 * The deterministic budget solver. Pure functions over menu records that were already
 * loaded from the database (and filtered for availability, outlet and diet), so it is
 * easy to test and never touches data it wasn't given.
 *
 *   filter (service) → score each dish → build combos per outlet → pick the best → explain
 *
 * Randomness comes only from the injected `rng`, used for variety between re-spins.
 */

export interface Candidate {
  id: string;
  name: string;
  description: string;
  pricePaise: number;
  dietary: Dietary | null;
  imageUrl: string | null;
  categoryId: string;
  categoryName: string;
  outletId: string;
  outletName: string;
  outletSlug: string;
}

/** What the student has ordered before (their own completed or active orders only). */
export interface History {
  itemCounts: Map<string, number>;
  categoryCounts: Map<string, number>;
}

export const emptyHistory = (): History => ({ itemCounts: new Map(), categoryCounts: new Map() });

export interface SolveInput {
  candidates: Candidate[];
  budgetPaise: number;
  mood: Mood;
  diet: Diet;
  history: History;
  /** The previous combo: penalised so a re-spin gives something different when it can. */
  avoidItemIds: string[];
  rng: () => number;
}

export type Rng = () => number;

/** Small seeded PRNG (mulberry32) so tests and replays are reproducible. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Is this dish allowed at all under the dietary choice? (Hard rule, from the database field only.) */
export function fitsDiet(diet: Diet, dietary: Dietary | null): boolean {
  if (diet === 'VEG') return dietary === 'VEG';
  // Non-veg: every dish must have a known classification; the combo must also contain
  // at least one NON_VEG dish (checked by comboFitsDiet).
  if (diet === 'NON_VEG') return dietary !== null;
  return true;
}

export function comboFitsDiet(diet: Diet, items: { dietary: Dietary | null }[]): boolean {
  if (!items.every((i) => fitsDiet(diet, i.dietary))) return false;
  return diet !== 'NON_VEG' || items.some((i) => i.dietary === 'NON_VEG');
}

/** A dish's appeal for this request. Soft signals only; hard rules were applied before. */
export function scoreItem(
  item: Candidate,
  input: Pick<SolveInput, 'budgetPaise' | 'mood' | 'history' | 'avoidItemIds'>,
  jitter: number,
): number {
  const profile = MOOD_PROFILES[input.mood];
  const share = item.pricePaise / input.budgetPaise;
  let score = 1;
  score += 2 * categoryAffinity(input.mood, item.categoryName);
  // Lighter moods like cheaper dishes; feast-style moods like substantial ones.
  score += profile.budgetUse < 0 ? 1 - share : profile.budgetUse * share;
  const timesOrdered = input.history.itemCounts.get(item.id) ?? 0;
  if (timesOrdered > 0) score += 1 + Math.min(1, Math.log2(1 + timesOrdered) / 3);
  if ((input.history.categoryCounts.get(item.categoryName.toLowerCase()) ?? 0) > 0) score += 0.5;
  if (input.avoidItemIds.includes(item.id)) score -= 3;
  return score + jitter;
}

export interface Combo {
  items: Candidate[];
  totalPaise: number;
}

const total = (items: { pricePaise: number }[]) => items.reduce((s, i) => s + i.pricePaise, 0);

function comboScore(items: Candidate[], scores: Map<string, number>, input: SolveInput): number {
  const profile = MOOD_PROFILES[input.mood];
  let score = items.reduce((s, i) => s + (scores.get(i.id) ?? 0), 0);
  const categories = new Set(items.map((i) => i.categoryId));
  score += 1.5 * (categories.size - 1); // variety
  if (items.length < profile.minItems) score -= 2 * (profile.minItems - items.length);
  const used = total(items) / input.budgetPaise;
  score += profile.budgetUse < 0 ? 1.5 * (1 - used) : 2 * profile.budgetUse * used;
  if (profile.wantsDrink && items.some((i) => isDrinkCategory(i.categoryName))) score += 2;
  const previous = new Set(input.avoidItemIds);
  if (
    previous.size > 0 &&
    items.length === previous.size &&
    items.every((i) => previous.has(i.id))
  ) {
    score -= 10; // the exact previous combo: only if nothing else fits
  }
  return score;
}

/** One randomised greedy pass within a single outlet. */
function greedy(
  pool: Candidate[],
  scores: Map<string, number>,
  input: SolveInput,
  noise: number,
): Candidate[] {
  const profile = MOOD_PROFILES[input.mood];
  const order = pool
    .map((item) => ({ item, key: (scores.get(item.id) ?? 0) + input.rng() * noise }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.item);

  const chosen: Candidate[] = [];
  let spent = 0;
  const take = (item: Candidate) => {
    chosen.push(item);
    spent += item.pricePaise;
  };

  // Seed the combo with what the request needs most, if anything fits.
  if (input.diet === 'NON_VEG') {
    const meat = order.find((i) => i.dietary === 'NON_VEG' && i.pricePaise <= input.budgetPaise);
    if (!meat) return [];
    take(meat);
  }
  if (profile.wantsDrink) {
    const drink = order.find(
      (i) =>
        isDrinkCategory(i.categoryName) &&
        !chosen.includes(i) &&
        spent + i.pricePaise <= input.budgetPaise,
    );
    if (drink) take(drink);
  }

  for (const item of order) {
    if (chosen.length >= profile.maxItems) break;
    if (chosen.includes(item) || spent + item.pricePaise > input.budgetPaise) continue;
    // Prefer variety: a second dish from a category already chosen only on some passes.
    if (chosen.some((c) => c.categoryId === item.categoryId) && input.rng() < 0.7) continue;
    take(item);
    // Quick bites stop once they have something satisfying.
    if (profile.budgetUse < 0 && chosen.length >= profile.minItems && input.rng() < 0.5) break;
  }
  return chosen;
}

const PASSES = 40;

/**
 * The best combo within budget, from ONE outlet (CampusCart carts hold one outlet's
 * items). Returns null when nothing valid exists. The total never exceeds the budget.
 */
export function solveCombo(input: SolveInput): Combo | null {
  const scores = new Map(
    input.candidates.map((c) => [c.id, scoreItem(c, input, input.rng() * 1.2)]),
  );
  const byOutlet = new Map<string, Candidate[]>();
  for (const c of input.candidates) {
    if (c.pricePaise > input.budgetPaise || !fitsDiet(input.diet, c.dietary)) continue;
    byOutlet.set(c.outletId, [...(byOutlet.get(c.outletId) ?? []), c]);
  }

  let best: { items: Candidate[]; score: number } | null = null;
  for (const pool of byOutlet.values()) {
    for (let pass = 0; pass < PASSES; pass++) {
      const items = greedy(pool, scores, input, pass === 0 ? 0 : 2);
      if (items.length === 0 || total(items) > input.budgetPaise) continue;
      if (!comboFitsDiet(input.diet, items)) continue;
      const score = comboScore(items, scores, input) + input.rng() * 0.5;
      if (!best || score > best.score) best = { items, score };
    }
  }
  if (!best) return null;
  const items = [...best.items].sort((a, b) => b.pricePaise - a.pricePaise);
  return { items, totalPaise: total(items) };
}

/**
 * A replacement for one dish: same outlet, not already in the combo, within what the
 * other dishes leave of the budget, keeping the combo's dietary rules. Prefers a dish
 * from the same category (a like-for-like swap). Null when nothing fits.
 */
export function findReplacement(input: {
  combo: Candidate[];
  replaceId: string;
  candidates: Candidate[];
  budgetPaise: number;
  mood: Mood;
  diet: Diet;
  history: History;
  rng: Rng;
}): Candidate | null {
  const replaced = input.combo.find((c) => c.id === input.replaceId);
  if (!replaced) return null;
  const others = input.combo.filter((c) => c.id !== input.replaceId);
  const leftPaise = input.budgetPaise - total(others);
  const options = input.candidates.filter(
    (c) =>
      c.outletId === replaced.outletId &&
      !input.combo.some((x) => x.id === c.id) &&
      c.pricePaise <= leftPaise &&
      comboFitsDiet(input.diet, [...others, c]),
  );
  if (options.length === 0) return null;
  const context = {
    budgetPaise: input.budgetPaise,
    mood: input.mood,
    history: input.history,
    avoidItemIds: [],
  };
  const ranked = options
    .map((c) => ({
      c,
      score:
        scoreItem(c, context, input.rng() * 1.5) +
        (c.categoryId === replaced.categoryId ? 1.5 : 0) +
        (others.some((o) => o.categoryId === c.categoryId) ? -1 : 0),
    }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]!.c;
}

/** Plain-language reasons for a combo, built only from facts we have. */
export function explainCombo(
  combo: Combo,
  input: Pick<SolveInput, 'budgetPaise' | 'mood' | 'history'>,
): string[] {
  const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN')}`;
  const left = input.budgetPaise - combo.totalPaise;
  const reasons = [
    left > 0
      ? `Fits your ${rupees(input.budgetPaise)} budget with ${rupees(left)} to spare.`
      : `Uses exactly your ${rupees(input.budgetPaise)} budget.`,
  ];
  const categories = [...new Set(combo.items.map((i) => i.categoryName))];
  if (categories.length > 1) reasons.push(`Mixes ${categories.join(' and ')}.`);
  const familiar = combo.items.filter((i) => (input.history.itemCounts.get(i.id) ?? 0) > 0);
  if (familiar.length > 0) {
    reasons.push(
      `Includes ${familiar.map((i) => i.name).join(' and ')}, which you’ve ordered before.`,
    );
  }
  const moodLine: Record<Mood, string> = {
    QUICK_BITE: 'Kept light for a quick bite.',
    HIGH_PROTEIN: 'Built around filling mains.',
    CAFE_TREAT: 'Leans towards drinks and treats.',
    FEAST: 'Goes big for a feast.',
  };
  reasons.push(moodLine[input.mood]);
  return reasons;
}
