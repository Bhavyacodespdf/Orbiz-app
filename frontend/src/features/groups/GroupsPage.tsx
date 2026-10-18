import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  CalendarHeart,
  KeyRound,
  Plus,
  ReceiptText,
  Ticket as TicketIcon,
  UsersRound,
  Wallet,
} from 'lucide-react';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField } from '@/components/ui/SelectField';
import { TextField } from '@/components/ui/TextField';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { describeError } from '@/lib/errors';
import { formatINR, parseRupeesToPaise } from '@/lib/money';
import { formatDateTime } from '@/lib/time';
import { cn } from '@/lib/cn';
import { newIdempotencyKey } from '@/lib/idempotency';
import { useOutlets } from '@/services/outlets';
import { useCurrentUser } from '@/services/auth';
import { useCreateGroup, useGroups, useJoinGroup, type AllocationMode } from '@/services/groups';
import {
  BOOKING_STATUS,
  EVENT_TYPE_LABELS,
  useCancelBooking,
  useMyBookings,
} from '@/services/banquets';
import {
  useCancelSplit,
  useCreateSplit,
  useSettleSplit,
  useSplits,
  type NewSplit,
  type Split,
} from '@/services/splits';
import { fromIstInput } from '@/features/specials/poll-format';
import { Card, PersonAvatar, StatusBadge } from './shared';
import { GROUP_STATUS, MODE_LABELS, PARTICIPANT_STATUS, SHARE_STATUS } from './labels';
import { Badge } from '@/components/ui/Badge';

type Tab = 'tray' | 'banquet' | 'splits';
const TABS: { id: Tab; label: string; icon: typeof UsersRound }[] = [
  { id: 'tray', label: 'Group Tray', icon: UsersRound },
  { id: 'banquet', label: 'Banquet', icon: CalendarHeart },
  { id: 'splits', label: 'Splits', icon: ReceiptText },
];

function JoinCodeDialog({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState('');
  const join = useJoinGroup();
  const navigate = useNavigate();
  return (
    <Dialog
      open
      onClose={onClose}
      title="Join a group"
      description="Enter the code the host shared with you. Codes aren’t case-sensitive."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={join.isPending}
            disabled={code.replace(/[^A-Za-z0-9]/g, '').length < 8}
            onClick={() =>
              join.mutate(code, { onSuccess: (r) => r && navigate(`/groups/tray/${r.group.id}`) })
            }
          >
            Join group
          </Button>
        </>
      }
    >
      <TextField
        label="Join code"
        placeholder="ABCDE-FGH23"
        value={code}
        maxLength={20}
        autoComplete="off"
        onChange={(e) => setCode(e.target.value)}
        data-autofocus
      />
      {join.error ? (
        <p role="alert" className="mt-2 text-sm text-chili-700">
          {describeError(join.error)}
        </p>
      ) : null}
    </Dialog>
  );
}

