import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';
import { listNotifications, markAllRead, markRead, unreadCount } from './notifications.service.js';

const listQuery = z.object({
  filter: z.enum(['all', 'unread']).default('all'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.uuid().optional(),
});

/** /api/v1/me/notifications — the signed-in user's own inbox (students and staff alike). */
export function notificationsRouter(db: Database) {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const q = listQuery.parse(req.query);
    res.json(
      await listNotifications(db, req.auth!.user.id, {
        unreadOnly: q.filter === 'unread',
        limit: q.limit,
        cursor: q.cursor,
      }),
    );
  });

  router.get('/unread-count', async (req, res) => {
    res.json({ unread: await unreadCount(db, req.auth!.user.id) });
  });

  router.post('/read-all', async (req, res) => {
    res.json({ marked: await markAllRead(db, req.auth!.user.id) });
  });

  router.post('/:id/read', async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw notFound('Notification not found');
    await markRead(db, req.auth!.user.id, id.data);
    res.json({ ok: true });
  });

  return router;
}
