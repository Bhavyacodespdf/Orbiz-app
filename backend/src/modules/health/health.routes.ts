import { Router } from 'express';
import type { Database } from '../../lib/prisma.js';

/**
 * GET /api/v1/health
 * Reports whether the API is up and whether it can actually reach PostgreSQL.
 * Returns 503 when the database is unreachable so monitors can tell the difference.
 */
export function healthRouter(db: Database) {
  const router = Router();

  router.get('/', async (req, res) => {
    const startedAt = Date.now();
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({
        status: 'ok',
        database: { status: 'up', latencyMs: Date.now() - startedAt },
        time: new Date().toISOString(),
      });
    } catch (err) {
      req.log.error({ err }, 'Health check: database unreachable');
      res.status(503).json({
        status: 'degraded',
        database: { status: 'down' },
        time: new Date().toISOString(),
      });
    }
  });

  return router;
}
