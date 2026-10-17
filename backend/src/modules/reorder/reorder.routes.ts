import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { requireRole } from '../../middleware/auth.js';
import { requireIdempotencyKey } from '../../lib/idempotency.js';
import { MAX_QUANTITY } from '../cart/cart.service.js';
import {
  createSavedCombo,
  deleteSavedCombo,
  favoriteCombos,
  listSavedCombos,
  MAX_COMBO_LINES,
  previewReorder,
  reorderHistory,
  reorderIntoCart,
  updateSavedCombo,
} from './reorder.service.js';

const items = z
  .array(
    z
      .object({ menuItemId: z.uuid(), quantity: z.number().int().min(1).max(MAX_QUANTITY) })
      .strict(),
  )
  .min(1, 'Choose at least one dish')
  .max(MAX_COMBO_LINES)
  .refine((list) => new Set(list.map((i) => i.menuItemId)).size === list.length, 'Each dish once');

const previewBody = z.union([
  z.object({ orderId: z.uuid() }).strict(),
  z.object({ savedComboId: z.uuid() }).strict(),
  z.object({ items }).strict(),
]);

const cartBody = z
  .object({
    items,
    /** The current-price total the student reviewed; the server recomputes it. */
    expectedTotalPaise: z.number().int().positive(),
    replaceCart: z.boolean().default(false),
    source: z.discriminatedUnion('type', [
      z.object({ type: z.literal('ORDER'), orderId: z.uuid() }).strict(),
      z.object({ type: z.literal('SAVED_COMBO'), savedComboId: z.uuid() }).strict(),
      z.object({ type: z.literal('SUGGESTED_COMBO') }).strict(),
      z.object({ type: z.literal('POPULAR') }).strict(),
    ]),
  })
  .strict();

const comboName = z.string().trim().min(1, 'Name your combo').max(60);
const createComboBody = z.object({ name: comboName, items }).strict();
const updateComboBody = z
  .object({ name: comboName, items })
  .partial()
  .strict()
  .refine((v) => v.name !== undefined || v.items !== undefined, 'Nothing to change');

const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(20).default(6) });
const combosQuery = z.object({ outletId: z.uuid().optional() });

const comboIdParam = (req: Request) => {
  const parsed = z.uuid().safeParse(req.params.comboId);
  if (!parsed.success) throw notFound('Saved combo not found');
  return parsed.data;
};

/** /api/v1/reorder — Quick Reorder from the signed-in student's own history. */
export function reorderRouter(db: Database) {
  const router = Router();
  router.use(requireRole('STUDENT'));

  router.get('/history', async (req, res) => {
    const { limit } = historyQuery.parse(req.query);
    res.json(await reorderHistory(db, req.auth!.user.id, { limit }));
  });

  router.get('/combos', async (req, res) => {
    res.json(await favoriteCombos(db, req.auth!.user.id, combosQuery.parse(req.query)));
  });

  /** Read-only: what would go in the cart now, line by line, with alternatives. */
  router.post('/preview', async (req, res) => {
    res.json({ preview: await previewReorder(db, req.auth!.user.id, previewBody.parse(req.body)) });
  });

  /** Adds the reviewed dishes to the existing cart. Header Idempotency-Key required. */
  router.post('/cart', async (req, res) => {
    const idempotencyKey = requireIdempotencyKey(req);
    const body = cartBody.parse(req.body);
    const result = await reorderIntoCart(db, req.auth!.user.id, { ...body, idempotencyKey });
    res.status(result.added ? 201 : 200).json(result);
  });

  return router;
}

/** /api/v1/saved-combos — the student's own saved combos. */
export function savedCombosRouter(db: Database) {
  const router = Router();
  router.use(requireRole('STUDENT'));

  router.get('/', async (req, res) => {
    res.json({ combos: await listSavedCombos(db, req.auth!.user.id) });
  });

  router.post('/', async (req, res) => {
    const id = await createSavedCombo(db, req.auth!.user.id, createComboBody.parse(req.body));
    const combos = await listSavedCombos(db, req.auth!.user.id);
    res.status(201).json({ combo: combos.find((c) => c.id === id) });
  });

  router.patch('/:comboId', async (req, res) => {
    const id = comboIdParam(req);
    await updateSavedCombo(db, req.auth!.user.id, id, updateComboBody.parse(req.body));
    const combos = await listSavedCombos(db, req.auth!.user.id);
    res.json({ combo: combos.find((c) => c.id === id) });
  });

  router.delete('/:comboId', async (req, res) => {
    await deleteSavedCombo(db, req.auth!.user.id, comboIdParam(req));
    res.status(204).end();
  });

  return router;
}
