import { useState } from 'react';
import { CalendarHeart, Search } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { TextField } from '@/components/ui/TextField';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { describeError } from '@/lib/errors';
import { formatINR } from '@/lib/money';
import { formatDateTime } from '@/lib/time';
import { StaffGate } from '@/features/staff/StaffGate';
import { isPastDue } from '@/features/scheduling/schedule-format';
import { OutletPicker } from '@/features/staff/OutletPicker';
import type { StaffOutlet } from '@/services/staff';
import {
  BOOKING_STATUS,
  checkPass,
  EVENT_TYPE_LABELS,
  useBanquetSettings,
  useDecideBooking,
  useOutletBookings,
  useSaveBanquetSettings,
  type BanquetSettings,
  type Booking,
} from '@/services/banquets';

function SettingsForm({ outletId, settings }: { outletId: string; settings: BanquetSettings }) {
  const save = useSaveBanquetSettings(outletId);
  const [s, setS] = useState({
    enabled: settings.enabled,
    maxGuests: String(settings.maxGuests),
    minNoticeDays: String(settings.minNoticeDays),
    maxConcurrentEvents: String(settings.maxConcurrentEvents),
  });
  const num = (v: string) => v.replace(/\D/g, '').slice(0, 4);
  return (
    <Panel className="flex flex-col gap-3 p-4">
      <h2 className="font-sans text-lg font-bold">Banquet rules</h2>
      <label className="flex items-center gap-2 font-semibold">
        <input
          type="checkbox"
          className="size-4"
          checked={s.enabled}
          onChange={(e) => setS({ ...s, enabled: e.target.checked })}
        />
        Take banquet bookings
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          label="Most guests per event"
          inputMode="numeric"
          value={s.maxGuests}
          onChange={(e) => setS({ ...s, maxGuests: num(e.target.value) })}
        />
        <TextField
          label="Minimum notice (days)"
          inputMode="numeric"
          value={s.minNoticeDays}
          onChange={(e) => setS({ ...s, minNoticeDays: num(e.target.value) })}
        />
        <TextField
          label="Events at the same time"
          inputMode="numeric"
          value={s.maxConcurrentEvents}
          onChange={(e) => setS({ ...s, maxConcurrentEvents: num(e.target.value) })}
        />
      </div>
      <p className="text-sm text-espresso-600">
        Events must also fit inside the outlet’s pickup hours (Outlet → Scheduled orders).
      </p>
      <Button
        className="self-start"
        loading={save.isPending}
        onClick={() =>
          save.mutate({
            enabled: s.enabled,
            maxGuests: Number(s.maxGuests),
            minNoticeDays: Number(s.minNoticeDays),
            maxConcurrentEvents: Number(s.maxConcurrentEvents),
          })
        }
      >
        Save rules
      </Button>
      {save.error ? (
        <p role="alert" className="text-sm text-chili-700">
          {describeError(save.error)}
        </p>
      ) : save.isSuccess ? (
        <p role="status" className="text-sm text-success-600">
          Saved.
        </p>
      ) : null}
    </Panel>
  );
}

function BookingRow({
  outletId,
  booking,
  canDecide,
}: {
  outletId: string;
  booking: Booking;
  canDecide: boolean;
}) {
  const decide = useDecideBooking(outletId);
  const [reason, setReason] = useState('');
  return (
    <li className="flex flex-col gap-2 border-b border-dashed border-espresso-100 p-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{booking.name}</strong>
        <Badge>{EVENT_TYPE_LABELS[booking.eventType]}</Badge>
        <Badge tone={BOOKING_STATUS[booking.status].tone}>
          {BOOKING_STATUS[booking.status].label}
        </Badge>
      </div>
      <p className="text-sm text-espresso-700">
        {formatDateTime(booking.startsAt)} – {formatDateTime(booking.endsAt)} · {booking.guestCount}{' '}
        guests · host {booking.host}
        {booking.contactPhone ? ` · ${booking.contactPhone}` : ''}
      </p>
      <p className="text-sm">
        {booking.items.map((i) => `${i.name} (x${i.quantity})`).join(', ')} · estimate{' '}
        {formatINR(booking.estimatedTotalPaise)}
      </p>
      {(booking.dietaryNotes || booking.instructions) && (
        <p className="text-sm text-espresso-600">
          {booking.dietaryNotes && `Dietary: ${booking.dietaryNotes}. `}
          {booking.instructions}
        </p>
      )}
      {canDecide && booking.status === 'PENDING_CONFIRMATION' && (
        <div className="flex flex-wrap items-end gap-2">
          <Button
            size="sm"
            loading={decide.isPending && decide.variables?.decision === 'confirm'}
            onClick={() => decide.mutate({ bookingId: booking.id, decision: 'confirm' })}
          >
            Confirm
          </Button>
          <TextField
            label="Reason if declining"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            className="min-w-48 flex-1"
          />
          <Button
            size="sm"
            variant="danger"
            disabled={reason.trim().length < 3}
            loading={decide.isPending && decide.variables?.decision === 'reject'}
            onClick={() =>
              decide.mutate({ bookingId: booking.id, decision: 'reject', reason: reason.trim() })
            }
          >
            Decline
          </Button>
        </div>
      )}
      {canDecide && booking.status === 'CONFIRMED' && isPastDue(booking.startsAt) && (
        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          onClick={() => decide.mutate({ bookingId: booking.id, decision: 'complete' })}
        >
          Mark completed
        </Button>
      )}
      {decide.error ? (
        <p role="alert" className="text-sm text-chili-700">
          {describeError(decide.error)}
        </p>
      ) : null}
    </li>
  );
}

