import type { Database } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import { orderInclude, toOrder } from '../orders/orders.serializer.js';
import { processDueNoShows } from './noshow.service.js';
import { deliverSoon } from '../notifications/deliver.js';

export const NO_SHOW_SWEEP_MS = 60_000;

/**
 * The background no-show sweep. Its state is entirely in the database (READY scheduled
 * orders past their deadline), so it picks up where it left off after a restart, and the
 * per-order row lock means several API instances can run it at once without settling
 * any order twice. A pass never overlaps the previous one in this process.
 */
export function startNoShowWorker(
  db: Database,
  realtime: RealtimePublisher,
  intervalMs = NO_SHOW_SWEEP_MS,
) {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const { processed, failed } = await processDueNoShows(db, (outcome) => {
        void (async () => {
          const order = await db.order.findUniqueOrThrow({
            where: { id: outcome.orderId },
            include: orderInclude,
          });
          realtime.orderUpdated(toOrder(order), outcome.userId);
          deliverSoon(db, realtime);
          if (outcome.refundPaise > 0) realtime.walletUpdated(outcome.userId, 'REFUND');
          if (outcome.restockedItemIds.length > 0)
            realtime.stockChanged(outcome.outletId, outcome.restockedItemIds);
        })().catch((err: unknown) => logger.warn({ err }, 'No-show notification failed'));
      });
      if (processed || failed) logger.info({ processed, failed }, 'No-show sweep finished');
    } catch (err) {
      logger.error({ err }, 'No-show sweep failed');
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
