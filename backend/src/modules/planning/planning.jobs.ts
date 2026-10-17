import type { Database } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { aggregateDemand, earliestActivityDay } from './demand.service.js';
import { evaluateForecasts, generateForecastRun } from './forecast.service.js';
import { finalizeOutcomes } from './plan.service.js';
import { addDays, nextMonday, todayIst, weekdayOf } from './dates.js';

export const PLANNING_SWEEP_MS = 15 * 60_000;
/** A RUNNING job older than this is assumed to have died with its process and may be retried. */
const STALE_MS = 30 * 60_000;
/** Next week's automatic forecast is made from Friday (IST), once per outlet and week. */
const AUTO_FORECAST_FROM_WEEKDAY = 4;
/** A first-ever backfill looks back at most this far. */
const BACKFILL_DAYS = 365;

/**
 * Claims a (job, key) unit of work once across all instances: a unique row is created, or a
 * FAILED/stale one re-claimed with a conditional update. Returns false if someone else holds or
 * finished it.
 */
async function claim(db: Database, job: string, key: string, now: Date): Promise<boolean> {
  try {
    await db.planningJobRun.create({
      data: { job, key, status: 'RUNNING', attempts: 1, startedAt: now },
    });
    return true;
  } catch {
    const { count } = await db.planningJobRun.updateMany({
      where: {
        job,
        key,
        OR: [
          { status: 'FAILED' },
          { status: 'RUNNING', startedAt: { lt: new Date(now.getTime() - STALE_MS) } },
        ],
      },
      data: { status: 'RUNNING', attempts: { increment: 1 }, startedAt: now, lastError: null },
    });
    return count === 1;
  }
}

async function once(
  db: Database,
  job: string,
  key: string,
  now: Date,
  work: () => Promise<unknown>,
) {
  if (!(await claim(db, job, key, now))) return false;
  try {
    const details = await work();
    await db.planningJobRun.update({
      where: { job_key: { job, key } },
      data: {
        status: 'DONE',
        finishedAt: new Date(),
        details: JSON.parse(JSON.stringify(details ?? null)),
      },
    });
    return true;
  } catch (err) {
    await db.planningJobRun.update({
      where: { job_key: { job, key } },
      data: {
        status: 'FAILED',
        lastError: err instanceof Error ? err.message.slice(0, 500) : String(err),
      },
    });
    throw err;
  }
}

/**
 * One pass of the planning jobs. Everything is derived from the database, so a restart simply
 * continues; each step is safe to repeat (recomputation + conditional updates + unique keys).
 */
export async function runPlanningJobs(db: Database, now = new Date()) {
  const today = todayIst(now);
  const report: Record<string, unknown> = {};

  // 1. Demand history: a one-time backfill, then the last few days on every pass.
  const earliest = await earliestActivityDay(db);
  if (earliest) {
    const from =
      earliest < addDays(today, -BACKFILL_DAYS) ? addDays(today, -BACKFILL_DAYS) : earliest;
    await once(db, 'demand-backfill', 'v1', now, () =>
      aggregateDemand(db, { from, to: today, now }),
    );
    report.recent = await aggregateDemand(db, { from: addDays(today, -2), to: today, now });
  }

  // 2. Next week's forecast, once per outlet, from Friday.
  if (weekdayOf(today) >= AUTO_FORECAST_FROM_WEEKDAY) {
    const weekStart = nextMonday(today);
    const outlets = await db.outlet.findMany({
      where: { isActive: true, items: { some: { isActive: true } } },
      select: { id: true },
    });
    let made = 0;
    for (const o of outlets) {
      try {
        const done = await once(db, 'auto-forecast', `${o.id}:${weekStart}`, now, async () => {
          const run = await generateForecastRun(db, {
            outletId: o.id,
            weekStart,
            trigger: 'AUTO',
            now,
          });
          return { runId: run.id };
        });
        if (done) made += 1;
      } catch (err) {
        logger.warn({ err, outletId: o.id }, 'Automatic forecast failed; will retry');
      }
    }
    report.autoForecasts = made;
  }

  // 3. Forecast vs actual, and 4. plan outcomes + decision rewards, for days that have passed.
  report.forecasts = await evaluateForecasts(db, now);
  report.outcomes = await finalizeOutcomes(db, now);
  return report;
}

/** In-process scheduler. The timer only triggers work; all state lives in PostgreSQL. */
export function startPlanningWorker(db: Database, intervalMs = PLANNING_SWEEP_MS) {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const report = await runPlanningJobs(db);
      logger.debug({ report }, 'Planning jobs finished');
    } catch (err) {
      logger.error({ err }, 'Planning jobs failed');
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