function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const outlets = useOutlets('');
  const create = useCreateGroup();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [outletId, setOutletId] = useState('');
  const [description, setDescription] = useState('');
  const [maxMembers, setMaxMembers] = useState('8');
  const [closes, setCloses] = useState('');
  const [mode, setMode] = useState<AllocationMode>('BY_DISH');
  const valid = name.trim().length > 0 && outletId !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      title="Start a group tray"
      description="Everyone adds their own food to one tray at one outlet, then pays their share from their own wallet."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!valid}
            onClick={() =>
              create.mutate(
                {
                  name: name.trim(),
                  description: description.trim() || undefined,
                  outletId,
                  maxMembers: Number(maxMembers),
                  joinClosesAt: closes ? fromIstInput(closes) : null,
                  allocationMode: mode,
                },
                { onSuccess: (r) => r && navigate(`/groups/tray/${r.group.id}`) },
              )
            }
          >
            Create group
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField
          label="Group name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder="Project lunch"
          data-autofocus
        />
        <SelectField label="Outlet" value={outletId} onChange={(e) => setOutletId(e.target.value)}>
          <option value="">Choose an outlet…</option>
          {(outlets.data ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.acceptingOrders ? '' : ' (not taking orders now)'}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Description (optional)"
          value={description}
          maxLength={300}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Up to"
            value={maxMembers}
            onChange={(e) => setMaxMembers(e.target.value)}
          >
            {Array.from({ length: 19 }, (_, i) => i + 2).map((n) => (
              <option key={n} value={n}>
                {n} people
              </option>
            ))}
          </SelectField>
          <TextField
            label="Joining closes (optional)"
            type="datetime-local"
            value={closes}
            onChange={(e) => setCloses(e.target.value)}
          />
        </div>
        <SelectField
          label="How to split the bill"
          value={mode}
          hint={MODE_LABELS[mode].hint}
          onChange={(e) => setMode(e.target.value as AllocationMode)}
        >
          {(Object.keys(MODE_LABELS) as AllocationMode[]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m].label}
            </option>
          ))}
        </SelectField>
        {create.error ? (
          <p role="alert" className="text-sm text-chili-700">
            {describeError(create.error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function TrayTab() {
  const groups = useGroups();
  const [creating, setCreating] = useState(false);
  return (
    <section aria-labelledby="tray-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="tray-heading" className="text-xl font-extrabold tracking-wide uppercase">
            Group trays
          </h2>
          <p className="text-espresso-600">
            Order together at one outlet; everyone pays their own share.
          </p>
        </div>
        <Button icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>
          New group
        </Button>
      </div>
      {groups.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : groups.error ? (
        <ErrorState
          error={groups.error}
          onRetry={() => void groups.refetch()}
          retrying={groups.isFetching}
        />
      ) : groups.data.length === 0 ? (
        <EmptyState
          icon={<UsersRound aria-hidden />}
          title="No group trays yet"
          description="Start one, or join with a code from a friend."
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {groups.data.map((g) => (
            <li key={g.id}>
              <Link
                to={`/groups/tray/${g.id}`}
                className="block rounded-(--radius-panel) focus-visible:outline-2"
              >
                <Card className="flex h-full flex-col gap-2 transition-colors hover:border-espresso-300">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-sans text-lg font-bold">{g.name}</h3>
                      <p className="text-sm text-espresso-600">
                        {g.outlet} · {g.memberCount} {g.memberCount === 1 ? 'person' : 'people'} ·{' '}
                        {g.role === 'HOST' ? 'You’re hosting' : 'Member'}
                      </p>
                    </div>
                    <StatusBadge tone={GROUP_STATUS[g.status].tone}>
                      {GROUP_STATUS[g.status].label}
                    </StatusBadge>
                  </div>
                  {g.myShare && (
                    <p className="text-sm">
                      Your share: <strong>{formatINR(g.myShare.amountDuePaise)}</strong>{' '}
                      <Badge tone={SHARE_STATUS[g.myShare.status].tone}>
                        {SHARE_STATUS[g.myShare.status].label}
                      </Badge>
                    </p>
                  )}
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {creating && <NewGroupDialog onClose={() => setCreating(false)} />}
    </section>
  );
}

function BanquetTab() {
  const bookings = useMyBookings();
  const cancel = useCancelBooking();
  return (
    <section aria-labelledby="banquet-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="banquet-heading" className="text-xl font-extrabold tracking-wide uppercase">
            Campus banquet bookings
          </h2>
          <p className="text-espresso-600">
            Pre-book catering for birthdays, club meets &amp; academic events
          </p>
        </div>
        <ButtonLink to="/groups/banquets/new">
          <Plus className="size-4" aria-hidden />
          Plan event
        </ButtonLink>
      </div>
      {bookings.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : bookings.error ? (
        <ErrorState
          error={bookings.error}
          onRetry={() => void bookings.refetch()}
          retrying={bookings.isFetching}
        />
      ) : bookings.data.length === 0 ? (
        <EmptyState
          icon={<CalendarHeart aria-hidden />}
          title="No events planned"
          description="Plan an event and the outlet will confirm it."
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {bookings.data.map((b) => (
            <li key={b.id}>
              <Card className="flex h-full flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-bold tracking-wide text-espresso-500 uppercase">
                      {EVENT_TYPE_LABELS[b.eventType]}
                    </p>
                    <h3 className="font-sans text-lg font-bold">{b.name}</h3>
                    <p className="text-sm text-espresso-600">
                      Hosted by {b.host} · {b.guestCount} guests
                    </p>
                  </div>
                  <StatusBadge tone={BOOKING_STATUS[b.status].tone}>
                    {BOOKING_STATUS[b.status].label}
                  </StatusBadge>
                </div>
                <p className="text-sm">
                  {formatDateTime(b.startsAt)} · {b.outlet.name}
                  {b.outlet.location ? `, ${b.outlet.location}` : ''}
                </p>
                <ul aria-label={`Menu package for ${b.name}`} className="flex flex-wrap gap-1.5">
                  {b.items.map((i) => (
                    <li key={i.menuItemId}>
                      <Badge>
                        {i.name} (x{i.quantity})
                      </Badge>
                    </li>
                  ))}
                </ul>
                <p className="text-sm">
                  Estimated <strong>{formatINR(b.estimatedTotalPaise)}</strong> · about{' '}
                  {formatINR(b.perGuestPaise)} per guest{' '}
                  <span className="text-espresso-500">
                    (estimate; nothing is charged when booking)
                  </span>
                </p>
                {b.decisionReason && b.status === 'REJECTED' && (
                  <p className="text-sm text-chili-700">Outlet’s reason: {b.decisionReason}</p>
                )}
                <div className="mt-auto flex flex-wrap gap-2">
                  <ButtonLink to={`/groups/banquets/${b.id}/pass`} variant="secondary" size="sm">
                    <TicketIcon className="size-4" aria-hidden />
                    View event pass
                  </ButtonLink>
                  {(b.status === 'PENDING_CONFIRMATION' || b.status === 'CONFIRMED') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={cancel.isPending && cancel.variables === b.id}
                      onClick={() => cancel.mutate(b.id)}
                    >
                      Cancel booking
                    </Button>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {cancel.error ? (
        <p role="alert" className="text-sm text-chili-700">
          {describeError(cancel.error)}
        </p>
      ) : null}
    </section>
  );
}

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

function NewSplitDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateSplit();
  const me = useCurrentUser();
  const [title, setTitle] = useState('');
  const [total, setTotal] = useState('');
  const [date, setDate] = useState(today());
  const [due, setDue] = useState('');
  const [description, setDescription] = useState('');
  const [method, setMethod] = useState<NewSplit['method']>('EQUAL');
  const [includeMe, setIncludeMe] = useState(true);
  const [people, setPeople] = useState<{ email: string; value: string }[]>([
    { email: '', value: '' },
  ]);
  const [myValue, setMyValue] = useState('');
  const totalPaise = parseRupeesToPaise(total);
  const filled = people.filter((p) => p.email.trim());

  const inputFor = (value: string) =>
    method === 'PERCENTAGE'
      ? { percentBps: Math.round(Number(value || '0') * 100) }
      : method === 'CUSTOM'
        ? { customAmountPaise: parseRupeesToPaise(value || '0') ?? -1 }
        : {};
  const values = [...(includeMe ? [myValue] : []), ...filled.map((p) => p.value)];
  const sumHint =
    method === 'PERCENTAGE'
      ? `Adds up to ${values.reduce((a, v) => a + Number(v || 0), 0).toFixed(2)}% (must be 100%)`
      : method === 'CUSTOM' && totalPaise !== null
        ? (() => {
            const sum = values.reduce((a, v) => a + (parseRupeesToPaise(v || '0') ?? 0), 0);
            return sum === totalPaise
              ? 'Adds up to the total'
              : `${formatINR(Math.abs(totalPaise - sum))} ${sum > totalPaise ? 'over' : 'short of'} the total`;
          })()
        : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title="New split"
      description="You paid for something shared. Everyone else repays their share from their Orbiz wallet to yours."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={
              !title.trim() || totalPaise === null || totalPaise < 100 || filled.length === 0
            }
            onClick={() =>
              create.mutate(
                {
                  title: title.trim(),
                  description: description.trim() || undefined,
                  totalPaise: totalPaise!,
                  expenseDate: date,
                  dueDate: due || null,
                  method,
                  participants: [
                    ...(includeMe && me.data
                      ? [{ email: me.data.email, ...inputFor(myValue) }]
                      : []),
                    ...filled.map((p) => ({ email: p.email.trim(), ...inputFor(p.value) })),
                  ],
                },
                { onSuccess: onClose },
              )
            }
          >
            Create split
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField
          label="What was it for?"
          value={title}
          maxLength={80}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Dinner at Night Owl"
          data-autofocus
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Total amount (₹)"
            inputMode="decimal"
            value={total}
            onChange={(e) => setTotal(e.target.value)}
            placeholder="1200"
          />
          <TextField
            label="Date of the expense"
            type="date"
            value={date}
            max={today()}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <SelectField
          label="Split"
          value={method}
          onChange={(e) => setMethod(e.target.value as NewSplit['method'])}
        >
          <option value="EQUAL">Equally</option>
          <option value="PERCENTAGE">By percentage</option>
          <option value="CUSTOM">By custom amounts</option>
        </SelectField>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            checked={includeMe}
            onChange={(e) => setIncludeMe(e.target.checked)}
            className="size-4"
          />
          I had a share too
        </label>
        {includeMe && method !== 'EQUAL' && (
          <TextField
            label={method === 'PERCENTAGE' ? 'My share (%)' : 'My share (₹)'}
            inputMode="decimal"
            value={myValue}
            onChange={(e) => setMyValue(e.target.value)}
          />
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">
            People who owe you (their Orbiz email)
          </legend>
          {people.map((p, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <TextField
                label={`Person ${i + 1} email`}
                type="email"
                value={p.email}
                onChange={(e) =>
                  setPeople(people.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))
                }
                className="min-w-48 flex-1"
              />
              {method !== 'EQUAL' && (
                <TextField
                  label={method === 'PERCENTAGE' ? '%' : '₹'}
                  inputMode="decimal"
                  value={p.value}
                  onChange={(e) =>
                    setPeople(people.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                  }
                  className="w-24"
                />
              )}
              {people.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPeople(people.filter((_, j) => j !== i))}
                  aria-label={`Remove person ${i + 1}`}
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
          {people.length < 19 && (
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              onClick={() => setPeople([...people, { email: '', value: '' }])}
            >
              Add person
            </Button>
          )}
          {sumHint && <p className="text-sm text-espresso-600">{sumHint}</p>}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Settle by (optional)"
            type="date"
            value={due}
            min={date}
            onChange={(e) => setDue(e.target.value)}
          />
          <TextField
            label="Note (optional)"
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        {create.error ? (
          <p role="alert" className="text-sm text-chili-700">
            {describeError(create.error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function SettleDialog({ split, onClose }: { split: Split; onClose: () => void }) {
  const settle = useSettleSplit(split.id);
  const outstanding = split.myShare!.outstandingPaise;
  const [amount, setAmount] = useState((outstanding / 100).toFixed(outstanding % 100 ? 2 : 0));
  const [key] = useState(newIdempotencyKey);
  const paise = parseRupeesToPaise(amount);
  const valid = paise !== null && paise >= Math.min(100, outstanding) && paise <= outstanding;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Repay ${split.owner.displayName}`}
      description={`You owe ${formatINR(outstanding)} for “${split.title}”. It moves from your Orbiz wallet to theirs straight away (simulated funds).`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={settle.isPending}
            disabled={!valid}
            icon={<Wallet className="size-4" aria-hidden />}
            onClick={() =>
              settle.mutate({ amountPaise: paise!, idempotencyKey: key }, { onSuccess: onClose })
            }
          >
            Pay {paise !== null ? formatINR(paise) : ''}
          </Button>
        </>
      }
    >
      <TextField
        label="Amount (₹)"
        hint="You can pay part now and the rest later."
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        data-autofocus
      />
      {settle.error ? (
        <p role="alert" className="mt-2 text-sm text-chili-700">
          {describeError(settle.error)}
        </p>
      ) : null}
    </Dialog>
  );
}

function SplitCard({ split }: { split: Split }) {
  const [settling, setSettling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancel = useCancelSplit(split.id);
  const mine = split.myShare;
  return (
    <Card className="flex h-full flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-sans text-lg font-bold">{split.title}</h3>
          <p className="text-sm text-espresso-600">
            {formatINR(split.totalPaise)} in total · paid by{' '}
            {split.isOwner ? 'you' : split.owner.displayName}
          </p>
        </div>
        <StatusBadge
          tone={
            split.status === 'SETTLED'
              ? 'success'
              : split.status === 'CANCELLED'
                ? 'neutral'
                : 'mustard'
          }
        >
          {split.status === 'SETTLED'
            ? 'Settled'
            : split.status === 'CANCELLED'
              ? 'Cancelled'
              : 'Open'}
        </StatusBadge>
      </div>
      <ul aria-label={`People in ${split.title}`} className="flex flex-col gap-1.5">
        {split.participants.map((p) => (
          <li key={p.id} className="flex items-center gap-2 text-sm">
            <PersonAvatar name={p.displayName} url={p.avatarUrl} className="size-7 text-xs" />
            <span className="flex-1">{p.displayName}</span>
            <span className="text-espresso-600">
              {p.status === 'OWNER'
                ? `own share ${formatINR(p.amountDuePaise)}`
                : `${formatINR(p.amountDuePaise)} share`}
            </span>
            <Badge tone={PARTICIPANT_STATUS[p.status].tone}>
              {PARTICIPANT_STATUS[p.status].label}
            </Badge>
          </li>
        ))}
      </ul>
      {split.isOwner ? (
        <p className="text-sm">
          Still to be repaid to you: <strong>{formatINR(split.totalOutstandingPaise)}</strong>
        </p>
      ) : (
        mine && (
          <p className="text-sm">
            Your share {formatINR(mine.amountDuePaise)} · you’ve paid{' '}
            {formatINR(mine.amountPaidPaise)} ·{' '}
            <strong>you owe {formatINR(mine.outstandingPaise)}</strong>
          </p>
        )
      )}
      {split.dueDate && split.status === 'OPEN' && (
        <p className="text-xs text-espresso-500">Settle by {split.dueDate}</p>
      )}
      <div className="mt-auto flex flex-wrap gap-2">
        {mine && mine.outstandingPaise > 0 && split.status === 'OPEN' ? (
          <Button
            size="sm"
            icon={<Wallet className="size-4" aria-hidden />}
            onClick={() => setSettling(true)}
          >
            Settle via wallet
          </Button>
        ) : mine && mine.status === 'PAID' ? (
          <Badge tone="success">Settled</Badge>
        ) : null}
        {split.isOwner && split.status !== 'CANCELLED' && (
          <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(true)}>
            Cancel split
          </Button>
        )}
      </div>
      {settling && <SettleDialog split={split} onClose={() => setSettling(false)} />}
      {confirmCancel && (
        <Dialog
          open
          onClose={() => setConfirmCancel(false)}
          title="Cancel this split?"
          description="Anything already repaid is sent back from your wallet to each person. The history is kept."
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                loading={cancel.isPending}
                onClick={() => cancel.mutate('', { onSuccess: () => setConfirmCancel(false) })}
              >
                Cancel split
              </Button>
            </>
          }
        >
          {cancel.error ? (
            <p role="alert" className="text-sm text-chili-700">
              {describeError(cancel.error)}
            </p>
          ) : null}
        </Dialog>
      )}
    </Card>
  );
}

function SplitsTab() {
  const splits = useSplits();
  const [creating, setCreating] = useState(false);
  return (
    <section aria-labelledby="splits-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="splits-heading" className="text-xl font-extrabold tracking-wide uppercase">
            Campus peer splits
          </h2>
          <p className="text-espresso-600">Settle shared campus cafeteria and dining expenses</p>
        </div>
        <Button icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>
          New split
        </Button>
      </div>
      {splits.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : splits.error ? (
        <ErrorState
          error={splits.error}
          onRetry={() => void splits.refetch()}
          retrying={splits.isFetching}
        />
      ) : splits.data.length === 0 ? (
        <EmptyState
          icon={<ReceiptText aria-hidden />}
          title="No shared expenses"
          description="Paid for friends? Create a split and they can repay you from their wallets."
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {splits.data.map((s) => (
            <li key={s.id}>
              <SplitCard split={s} />
            </li>
          ))}
        </ul>
      )}
      {creating && <NewSplitDialog onClose={() => setCreating(false)} />}
    </section>
  );
}

export function GroupsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'tray') as Tab;
  const [joining, setJoining] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold tracking-[0.18em] text-chili-600 uppercase">
            Collaborative dining
          </p>
          <h1 className="text-3xl font-extrabold tracking-tight uppercase md:text-4xl">
            Group repast &amp; splits
          </h1>
          <p className="mt-1 text-espresso-600">
            Multi-guest trays, equitable bill division &amp; private catering suites
          </p>
        </div>
        <Button
          variant="secondary"
          icon={<KeyRound className="size-4" aria-hidden />}
          onClick={() => setJoining(true)}
        >
          Join code
        </Button>
      </header>
      <div
        role="tablist"
        aria-label="Group dining"
        className="flex gap-1 overflow-x-auto rounded-(--radius-control) bg-espresso-50 p-1 [scrollbar-width:none]"
      >
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            onClick={() => setParams(id === 'tray' ? {} : { tab: id }, { replace: true })}
            className={cn(
              'flex min-h-11 flex-1 shrink-0 items-center justify-center gap-2 rounded-(--radius-control) px-4 text-sm font-bold whitespace-nowrap transition-colors',
              tab === id
                ? 'bg-white text-espresso-900 shadow-press'
                : 'text-espresso-600 hover:text-espresso-900',
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'tray' ? <TrayTab /> : tab === 'banquet' ? <BanquetTab /> : <SplitsTab />}
      </div>
      {joining && <JoinCodeDialog onClose={() => setJoining(false)} />}
    </div>
  );
}
