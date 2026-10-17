import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Gift,
  ReceiptText,
  Sparkles,
  WalletMinimal,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { TestModeBanner } from '@/components/feedback/TestModeBanner';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useToast } from '@/components/feedback/toast-context';
import { RECHARGE_PRESETS_PAISE } from '@/config/wallet';
import { describeError } from '@/lib/errors';
import { newIdempotencyKey } from '@/lib/idempotency';
import { formatINR } from '@/lib/money';
import { cn } from '@/lib/cn';
import {
  bonusFor,
  useLoyaltyTransactions,
  useStartRecharge,
  useWallet,
  useWalletTransactions,
  type LoyaltyTransaction,
  type Recharge,
  type Wallet,
  type WalletTransaction,
} from '@/services/wallet';
import { MockPaymentDialog } from './MockPaymentDialog';
import { TransactionDialog } from './TransactionDialog';
import { statusInfo, typeLabels } from './wallet-labels';

function BalanceCard({ wallet }: { wallet: Wallet }) {
  return (
    <section
      aria-labelledby="balance-heading"
      className="relative overflow-hidden rounded-(--radius-panel) bg-espresso-900 p-6 text-cream-100 shadow-lift"
    >
      <div
        aria-hidden
        className="absolute -top-10 -right-10 size-40 rounded-full border-[18px] border-mustard-500/15"
      />
      <div className="flex items-center gap-2 text-sm font-semibold text-cream-100/70">
        <WalletMinimal className="size-4" aria-hidden />
        <h2 id="balance-heading">Available balance</h2>
      </div>
      <p className="mt-3 font-display text-5xl font-extrabold tabular">
        {formatINR(wallet.balancePaise)}
      </p>
      <p className="mt-2 text-sm text-cream-100/70">
        Simulated test funds · maximum balance {formatINR(wallet.recharge.maxBalancePaise)}
      </p>
    </section>
  );
}

const pointsLabel = (n: number) => `${n} ${n === 1 ? 'point' : 'points'}`;

/** Loyalty points, kept visibly separate from money. */
function PointsCard({ wallet }: { wallet: Wallet }) {
  const { pointsBalance, pointValuePaise } = wallet.loyalty;
  return (
    <section
      aria-labelledby="points-heading"
      className="rounded-(--radius-panel) border border-mustard-100 bg-mustard-50 p-5"
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-mustard-800">
        <Sparkles className="size-4" aria-hidden />
        <h2 id="points-heading">Loyalty points</h2>
      </div>
      <p className="mt-2 font-display text-3xl font-extrabold text-espresso-900 tabular">
        {pointsLabel(pointsBalance)}
      </p>
      <p className="mt-1 text-sm text-espresso-700">
        Worth {formatINR(pointsBalance * pointValuePaise)} off your orders at checkout · 1 point ={' '}
        {formatINR(pointValuePaise)}. Points aren’t cash and can’t be withdrawn.
      </p>
    </section>
  );
}

