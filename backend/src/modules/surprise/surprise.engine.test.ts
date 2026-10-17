import { describe, expect, it } from 'vitest';
import {
  emptyHistory,
  findReplacement,
  seededRng,
  solveCombo,
  type Candidate,
} from './surprise.engine.js';
import type { Diet, Mood } from './surprise.rules.js';

let n = 0;
function dish(overrides: Partial<Candidate>): Candidate {
  n += 1;
  return {
    id: `d${n}`,
    name: `Dish ${n}`,
    description: '',
    pricePaise: 5_000,
    dietary: 'VEG',
    imageUrl: null,
    categoryId: 'snacks',
    categoryName: 'Snacks',
    outletId: 'o1',
    outletName: 'Canteen',
    outletSlug: 'canteen',
    ...overrides,
  };
}

const menu = [
  dish({ id: 'thali', pricePaise: 12_000, categoryId: 'meals', categoryName: 'Meals' }),
  dish({
    id: 'biryani',
    pricePaise: 15_000,
    dietary: 'NON_VEG',
    categoryId: 'meals',
    categoryName: 'Meals',
  }),
  dish({
    id: 'curry',
    pricePaise: 10_000,
    dietary: null,
    categoryId: 'meals',
    categoryName: 'Meals',
  }),
  dish({ id: 'chai', pricePaise: 2_000, categoryId: 'drinks', categoryName: 'Hot drinks' }),
  dish({ id: 'coffee', pricePaise: 6_000, categoryId: 'drinks', categoryName: 'Hot drinks' }),
  dish({ id: 'samosa', pricePaise: 1_500 }),
  dish({ id: 'eggpuff', pricePaise: 3_000, dietary: 'EGG' }),
  dish({
    id: 'latte',
    pricePaise: 9_000,
    outletId: 'o2',
    outletName: 'Cafe',
    categoryId: 'cafe-drinks',
    categoryName: 'Coffee',
  }),
  dish({
    id: 'brownie',
    pricePaise: 8_000,
    outletId: 'o2',
    outletName: 'Cafe',
    categoryId: 'desserts',
    categoryName: 'Desserts',
  }),
];

const solve = (
  overrides: {
    budgetPaise?: number;
    mood?: Mood;
    diet?: Diet;
    seed?: number;
    avoid?: string[];
    candidates?: Candidate[];
  } = {},
) =>
  solveCombo({
    candidates: overrides.candidates ?? menu,
    budgetPaise: overrides.budgetPaise ?? 20_000,
    mood: overrides.mood ?? 'FEAST',
    diet: overrides.diet ?? 'ANY',
    history: emptyHistory(),
    avoidItemIds: overrides.avoid ?? [],
    rng: seededRng(overrides.seed ?? 1),
  });

const moods: Mood[] = ['QUICK_BITE', 'HIGH_PROTEIN', 'CAFE_TREAT', 'FEAST'];
const diets: Diet[] = ['ANY', 'VEG', 'NON_VEG'];

