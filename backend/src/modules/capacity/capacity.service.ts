import type { DbClient } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { CAPACITY_FULL_MESSAGE, ORDER_CAPACITY_WINDOW_SECONDS } from './capacity.rules.js';

/**
 * Claims one unit of the outlet's rolling order capacity for `orderId`, inside the checkout
 * transaction. Concurrency: a transaction-scoped advisory lock per outlet serialises claims for
 * that outlet across every API instance (the lock lives in PostgreSQL), so the count below can't
 * go stale before the insert. Other outlets are never blocked. If checkout later fails, the
 * claim rolls back with it, so refused or failed requests never use capacity.
 *
 * Throws 429 ORDER_CAPACITY_FULL (with when to retry) when the outlet is full.
 */
export async function claimOrderCapacity(
  tx: DbClient,
  { outletId, orderId, limit }: { outletId: string; orderId: string; limit: number },
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order-capacity:${outletId}`}))`;
  // The clock is read after the lock, so it is never earlier than a claim that committed first.
  const recent = await tx.$queryRaw<{ acceptedAt: Date; now: Date }[]>`
    SELECT "acceptedAt", (clock_timestamp() AT TIME ZONE 'UTC') AS "now"
    FROM "OutletOrderAcceptance"
    WHERE "outletId" = ${outletId}::uuid
      AND "acceptedAt" > (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${ORDER_CAPACITY_WINDOW_SECONDS})
    ORDER BY "acceptedAt" DESC
    LIMIT ${limit}`;
  if (recent.length >= limit) {
    // Room opens when the oldest of the last `limit` orders leaves the window.
    const oldest = recent[recent.length - 1]!.acceptedAt;
    const retryAt = new Date(oldest.getTime() + ORDER_CAPACITY_WINDOW_SECONDS * 1000);
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((retryAt.getTime() - recent[0]!.now.getTime()) / 1000),
    );
    throw new AppError(429, 'ORDER_CAPACITY_FULL', CAPACITY_FULL_MESSAGE, {
      retryAt: retryAt.toISOString(),
      retryAfterSeconds,
    });
  }
  // One row per order (primary key): an order can never be counted twice.
  await tx.$executeRaw`
    INSERT INTO "OutletOrderAcceptance" ("orderId", "outletId", "acceptedAt")
    VALUES (${orderId}::uuid, ${outletId}::uuid, clock_timestamp() AT TIME ZONE 'UTC')`;
}
