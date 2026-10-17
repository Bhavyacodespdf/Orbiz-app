import type { OutletStatus } from '../../generated/prisma/enums.js';
import { TIMEZONE } from './scheduling.rules.js';

/*
 * Pure slot logic. Slots are generated from the outlet's own weekly pickup hours and
 * scheduling settings; with no hours for a day, that day offers nothing. All dates are
 * IST calendar dates; instants are absolute (stored as UTC by the database).
 */

export interface DayHours {
  weekday: number; // 0 = Sunday … 6 = Saturday (IST)
  opensMinute: number;
  closesMinute: number;
}

export interface ScheduleConfig {
  outletActive: boolean;
  outletStatus: OutletStatus;
  leadMinutes: number;
  slotMinutes: number;
  daysAhead: number;
  slotCapacity: number | null;
  hours: DayHours[];
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const istDate = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE });
const istClock = new Intl.DateTimeFormat('en-IN', { timeZone: TIMEZONE, timeStyle: 'short' });

/** YYYY-MM-DD in IST. */
export const istDayOf = (ms: number) => istDate.format(ms);
/** Midnight at the start of an IST date, as an instant. */
export const istMidnight = (day: string) => Date.parse(`${day}T00:00:00+05:30`);
/** Day of the week of an IST calendar date (0 = Sunday). */
export const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
export const addDays = (day: string, n: number) =>
  istDayOf(istMidnight(day) + n * DAY + 12 * 60 * MINUTE);

/** Can this outlet take scheduled orders at all? PAUSED means "no new orders". */
export function schedulingBlocked(config: ScheduleConfig): string | null {
  if (!config.outletActive) return 'This outlet is no longer listed.';
  if (config.outletStatus === 'PAUSED') return 'This outlet has paused new orders.';
  if (config.hours.length === 0)
    return 'This outlet hasn’t set pickup hours for scheduled orders yet.';
  return null;
}

export interface Slot {
  startsAt: string;
  label: string;
  available: boolean;
}
export interface SlotDay {
  date: string;
  hours: { opensMinute: number; closesMinute: number } | null;
  slots: Slot[];
}

/**
 * Every bookable slot from now (plus the lead time) through the last allowed day.
 * `booked` counts active scheduled orders per slot start (ISO), for the capacity limit.
 */
export function generateSlots(
  config: ScheduleConfig,
  nowMs: number,
  booked: Map<string, number>,
): SlotDay[] {
  if (schedulingBlocked(config)) return [];
  const earliest = nowMs + config.leadMinutes * MINUTE;
  const today = istDayOf(nowMs);
  const days: SlotDay[] = [];
  for (let d = 0; d <= config.daysAhead; d++) {
    const date = addDays(today, d);
    const hours = config.hours.find((h) => h.weekday === weekdayOf(date)) ?? null;
    const slots: Slot[] = [];
    if (hours) {
      for (let m = hours.opensMinute; m < hours.closesMinute; m += config.slotMinutes) {
        const start = istMidnight(date) + m * MINUTE;
        if (start < earliest) continue;
        const iso = new Date(start).toISOString();
        const taken = booked.get(iso) ?? 0;
        slots.push({
          startsAt: iso,
          label: istClock.format(start),
          available: config.slotCapacity === null || taken < config.slotCapacity,
        });
      }
    }
    days.push({
      date,
      hours: hours && { opensMinute: hours.opensMinute, closesMinute: hours.closesMinute },
      slots,
    });
  }
  return days;
}

export type SlotCheck = { ok: true } | { ok: false; code: string; message: string };

/** Is this exact instant a valid slot start right now? (Capacity is checked separately, under a lock.) */
export function checkSlot(config: ScheduleConfig, nowMs: number, startsAt: Date): SlotCheck {
  const blocked = schedulingBlocked(config);
  if (blocked) return { ok: false, code: 'SCHEDULING_UNAVAILABLE', message: blocked };
  const start = startsAt.getTime();
  if (Number.isNaN(start))
    return { ok: false, code: 'INVALID_SLOT', message: 'That isn’t a valid time.' };
  if (start <= nowMs)
    return { ok: false, code: 'SLOT_IN_PAST', message: 'That time has already passed.' };
  if (start < nowMs + config.leadMinutes * MINUTE) {
    return {
      ok: false,
      code: 'SLOT_TOO_SOON',
      message: `Scheduled orders need at least ${config.leadMinutes} minutes’ notice.`,
    };
  }
  const date = istDayOf(start);
  if (date > addDays(istDayOf(nowMs), config.daysAhead)) {
    return {
      ok: false,
      code: 'SLOT_TOO_FAR',
      message: `You can schedule up to ${config.daysAhead} days ahead.`,
    };
  }
  const hours = config.hours.find((h) => h.weekday === weekdayOf(date));
  const minute = (start - istMidnight(date)) / MINUTE;
  if (
    !hours ||
    !Number.isInteger(minute) ||
    minute < hours.opensMinute ||
    minute >= hours.closesMinute ||
    (minute - hours.opensMinute) % config.slotMinutes !== 0
  ) {
    return {
      ok: false,
      code: 'INVALID_SLOT',
      message: 'That time isn’t one of the outlet’s pickup slots.',
    };
  }
  return { ok: true };
}

export const formatSlot = (iso: string | Date) =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: TIMEZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
