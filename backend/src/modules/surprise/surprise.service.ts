import { randomInt } from 'node:crypto';
import type { Database } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { askAdvisor, validateAdvice, type ComboAdvisor } from './surprise.ai.js';
import {
  comboFitsDiet,
  explainCombo,
  findReplacement,
  fitsDiet,
  seededRng,
  solveCombo,
  type Candidate,
  type History,
  type Rng,
} from './surprise.engine.js';
import { inStockWhere } from '../inventory/stock.js';
import { HIGH_PROTEIN_NOTE, NUTRITION_NOTE, type Diet, type Mood } from './surprise.rules.js';

/** Upper bound on dishes considered per request (menus are far smaller today). */
const CANDIDATE_LIMIT = 500;

/** Orderable right now: active, in stock, in an active category, at an active outlet that is OPEN. */
const orderable = (outletId: string | null): Prisma.MenuItemWhereInput => ({
  isActive: true,
  ...inStockWhere, // never sold out (marked, or none left)
  category: { isActive: true },
  outlet: { isActive: true, status: 'OPEN', ...(outletId && { id: outletId }) },
});

async function loadCandidates(
  db: Database,
  where: Prisma.MenuItemWhereInput,
): Promise<Candidate[]> {
  const rows = await db.menuItem.findMany({
    where,
    include: { category: true, outlet: true },
    orderBy: [{ pricePaise: 'asc' }, { id: 'asc' }],
    take: CANDIDATE_LIMIT,
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    pricePaise: r.pricePaise,
    dietary: r.dietary,
    imageUrl: r.imageUrl,
    categoryId: r.categoryId,
    categoryName: r.category.name,
    outletId: r.outletId,
    outletName: r.outlet.name,
    outletSlug: r.outlet.slug,
  }));
}

/**
 * The signed-in student's own ordering habits (never anyone else's): dishes and
 * categories from their recent orders that weren't rejected or cancelled.
 */
export async function loadHistory(db: Database, userId: string): Promise<History> {
  const rows = await db.orderItem.findMany({
    where: { order: { userId, status: { notIn: ['REJECTED', 'CANCELLED'] } } },
    select: {
      menuItemId: true,
      quantity: true,
      menuItem: { select: { category: { select: { name: true } } } },
    },
    orderBy: { order: { placedAt: 'desc' } },
    take: 200,
  });
  const history: History = { itemCounts: new Map(), categoryCounts: new Map() };
  for (const row of rows) {
    history.itemCounts.set(
      row.menuItemId,
      (history.itemCounts.get(row.menuItemId) ?? 0) + row.quantity,
    );
    const category = row.menuItem.category.name.toLowerCase();
    history.categoryCounts.set(
      category,
      (history.categoryCounts.get(category) ?? 0) + row.quantity,
    );
  }
  return history;
}

export interface Preferences {
  budgetPaise: number;
  mood: Mood;
  diet: Diet;
  outletId: string | null;
}

function toItem(c: Candidate) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    pricePaise: c.pricePaise,
    dietary: c.dietary,
    imageUrl: c.imageUrl,
    category: { id: c.categoryId, name: c.categoryName },
  };
}

function toCombo(
  items: Candidate[],
  prefs: Preferences,
  source: 'RULES' | 'AI',
  reasons: string[],
) {
  const totalPaise = items.reduce((s, i) => s + i.pricePaise, 0);
  if (totalPaise > prefs.budgetPaise) throw new Error('Combo over budget'); // last line of defence
  const first = items[0]!;
  return {
    source,
    outlet: { id: first.outletId, name: first.outletName, slug: first.outletSlug },
    items: items.map(toItem),
    itemCount: items.length,
    totalPaise,
    budgetPaise: prefs.budgetPaise,
    remainingPaise: prefs.budgetPaise - totalPaise,
    reasons,
    nutrition: { available: false as const, note: NUTRITION_NOTE },
  };
}

export type ComboView = ReturnType<typeof toCombo>;

const notices = (mood: Mood) => (mood === 'HIGH_PROTEIN' ? [HIGH_PROTEIN_NOTE] : []);

