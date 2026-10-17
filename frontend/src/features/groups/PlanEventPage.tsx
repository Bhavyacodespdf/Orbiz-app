import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SelectField } from '@/components/ui/SelectField';
import { TextField } from '@/components/ui/TextField';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { describeError } from '@/lib/errors';
import { formatINR } from '@/lib/money';
import { useOutletMenu } from '@/services/outlets';
import {
  EVENT_TYPE_LABELS,
  useCreateBooking,
  useQuote,
  useVenues,
  type EventType,
  type Venue,
} from '@/services/banquets';
import { fromIstInput } from '@/features/specials/poll-format';
import { Card } from './shared';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const clock = (minute: number) =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

function PackagePicker({
  venue,
  quantities,
  onChange,
}: {
  venue: Venue;
  quantities: Record<string, string>;
  onChange: (q: Record<string, string>) => void;
}) {
  const menu = useOutletMenu(venue.slug, {});
  if (menu.isPending) return <Skeleton className="h-32 w-full" />;
  if (menu.error)
    return (
      <ErrorState
        error={menu.error}
        onRetry={() => void menu.refetch()}
        retrying={menu.isFetching}
      />
    );
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {menu.data.items.map((item) => (
        <li
          key={item.id}
          className="flex items-end gap-2 rounded-(--radius-control) border border-espresso-100 p-2"
        >
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{item.name}</p>
            <p className="text-sm text-espresso-600">{formatINR(item.pricePaise)} each</p>
          </div>
          <TextField
            label={`Quantity of ${item.name}`}
            className="w-24 [&_label]:sr-only"
            inputMode="numeric"
            placeholder="0"
            value={quantities[item.id] ?? ''}
            onChange={(e) =>
              onChange({ ...quantities, [item.id]: e.target.value.replace(/\D/g, '').slice(0, 4) })
            }
          />
        </li>
      ))}
    </ul>
  );
}

