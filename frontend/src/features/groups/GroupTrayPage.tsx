import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Check, Copy, Minus, Plus, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { TextField } from '@/components/ui/TextField';
import { Skeleton } from '@/components/feedback/Skeleton';
import { ErrorState } from '@/components/feedback/ErrorState';
import { describeError } from '@/lib/errors';
import { formatINR, paiseToRupeesInput, parseRupeesToPaise } from '@/lib/money';
import { formatDateTime } from '@/lib/time';
import { newIdempotencyKey } from '@/lib/idempotency';
import { cn } from '@/lib/cn';
import { useOutletMenu } from '@/services/outlets';
import {
  formatCode,
  useCancelGroup,
  useGroup,
  useJoinGroup,
  usePayMyShare,
  usePlaceGroupOrder,
  useRemoveMember,
  useReopenGroup,
  useSetAllocation,
  useSetMyItem,
  useStartCheckout,
  type AllocationMode,
  type Group,
} from '@/services/groups';
import { useWallet } from '@/services/wallet';
import { Card, PersonAvatar, StatusBadge } from './shared';
import { GROUP_STATUS, MODE_LABELS, SHARE_STATUS } from './labels';

const EVENT_LABELS: Record<string, string> = {
  CREATED: 'created the group',
  JOINED: 'joined',
  LEFT: 'left',
  REMOVED: 'removed a member',
  SETTINGS_CHANGED: 'changed the group settings',
  ALLOCATION_CHANGED: 'changed how the bill is split',
  CHECKOUT_STARTED: 'locked the tray for payment',
  SHARE_PAID: 'paid their share',
  ORDER_PLACED: 'Order placed',
  ORDER_FAILED: 'The order couldn’t be placed yet',
  REOPENED: 'reopened the tray (paid shares refunded)',
  CANCELLED: 'cancelled the group (paid shares refunded)',
  ORDER_REFUNDED: 'The outlet ended the order; every share was refunded',
};

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 2000);
        })
      }
    >
      {done ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {done ? 'Copied' : label}
    </Button>
  );
}

/** Amount each member is allocated: the frozen settlement after checkout, else the live preview. */
function amountsOf(g: Group): Map<string, number> | null {
  if (g.settlement) return new Map(g.settlement.shares.map((s) => [s.memberId, s.amountDuePaise]));
  if (g.allocationPreview?.ok)
    return new Map(g.allocationPreview.amounts.map((a) => [a.id, a.amountPaise]));
  return null;
}

function AllocationEditor({ g }: { g: Group }) {
  const save = useSetAllocation(g.id);
  const [mode, setMode] = useState<AllocationMode>(g.allocationMode);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      g.members.map((m) => [
        m.id,
        g.allocationMode === 'PERCENTAGE' && m.percentBps !== null
          ? String(m.percentBps / 100)
          : g.allocationMode === 'CUSTOM' && m.customAmountPaise !== null
            ? paiseToRupeesInput(m.customAmountPaise)
            : '',
      ]),
    ),
  );
  const needsInputs = mode === 'PERCENTAGE' || mode === 'CUSTOM';
  const sum = g.members.reduce(
    (a, m) =>
      a +
      (mode === 'PERCENTAGE'
        ? Math.round(Number(values[m.id] || 0) * 100)
        : (parseRupeesToPaise(values[m.id] || '0') ?? 0)),
    0,
  );
  const target = mode === 'PERCENTAGE' ? 10_000 : g.tray.totalPaise;
  const balanced = !needsInputs || sum === target;
  return (
    <Card>
      <fieldset>
        <legend className="mb-2 font-sans font-bold">Settlement formula</legend>
        <div role="radiogroup" className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {(Object.keys(MODE_LABELS) as AllocationMode[]).map((m) => (
            <label
              key={m}
              className={cn(
                'flex cursor-pointer flex-col rounded-(--radius-control) border p-3 text-sm',
                mode === m ? 'border-espresso-900 bg-espresso-50' : 'border-espresso-100 bg-white',
              )}
            >
              <span className="flex items-center gap-2 font-bold">
                <input
                  type="radio"
                  name="allocation"
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                />
                {MODE_LABELS[m].label}
              </span>
              <span className="mt-1 text-espresso-600">{MODE_LABELS[m].hint}</span>
            </label>
          ))}
        </div>
        {needsInputs && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {g.members.map((m) => (
              <TextField
                key={m.id}
                label={`${m.displayName} ${mode === 'PERCENTAGE' ? '(%)' : '(₹)'}`}
                inputMode="decimal"
                value={values[m.id] ?? ''}
                onChange={(e) => setValues({ ...values, [m.id]: e.target.value })}
              />
            ))}
            <p
              className={cn(
                'text-sm sm:col-span-2',
                balanced ? 'text-success-600' : 'text-chili-700',
              )}
              role="status"
            >
              {mode === 'PERCENTAGE'
                ? `Adds up to ${(sum / 100).toFixed(2)}% of 100%`
                : balanced
                  ? `Adds up to the tray total, ${formatINR(target)}`
                  : `${formatINR(Math.abs(target - sum))} ${sum > target ? 'over' : 'short of'} the tray total (${formatINR(target)})`}
            </p>
          </div>
        )}
        <Button
          className="mt-3"
          size="sm"
          loading={save.isPending}
          disabled={!balanced || (mode === g.allocationMode && !needsInputs)}
          onClick={() =>
            save.mutate({
              mode,
              ...(mode === 'PERCENTAGE' && {
                percents: Object.fromEntries(
                  g.members.map((m) => [m.id, Math.round(Number(values[m.id] || 0) * 100)]),
                ),
              }),
              ...(mode === 'CUSTOM' && {
                amounts: Object.fromEntries(
                  g.members.map((m) => [m.id, parseRupeesToPaise(values[m.id] || '0') ?? 0]),
                ),
              }),
            })
          }
        >
          Save formula
        </Button>
        {save.error ? (
          <p role="alert" className="mt-2 text-sm text-chili-700">
            {describeError(save.error)}
          </p>
        ) : null}
      </fieldset>
    </Card>
  );
}

