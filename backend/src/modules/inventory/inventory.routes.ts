import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireOutletRole } from '../../middleware/outlet-access.js';
import type { StaffRole } from '../../generated/prisma/enums.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import { uuidParam } from '../outlets/outlets.schema.js';
import { MAX_STOCK, MAX_THRESHOLD, STOCK_STATUSES } from './stock.js';
import {
  adjustStock,
  listInventory,
  setThreshold,
  setTracking,
  stockHistory,
  type Actor,
} from './inventory.service.js';

const quantity = z.number().int().min(1).max(MAX_STOCK);
const count = z.number().int().min(0).max(MAX_STOCK);
const threshold = z.number().int().min(0).max(MAX_THRESHOLD);
const reason = z.string().trim().max(200);

const listQuery = z.object({
  q: z
    .string()
    .trim()
    .max(60)
    .optional()
    .transform((v) => v || undefined),
  categoryId: uuidParam.optional(),
  status: z.enum(STOCK_STATUSES).optional(),
});

const adjustmentBody = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('RESTOCK'),
      quantity,
      reason: reason.optional(),
      markAvailable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('REMOVAL'),
      quantity,
      reason: reason.min(3, 'Say why stock is being removed'),
    })
    .strict(),
  z
    .object({
      type: z.literal('COUNT_SET'),
      quantity: count,
      expectedQuantity: count,
      reason: reason.optional(),
    })
    .strict(),
]);

const thresholdBody = z.object({ lowStockThreshold: threshold }).strict();
const trackingBody = z
  .object({
    enabled: z.boolean(),
    quantity: count.optional(),
    lowStockThreshold: threshold.optional(),
  })
  .strict();

function idParam(req: Request, name: string): string {
  const parsed = uuidParam.safeParse(req.params[name]);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

/** The staff roles the user holds AT this outlet (live role + assignment). */
async function rolesAtOutlet(db: Database, req: Request, outletId: string): Promise<StaffRole[]> {
  const live = req.auth!.user.roles.filter((r): r is StaffRole => r === 'MANAGER' || r === 'POS');
  const assignments = await db.staffAssignment.findMany({
    where: { userId: req.auth!.user.id, outletId, role: { in: live } },
    select: { role: true },
  });
  return assignments.map((a) => a.role);
}

/**
 * /api/v1/staff/outlets/:outletId/inventory — stock for the outlet's menu items.
 * Managers and POS staff assigned to the outlet can view, restock, remove (with a reason)
 * and mark items sold out or available (that stays on the existing availability route).
 * Only managers can switch quantity tracking, set thresholds or replace a quantity with a
 * stock count. Every lookup is scoped by outletId.
 */
export function inventoryRouter(db: Database, realtime: RealtimePublisher) {
  const router = Router({ mergeParams: true });
  router.use(requireAuth, requireOutletRole(db, 'MANAGER', 'POS'));

  /** Who is acting, and as which role (the least privileged role that allows the action). */
  async function actorFor(req: Request, outletId: string, managerOnly: boolean): Promise<Actor> {
    const roles = await rolesAtOutlet(db, req, outletId);
    if (managerOnly) {
      if (!roles.includes('MANAGER')) throw forbidden('Only the outlet’s manager can do that.');
      return { userId: req.auth!.user.id, role: 'MANAGER' };
    }
    return { userId: req.auth!.user.id, role: roles.includes('POS') ? 'POS' : 'MANAGER' };
  }

  router.get('/', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    res.json(await listInventory(db, outletId, listQuery.parse(req.query)));
  });

  router.get('/:itemId/history', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    res.json({ history: await stockHistory(db, outletId, idParam(req, 'itemId')) });
  });

  router.post('/:itemId/adjustments', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const itemId = idParam(req, 'itemId');
    const input = adjustmentBody.parse(req.body);
    const actor = await actorFor(req, outletId, input.type === 'COUNT_SET');
    const item = await adjustStock(db, { outletId, itemId, input, actor });
    realtime.stockChanged(outletId, [itemId]);
    res.json({ item });
  });

  router.patch('/:itemId/threshold', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const itemId = idParam(req, 'itemId');
    const { lowStockThreshold } = thresholdBody.parse(req.body);
    const actor = await actorFor(req, outletId, true);
    const item = await setThreshold(db, { outletId, itemId, lowStockThreshold, actor });
    realtime.stockChanged(outletId, [itemId]);
    res.json({ item });
  });

  router.post('/:itemId/tracking', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const itemId = idParam(req, 'itemId');
    const body = trackingBody.parse(req.body);
    const actor = await actorFor(req, outletId, true);
    const item = await setTracking(db, { outletId, itemId, ...body, actor });
    realtime.stockChanged(outletId, [itemId]);
    res.json({ item });
  });

  return router;
}
