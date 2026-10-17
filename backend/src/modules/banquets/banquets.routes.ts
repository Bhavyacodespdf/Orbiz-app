import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { requireOutletRole } from '../../middleware/outlet-access.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import {
  cancelBooking,
  createBooking,
  decideBooking,
  getMyBooking,
  getSettings,
  listMyBookings,
  listOutletBookings,
  listVenues,
  MAX_MENU_LINES,
  quote,
  saveSettings,
  verifyPass,
} from './banquets.service.js';

const items = z
  .array(z.object({ menuItemId: z.uuid(), quantity: z.number().int().min(1).max(1000) }).strict())
  .min(1, 'Choose at least one dish')
  .max(MAX_MENU_LINES);
const guestCount = z.number().int().min(1).max(1000);
const quoteBody = z.object({ outletId: z.uuid(), guestCount, items }).strict();
const createBody = z
  .object({
    outletId: z.uuid(),
    name: z.string().trim().min(1, 'Name the event').max(80),
    eventType: z.enum(['PROJECT_LUNCH', 'BIRTHDAY', 'CLUB_EVENT', 'ACADEMIC_EVENT', 'OTHER']),
    startsAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
    durationMinutes: z.number().int().min(30).max(360).multipleOf(15),
    guestCount,
    dietaryNotes: z.string().trim().max(300).optional(),
    instructions: z.string().trim().max(500).optional(),
    contactPhone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ]{8,16}$/, 'Enter a phone number')
      .nullable()
      .optional(),
    items,
    expectedTotalPaise: z.number().int().positive(),
  })
  .strict();
const reasonBody = z.object({ reason: z.string().trim().max(300).optional() }).strict();
const settingsBody = z
  .object({
    enabled: z.boolean(),
    maxGuests: z.number().int().min(1).max(1000),
    minNoticeDays: z.number().int().min(0).max(60),
    maxConcurrentEvents: z.number().int().min(1).max(20),
  })
  .strict();
const statusQuery = z.object({
  status: z
    .enum(['PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'COMPLETED'])
    .optional(),
});

const idParam = (req: Request, key: string) => {
  const parsed = z.uuid().safeParse(req.params[key]);
  if (!parsed.success) throw notFound('Booking not found');
  return parsed.data;
};

/** /api/v1/banquets — a student's own banquet bookings. */
export function banquetsRouter(db: Database, realtime: RealtimePublisher) {
  const router = Router();
  router.use(requireRole('STUDENT'));

  router.get('/venues', async (_req, res) => {
    res.json({ venues: await listVenues(db) });
  });

  router.post('/quote', async (req, res) => {
    const body = quoteBody.parse(req.body);
    res.json({ quote: await quote(db, body.outletId, body.guestCount, body.items) });
  });

  router.get('/', async (req, res) => {
    res.json({ bookings: await listMyBookings(db, req.auth!.user.id) });
  });

  router.post('/', async (req, res) => {
    const body = createBody.parse(req.body);
    const id = await createBooking(db, { ...body, hostUserId: req.auth!.user.id });
    realtime.socialChanged([req.auth!.user.id], { kind: 'BANQUET', id }, body.outletId);
    res.status(201).json({ booking: await getMyBooking(db, id, req.auth!.user.id) });
  });

  router.get('/:bookingId', async (req, res) => {
    res.json({ booking: await getMyBooking(db, idParam(req, 'bookingId'), req.auth!.user.id) });
  });

  /** The event pass: only the host gets the token. */
  router.get('/:bookingId/pass', async (req, res) => {
    res.json({
      booking: await getMyBooking(db, idParam(req, 'bookingId'), req.auth!.user.id, true),
    });
  });

  router.post('/:bookingId/cancel', async (req, res) => {
    const bookingId = idParam(req, 'bookingId');
    const { reason } = reasonBody.parse(req.body);
    const r = await cancelBooking(db, bookingId, req.auth!.user.id, reason);
    realtime.socialChanged([r.hostUserId], { kind: 'BANQUET', id: bookingId }, r.outletId);
    res.json({ booking: await getMyBooking(db, bookingId, req.auth!.user.id) });
  });

  return router;
}

/** /api/v1/staff/outlets/:outletId/banquets — requests for this outlet (MANAGER or POS; decisions MANAGER). */
export function staffBanquetsRouter(db: Database, realtime: RealtimePublisher) {
  const router = Router({ mergeParams: true });
  router.use(requireAuth, requireOutletRole(db, 'MANAGER', 'POS'));

  async function requireManager(req: Request, outletId: string) {
    const assignment = req.auth!.user.roles.includes('MANAGER')
      ? await db.staffAssignment.findFirst({
          where: { userId: req.auth!.user.id, outletId, role: 'MANAGER' },
        })
      : null;
    if (!assignment) throw forbidden('Only the outlet’s manager can do that.');
  }
  const outletOf = (req: Request) => idParam(req, 'outletId');

  router.get('/settings', async (req, res) => {
    res.json({ settings: await getSettings(db, outletOf(req)) });
  });

  router.put('/settings', async (req, res) => {
    const outletId = outletOf(req);
    await requireManager(req, outletId);
    const body = settingsBody.parse(req.body);
    res.json({
      settings: await saveSettings(db, { outletId, userId: req.auth!.user.id, ...body }),
    });
  });

  router.get('/', async (req, res) => {
    const { status } = statusQuery.parse(req.query);
    res.json({ bookings: await listOutletBookings(db, outletOf(req), status) });
  });

  router.get('/pass/:token', async (req, res) => {
    const token = z
      .string()
      .regex(/^[A-Za-z0-9_-]{20,64}$/)
      .safeParse(req.params.token);
    if (!token.success) throw notFound('No booking matches that pass at this outlet.');
    res.json(await verifyPass(db, outletOf(req), token.data));
  });

  for (const decision of ['confirm', 'reject', 'complete'] as const) {
    router.post(`/:bookingId/${decision}`, async (req, res) => {
      const outletId = outletOf(req);
      await requireManager(req, outletId);
      const { reason } = reasonBody.parse(req.body ?? {});
      const r = await decideBooking(db, {
        outletId,
        bookingId: idParam(req, 'bookingId'),
        managerUserId: req.auth!.user.id,
        decision,
        reason,
      });
      realtime.socialChanged(
        [r.hostUserId],
        { kind: 'BANQUET', id: idParam(req, 'bookingId') },
        outletId,
      );
      res.json({ bookings: await listOutletBookings(db, outletId) });
    });
  }

  return router;
}
