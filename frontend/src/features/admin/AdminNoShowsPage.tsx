import { useState } from 'react';
import { TimerOff } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SelectField } from '@/components/ui/SelectField';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { describeError } from '@/lib/errors';
import { formatINR } from '@/lib/money';
import { formatDateTime } from '@/lib/time';
import { useNoShowSettlements, useRetryNoShow } from '@/services/admin';

/**
 * Recovery for scheduled-order no-shows the background worker couldn't settle. Retrying re-runs
 * the same server policy; nobody types an amount.
 */
export function AdminNoShowsPage() {
  const [status, setStatus] = useState<'FAILED' | 'PROCESSED'>('FAILED');
  const list = useNoShowSettlements(status);
  const retry = useRetryNoShow();
  const [result, setResult] = useState<{ orderId: string; text: string } | null>(null);

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="No-shows"
        description="Scheduled orders not collected within 10 minutes of their slot. Failed ones can be retried; the refund is always worked out by the server."
      />
      <SelectField
        label="Show"
        value={status}
        onChange={(e) => setStatus(e.target.value as 'FAILED' | 'PROCESSED')}
        className="mb-4 max-w-xs"
      >
        <option value="FAILED">Needs attention (failed)</option>
        <option value="PROCESSED">Processed</option>
      </SelectField>

      {list.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : list.error ? (
        <ErrorState
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : list.data.length === 0 ? (
        <EmptyState
          icon={<TimerOff aria-hidden />}
          title={status === 'FAILED' ? 'Nothing needs attention' : 'No processed no-shows yet'}
        />
      ) : (
        <Panel>
          <ul aria-label="No-show settlements">
            {list.data.map((s) => (
              <li
                key={s.orderId}
                className="flex flex-col gap-1 border-b border-dashed border-espresso-100 p-4 last:border-b-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-bold">{s.pickupCode}</span>
                  <span className="text-sm text-espresso-600">{s.outlet}</span>
                  <Badge tone={s.status === 'FAILED' ? 'chili' : 'success'}>
                    {s.status === 'FAILED' ? 'Failed' : 'Processed'}
                  </Badge>
                </div>
                <p className="text-sm text-espresso-600">
                  Collect-by {formatDateTime(s.pickupDeadline)}
                  {s.processedAt
                    ? ` · processed ${formatDateTime(s.processedAt)} · refund ${formatINR(s.refundPaise)}, fee kept ${formatINR(s.convenienceFeePaise)}, ${s.restockedUnits} restocked`
                    : ` · ${s.attempts} attempt${s.attempts === 1 ? '' : 's'}`}
                </p>
                {s.status === 'FAILED' && s.lastError && (
                  <p className="text-xs text-chili-700">Last error: {s.lastError}</p>
                )}
                {s.status === 'FAILED' && (
                  <div className="mt-1 flex flex-wrap items-center gap-3">
                    <Button
                      size="sm"
                      loading={retry.isPending && retry.variables === s.orderId}
                      onClick={() =>
                        retry.mutate(s.orderId, {
                          onSuccess: (r) =>
                            setResult({
                              orderId: s.orderId,
                              text: r.processed
                                ? 'Processed.'
                                : 'Nothing to do: the order was collected, isn’t due yet or is already settled.',
                            }),
                          onError: (e) => setResult({ orderId: s.orderId, text: describeError(e) }),
                        })
                      }
                    >
                      Retry
                    </Button>
                    {result?.orderId === s.orderId && (
                      <span role="status" className="text-sm">
                        {result.text}
                      </span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
