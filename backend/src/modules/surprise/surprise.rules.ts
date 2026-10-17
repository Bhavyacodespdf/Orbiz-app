/*
 * AI Surprise Meal — Budget Solver: the fixed rules. Budgets are whole rupees, held in
 * paise like every other amount in CampusCart.
 */

export const BUDGET_MIN_PAISE = 5_000; // ₹50
export const BUDGET_MAX_PAISE = 100_000; // ₹1,000
export const BUDGET_STEP_PAISE = 1_000; // ₹10 slider steps (any whole rupee is accepted)

export const BUDGET_PRESETS = [
  { label: 'Snack', budgetPaise: 8_000 },
  { label: 'Lunch', budgetPaise: 14_000 },
  { label: 'Power', budgetPaise: 20_000 },
  { label: 'Feast', budgetPaise: 30_000 },
] as const;

export const MOODS = ['QUICK_BITE', 'HIGH_PROTEIN', 'CAFE_TREAT', 'FEAST'] as const;
export type Mood = (typeof MOODS)[number];

export const DIETS = ['ANY', 'VEG', 'NON_VEG'] as const;
export type Diet = (typeof DIETS)[number];

/** Most dishes in one combo (each once). */
export const MAX_COMBO_ITEMS = 4;

export interface MoodProfile {
  /** Fewest / most dishes this mood aims for (fewer if the budget or menu can't fit them). */
  minItems: number;
  maxItems: number;
  /**
   * Words matched against the outlet's own CATEGORY names (e.g. "Hot drinks", "Meals").
   * A soft ranking signal only — never used for dietary, outlet or availability rules.
   */
  categoryWords: readonly string[];
  /** How much of the budget the mood likes to use: -1 = as little as possible, 1 = as much. */
  budgetUse: number;
  /** Rewards a combo that includes a drink/treat-style category (Cafe & Treat). */
  wantsDrink: boolean;
}

const DRINK_WORDS = [
  'drink',
  'beverage',
  'coffee',
  'tea',
  'chai',
  'juice',
  'shake',
  'smoothie',
  'soda',
  'cooler',
];
const TREAT_WORDS = [
  'dessert',
  'sweet',
  'bakery',
  'cake',
  'treat',
  'ice cream',
  'pastry',
  'cookie',
];
const LIGHT_WORDS = [
  'snack',
  'roll',
  'wrap',
  'sandwich',
  'puff',
  'bite',
  'chaat',
  'burger',
  'momo',
  'fast food',
];
const MAIN_WORDS = [
  'meal',
  'main',
  'thali',
  'rice',
  'biryani',
  'curry',
  'combo',
  'platter',
  'roll',
  'wrap',
  'burger',
];

export const MOOD_PROFILES: Record<Mood, MoodProfile> = {
  QUICK_BITE: {
    minItems: 1,
    maxItems: 2,
    categoryWords: LIGHT_WORDS,
    budgetUse: -1,
    wantsDrink: false,
  },
  // There is no protein data on CampusCart menus, so this mood favours filling mains
  // and says so; it never claims an item is high in protein.
  HIGH_PROTEIN: {
    minItems: 1,
    maxItems: 3,
    categoryWords: MAIN_WORDS,
    budgetUse: 0.5,
    wantsDrink: false,
  },
  CAFE_TREAT: {
    minItems: 2,
    maxItems: 3,
    categoryWords: [...DRINK_WORDS, ...TREAT_WORDS, 'snack'],
    budgetUse: 0,
    wantsDrink: true,
  },
  FEAST: {
    minItems: 2,
    maxItems: MAX_COMBO_ITEMS,
    categoryWords: MAIN_WORDS,
    budgetUse: 1,
    wantsDrink: false,
  },
};

export const isDrinkCategory = (categoryName: string) =>
  [...DRINK_WORDS, ...TREAT_WORDS].some((w) => categoryName.toLowerCase().includes(w));

export function categoryAffinity(mood: Mood, categoryName: string): number {
  const name = categoryName.toLowerCase();
  return MOOD_PROFILES[mood].categoryWords.some((w) => name.includes(w)) ? 1 : 0;
}

/** Shown with every result, because it is true for every CampusCart menu today. */
export const NUTRITION_NOTE =
  'Calories, protein and preparation times aren’t recorded on CampusCart menus yet, so they aren’t shown.';

export const HIGH_PROTEIN_NOTE =
  'Protein isn’t recorded on CampusCart menus, so dishes aren’t ranked by protein. This mood favours filling mains instead.';
