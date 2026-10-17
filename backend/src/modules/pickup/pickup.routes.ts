import { Router, type Request } from 'express';
import { deliverSoon } from '../notifications/deliver.js';
import { afterOrderChange } from '../kitchen/kitchen.service.js';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { requireOutletRole } from '../../middleware/outlet-access.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import type { StaffRole } from '../../generated/prisma/enums.js';
import { confirmHandover, refreshPickup, studentPickup, verifyPickup } from './pickup.service.js';

const verifyBody = z.discriminatedUnion('method', [
  z.object({ method: z.literal('CODE'), code: z.string().trim().max(20) }).strict(),
  z.object({ method: z.literal('QR'), payload: z.string().trim().max(200) }).strict(),
]);
const confirmBody = z.object({ challengeToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

const idParam = (req: Request, key: string) => {
  const parsed = z.uuid().safeParse(req.params[key]);
  if (!parsed.success) throw notFound(key === 'outletId' ? 'Outlet not found' : 'Order not found');
  return parsed.data;
};

/** Pickup codes are secrets: never cache them in the browser or any proxy. */
const noStore = (res: { set: (k: string, v: string) => void }) =>
  res.set('Cache-Control', 'no-store');

/** /api/v1/orders/:orderId/pickup — the student's own pickup code (owner only). */
export function studentPickupRouter(db: Database) {
  const router = Router({ mergeParams: true });
  router.use(requireRole('STUDENT'));

  router.get('/', async (req, res) => {
    noStore(res);
    res.json({ pickup: await studentPickup(db, req.auth!.user.id, idParam(req, 'orderId')) });
  });

  /** A fresh code while the order is READY (e.g. the old one expired). */
  router.post('/refresh', async (req, res) => {
    noStore(res);
    res.json({ pickup: await refreshPickup(db, req.auth!.user.id, idParam(req, 'orderId')) });
  });

  return router;
}

/**
 * /api/v1/staff/outlets/:outletId/pickup — assigned MANAGER or POS staff verify a student's code
 * and then explicitly confirm the handover. Verification alone never releases an order.
 */
export function staffPickupRouter(db: Database, realtime: RealtimePublisher) {
  const router = Router({ mergeParams: true });
  router.use(requireAuth, requireOutletRole(db, 'MANAGER', 'POS'));

  router.post('/verify', async (req, res) => {
    noStore(res);
    const body = verifyBody.parse(req.body);
    res.json(
      await verifyPickup(db, {
        outletId: idParam(req, 'outletId'),
        staffUserId: req.auth!.user.id,
        method: body.method,
        secret: body.method === 'CODE' ? body.code : body.payload,
      }),
    );
  });

  router.post('/confirm', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const { challengeToken } = confirmBody.parse(req.body);
    const live = req.auth!.user.roles.filter((r): r is StaffRole => r === 'MANAGER' || r === 'POS');
    const assignments = await db.staffAssignment.findMany({
      where: { userId: req.auth!.user.id, outletId, role: { in: live } },
      select: { role: true },
    });
    const result = await confirmHandover(db, {
      outletId,
      staffUserId: req.auth!.user.id,
      staffRoles: assignments.map((a) => a.role),
      challengeToken,
    });
    if (!result.alreadyConfirmed) {
      realtime.orderUpdated(result.order, result.ownerId);
      deliverSoon(db, realtime);
      await afterOrderChange(db, realtime, outletId);
    }
    res.json({
      order: result.order,
      handover: result.handover,
      alreadyConfirmed: result.alreadyConfirmed,
    });
  });

  return router;
}