function RechargeForm({
  wallet,
  initialRupees,
  onStarted,
}: {
  wallet: Wallet;
  initialRupees: string;
  onStarted: (recharge: Recharge) => void;
}) {
  const toast = useToast();
  const start = useStartRecharge();
  const [rupees, setRupees] = useState(initialRupees);
  const [error, setError] = useState<string | null>(null);
  // One key per recharge intent; renewed after each successful start.
  const key = useRef(newIdempotencyKey());

  const { minPaise, maxPaise, maxBalancePaise } = wallet.recharge;
  const headroomPaise = maxBalancePaise - wallet.balancePaise;
  const typedPaise = /^\d+$/.test(rupees.trim()) ? Number(rupees.trim()) * 100 : null;
  const typedValid = typedPaise !== null && typedPaise >= minPaise && typedPaise <= maxPaise;
  const typedBonus = typedValid ? bonusFor(wallet, typedPaise) : 0;
  const slabText = wallet.loyalty.rechargeBonusSlabs
    .map((s) => `${formatINR(s.amountPaise)} → ${pointsLabel(s.points)}`)
    .join(' · ');

  if (!wallet.recharge.available) {
    return (
      <Panel className="p-5">
        <h2 className="text-lg font-bold">Add money</h2>
        <p className="mt-2 text-sm text-espresso-500">
          Recharge isn’t available right now: no payment provider is configured on this server.
        </p>
      </Panel>
    );
  }

  function validate(): number | null {
    if (!/^\d+$/.test(rupees.trim())) return (setError('Enter a whole number of rupees.'), null);
    const paise = Number(rupees.trim()) * 100;
    if (paise < minPaise)
      return (setError(`The minimum recharge is ${formatINR(minPaise)}.`), null);
    if (paise > maxPaise)
      return (setError(`The maximum recharge is ${formatINR(maxPaise)}.`), null);
    if (paise > headroomPaise) {
      return (
        setError(
          `You can add up to ${formatINR(Math.max(headroomPaise, 0))} before reaching the ${formatINR(maxBalancePaise)} limit.`,
        ),
        null
      );
    }
    return paise;
  }

  function submit() {
    setError(null);
    const amountPaise = validate();
    if (amountPaise === null) return;
    start.mutate(
      { amountPaise, idempotencyKey: key.current },
      {
        onSuccess: (recharge) => {
          key.current = newIdempotencyKey();
          onStarted(recharge);
        },
        onError: (e) =>
          toast.show({
            tone: 'error',
            title: 'Couldn’t start the recharge',
            description: describeError(e),
          }),
      },
    );
  }

  return (
    <Panel className="p-5">
      <h2 className="text-lg font-bold">Add money</h2>
      <p className="mt-1 text-sm text-espresso-500">
        Minimum {formatINR(minPaise)}, up to {formatINR(maxPaise)} per recharge. Uses the test-mode
        payment simulator.
      </p>
      <form
        className="mt-4 flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
          role="group"
          aria-label="Quick amounts"
        >
          {RECHARGE_PRESETS_PAISE.map((paise) => {
            const selected = rupees === String(paise / 100);
            const bonus = bonusFor(wallet, paise);
            return (
              <button
                key={paise}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  setRupees(String(paise / 100));
                  setError(null);
                }}
                className={cn(
                  'flex h-14 flex-col items-center justify-center rounded-(--radius-control) border font-semibold tabular transition-colors',
                  selected
                    ? 'border-espresso-900 bg-espresso-900 text-cream-100'
                    : 'border-espresso-200 bg-cream-50 hover:border-espresso-400',
                )}
              >
                {formatINR(paise)}
                {bonus > 0 && ' '}
                {bonus > 0 && (
                  <span
                    className={cn(
                      'text-xs font-bold',
                      selected ? 'text-mustard-300' : 'text-mustard-700',
                    )}
                  >
                    +{pointsLabel(bonus)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <TextField
          label="Amount"
          adornment="₹"
          inputMode="numeric"
          placeholder="Enter amount in rupees"
          value={rupees}
          error={error ?? undefined}
          onChange={(event) => {
            setRupees(event.target.value.replace(/[^\d]/g, '').slice(0, 6));
            setError(null);
          }}
        />
        <p
          aria-live="polite"
          className={cn(
            'flex items-start gap-2 rounded-(--radius-control) px-3 py-2 text-sm',
            typedBonus > 0 ? 'bg-mustard-50 text-mustard-800' : 'bg-cream-200 text-espresso-700',
          )}
        >
          <Gift className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {typedBonus > 0
              ? `You’ll earn ${pointsLabel(typedBonus)} (worth ${formatINR(typedBonus * wallet.loyalty.pointValuePaise)}) once this recharge succeeds.`
              : typedValid
                ? `No bonus points for this amount. Bonuses: ${slabText}.`
                : `Bonus points: ${slabText}. Other amounts earn none.`}
          </span>
        </p>
        <Button type="submit" block loading={start.isPending}>
          Add {rupees && /^\d+$/.test(rupees) ? formatINR(Number(rupees) * 100) : 'money'}
        </Button>
      </form>
    </Panel>
  );
}

function TransactionRow({
  t,
  onOpen,
  onContinue,
}: {
  t: WalletTransaction;
  onOpen: () => void;
  onContinue?: () => void;
}) {
  const credit = t.direction === 'CREDIT';
  const settled = t.status === 'COMPLETED';
  return (
    <li className="flex items-center gap-3 border-b border-dashed border-espresso-100 py-3 last:border-b-0">
      <span
        className={cn(
          'grid size-10 shrink-0 place-items-center rounded-full',
          credit ? 'bg-success-50 text-success-600' : 'bg-chili-50 text-chili-600',
        )}
      >
        {credit ? (
          <ArrowDownLeft className="size-5" aria-hidden />
        ) : (
          <ArrowUpRight className="size-5" aria-hidden />
        )}
      </span>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="block font-semibold hover:underline">{typeLabels[t.type]}</span>
        <span className="block truncate text-sm text-espresso-500">
          {new Date(t.createdAt).toLocaleString('en-IN', {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}{' '}
          · {t.description}
        </span>
      </button>
      <div className="flex flex-col items-end gap-1">
        <span
          className={cn(
            'font-semibold tabular',
            !settled && 'text-espresso-500 line-through decoration-espresso-200',
            settled && credit && 'text-success-600',
          )}
        >
          {credit ? '+' : '−'}
          {formatINR(t.amountPaise)}
        </span>
        {t.status === 'PENDING' && onContinue ? (
          <button
            type="button"
            onClick={onContinue}
            className="text-xs font-bold text-chili-600 hover:underline"
          >
            Complete payment
          </button>
        ) : (
          t.status !== 'COMPLETED' && (
            <Badge tone={statusInfo[t.status].tone}>{statusInfo[t.status].label}</Badge>
          )
        )}
      </div>
    </li>
  );
}

function PointsRow({ t }: { t: LoyaltyTransaction }) {
  const credit = t.direction === 'CREDIT';
  const label =
    t.type === 'EARNED_RECHARGE'
      ? 'Recharge bonus'
      : t.type === 'REDEEMED_ORDER'
        ? 'Used at checkout'
        : 'Returned (order cancelled)';
  return (
    <li className="flex items-center gap-3 border-b border-dashed border-espresso-100 py-3 last:border-b-0">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-mustard-50 text-mustard-700">
        <Sparkles className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        <span className="block truncate text-sm text-espresso-500">
          {new Date(t.createdAt).toLocaleString('en-IN', {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}{' '}
          · {t.description}
        </span>
      </div>
      <span className={cn('font-semibold tabular', credit ? 'text-success-600' : 'text-chili-600')}>
        {credit ? '+' : '−'}
        {pointsLabel(t.points)}
      </span>
    </li>
  );
}

function PointsHistory() {
  const points = useLoyaltyTransactions();
  const rows = points.data?.pages.flatMap((page) => page.transactions) ?? [];
  return (
    <section aria-labelledby="points-history-heading" className="mt-8">
      <h2 id="points-history-heading" className="mb-4 text-xl font-bold">
        Points activity
      </h2>
      {points.isPending ? (
        <Skeleton className="h-14" />
      ) : points.error ? (
        <ErrorState
          error={points.error}
          onRetry={() => void points.refetch()}
          retrying={points.isFetching}
        />
      ) : rows.length === 0 ? (
        <p className="text-sm text-espresso-500">
          No points yet. Recharging one of the bonus amounts earns points once the payment succeeds.
        </p>
      ) : (
        <Panel className="px-4">
          <ul aria-label="Points activity">
            {rows.map((t) => (
              <PointsRow key={t.id} t={t} />
            ))}
          </ul>
          {points.hasNextPage && (
            <div className="flex justify-center py-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void points.fetchNextPage()}
                loading={points.isFetchingNextPage}
              >
                Load more
              </Button>
            </div>
          )}
        </Panel>
      )}
    </section>
  );
}

const outcomeToast: Record<string, { tone: 'success' | 'error' | 'info'; title: string }> = {
  SUCCEEDED: { tone: 'success', title: 'Wallet recharged (simulated)' },
  FAILED: { tone: 'error', title: 'Payment failed — no money added' },
  CANCELLED: { tone: 'info', title: 'Recharge cancelled — no money added' },
  EXPIRED: { tone: 'info', title: 'That recharge expired — no money added' },
};

export function WalletPage() {
  const [params] = useSearchParams();
  const toast = useToast();
  const wallet = useWallet();
  const history = useWalletTransactions();
  const [simulating, setSimulating] = useState<Recharge | null>(null);
  const [viewing, setViewing] = useState<WalletTransaction | null>(null);
  const [justRecharged, setJustRecharged] = useState(false);
  const returnTo = params.get('returnTo');
  const safeReturnTo = returnTo && /^\/(?![/\\])/.test(returnTo) ? returnTo : null;

  const transactions = history.data?.pages.flatMap((page) => page.transactions) ?? [];

  function continuePending(t: WalletTransaction) {
    if (!t.rechargeId) return;
    // Re-open the simulator for a recharge that was started but not finished.
    setSimulating({
      id: t.rechargeId,
      amountPaise: t.amountPaise,
      status: 'PENDING',
      // Display only: the server awards the bonus it stored when the recharge started.
      bonusPoints: wallet.data ? bonusFor(wallet.data, t.amountPaise) : 0,
      provider: 'MOCK',
      providerReference: '(pending recharge)',
      isSimulated: true,
      failureReason: null,
      expiresAt: '',
      createdAt: t.createdAt,
      completedAt: null,
    });
  }

  return (
    <>
      <PageHeader
        eyebrow="CampusCart wallet"
        title="Wallet"
        description="Top up once, then pay for orders in a tap."
      />
      <TestModeBanner className="mb-6" />

      {justRecharged && safeReturnTo && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-(--radius-control) border border-success-600/20 bg-success-50 p-4">
          <p className="font-semibold text-success-600">
            Your balance is updated. Ready to finish your order?
          </p>
          <ButtonLink to={safeReturnTo} size="sm">
            Back to checkout
          </ButtonLink>
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex flex-col gap-6">
          {wallet.isPending ? (
            <Skeleton className="h-40 rounded-(--radius-panel)" />
          ) : wallet.error ? (
            <ErrorState
              title="Couldn’t load your wallet"
              error={wallet.error}
              onRetry={() => void wallet.refetch()}
              retrying={wallet.isFetching}
            />
          ) : (
            <>
              <BalanceCard wallet={wallet.data} />
              <PointsCard wallet={wallet.data} />
              <RechargeForm
                wallet={wallet.data}
                initialRupees={params.get('amount') ?? ''}
                onStarted={setSimulating}
              />
            </>
          )}
        </div>

        <section aria-labelledby="history-heading">
          <h2 id="history-heading" className="mb-4 text-xl font-bold">
            Transactions
          </h2>
          {history.isPending ? (
            <div className="flex flex-col gap-3">
              {[0, 1, 2].map((n) => (
                <Skeleton key={n} className="h-14" />
              ))}
            </div>
          ) : history.error ? (
            <ErrorState
              error={history.error}
              onRetry={() => void history.refetch()}
              retrying={history.isFetching}
            />
          ) : transactions.length === 0 ? (
            <EmptyState
              icon={<ReceiptText aria-hidden />}
              title="No transactions yet"
              description="Recharges, order payments and refunds will appear here."
            />
          ) : (
            <Panel className="px-4">
              <ul aria-label="Wallet transactions">
                {transactions.map((t) => (
                  <TransactionRow
                    key={t.id}
                    t={t}
                    onOpen={() => setViewing(t)}
                    onContinue={t.type === 'RECHARGE' ? () => continuePending(t) : undefined}
                  />
                ))}
              </ul>
              {history.hasNextPage && (
                <div className="flex justify-center py-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void history.fetchNextPage()}
                    loading={history.isFetchingNextPage}
                  >
                    Load more
                  </Button>
                </div>
              )}
            </Panel>
          )}
          <PointsHistory />
        </section>
      </div>

      <MockPaymentDialog
        recharge={simulating}
        onClose={() => {
          setSimulating(null);
          void history.refetch();
        }}
        onSettled={({ status, pointsAwarded }) => {
          setSimulating(null);
          void history.refetch();
          void wallet.refetch();
          if (status === 'SUCCEEDED') setJustRecharged(true);
          const message = outcomeToast[status];
          if (message) {
            toast.show({
              ...message,
              ...(pointsAwarded > 0 && {
                description: `You earned ${pointsLabel(pointsAwarded)} (test mode).`,
              }),
            });
          }
        }}
      />
      <TransactionDialog transaction={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