describe('budget solver', () => {
  it('never exceeds the budget and always uses one outlet, across many requests', () => {
    for (const budgetPaise of [1_500, 3_000, 8_000, 14_000, 20_000, 30_000, 100_000]) {
      for (const mood of moods) {
        for (const diet of diets) {
          for (let seed = 1; seed <= 15; seed++) {
            const combo = solve({ budgetPaise, mood, diet, seed });
            if (!combo) continue;
            expect(combo.totalPaise).toBeLessThanOrEqual(budgetPaise);
            expect(combo.totalPaise).toBe(combo.items.reduce((s, i) => s + i.pricePaise, 0));
            expect(new Set(combo.items.map((i) => i.outletId)).size).toBe(1);
            expect(new Set(combo.items.map((i) => i.id)).size).toBe(combo.items.length);
          }
        }
      }
    }
  });

  it('uses only vegetarian dishes for Veg: never egg, non-veg or unclassified', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const combo = solve({ diet: 'VEG', seed, budgetPaise: 40_000 })!;
      expect(combo.items.every((i) => i.dietary === 'VEG')).toBe(true);
    }
  });

  it('for Non-veg includes a non-veg dish and never an unclassified one', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const combo = solve({ diet: 'NON_VEG', seed, budgetPaise: 40_000 })!;
      expect(combo.items.some((i) => i.dietary === 'NON_VEG')).toBe(true);
      expect(combo.items.every((i) => i.dietary !== null)).toBe(true);
    }
    expect(solve({ diet: 'NON_VEG', budgetPaise: 14_000 })).toBeNull(); // biryani costs ₹150
  });

  it('returns one dish when the budget only allows one', () => {
    const combo = solve({ budgetPaise: 1_500, mood: 'FEAST' })!;
    expect(combo.items.map((i) => i.id)).toEqual(['samosa']);
    expect(solve({ budgetPaise: 1_000 })).toBeNull();
  });

  it('lets the mood shape the combo', () => {
    let cafeDrinks = 0;
    let feastSpend = 0;
    let quickSpend = 0;
    let feastItems = 0;
    let quickItems = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const cafe = solve({ mood: 'CAFE_TREAT', seed, budgetPaise: 20_000 })!;
      if (cafe.items.some((i) => /drinks|coffee/i.test(i.categoryName))) cafeDrinks += 1;
      const feast = solve({ mood: 'FEAST', seed, budgetPaise: 30_000 })!;
      const quick = solve({ mood: 'QUICK_BITE', seed, budgetPaise: 30_000 })!;
      feastSpend += feast.totalPaise;
      quickSpend += quick.totalPaise;
      feastItems += feast.items.length;
      quickItems += quick.items.length;
    }
    expect(cafeDrinks).toBe(40);
    expect(feastSpend).toBeGreaterThan(quickSpend * 1.5);
    expect(feastItems).toBeGreaterThan(quickItems);
  });

  it('gives a different combo on a re-spin when alternatives exist', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const first = solve({ seed, budgetPaise: 14_000, mood: 'CAFE_TREAT' })!;
      const again = solve({
        seed: seed + 100,
        budgetPaise: 14_000,
        mood: 'CAFE_TREAT',
        avoid: first.items.map((i) => i.id),
      })!;
      expect(again.items.map((i) => i.id).sort()).not.toEqual(first.items.map((i) => i.id).sort());
    }
  });

  it('ranks dishes the student orders often higher, but never past the hard rules', () => {
    const history = emptyHistory();
    history.itemCounts.set('eggpuff', 8);
    let picked = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const combo = solveCombo({
        candidates: menu,
        budgetPaise: 8_000,
        mood: 'QUICK_BITE',
        diet: 'ANY',
        history,
        avoidItemIds: [],
        rng: seededRng(seed),
      })!;
      if (combo.items.some((i) => i.id === 'eggpuff')) picked += 1;
      const veg = solveCombo({
        candidates: menu,
        budgetPaise: 8_000,
        mood: 'QUICK_BITE',
        diet: 'VEG',
        history,
        avoidItemIds: [],
        rng: seededRng(seed),
      })!;
      expect(veg.items.some((i) => i.id === 'eggpuff')).toBe(false);
    }
    expect(picked).toBeGreaterThan(20);
  });
});

describe('swapping one dish', () => {
  const combo = [menu[0]!, menu[3]!]; // thali ₹120 + chai ₹20

  it('keeps the other dishes and stays within what they leave of the budget', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const next = findReplacement({
        combo,
        replaceId: 'chai',
        candidates: menu,
        budgetPaise: 15_000,
        mood: 'CAFE_TREAT',
        diet: 'ANY',
        history: emptyHistory(),
        rng: seededRng(seed),
      })!;
      expect(next.id).not.toBe('chai');
      expect(next.id).not.toBe('thali');
      expect(next.outletId).toBe('o1');
      expect(next.pricePaise).toBeLessThanOrEqual(3_000); // ₹150 − ₹120
    }
  });

  it('returns nothing when no other dish fits the remaining budget', () => {
    // Samosa ₹15 + chai ₹20 on a ₹35 budget: swapping chai leaves ₹20, and the only
    // dish that cheap is the chai itself (excluded) or the samosa (already in the combo).
    expect(
      findReplacement({
        combo: [menu[5]!, menu[3]!],
        replaceId: 'chai',
        candidates: menu,
        budgetPaise: 3_500,
        mood: 'QUICK_BITE',
        diet: 'ANY',
        history: emptyHistory(),
        rng: seededRng(1),
      }),
    ).toBeNull();
  });

  it('keeps a Non-veg combo non-veg when its only non-veg dish is swapped', () => {
    const meat = [menu[1]!, menu[3]!]; // biryani + chai
    const next = findReplacement({
      combo: meat,
      replaceId: 'biryani',
      candidates: [
        ...menu,
        dish({
          id: 'kebab',
          pricePaise: 14_000,
          dietary: 'NON_VEG',
          categoryId: 'meals',
          categoryName: 'Meals',
        }),
      ],
      budgetPaise: 20_000,
      mood: 'FEAST',
      diet: 'NON_VEG',
      history: emptyHistory(),
      rng: seededRng(3),
    })!;
    expect(next.dietary).toBe('NON_VEG');
  });
});
