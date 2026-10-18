/** Scheduled orders follow Orbiz's calendar policy: India Standard Time. */
const IST = 'Asia/Kolkata';

const full = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const clock = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST,
  hour: 'numeric',
  minute: '2-digit',
});
const dayLabel = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'UTC',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const istDate = new Intl.DateTimeFormat('en-CA', { timeZone: IST });

/** "Fri, 17 Oct, 1:30 pm" (IST). */
export const formatSlot = (iso: string) => full.format(new Date(iso));
/** "1:30 pm" (IST). */
export const formatClock = (iso: string) => clock.format(new Date(iso));

/** "Today", "Tomorrow" or "Sat, 18 Oct" for a YYYY-MM-DD IST date. */
export function formatDayChoice(date: string, nowMs: number): string {
  if (date === istDate.format(nowMs)) return 'Today';
  if (date === istDate.format(nowMs + 86_400_000)) return 'Tomorrow';
  return dayLabel.format(new Date(`${date}T00:00:00Z`));
}

/** "in 2 h 15 min", "in 40 min", "past due by 5 min". */
export function dueIn(iso: string, nowMs = Date.now()): string {
  const minutes = Math.round((Date.parse(iso) - nowMs) / 60_000);
  const span = (m: number) =>
    m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
  if (minutes >= 0) return `in ${span(minutes)}`;
  return `past due by ${span(-minutes)}`;
}

/** 540 → "09:00". */
export const minutesToTime = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/** "09:00" → 540; "24:00"/"00:00" closing handled by the caller. */
export const timeToMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Whether a scheduled pickup time has passed. */
export const isPastDue = (iso: string, nowMs = Date.now()) => Date.parse(iso) < nowMs;
