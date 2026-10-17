import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { requireOutletRole } from '../../middleware/outlet-access.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import {
  afterOrderChange,
  kitchenOverview,
  trackingFor,
  updateKitchenSettings,
  updatePrepMinutes,
} from './kitchen.service.js';
import { estimateAccuracy } from './accuracy.service.js';

const idParam = (req: Request, key: string, what: string) => {
  const parsed = z.uuid().safeParse(req.params[key]);
  if (!parsed.success) throw notFound(`${what} not found`);
  return parsed.data;
};

const prepBody = z
  .object({
    /** Configured Preparation Time: whole minutes 1–180, or null to clear it. */
    prepMinutes: z.number().int('Use whole minutes').min(1).max(180).nullable(),
  })
  .strict();
const settingsBody = z
  .object({
    kitchenParallelOrders: z.number().int().min(1).max(20),
    autoAcceptMode: z.enum(['MANUAL', 'AUTO']),
    autoAcceptMaxWaitMinutes: z.number().int().min(5).max(120),
  })
  .strict();
const accuracyQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) });

/** /api/v1/orders/:orderId/tracking — the owner's live tracking view. */
export function trackingRouter(db: Database) {
  const router = Router({ mergeParams: true });
  router.use(requireRole('STUDENT'));
  router.get('/', async (req, res) => {
    res.json({
      tracking: await trackingFor(db, req.auth!.user.id, idParam(req, 'orderId', 'Order')),
    });
  });
  return router;
}

/** /api/v1/staff/outlets/:outletId/kitchen — kitchen timing for the outlet's MANAGER. */
export function kitchenRouter(db: Database, realtime: RealtimePublisher) {
  const router = Router({ mergeParams: true });
  router.use(requireAuth, requireOutletRole(db, 'MANAGER'));
  const outletOf = (req: Request) => idParam(req, 'outletId', 'Outlet');

  router.get('/', async (req, res) => {
    res.json(await kitchenOverview(db, outletOf(req)));
  });

  router.patch('/items/:menuItemId', async (req, res) => {
    const outletId = outletOf(req);
    const { prepMinutes } = prepBody.parse(req.body);
    await updatePrepMinutes(db, {
      outletId,
      menuItemId: idParam(req, 'menuItemId', 'Dish'),
      prepMinutes,
      actorUserId: req.auth!.user.id,
    });
    // Future estimates use it straight away.
    await afterOrderChange(db, realtime, outletId);
    res.json(await kitchenOverview(db, outletId));
  });

  router.put('/settings', async (req, res) => {
    const outletId = outletOf(req);
    const body = settingsBody.parse(req.body);
    await updateKitchenSettings(db, { outletId, actorUserId: req.auth!.user.id, ...body });
    await afterOrderChange(db, realtime, outletId);
    res.json(await kitchenOverview(db, outletId));
  });

  router.get('/accuracy', async (req, res) => {
    const { days } = accuracyQuery.parse(req.query);
    res.json({ accuracy: await estimateAccuracy(db, outletOf(req), days) });
  });

  return router;
}
