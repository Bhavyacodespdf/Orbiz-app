import type { Database } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import { dispatchPending } from './notifications.service.js';

/**
 * Called right after a business transaction commits: delivers its notifications live without
 * waiting for the next worker sweep. Never fails the request — the sweep retries anything left.
 */
export function deliverSoon(db: Database, realtime: RealtimePublisher) {
  void dispatchPending(db, realtime).catch((err: unknown) =>
    logger.warn({ err }, 'Notification dispatch failed; the worker will retry'),
  );
}
