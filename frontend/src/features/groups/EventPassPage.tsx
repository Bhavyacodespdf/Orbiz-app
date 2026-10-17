import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Ticket, TicketLine } from '@/components/ui/Ticket';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/feedback/Skeleton';
import { ErrorState } from '@/components/feedback/ErrorState';
import { formatINR } from '@/lib/money';
import { formatDateTime } from '@/lib/time';
import { BOOKING_STATUS, EVENT_TYPE_LABELS, useEventPass } from '@/services/banquets';

/** The host's event pass. Staff check the code on their side; it never grants changes. */
export function EventPassPage() {
  const { bookingId = '' } = useParams();
  const pass = useEventPass(bookingId);
  if (pass.isPending) return <Skeleton className="mx-auto h-96 w-full max-w-md" />;
  if (pass.error)
    return (
      <ErrorState
        error={pass.error}
        onRetry={() => void pass.refetch()}
        retrying={pass.isFetching}
      />
    );
  const b = pass.data;
  const valid = b.status === 'CONFIRMED';
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <Link
        to="/groups?tab=banquet"
        className="flex items-center gap-1 text-sm font-semibold text-espresso-600 hover:text-espresso-900"
      >
        <ArrowLeft className="size-4" aria-hidden /> Banquet bookings
      </Link>
      <Ticket
        header={
          <div className="flex flex-col items-center gap-1 text-center">
            <p className="text-xs font-bold tracking-[0.18em] text-espresso-500 uppercase">
              Event pass · {EVENT_TYPE_LABELS[b.eventType]}
            </p>
            <h1 className="text-2xl font-extrabold">{b.name}</h1>
            <Badge tone={BOOKING_STATUS[b.status].tone}>{BOOKING_STATUS[b.status].label}</Badge>
          </div>
        }
      >
        <TicketLine label="When" value={formatDateTime(b.startsAt)} />
        <TicketLine
          label="Venue"
          value={`${b.outlet.name}${b.outlet.location ? `, ${b.outlet.location}` : ''}`}
        />
        <TicketLine label="Host" value={b.host} />
        <TicketLine label="Guests" value={String(b.guestCount)} />
        <TicketLine
          label="Estimate"
          value={`${formatINR(b.estimatedTotalPaise)} (${formatINR(b.perGuestPaise)}/guest)`}
        />
        <div className="mt-3 text-center">
          <p className="text-xs font-bold tracking-wide text-espresso-500 uppercase">Pass code</p>
          <p className="font-mono text-sm font-bold break-all select-all" aria-label="Pass code">
            {b.passToken}
          </p>
          <p className="mt-1 text-xs text-espresso-500">
            {valid
              ? 'Show this code at the counter. Staff check it against the outlet’s bookings.'
              : 'This pass is only valid once the outlet has confirmed the event.'}
          </p>
        </div>
      </Ticket>
      <p className="text-center text-xs text-espresso-500">
        Keep this code private: it identifies your booking.
      </p>
    </div>
  );
}
