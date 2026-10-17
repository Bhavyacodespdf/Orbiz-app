import type { Database } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import { runOperations } from './operations.service.js';

/** Every 30 s: auto-accept safety net, queue recalculation, alerts, notification retries. */
export const OPERATIONS_SWEEP_MS = 30_000;

/**
 * The operations sweep. Like the no-show worker, all of its state is in the database (orders,
 * estimates, notifications with unique dedupe keys), so it resumes after a restart and several
 * API instances can run it at once. A pass never overlaps the previous one in this process.
 */
export function startOperationsWorker(
  db: Database,
  realtime: RealtimePublisher,
  intervalMs = OPERATIONS_SWEEP_MS,
) {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      await runOperations(db, realtime);
    } catch (err) {
      logger.error({ err }, 'Operations sweep failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref();
  void sweep();
  return {
    sweep,
    stop() {
      clearInterval(timer);
    },
  };
}
