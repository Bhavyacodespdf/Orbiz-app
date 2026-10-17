import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { requireRole } from '../../middleware/auth.js';
import { requireIdempotencyKey } from '../../lib/idempotency.js';
import {
  addCombo,
  addItem,
  clearCart,
  getCartView,
  MAX_QUANTITY,
  removeItem,
  setQuantity,
} from './cart.service.js';

const quantity = z.number().int().min(1).max(MAX_QUANTITY);
const addBody = z
  .object({
    menuItemId: z.uuid(),
    quantity: quantity.default(1),
    replaceCart: z.boolean().default(false),
  })
  .strict();
const quantityBody = z.object({ quantity }).strict();
const comboBody = z
  .object({
    items: z
      .array(z.object({ menuItemId: z.uuid(), quantity }).strict())
      .min(1)
      .max(6)
      .refine(
        (items) => new Set(items.map((i) => i.menuItemId)).size === items.length,
        'Each dish once',
      ),
    /** The combo total the student saw; the server recomputes it from live prices. */
    expectedTotalPaise: z.number().int().positive(),
    replaceCart: z.boolean().default(false),
  })
  .strict();

function menuItemIdParam(value: unknown): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw notFound('That item is not in your cart.');
  return parsed.data;
}

/** /api/v1/cart — the signed-in student's own cart. There is no way to address anyone else's. */
export function cartRouter(db: Database) {
  const router = Router();
  router.use(requireRole('STUDENT'));

  router.get('/', async (req, res) => {
    res.json({ cart: await getCartView(db, req.auth!.user.id) });
  });

  /** Adds a whole Surprise Meal combo atomically. Header Idempotency-Key required. */
  router.post('/combo', async (req, res) => {
    const idempotencyKey = requireIdempotencyKey(req);
    const body = comboBody.parse(req.body);
    const { cart, added } = await addCombo(db, req.auth!.user.id, { ...body, idempotencyKey });
    res.status(added ? 201 : 200).json({ cart, added });
  });

  router.post('/items', async (req, res) => {
    const body = addBody.parse(req.body);
    res.json({ cart: await addItem(db, req.auth!.user.id, body) });
  });

  router.patch('/items/:menuItemId', async (req, res) => {
    const { quantity: q } = quantityBody.parse(req.body);
    res.json({
      cart: await setQuantity(db, req.auth!.user.id, menuItemIdParam(req.params.menuItemId), q),
    });
  });

  router.delete('/items/:menuItemId', async (req, res) => {
    res.json({
      cart: await removeItem(db, req.auth!.user.id, menuItemIdParam(req.params.menuItemId)),
    });
  });

  router.delete('/', async (req, res) => {
    await clearCart(db, req.auth!.user.id);
    res.json({ cart: await getCartView(db, req.auth!.user.id) });
  });

  return router;
}