const noCombo = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  combo: null,
  reason: { code, message, ...extra },
});

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

/**
 * Re-reads the chosen dishes from the database and checks every rule again. This is
 * what the student receives — whatever the solver or an AI provider produced.
 */
async function confirmFromDatabase(db: Database, ids: string[], prefs: Preferences) {
  const fresh = await loadCandidates(db, { ...orderable(prefs.outletId), id: { in: ids } });
  const byId = new Map(fresh.map((c) => [c.id, c]));
  const items = ids.map((id) => byId.get(id));
  if (items.some((i) => !i)) return null;
  const confirmed = items as Candidate[];
  if (new Set(confirmed.map((i) => i.outletId)).size !== 1) return null;
  if (!comboFitsDiet(prefs.diet, confirmed)) return null;
  if (confirmed.reduce((s, i) => s + i.pricePaise, 0) > prefs.budgetPaise) return null;
  return confirmed;
}

export async function generateCombo(
  db: Database,
  params: Preferences & {
    userId: string;
    avoidItemIds: string[];
    advisor: ComboAdvisor | null;
    rng?: Rng;
  },
) {
  const rng = params.rng ?? seededRng(randomInt(2 ** 31));
  const prefs: Preferences = params;

  if (params.outletId) {
    const outlet = await db.outlet.findFirst({ where: { id: params.outletId, isActive: true } });
    if (!outlet) throw notFound('Outlet not found');
    if (outlet.status !== 'OPEN') {
      return {
        ...noCombo(
          'OUTLET_NOT_ACCEPTING',
          `${outlet.name} isn’t taking orders right now. Try another outlet.`,
        ),
        notices: notices(params.mood),
      };
    }
  }

  const all = await loadCandidates(db, orderable(params.outletId));
  const eligible = all.filter((c) => fitsDiet(params.diet, c.dietary));
  const where = params.outletId ? 'at this outlet' : 'at any open outlet';
  if (eligible.length === 0) {
    return {
      ...noCombo(
        'NO_MATCHING_DISHES',
        params.diet === 'ANY'
          ? `No dishes are available ${where} right now.`
          : `No ${params.diet === 'VEG' ? 'vegetarian' : 'classified'} dishes are available ${where} right now. Try another outlet or diet.`,
      ),
      notices: notices(params.mood),
    };
  }
  if (params.diet === 'NON_VEG' && !eligible.some((c) => c.dietary === 'NON_VEG')) {
    return {
      ...noCombo(
        'NO_NON_VEG',
        `No non-veg dishes are available ${where} right now. Try another outlet or diet.`,
      ),
      notices: notices(params.mood),
    };
  }
  const cheapest = Math.min(
    ...eligible
      .filter((c) => params.diet !== 'NON_VEG' || c.dietary === 'NON_VEG')
      .map((c) => c.pricePaise),
  );
  if (cheapest > params.budgetPaise) {
    return {
      ...noCombo(
        'BUDGET_TOO_LOW',
        `The cheapest matching dish costs ${rupees(cheapest)}. Raise your budget to at least that, or change a filter.`,
        { cheapestPaise: cheapest },
      ),
      notices: notices(params.mood),
    };
  }

  const history = await loadHistory(db, params.userId);
  const affordable = eligible.filter((c) => c.pricePaise <= params.budgetPaise);

  // 1. Optional AI suggestion, validated against the candidates; ignored if anything is off.
  if (params.advisor) {
    const raw = await askAdvisor(params.advisor, {
      budgetPaise: params.budgetPaise,
      mood: params.mood,
      diet: params.diet,
      candidates: affordable.slice(0, 80).map((c) => ({
        id: c.id,
        name: c.name,
        category: c.categoryName,
        pricePaise: c.pricePaise,
        outlet: c.outletName,
      })),
    });
    const advice = validateAdvice(raw, {
      candidates: affordable,
      budgetPaise: params.budgetPaise,
      diet: params.diet,
      outletId: params.outletId,
    });
    if (advice.ok) {
      const confirmed = await confirmFromDatabase(
        db,
        advice.items.map((i) => i.id),
        prefs,
      );
      if (confirmed) {
        const combo = {
          items: confirmed,
          totalPaise: confirmed.reduce((s, i) => s + i.pricePaise, 0),
        };
        const reasons = explainCombo(combo, { ...params, history });
        return {
          combo: toCombo(
            confirmed,
            prefs,
            'AI',
            advice.explanation ? [advice.explanation, ...reasons] : reasons,
          ),
          reason: null,
          notices: notices(params.mood),
        };
      }
    }
    logger.info(
      { advisor: params.advisor.name, reason: advice.ok ? 'stale' : advice.reason },
      'AI combo rejected; using the rules engine',
    );
  }

  // 2. The deterministic solver.
  const solved = solveCombo({
    candidates: affordable,
    budgetPaise: params.budgetPaise,
    mood: params.mood,
    diet: params.diet,
    history,
    avoidItemIds: params.avoidItemIds,
    rng,
  });
  if (!solved) {
    return {
      ...noCombo(
        'NO_COMBO_FITS',
        `No combo fits ${rupees(params.budgetPaise)} with these filters. Try a bigger budget or another filter.`,
      ),
      notices: notices(params.mood),
    };
  }
  const confirmed = await confirmFromDatabase(
    db,
    solved.items.map((i) => i.id),
    prefs,
  );
  if (!confirmed) {
    throw new AppError(409, 'MENU_CHANGED', 'The menu just changed. Please try again.');
  }
  return {
    combo: toCombo(confirmed, prefs, 'RULES', explainCombo(solved, { ...params, history })),
    reason: null,
    notices: notices(params.mood),
  };
}