export function PlanEventPage() {
  const venues = useVenues();
  const create = useCreateBooking();
  const navigate = useNavigate();
  const [outletId, setOutletId] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<EventType>('PROJECT_LUNCH');
  const [startsAt, setStartsAt] = useState('');
  const [duration, setDuration] = useState('120');
  const [guests, setGuests] = useState('10');
  const [dietary, setDietary] = useState('');
  const [instructions, setInstructions] = useState('');
  const [phone, setPhone] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const venue = venues.data?.find((v) => v.outletId === outletId) ?? null;
  const items = useMemo(
    () =>
      Object.entries(quantities)
        .filter(([, q]) => Number(q) > 0)
        .map(([menuItemId, q]) => ({ menuItemId, quantity: Number(q) })),
    [quantities],
  );
  const guestCount = Number(guests) || 0;
  const quote = useQuote(venue?.outletId ?? null, guestCount, items);
  const ready =
    venue && name.trim() && startsAt && guestCount > 0 && items.length > 0 && quote.data;

  if (venues.isPending) return <Skeleton className="h-96 w-full" />;
  if (venues.error)
    return (
      <ErrorState
        error={venues.error}
        onRetry={() => void venues.refetch()}
        retrying={venues.isFetching}
      />
    );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Link
        to="/groups?tab=banquet"
        className="flex items-center gap-1 text-sm font-semibold text-espresso-600 hover:text-espresso-900"
      >
        <ArrowLeft className="size-4" aria-hidden /> Banquet bookings
      </Link>
      <div>
        <p className="text-xs font-bold tracking-[0.18em] text-chili-600 uppercase">
          Campus banquet bookings
        </p>
        <h1 className="text-3xl font-extrabold uppercase">Plan an event</h1>
        <p className="text-espresso-600">
          The outlet reviews every request. Prices are an estimate; nothing is charged now.
        </p>
      </div>
      {venues.data.length === 0 ? (
        <EmptyState
          title="No outlet is taking banquet bookings yet"
          description="An outlet’s manager has to turn banquets on first."
        />
      ) : (
        <>
          <Card className="flex flex-col gap-3">
            <SelectField
              label="Venue"
              value={outletId}
              onChange={(e) => {
                setOutletId(e.target.value);
                setQuantities({});
              }}
            >
              <option value="">Choose an outlet…</option>
              {venues.data.map((v) => (
                <option key={v.outletId} value={v.outletId}>
                  {v.name}
                  {v.location ? ` — ${v.location}` : ''}
                </option>
              ))}
            </SelectField>
            {venue && (
              <p className="text-sm text-espresso-600">
                Up to {venue.maxGuests} guests · book {venue.minNoticeDays}+ days ahead · hours:{' '}
                {venue.hours.length === 0
                  ? 'not set'
                  : venue.hours
                      .map(
                        (h) =>
                          `${WEEKDAYS[h.weekday]} ${clock(h.opensMinute)}–${clock(h.closesMinute)}`,
                      )
                      .join(', ')}{' '}
                (IST)
              </p>
            )}
            <TextField
              label="Event name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              placeholder="ML club meetup"
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                label="Event type"
                value={type}
                onChange={(e) => setType(e.target.value as EventType)}
              >
                {(Object.keys(EVENT_TYPE_LABELS) as EventType[]).map((t) => (
                  <option key={t} value={t}>
                    {EVENT_TYPE_LABELS[t]}
                  </option>
                ))}
              </SelectField>
              <TextField
                label="Expected guests"
                inputMode="numeric"
                value={guests}
                onChange={(e) => setGuests(e.target.value.replace(/\D/g, '').slice(0, 4))}
              />
              <TextField
                label="Date and start time (IST)"
                type="datetime-local"
                step={900}
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
              <SelectField
                label="Duration"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              >
                {[30, 60, 90, 120, 150, 180, 240, 300, 360].map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}
                  </option>
                ))}
              </SelectField>
            </div>
          </Card>
          {venue && (
            <Card>
              <h2 className="mb-3 font-sans text-lg font-bold">Menu package</h2>
              <PackagePicker venue={venue} quantities={quantities} onChange={setQuantities} />
            </Card>
          )}
          <Card className="flex flex-col gap-3">
            <TextField
              label="Dietary requirements (optional)"
              value={dietary}
              maxLength={300}
              onChange={(e) => setDietary(e.target.value)}
              placeholder="3 vegan, 1 nut allergy"
            />
            <TextField
              label="Special instructions (optional)"
              value={instructions}
              maxLength={500}
              onChange={(e) => setInstructions(e.target.value)}
            />
            <TextField
              label="Contact phone (optional)"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Card>
          <Card>
            <h2 className="font-sans text-lg font-bold">Estimate</h2>
            {items.length === 0 ? (
              <p className="text-espresso-600">Choose dishes to see an estimate.</p>
            ) : quote.isPending ? (
              <Skeleton className="h-16 w-full" />
            ) : quote.error ? (
              <p role="alert" className="text-chili-700">
                {describeError(quote.error)}
              </p>
            ) : (
              <>
                <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Menu package">
                  {quote.data.lines.map((l) => (
                    <li key={l.menuItemId}>
                      <Badge>
                        {l.name} (x{l.quantity})
                      </Badge>
                    </li>
                  ))}
                </ul>
                <p className="mt-2">
                  Estimated total <strong>{formatINR(quote.data.totalPaise)}</strong> · about{' '}
                  <strong>{formatINR(quote.data.perGuestPaise)}</strong> per guest
                </p>
                <p className="text-xs text-espresso-500">
                  No taxes or fees apply. The outlet confirms the final arrangement; no deposit is
                  taken in the app.
                </p>
              </>
            )}
            {create.error ? (
              <p role="alert" className="mt-2 text-sm text-chili-700">
                {describeError(create.error)}
              </p>
            ) : null}
            <Button
              className="mt-3"
              block
              disabled={!ready}
              loading={create.isPending}
              onClick={() =>
                create.mutate(
                  {
                    outletId,
                    name: name.trim(),
                    eventType: type,
                    startsAt: fromIstInput(startsAt),
                    durationMinutes: Number(duration),
                    guestCount,
                    dietaryNotes: dietary.trim() || undefined,
                    instructions: instructions.trim() || undefined,
                    contactPhone: phone.trim() || null,
                    items,
                    expectedTotalPaise: quote.data!.totalPaise,
                  },
                  { onSuccess: () => navigate('/groups?tab=banquet') },
                )
              }
            >
              Send booking request
            </Button>
          </Card>
        </>
      )}
    </div>
  );
}
