import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { requireRole } from '../../middleware/auth.js';
import type { ComboAdvisor } from './surprise.ai.js';
import {
  BUDGET_MAX_PAISE,
  BUDGET_MIN_PAISE,
  BUDGET_PRESETS,
  BUDGET_STEP_PAISE,
  DIETS,
  MAX_COMBO_ITEMS,
  MOODS,
} from './surprise.rules.js';
import { generateCombo, swapComboItem } from './surprise.service.js';
import { withRatings } from '../reviews/ratings.js';

const budgetPaise = z
  .number()
  .int()
  .min(BUDGET_MIN_PAISE, `The smallest budget is ₹${BUDGET_MIN_PAISE / 100}`)
  .max(BUDGET_MAX_PAISE, `The largest budget is ₹${BUDGET_MAX_PAISE / 100}`)
  .refine((v) => v % 100 === 0, 'Budgets are whole rupees');

const preferences = {
  budgetPaise,
  mood: z.enum(MOODS),
  diet: z.enum(DIETS),
  /** null = all outlets (the combo still comes from one outlet: carts hold one outlet). */
  outletId: z.uuid().nullable(),
};

const generateBody = z
  .object({
    ...preferences,
    /** The combo being replaced by a re-spin, so the next one differs when it can. */
    avoidItemIds: z.array(z.uuid()).max(MAX_COMBO_ITEMS).default([]),
  })
  .strict();

const swapBody = z
  .object({
    ...preferences,
    itemIds: z
      .array(z.uuid())
      .min(1)
      .max(MAX_COMBO_ITEMS)
      .refine((ids) => new Set(ids).size === ids.length, 'Each dish appears once'),
    replaceItemId: z.uuid(),
  })
  .strict()
  .refine((b) => b.itemIds.includes(b.replaceItemId), {
    path: ['replaceItemId'],
    message: 'The dish to swap must be in the combo',
  });

/** Adds each dish's real rating summary (from published reviews) to a combo. */
async function rateCombo<T extends { items: { id: string }[] }>(db: Database, combo: T) {
  return { ...combo, items: await withRatings(db, combo.items) };
}

/**
 * /api/v1/surprise-meal — the AI Surprise Meal budget solver for signed-in students.
 * Read-only: it never changes menus, carts or orders. The student is always the session
 * user; no request can name another student.
 */
export function surpriseMealRouter(db: Database, advisor: ComboAdvisor | null) {
  const router = Router();
  router.use(requireRole('STUDENT'));

  router.get('/options', (_req, res) => {
    res.json({
      budget: {
        minPaise: BUDGET_MIN_PAISE,
        maxPaise: BUDGET_MAX_PAISE,
        stepPaise: BUDGET_STEP_PAISE,
        presets: BUDGET_PRESETS,
      },
      moods: MOODS,
      diets: DIETS,
      aiAvailable: advisor !== null,
    });
  });

  router.post('/generate', async (req, res) => {
    const body = generateBody.parse(req.body);
    const result = await generateCombo(db, { ...body, userId: req.auth!.user.id, advisor });
    res.json({ ...result, combo: result.combo && (await rateCombo(db, result.combo)) });
  });

  router.post('/swap', async (req, res) => {
    const body = swapBody.parse(req.body);
    const result = await swapComboItem(db, { ...body, userId: req.auth!.user.id });
    res.json({ ...result, combo: await rateCombo(db, result.combo) });
  });

  return router;
}
