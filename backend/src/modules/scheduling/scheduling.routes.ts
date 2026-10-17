import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireOutletRole } from '../../middleware/outlet-access.js';
import { uuidParam } from '../outlets/outlets.schema.js';
import { loadOutletWithHours, slotsFor } from './scheduling.service.js';

const scheduleBody = z
  .object({
    leadMinutes: z.number().int().min(0).max(1440),
    slotMinutes: z.number().int().min(5).max(120),
    daysAhead: z.number().int().min(0).max(14),
    slotCapacity: z.number().int().min(1).max(500).nullable(),
    hours: z
      .array(
        z
          .object({
            weekday: z.number().int().min(0).max(6),
            opensMinute: z.number().int().min(0).max(1439),
            closesMinute: z.number().int().min(1).max(1440),
          })
          .strict()
          .refine((h) => h.closesMinute > h.opensMinute, 'Closing time must be after opening time'),
      )
      .max(7)
      .refine(
        (hours) => new Set(hours.map((h) => h.weekday)).size === hours.length,
        'One range per day',
      ),
  })
  .strict();

function toSchedule(outlet: Awaited<ReturnType<typeof loadOutletWithHours>>) {
  return {
    leadMinutes: outlet.scheduleLeadMinutes,
    slotMinutes: outlet.scheduleSlotMinutes,
    daysAhead: outlet.scheduleDaysAhead,
    slotCapacity: outlet.scheduleSlotCapacity,
    hours: outlet.hours.map((h) => ({
      weekday: h.weekday,
      opensMinute: h.opensMinute,
      closesMinute: h.closesMinute,
    })),
  };
}

/** GET /outlets/:slug/slots — public: the pickup slots that can be booked right now. */
export function slotsRouter(db: Database) {
  const router = Router({ mergeParams: true });
  router.get('/', async (req, res) => {
    const slug = String((req.params as Record<string, string>).slug ?? '');
    const outlet = await loadOutletWithHours(db, { slug });
    if (!outlet.isActive) throw notFound('Outlet not found');
    res.json(await slotsFor(db, outlet));
  });
  return router;
}

function outletIdParam(req: Request): string {
  const parsed = uuidParam.safeParse(req.params.outletId);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

/**
 * /staff/outlets/:outletId/schedule — pickup hours (IST) and slot settings for scheduled
 * orders. Assigned staff can read them; only the outlet's manager can change them.
 */
export function staffScheduleRouter(db: Database) {
  const router = Router({ mergeParams: true });
  router.use(requireAuth);

  router.get('/', requireOutletRole(db, 'MANAGER', 'POS'), async (req, res) => {
    res.json({ schedule: toSchedule(await loadOutletWithHours(db, { id: outletIdParam(req) })) });
  });

  router.put('/', requireOutletRole(db, 'MANAGER'), async (req, res) => {
    const outletId = outletIdParam(req);
    const body = scheduleBody.parse(req.body);
    await db.$transaction(async (tx) => {
      const before = await loadOutletWithHours(tx, { id: outletId });
      await tx.outlet.update({
        where: { id: outletId },
        data: {
          scheduleLeadMinutes: body.leadMinutes,
          scheduleSlotMinutes: body.slotMinutes,
          scheduleDaysAhead: body.daysAhead,
          scheduleSlotCapacity: body.slotCapacity,
        },
      });
      await tx.outletHours.deleteMany({ where: { outletId } });
      if (body.hours.length > 0) {
        await tx.outletHours.createMany({ data: body.hours.map((h) => ({ ...h, outletId })) });
      }
      await recordAudit(tx, {
        actor: { type: 'USER', userId: req.auth!.user.id },
        action: 'OUTLET_SCHEDULE_UPDATED',
        entityType: 'Outlet',
        entityId: outletId,
        metadata: { before: toSchedule(before), after: body },
      });
    });
    res.json({ schedule: toSchedule(await loadOutletWithHours(db, { id: outletId })) });
  });

  return router;
}
