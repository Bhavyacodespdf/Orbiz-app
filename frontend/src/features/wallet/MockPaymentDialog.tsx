import { CircleAlert, CircleCheck, CircleX, FlaskConical } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { describeError } from '@/lib/errors';
import { formatINR } from '@/lib/money';
import { useSettleMockRecharge, type MockOutcome, type Recharge } from '@/services/wallet';

/**
 * TEST MODE ONLY. Stands in for a payment page so the recharge flow can be
 * tried without real money. The chosen outcome is sent to the server, which
 * decides what happens to the wallet — the browser never credits anything.
 */
export function MockPaymentDialog({
  recharge,
  onClose,
  onSettled,
}: {
  recharge: Recharge | null;
  onClose: () => void;
  onSettled: (result: {
    status: Recharge['status'];
    balancePaise: number;
    /** Points the server awarded (0 unless the recharge succeeded with a bonus). */
    pointsAwarded: number;
  }) => void;
}) {
  const settle = useSettleMockRecharge();

  function choose(outcome: MockOutcome) {
    if (!recharge) return;
    settle.mutate(
      { rechargeId: recharge.id, outcome },
      {
        onSuccess: (result) =>
          onSettled({
            status: result.recharge.status,
            balancePaise: result.wallet.balancePaise,
            pointsAwarded:
              result.changed && result.recharge.status === 'SUCCEEDED'
                ? result.recharge.bonusPoints
                : 0,
          }),
      },
    );
  }

  return (
    <Dialog
      open={recharge !== null}
      onClose={onClose}
      title="Test payment simulator"
      description={
        <div className="flex items-start gap-2 rounded-(--radius-control) bg-mustard-50 p-3 text-sm text-mustard-800">
          <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            <strong>No real money moves.</strong> This simulates a payment provider for development
            and demos. Choose what the “payment” should do.
          </p>
        </div>
      }
    >
      {recharge && (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-espresso-500">Amount</dt>
            <dd className="text-right font-display text-xl font-bold tabular">
              {formatINR(recharge.amountPaise)}
            </dd>
            <dt className="text-espresso-500">Bonus if it succeeds</dt>
            <dd className="text-right font-semibold">
              {recharge.bonusPoints > 0 ? `${recharge.bonusPoints} loyalty points` : 'None'}
            </dd>
            <dt className="text-espresso-500">Reference</dt>
            <dd className="truncate text-right font-mono text-xs">{recharge.providerReference}</dd>
          </dl>
          {settle.error && (
            <p role="alert" className="text-sm font-medium text-chili-600">
              {describeError(settle.error)}
            </p>
          )}
          <div className="flex flex-col gap-2">
            <Button
              onClick={() => choose('SUCCESS')}
              loading={settle.isPending && settle.variables?.outcome === 'SUCCESS'}
              disabled={settle.isPending}
              icon={<CircleCheck className="size-4" aria-hidden />}
            >
              Simulate successful payment
            </Button>
            <Button
              variant="secondary"
              onClick={() => choose('FAILURE')}
              disabled={settle.isPending}
              icon={<CircleAlert className="size-4" aria-hidden />}
            >
              Simulate failed payment
            </Button>
            <Button
              variant="ghost"
              onClick={() => choose('CANCEL')}
              disabled={settle.isPending}
              icon={<CircleX className="size-4" aria-hidden />}
            >
              Cancel payment
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
