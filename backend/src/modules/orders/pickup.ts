import type { DbClient } from '../../lib/prisma.js';

/** Today's date in India Standard Time as YYYY-MM-DD (pickup numbers restart each day). */
export function istDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Atomically takes the next pickup number for an outlet today. The
 * INSERT … ON CONFLICT … DO UPDATE is a single statement that locks the
 * counter row, so concurrent orders always get distinct numbers. If the
 * surrounding transaction rolls back, the number is not consumed.
 */
export async function nextPickupNumber(
  tx: DbClient,
  outletId: string,
  day: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ lastNumber: number }[]>`
    INSERT INTO "OutletDailyCounter" ("outletId", "day", "lastNumber")
    VALUES (${outletId}::uuid, ${day}::date, 1)
    ON CONFLICT ("outletId", "day")
    DO UPDATE SET "lastNumber" = "OutletDailyCounter"."lastNumber" + 1
    RETURNING "lastNumber"`;
  return rows[0]!.lastNumber;
}

/** "Night Owl Café", 7 → "N-007" */
export function formatPickupCode(outletName: string, number: number): string {
  const letter = outletName.match(/[A-Za-z0-9]/)?.[0]?.toUpperCase() ?? 'X';
  return `${letter}-${String(number).padStart(3, '0')}`;
}
