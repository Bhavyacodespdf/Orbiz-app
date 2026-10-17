import { createServer } from 'node:http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { createApp } from './app.js';
import { createSocketServer } from './realtime/socket-server.js';
import { createDeferredPublisher } from './realtime/publisher.js';
import { startNoShowWorker } from './modules/noshow/noshow.worker.js';
import { startPlanningWorker } from './modules/planning/planning.jobs.js';
import { startOperationsWorker } from './modules/operations/operations.worker.js';

async function main() {
  // Fail fast if the database is unreachable instead of serving broken requests.
  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
  } catch (cause) {
    throw new Error(
      'Cannot connect to PostgreSQL. Is it running (pg_isready) and is DATABASE_URL in backend/.env correct?',
      { cause },
    );
  }
  logger.info('Connected to PostgreSQL');

  // One HTTP server carries both the REST API and Socket.IO. Express is the
  // server's request handler; attaching Socket.IO afterwards lets it take over
  // /socket.io requests (both WebSocket and long-polling) before Express sees them.
  const deferred = createDeferredPublisher();
  const server = createServer(createApp({ db: prisma, realtime: deferred.publisher }));
  const realtime = createSocketServer(server, prisma, env);
  deferred.connect(realtime.publisher);

  // The scheduled-order no-show sweep (every minute; state lives in the database).
  const noShowWorker = startNoShowWorker(prisma, deferred.publisher);
  // Weekly stock planning: demand history, forecasts and outcomes (every 15 minutes).
  const planningWorker = startPlanningWorker(prisma);
  // Notifications, queue estimates, alerts and auto-accept (every 30 seconds).
  const operationsWorker = startOperationsWorker(prisma, deferred.publisher);

  server.listen(env.PORT, () => {
    logger.info(`CampusCart API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    noShowWorker.stop();
    planningWorker.stop();
    operationsWorker.stop();
    void realtime.close().finally(() => {
      server.close(async () => {
        await prisma.$disconnect();
        process.exit(0);
      });
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(async (err) => {
  logger.fatal({ err }, 'Failed to start CampusCart API');
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