function PassCheck({ outletId }: { outletId: string }) {
  const [token, setToken] = useState('');
  const [result, setResult] = useState<{ valid: boolean; booking: Booking } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Panel className="flex flex-col gap-2 p-4">
      <h2 className="font-sans text-lg font-bold">Check an event pass</h2>
      <div className="flex flex-wrap items-end gap-2">
        <TextField
          label="Pass code"
          value={token}
          onChange={(e) => setToken(e.target.value.trim())}
          className="min-w-64 flex-1"
        />
        <Button
          variant="secondary"
          loading={busy}
          disabled={token.length < 20}
          onClick={() => {
            setBusy(true);
            setError(null);
            setResult(null);
            checkPass(outletId, token)
              .then(setResult)
              .catch(setError)
              .finally(() => setBusy(false));
          }}
        >
          <Search className="size-4" aria-hidden /> Check
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-chili-700">
          {describeError(error)}
        </p>
      ) : null}
      {result && (
        <p role="status" className={result.valid ? 'text-success-600' : 'text-chili-700'}>
          {result.valid
            ? 'Valid'
            : `Not valid (${BOOKING_STATUS[result.booking.status].label.toLowerCase()})`}
          : {result.booking.name} · {formatDateTime(result.booking.startsAt)} ·{' '}
          {result.booking.guestCount} guests · host {result.booking.host}
        </p>
      )}
    </Panel>
  );
}

function Desk({
  current,
  outlets,
  select,
  role,
}: {
  current: StaffOutlet;
  outlets: StaffOutlet[];
  select: (id: string) => void;
  role: 'MANAGER' | 'POS';
}) {
  const outletId = current.outlet.id;
  const canDecide = current.roles.includes('MANAGER');
  const settings = useBanquetSettings(outletId);
  const bookings = useOutletBookings(outletId);
  return (
    <>
      <PageHeader
        eyebrow={role === 'MANAGER' ? 'Kitchen' : 'Counter'}
        title="Banquets"
        description="Catering requests from students. Prices shown are estimates; nothing is charged through the app."
        actions={<OutletPicker outlets={outlets} selectedId={outletId} onSelect={select} />}
      />
      <div className="flex flex-col gap-4">
        {canDecide &&
          (settings.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : settings.error ? (
            <ErrorState error={settings.error} />
          ) : (
            <SettingsForm key={outletId} outletId={outletId} settings={settings.data} />
          ))}
        <PassCheck outletId={outletId} />
        {bookings.isPending ? (
          <Skeleton className="h-48 w-full" />
        ) : bookings.error ? (
          <ErrorState
            error={bookings.error}
            onRetry={() => void bookings.refetch()}
            retrying={bookings.isFetching}
          />
        ) : bookings.data.length === 0 ? (
          <EmptyState icon={<CalendarHeart aria-hidden />} title="No banquet requests" />
        ) : (
          <Panel>
            <ul aria-label="Banquet requests">
              {bookings.data.map((b) => (
                <BookingRow key={b.id} outletId={outletId} booking={b} canDecide={canDecide} />
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </>
  );
}

export function ManagerBanquetsPage() {
  return (
    <StaffGate role="MANAGER">
      {(ctx) => <Desk key={ctx.current.outlet.id} {...ctx} role="MANAGER" />}
    </StaffGate>
  );
}

export function PosBanquetsPage() {
  return (
    <StaffGate role="POS">
      {(ctx) => <Desk key={ctx.current.outlet.id} {...ctx} role="POS" />}
    </StaffGate>
  );
}
