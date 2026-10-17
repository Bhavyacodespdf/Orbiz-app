import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { requireAuth } from '../../middleware/auth.js';
import { toPublicUser } from './users.serializer.js';

/** Only these fields are user-editable. Email, roles and status are not. */
export const profileUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1, 'Name is required').max(60),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9][0-9 -]{6,18}[0-9]$/, 'Enter a valid phone number')
      .or(z.literal('').transform(() => null))
      .nullable(),
  })
  .partial()
  .strict();

/** GET/PATCH /api/v1/me/profile — the signed-in user's own profile. */
export function profileRouter(db: Database) {
  const router = Router();
  router.use(requireAuth);

  router.get('/', (req, res) => {
    res.json({ user: toPublicUser(req.auth!.user) });
  });

  router.patch('/', async (req, res, next) => {
    try {
      const changes = profileUpdateSchema.parse(req.body);
      const updated = await db.user.update({
        where: { id: req.auth!.user.id },
        data: changes,
        select: { displayName: true, phone: true },
      });
      res.json({ user: toPublicUser({ ...req.auth!.user, ...updated }) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
