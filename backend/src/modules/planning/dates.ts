import { istDay } from '../orders/pickup.js';

/*
 * Business dates. CampusCart's calendar is India Standard Time (UTC+5:30, no daylight saving);
 * a "business date" is an IST calendar day written YYYY-MM-DD, and weeks run Monday–Sunday.
 */

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;

/** Today's IST date. */
export const todayIst = (now = new Date()) => istDay(now);

/** YYYY-MM-DD → a Date at UTC midnight (how Prisma reads and writes @db.Date). */
export const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
/** A @db.Date value → YYYY-MM-DD. */
export const dayOf = (date: Date) => date.toISOString().slice(0, 10);

export const addDays = (day: string, n: number) =>
  dayOf(new Date(asDate(day).getTime() + n * DAY_MS));
export const daysBetween = (from: string, to: string) =>
  Math.round((asDate(to).getTime() - asDate(from).getTime()) / DAY_MS);

/** 0 = Monday … 6 = Sunday. */
export const weekdayOf = (day: string) => (asDate(day).getUTCDay() + 6) % 7;
export const isMonday = (day: string) => weekdayOf(day) === 0;
export const mondayOf = (day: string) => addDays(day, -weekdayOf(day));
/** The Monday after `day` (the next full week). */
export const nextMonday = (day: string) => addDays(mondayOf(day), 7);

/** The UTC instant at which an IST day starts. */
export const istDayStart = (day: string) => new Date(asDate(day).getTime() - IST_OFFSET_MS);

/** Every day from `from` to `to`, inclusive. */
export function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;