export async function swapComboItem(
  db: Database,
  params: Preferences & { userId: string; itemIds: string[]; replaceItemId: string; rng?: Rng },
) {
  const rng = params.rng ?? seededRng(randomInt(2 ** 31));
  const prefs: Preferences = params;
  // The current combo must still be valid as it stands, from the database's point of view.
  const current = await confirmFromDatabase(db, params.itemIds, prefs);
  if (!current) {
    throw new AppError(
      409,
      'COMBO_OUT_OF_DATE',
      'Something in this combo changed (price or availability). Re-spin for a fresh combo.',
    );
  }
  const outletId = current[0]!.outletId;
  const candidates = (await loadCandidates(db, orderable(outletId))).filter((c) =>
    fitsDiet(params.diet, c.dietary),
  );
  const history = await loadHistory(db, params.userId);
  const replacement = findReplacement({
    combo: current,
    replaceId: params.replaceItemId,
    candidates,
    budgetPaise: params.budgetPaise,
    mood: params.mood,
    diet: params.diet,
    history,
    rng,
  });

  const replaced = current.find((c) => c.id === params.replaceItemId)!;
  if (!replacement) {
    const leftPaise =
      params.budgetPaise - current.reduce((s, i) => s + i.pricePaise, 0) + replaced.pricePaise;
    const combo = { items: current, totalPaise: current.reduce((s, i) => s + i.pricePaise, 0) };
    return {
      swapped: false,
      message: `No other dish fits the ${rupees(leftPaise)} available for ${replaced.name}, so it stays.`,
      combo: toCombo(current, prefs, 'RULES', explainCombo(combo, { ...params, history })),
      notices: notices(params.mood),
    };
  }

  const nextIds = current.map((c) => (c.id === params.replaceItemId ? replacement.id : c.id));
  const confirmed = await confirmFromDatabase(db, nextIds, prefs);
  if (!confirmed)
    throw new AppError(409, 'MENU_CHANGED', 'The menu just changed. Please try again.');
  const combo = { items: confirmed, totalPaise: confirmed.reduce((s, i) => s + i.pricePaise, 0) };
  return {
    swapped: true,
    message: `Swapped ${replaced.name} for ${replacement.name}.`,
    replacedItemId: replaced.id,
    newItemId: replacement.id,
    combo: toCombo(confirmed, prefs, 'RULES', explainCombo(combo, { ...params, history })),
    notices: notices(params.mood),
  };
}
