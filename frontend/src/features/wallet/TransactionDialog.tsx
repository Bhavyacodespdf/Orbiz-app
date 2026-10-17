import { Link } from 'react-router';
import { Dialog } from '@/components/ui/Dialog';
import { Badge } from '@/components/ui/Badge';
import { formatINR } from '@/lib/money';
import type { WalletTransaction } from '@/services/wallet';
import { statusInfo, typeLabels } from './wallet-labels';

export function TransactionDialog({
  transaction,
  onClose,
}: {
  transaction: WalletTransaction | null;
  onClose: () => void;
}) {
  const t = transaction;
  return (
    <Dialog open={t !== null} onClose={onClose} title={t ? typeLabels[t.type] : ''}>
      {t && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-espresso-500">Amount</dt>
          <dd className="text-right font-display text-xl font-bold tabular">
            {t.direction === 'CREDIT' ? '+' : '−'}
            {formatINR(t.amountPaise)}
          </dd>
          <dt className="text-espresso-500">Status</dt>
          <dd className="text-right">
            <Badge tone={statusInfo[t.status].tone}>{statusInfo[t.status].label}</Badge>
          </dd>
          <dt className="text-espresso-500">Description</dt>
          <dd className="text-right">{t.description}</dd>
          {t.balanceAfterPaise !== null && (
            <>
              <dt className="text-espresso-500">Balance after</dt>
              <dd className="text-right tabular">{formatINR(t.balanceAfterPaise)}</dd>
            </>
          )}
          <dt className="text-espresso-500">Started</dt>
          <dd className="text-right">{new Date(t.createdAt).toLocaleString('en-IN')}</dd>
          {t.completedAt && (
            <>
              <dt className="text-espresso-500">Completed</dt>
              <dd className="text-right">{new Date(t.completedAt).toLocaleString('en-IN')}</dd>
            </>
          )}
          {t.orderId && (
            <>
              <dt className="text-espresso-500">Order</dt>
              <dd className="text-right">
                <Link
                  to={`/orders/${t.orderId}`}
                  className="font-semibold text-chili-600 hover:underline"
                  onClick={onClose}
                >
                  View order
                </Link>
              </dd>
            </>
          )}
          <dt className="text-espresso-500">Transaction ID</dt>
          <dd className="truncate text-right font-mono text-xs">{t.id}</dd>
          {t.isSimulated && (
            <dd className="col-span-2 mt-2 rounded-(--radius-control) bg-mustard-50 p-2 text-xs text-mustard-800">
              Simulated test funds — not a real bank, UPI or card transaction.
            </dd>
          )}
        </dl>
      )}
    </Dialog>
  );
}
