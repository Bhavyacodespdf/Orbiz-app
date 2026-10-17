import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { SelectField } from '@/components/ui/SelectField';
import { Skeleton } from '@/components/feedback/Skeleton';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { useOutletSchedule, useSaveSchedule, type OutletSchedule } from '@/services/scheduling';
import { minutesToTime, timeToMinutes } from './schedule-format';

// Monday first, as staff read a week; weekday numbers follow the server (0 = Sunday).
const DAYS = [
  { weekday: 1, label: 'Monday' },
  { weekday: 2, label: 'Tuesday' },
  { weekday: 3, label: 'Wednesday' },
  { weekday: 4, label: 'Thursday' },
  { weekday: 5, label: 'Friday' },
  { weekday: 6, label: 'Saturday' },
  { weekday: 0, label: 'Sunday' },
];
const SLOT_LENGTHS = [5, 10, 15, 20, 30, 45, 60, 90, 120];

interface DayRow {
  open: boolean;
  opens: string;
  closes: string;
}

function Form({ outletId, schedule }: { outletId: string; schedule: OutletSchedule }) {
  const save = useSaveSchedule(outletId);
  const toast = useToast();
  const [rows, setRows] = useState<Record<number, DayRow>>(() =>
    Object.fromEntries(
      DAYS.map(({ weekday }) => {
        const h = schedule.hours.find((x) => x.weekday === weekday);
        return [
          weekday,
          h
            ? {
                open: true,
                opens: minutesToTime(h.opensMinute),
                closes: minutesToTime(h.closesMinute % 1440),
              }
            : { open: false, opens: '09:00', closes: '21:00' },
        ];
      }),
    ),
  );
  const [lead, setLead] = useState(String(schedule.leadMinutes));
  const [slot, setSlot] = useState(String(schedule.slotMinutes));
  const [days, setDays] = useState(String(schedule.daysAhead));
  const [capacity, setCapacity] = useState(
    schedule.slotCapacity === null ? '' : String(schedule.slotCapacity),
  );
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    const hours = [];
    for (const { weekday, label } of DAYS) {
      const row = rows[weekday]!;
      if (!row.open) continue;
      const opensMinute = timeToMinutes(row.opens);
      // 00:00 as a closing time means midnight at the end of the day.
      const closesMinute = row.closes === '00:00' ? 1440 : timeToMinutes(row.closes);
      if (closesMinute <= opensMinute) return setError(`${label}: closing must be after opening.`);
      hours.push({ weekday, opensMinute, closesMinute });
    }
    const leadMinutes = Number(lead);
    if (!/^\d+$/.test(lead) || leadMinutes > 1440)
      return setError('Notice must be 0–1440 minutes.');
    if (capacity && (!/^\d+$/.test(capacity) || Number(capacity) < 1 || Number(capacity) > 500)) {
      return setError('Orders per slot must be 1–500, or blank for no limit.');
    }
    save.mutate(
      {
        leadMinutes,
        slotMinutes: Number(slot),
        daysAhead: Number(days),
        slotCapacity: capacity ? Number(capacity) : null,
        hours,
      },
      {
        onSuccess: () => toast.show({ tone: 'success', title: 'Pickup hours saved' }),
        onError: (e) =>
          toast.show({ tone: 'error', title: 'Couldn’t save', description: describeError(e) }),
      },
    );
  }

  const update = (weekday: number, patch: Partial<DayRow>) =>
    setRows((r) => ({ ...r, [weekday]: { ...r[weekday]!, ...patch } }));

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold">Pickup hours (IST)</legend>
        {DAYS.map(({ weekday, label }) => {
          const row = rows[weekday]!;
          return (
            <div
              key={weekday}
              className="grid grid-cols-[6.25rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2"
            >
              <label className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  className="accent-chili-500"
                  checked={row.open}
                  onChange={(event) => update(weekday, { open: event.target.checked })}
                />
                {label}
              </label>
              <input
                type="time"
                aria-label={`${label} opens`}
                value={row.opens}
                disabled={!row.open}
                onChange={(event) => update(weekday, { opens: event.target.value })}
                className="h-10 w-full min-w-0 rounded-(--radius-control) border border-espresso-200 bg-cream-50 px-1.5 text-sm disabled:opacity-50"
              />
              <input
                type="time"
                aria-label={`${label} closes`}
                value={row.closes}
                disabled={!row.open}
                onChange={(event) => update(weekday, { closes: event.target.value })}
                className="h-10 w-full min-w-0 rounded-(--radius-control) border border-espresso-200 bg-cream-50 px-1.5 text-sm disabled:opacity-50"
              />
            </div>
          );
        })}
        <p className="text-xs text-espresso-500">
          Unticked days take no scheduled orders. Use 00:00 to close at midnight.
        </p>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Minimum notice (minutes)"
          inputMode="numeric"
          value={lead}
          onChange={(event) => setLead(event.target.value.replace(/[^\d]/g, '').slice(0, 4))}
          hint="Also when preparation may start before a slot."
        />
        <SelectField
          label="Slot length"
          value={slot}
          onChange={(event) => setSlot(event.target.value)}
        >
          {SLOT_LENGTHS.map((m) => (
            <option key={m} value={m}>
              {m} minutes
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Book up to"
          value={days}
          onChange={(event) => setDays(event.target.value)}
        >
          {Array.from({ length: 15 }, (_, n) => (
            <option key={n} value={n}>
              {n === 0 ? 'Today only' : `${n} day${n === 1 ? '' : 's'} ahead`}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Orders per slot (blank = no limit)"
          inputMode="numeric"
          value={capacity}
          onChange={(event) => setCapacity(event.target.value.replace(/[^\d]/g, '').slice(0, 3))}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm font-medium text-chili-600">
          {error}
        </p>
      )}
      <Button type="submit" loading={save.isPending} className="w-fit">
        Save pickup hours
      </Button>
    </form>
  );
}

/** Manager settings for scheduled orders. No hours = students can't schedule here. */
export function PickupHoursPanel({ outletId }: { outletId: string }) {
  const schedule = useOutletSchedule(outletId);
  return (
    <Panel className="mt-6 max-w-xl p-5" role="region" aria-labelledby="pickup-hours-heading">
      <h2 id="pickup-hours-heading" className="mb-1 flex items-center gap-2 text-xl font-bold">
        <CalendarClock className="size-5" aria-hidden />
        Scheduled orders
      </h2>
      <p className="mb-4 text-sm text-espresso-500">
        Students can order ahead for a pickup slot inside these hours. Each scheduled order costs
        them ₹10 extra. Paused outlets take no scheduled orders.
      </p>
      {schedule.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : schedule.error ? (
        <ErrorState
          error={schedule.error}
          onRetry={() => void schedule.refetch()}
          retrying={schedule.isFetching}
        />
      ) : (
        <Form key={JSON.stringify(schedule.data)} outletId={outletId} schedule={schedule.data} />
      )}
    </Panel>
  );
}