function AddFood({ g }: { g: Group }) {
  const menu = useOutletMenu(g.outlet.slug, {});
  const setItem = useSetMyItem(g.id);
  const mine = new Map(
    g.members.find((m) => m.id === g.me.memberId)?.items.map((i) => [i.menuItemId, i.quantity]) ??
      [],
  );
  return (
    <Card>
      <h2 className="mb-3 font-sans text-lg font-bold">Add your food</h2>
      {menu.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : menu.error ? (
        <ErrorState
          error={menu.error}
          onRetry={() => void menu.refetch()}
          retrying={menu.isFetching}
        />
      ) : (
        <ul className="divide-y divide-dashed divide-espresso-100">
          {menu.data.items.map((item) => {
            const qty = mine.get(item.id) ?? 0;
            return (
              <li key={item.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{item.name}</p>
                  <p className="text-sm text-espresso-600">
                    {formatINR(item.pricePaise)}
                    {!item.isAvailable && ' · sold out'}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`One less ${item.name}`}
                    disabled={qty === 0 || setItem.isPending}
                    onClick={() => setItem.mutate({ menuItemId: item.id, quantity: qty - 1 })}
                  >
                    <Minus className="size-4" aria-hidden />
                  </Button>
                  <span
                    className="w-6 text-center font-bold"
                    aria-label={`${qty} ${item.name} in your share`}
                  >
                    {qty}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`One more ${item.name}`}
                    disabled={!item.isAvailable || qty >= 10 || setItem.isPending}
                    onClick={() => setItem.mutate({ menuItemId: item.id, quantity: qty + 1 })}
                  >
                    <Plus className="size-4" aria-hidden />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {setItem.error ? (
        <p role="alert" className="mt-2 text-sm text-chili-700">
          {describeError(setItem.error)}
        </p>
      ) : null}
    </Card>
  );
}

function Members({ g }: { g: Group }) {
  const remove = useRemoveMember(g.id);
  const navigate = useNavigate();
  const amounts = amountsOf(g);
  const shares = new Map(g.settlement?.shares.map((s) => [s.memberId, s]) ?? []);
  const isHost = g.me.role === 'HOST';
  // After checkout, show the frozen lines; before, the live tray.
  const lines = (memberId: string) =>
    g.settlement
      ? g.settlement.lines.filter((l) => l.memberId === memberId)
      : (g.members.find((m) => m.id === memberId)?.items ?? []);
  return (
    <Card>
      <h2 className="mb-3 font-sans text-lg font-bold">
        Members ({g.members.length}/{g.maxMembers})
      </h2>
      <ul className="flex flex-col divide-y divide-espresso-100">
        {g.members.map((m) => {
          const share = shares.get(m.id);
          return (
            <li key={m.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
              <div className="flex flex-1 items-start gap-3">
                <PersonAvatar name={m.displayName} url={m.avatarUrl} />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {m.displayName}{' '}
                    {m.id === g.me.memberId && <span className="text-espresso-500">(you)</span>}{' '}
                    <Badge tone={m.role === 'HOST' ? 'dark' : 'neutral'}>
                      {m.role === 'HOST' ? 'Host' : 'Member'}
                    </Badge>
                  </p>
                  {lines(m.id).length === 0 ? (
                    <p className="text-sm text-espresso-500">Nothing added yet</p>
                  ) : (
                    <ul className="text-sm text-espresso-700">
                      {lines(m.id).map((l) => (
                        <li key={l.menuItemId}>
                          {l.quantity} × {l.name} · {formatINR(l.lineTotalPaise)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 pl-12 sm:flex-col sm:items-end sm:pl-0">
                <span className="text-sm">
                  Pays{' '}
                  <strong>
                    {amounts?.get(m.id) !== undefined ? formatINR(amounts.get(m.id)!) : '—'}
                  </strong>
                </span>
                {share ? (
                  <Badge tone={SHARE_STATUS[share.status].tone}>
                    {SHARE_STATUS[share.status].label}
                    {share.paidAt && share.status === 'PAID' ? ' · wallet' : ''}
                  </Badge>
                ) : (
                  <Badge tone="neutral">Not due yet</Badge>
                )}
                {g.status === 'ACTIVE' &&
                  m.role !== 'HOST' &&
                  (isHost || m.id === g.me.memberId) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={remove.isPending && remove.variables === m.id}
                      onClick={() =>
                        remove.mutate(m.id, {
                          onSuccess: () =>
                            m.id === g.me.memberId ? navigate('/groups') : undefined,
                        })
                      }
                    >
                      {m.id === g.me.memberId ? 'Leave group' : 'Remove'}
                    </Button>
                  )}
              </div>
            </li>
          );
        })}
      </ul>
      {remove.error ? (
        <p role="alert" className="text-sm text-chili-700">
          {describeError(remove.error)}
        </p>
      ) : null}
    </Card>
  );
}

function Summary({ g }: { g: Group }) {
  const checkout = useStartCheckout(g.id);
  const [confirming, setConfirming] = useState(false);
  const combined = useMemo(() => {
    const src = g.settlement ? g.settlement.lines : g.members.flatMap((m) => m.items);
    const map = new Map<string, { name: string; quantity: number; total: number }>();
    for (const l of src) {
      const e = map.get(l.menuItemId) ?? { name: l.name, quantity: 0, total: 0 };
      e.quantity += l.quantity;
      e.total += l.lineTotalPaise;
      map.set(l.menuItemId, e);
    }
    return [...map.values()];
  }, [g]);
  const total = g.settlement?.totalPaise ?? g.tray.totalPaise;
  const preview = g.allocationPreview;
  const isHost = g.me.role === 'HOST';
  return (
    <Card>
      <h2 className="mb-2 font-sans text-lg font-bold">Combined tray</h2>
      {combined.length === 0 ? (
        <p className="text-espresso-600">The tray is empty. Add food below.</p>
      ) : (
        <ul className="text-sm">
          {combined.map((l) => (
            <li
              key={l.name}
              className="flex justify-between border-b border-dashed border-espresso-100 py-1"
            >
              <span>
                {l.quantity} × {l.name}
              </span>
              <span>{formatINR(l.total)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 flex justify-between font-bold">
        <span>Total</span>
        <span>{formatINR(total)}</span>
      </p>
      <p className="text-xs text-espresso-500">
        Orbiz has no taxes, fees or group discounts, so this is what the group pays.
      </p>
      <p className="mt-2 text-sm">
        Formula: <strong>{MODE_LABELS[g.settlement?.mode ?? g.allocationMode].label}</strong>
        {g.settlement ? ' (locked at checkout)' : ''}
      </p>
      {g.tray.problems.length > 0 && g.status === 'ACTIVE' && (
        <p role="alert" className="mt-2 text-sm text-chili-700">
          Not available any more: {g.tray.problems.map((p) => p.name).join(', ')}. Remove them
          before checkout.
        </p>
      )}
      {preview && !preview.ok && (
        <p role="alert" className="mt-2 text-sm text-chili-700">
          {preview.message}
        </p>
      )}
      {isHost && g.status === 'ACTIVE' && (
        <Button
          className="mt-3"
          block
          disabled={total === 0 || !preview?.ok || g.tray.problems.length > 0}
          onClick={() => setConfirming(true)}
        >
          Group checkout · {formatINR(total)}
        </Button>
      )}
      {confirming && preview?.ok && (
        <Dialog
          open
          onClose={() => setConfirming(false)}
          title="Lock the tray and ask everyone to pay?"
          description="Prices and the split are fixed now. Each person pays their share from their own wallet; the order goes to the kitchen once everyone has paid."
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Not yet
              </Button>
              <Button
                loading={checkout.isPending}
                onClick={() => checkout.mutate(total, { onSuccess: () => setConfirming(false) })}
              >
                Confirm {formatINR(total)}
              </Button>
            </>
          }
        >
          <ul className="text-sm">
            {preview.amounts.map((a) => (
              <li key={a.id} className="flex justify-between py-1">
                <span>{g.members.find((m) => m.id === a.id)?.displayName}</span>
                <strong>{formatINR(a.amountPaise)}</strong>
              </li>
            ))}
          </ul>
          {checkout.error ? (
            <p role="alert" className="mt-2 text-sm text-chili-700">
              {describeError(checkout.error)}
            </p>
          ) : null}
        </Dialog>
      )}
    </Card>
  );
}

function Payment({ g }: { g: Group }) {
  const pay = usePayMyShare(g.id);
  const place = usePlaceGroupOrder(g.id);
  const reopen = useReopenGroup(g.id);
  const wallet = useWallet();
  const [key, setKey] = useState(newIdempotencyKey);
  const mine = g.settlement?.shares.find((s) => s.memberId === g.me.memberId);
  const unpaid = g.settlement?.shares.filter((s) => s.status === 'UNPAID').length ?? 0;
  const isHost = g.me.role === 'HOST';
  const orderError = pay.data?.orderError ?? null;
  return (
    <Card className="border-mustard-300 bg-mustard-50/40">
      <h2 className="font-sans text-lg font-bold">Pay your share</h2>
      {mine && mine.status === 'UNPAID' ? (
        <>
          <p className="mt-1">
            You owe <strong>{formatINR(mine.amountDuePaise)}</strong> to Orbiz for this order
            {mine.ownItemsPaise !== mine.amountDuePaise
              ? ` (your own items: ${formatINR(mine.ownItemsPaise)})`
              : ''}
            .
          </p>
          {wallet.data && (
            <p className="text-sm text-espresso-600">
              Wallet balance {formatINR(wallet.data.balancePaise)} (simulated test funds)
            </p>
          )}
          <Button
            className="mt-2"
            icon={<Wallet className="size-4" aria-hidden />}
            loading={pay.isPending}
            onClick={() => pay.mutate(key, { onSuccess: () => setKey(newIdempotencyKey()) })}
          >
            Pay {formatINR(mine.amountDuePaise)} from wallet
          </Button>
        </>
      ) : mine ? (
        <p className="mt-1">
          Your share: <strong>{formatINR(mine.amountDuePaise)}</strong>{' '}
          <Badge tone={SHARE_STATUS[mine.status].tone}>{SHARE_STATUS[mine.status].label}</Badge>
        </p>
      ) : null}
      <p className="mt-2 text-sm text-espresso-700">
        {unpaid === 0
          ? 'Everyone has paid.'
          : `${unpaid} ${unpaid === 1 ? 'person hasn’t' : 'people haven’t'} paid yet. The order is placed once everyone has.`}{' '}
        This is a payment to Orbiz; settling up between friends afterwards is separate (use Splits).
      </p>
      {pay.error ? (
        <p role="alert" className="mt-2 text-sm text-chili-700">
          {describeError(pay.error)}
        </p>
      ) : null}
      {orderError && (
        <p role="alert" className="mt-2 text-sm text-chili-700">
          {orderError.message}
        </p>
      )}
      {isHost && (
        <div className="mt-3 flex flex-wrap gap-2">
          {unpaid === 0 && (
            <Button size="sm" loading={place.isPending} onClick={() => place.mutate(undefined)}>
              Place the order
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            loading={reopen.isPending}
            onClick={() => reopen.mutate(undefined)}
          >
            Reopen tray (refunds everyone)
          </Button>
        </div>
      )}
      {(place.error || reopen.error) && (
        <p role="alert" className="mt-2 text-sm text-chili-700">
          {describeError(place.error ?? reopen.error)}
        </p>
      )}
    </Card>
  );
}

export function GroupTrayPage() {
  const { groupId = '' } = useParams();
  const group = useGroup(groupId);
  const cancel = useCancelGroup(groupId);
  const [confirmCancel, setConfirmCancel] = useState(false);
  if (group.isPending) return <Skeleton className="h-96 w-full" />;
  if (group.error)
    return (
      <ErrorState
        error={group.error}
        onRetry={() => void group.refetch()}
        retrying={group.isFetching}
      />
    );
  const g = group.data;
  const isHost = g.me.role === 'HOST';
  const invite = `${window.location.origin}/groups/join/${g.code}`;
  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/groups"
        className="flex items-center gap-1 text-sm font-semibold text-espresso-600 hover:text-espresso-900"
      >
        <ArrowLeft className="size-4" aria-hidden /> Groups
      </Link>
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <StatusBadge tone={GROUP_STATUS[g.status].tone}>
              {GROUP_STATUS[g.status].label}
            </StatusBadge>
            <h1 className="mt-1 text-2xl font-extrabold">{g.name}</h1>
            <p className="text-espresso-600">
              {g.outlet.name} · hosted by {g.host.displayName}
              {g.joinClosesAt ? ` · joining closes ${formatDateTime(g.joinClosesAt)}` : ''}
            </p>
            {g.description && <p className="mt-1">{g.description}</p>}
          </div>
          {g.status === 'ACTIVE' && (
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <p className="text-sm text-espresso-600">
                Join code{' '}
                <span className="font-mono text-lg font-bold tracking-widest text-espresso-900">
                  {formatCode(g.code)}
                </span>
              </p>
              <div className="flex gap-2">
                <CopyButton text={g.code} label="Copy code" />
                <CopyButton text={invite} label="Copy invite link" />
              </div>
            </div>
          )}
        </div>
        {g.status === 'ORDERED' && g.order && (
          <p
            role="status"
            className="rounded-(--radius-control) bg-success-50 px-3 py-2 text-success-700"
          >
            Order placed — pickup code <strong className="font-mono">{g.order.pickupCode}</strong> (
            {g.order.status.toLowerCase()}).
            {isHost && (
              <>
                {' '}
                <Link to={`/orders/${g.order.id}`} className="font-semibold underline">
                  Track the order
                </Link>
              </>
            )}
          </p>
        )}
        {g.status === 'CANCELLED' && (
          <p className="rounded-(--radius-control) bg-espresso-50 px-3 py-2">
            This group was cancelled{g.cancelReason ? `: ${g.cancelReason}` : ''}. Any paid shares
            were refunded.
          </p>
        )}
      </Card>

      {g.status === 'CHECKOUT' && <Payment g={g} />}
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-4">
          {isHost && g.status === 'ACTIVE' && <AllocationEditor key={g.allocationMode} g={g} />}
          <Members g={g} />
          {g.status === 'ACTIVE' && <AddFood g={g} />}
        </div>
        <div className="flex flex-col gap-4">
          <Summary g={g} />
          <Card>
            <details>
              <summary className="cursor-pointer font-sans font-bold">Activity</summary>
              <ol className="mt-2 space-y-1 text-sm text-espresso-700">
                {g.events.map((e) => (
                  <li key={e.id}>
                    <time className="text-espresso-500" dateTime={e.at}>
                      {formatDateTime(e.at)}
                    </time>{' '}
                    {e.actor ? `${e.actor} ` : ''}
                    {EVENT_LABELS[e.kind] ?? e.kind.toLowerCase()}
                  </li>
                ))}
              </ol>
            </details>
          </Card>
          {isHost && (g.status === 'ACTIVE' || g.status === 'CHECKOUT') && (
            <Button variant="ghost" onClick={() => setConfirmCancel(true)}>
              Cancel group
            </Button>
          )}
          {g.status === 'ORDERED' && !isHost && (
            <ButtonLink to="/orders" variant="secondary">
              Your orders
            </ButtonLink>
          )}
        </div>
      </div>
      {confirmCancel && (
        <Dialog
          open
          onClose={() => setConfirmCancel(false)}
          title="Cancel this group?"
          description="Anyone who already paid gets their share back in their wallet. This can’t be undone."
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
                Keep group
              </Button>
              <Button
                variant="danger"
                loading={cancel.isPending}
                onClick={() => cancel.mutate('', { onSuccess: () => setConfirmCancel(false) })}
              >
                Cancel group
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
    </div>
  );
}

/** /groups/join/:code — invite links land here. */
export function JoinGroupRoute() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const join = useJoinGroupOnce(code, (id) => navigate(`/groups/tray/${id}`, { replace: true }));
  if (join.error) return <ErrorState error={join.error} />;
  return <Skeleton className="h-48 w-full" />;
}

function useJoinGroupOnce(code: string, done: (groupId: string) => void) {
  const join = useJoinGroup();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    join.mutate(code, { onSuccess: (r) => r && done(r.group.id) });
  }, [code, done, join]);
  return join;
}
