import { describe, expect, it } from 'vitest';
import {
  addDays,
  checkSlot,
  generateSlots,
  istDayOf,
  istMidnight,
  weekdayOf,
  type ScheduleConfig,
} from './slots.js';

const allWeek = (opensMinute: number, closesMinute: number) =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opensMinute, closesMinute }));

const config = (overrides: Partial<ScheduleConfig> = {}): ScheduleConfig => ({
  outletActive: true,
  outletStatus: 'OPEN',
  leadMinutes: 30,
  slotMinutes: 15,
  daysAhead: 2,
  slotCapacity: null,
  hours: allWeek(9 * 60, 21 * 60), // 9:00–21:00 IST
  ...overrides,
});

// Friday 16 Oct 2026, 10:07 IST = 04:37 UTC.
const now = Date.parse('2026-10-16T10:07:00+05:30');
const at = (local: string) => new Date(`${local}+05:30`);

describe('IST calendar helpers', () => {
  it('uses the IST date even when the UTC date differs', () => {
    expect(istDayOf(Date.parse('2026-10-16T00:15:00+05:30'))).toBe('2026-10-16'); // 15 Oct in UTC
    expect(istDayOf(Date.parse('2026-10-16T23:59:00+05:30'))).toBe('2026-10-16');
    expect(new Date(istMidnight('2026-10-16')).toISOString()).toBe('2026-10-15T18:30:00.000Z');
    expect(weekdayOf('2026-10-16')).toBe(5); // Friday
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });
});

describe('slot generation', () => {
  it('offers only future slots at least the lead time ahead, inside the hours', () => {
    const days = generateSlots(config(), now, new Map());
    expect(days.map((d) => d.date)).toEqual(['2026-10-16', '2026-10-17', '2026-10-18']);
    const today = days[0]!.slots;
    expect(today[0]!.startsAt).toBe(at('2026-10-16T10:45:00').toISOString()); // 10:07 + 30 → next slot 10:45
    expect(today.at(-1)!.startsAt).toBe(at('2026-10-16T20:45:00').toISOString()); // last slot before 21:00
    expect(today[0]!.label.toLowerCase()).toBe('10:45 am');
    expect(days[1]!.slots).toHaveLength(48); // 12 h × 4
  });

  it('offers nothing on days without hours, and nothing at all without hours or when paused', () => {
    const noSaturday = config({ hours: allWeek(9 * 60, 21 * 60).filter((h) => h.weekday !== 6) });
    expect(generateSlots(noSaturday, now, new Map())[1]!.slots).toEqual([]);
    expect(generateSlots(config({ hours: [] }), now, new Map())).toEqual([]);
    expect(generateSlots(config({ outletStatus: 'PAUSED' }), now, new Map())).toEqual([]);
    // Closed right now is fine: scheduled orders are for later, inside the hours.
    expect(
      generateSlots(config({ outletStatus: 'CLOSED' }), now, new Map())[0]!.slots.length,
    ).toBeGreaterThan(0);
  });

  it('marks full slots unavailable when there is a capacity', () => {
    const iso = at('2026-10-16T11:00:00').toISOString();
    const days = generateSlots(config({ slotCapacity: 2 }), now, new Map([[iso, 2]]));
    expect(days[0]!.slots.find((s) => s.startsAt === iso)!.available).toBe(false);
    expect(days[0]!.slots.find((s) => s.startsAt !== iso)!.available).toBe(true);
  });

  it('handles hours that run to midnight', () => {
    const lateNow = Date.parse('2026-10-16T23:10:00+05:30');
    const days = generateSlots(config({ hours: allWeek(22 * 60, 24 * 60) }), lateNow, new Map());
    expect(days[0]!.slots.map((s) => s.label.toLowerCase())).toEqual(['11:45 pm']);
    expect(days[1]!.date).toBe('2026-10-17');
    expect(days[1]!.slots[0]!.startsAt).toBe(at('2026-10-17T22:00:00').toISOString());
  });
});

describe('checking a requested slot', () => {
  it.each([
    ['2026-10-16T09:00:00', 'SLOT_IN_PAST'],
    ['2026-10-16T10:30:00', 'SLOT_TOO_SOON'],
    ['2026-10-16T21:00:00', 'INVALID_SLOT'], // closing time is not a slot
    ['2026-10-16T08:45:00', 'SLOT_IN_PAST'],
    ['2026-10-16T12:10:00', 'INVALID_SLOT'], // not on a 15-minute boundary
    ['2026-10-19T12:00:00', 'SLOT_TOO_FAR'], // 3 days ahead, limit 2
  ])('refuses %s (%s)', (local, code) => {
    expect(checkSlot(config(), now, at(local))).toMatchObject({ ok: false, code });
  });

  it.each(['2026-10-16T10:45:00', '2026-10-16T20:45:00', '2026-10-18T09:00:00'])(
    'accepts %s',
    (local) => {
      expect(checkSlot(config(), now, at(local))).toEqual({ ok: true });
    },
  );

  it('refuses when scheduling is unavailable', () => {
    expect(checkSlot(config({ hours: [] }), now, at('2026-10-16T12:00:00'))).toMatchObject({
      ok: false,
      code: 'SCHEDULING_UNAVAILABLE',
    });
    expect(checkSlot(config({ outletStatus: 'PAUSED' }), now, at('2026-10-16T12:00:00')).ok).toBe(
      false,
    );
    expect(checkSlot(config(), now, new Date('nonsense'))).toMatchObject({
      ok: false,
      code: 'INVALID_SLOT',
    });
  });
});
