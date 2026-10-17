import type { PollOutcome } from '@/services/polls';

/** Polls follow the app's India Standard Time policy, whatever the device's zone. */
const IST = 'Asia/Kolkata';

const clock = new Intl.DateTimeFormat('en-IN', { timeStyle: 'short', timeZone: IST });
const dayAndClock = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: IST,
});
const weekday = new Intl.DateTimeFormat('en-IN', { weekday: 'long', timeZone: 'UTC' });
const istDate = new Intl.DateTimeFormat('en-CA', { timeZone: IST });

/** YYYY-MM-DD in IST. */
export const istDay = (ms: number) => istDate.format(ms);

/** "1:00 pm" when it's on the same IST day as `now`, else "Fri, 17 Oct, 1:00 pm". */
export function formatWhen(iso: string, now: number): string {
  const at = Date.parse(iso);
  return istDay(at) === istDay(now) ? clock.format(at) : dayAndClock.format(at);
}

/** "today's", "tomorrow's" or "Friday's" — whose special a poll decides. */
export function specialDayLabel(day: string, now: number): string {
  const today = istDay(now);
  if (day === today) return 'today’s';
  const tomorrow = istDay(now + 24 * 60 * 60 * 1000);
  if (day === tomorrow) return 'tomorrow’s';
  return `${weekday.format(new Date(`${day}T00:00:00Z`))}’s`;
}

/** "2 h 5 min", "12 min", "under a minute". */
export function formatRemaining(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (ms < 60_000) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export const votesLabel = (n: number) => `${n} ${n === 1 ? 'vote' : 'votes'}`;

/** How a special was decided, in plain words. Never shown for a poll without a winner. */
export function outcomeSummary(
  outcome: PollOutcome,
  winnerVotes: number,
  totalVotes: number,
  percentage: number,
): string {
  if (outcome === 'TIE_RESOLVED_BY_MANAGER') {
    return `Tied at ${votesLabel(winnerVotes)} — chosen by the outlet manager`;
  }
  return `Won with ${winnerVotes} of ${votesLabel(totalVotes)} (${percentage}%)`;
}

const inputParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** An instant as a datetime-local value in IST, e.g. "2026-10-17T11:00". */
export function toIstInput(iso: string): string {
  const parts = Object.fromEntries(
    inputParts.formatToParts(Date.parse(iso)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** A datetime-local value entered as IST, as an instant with an explicit offset. */
export const fromIstInput = (local: string) => `${local}:00+05:30`;

const longDay = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "Fri, 17 Oct 2026" for a YYYY-MM-DD date. */
export const formatDay = (day: string) => longDay.format(new Date(`${day}T00:00:00Z`));
