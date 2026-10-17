import { useState } from 'react';
import { ScrollText } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SelectField } from '@/components/ui/SelectField';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { formatDateTime } from '@/lib/time';
import { useAuditActions, useAuditLog, type AuditEntry } from '@/services/admin';

const humanise = (action: string) =>
  action
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

function actorLabel(entry: AuditEntry): string {
  if (entry.actor) return `${entry.actor.displayName} (${entry.actor.email})`;
  return entry.actorType === 'CLI' ? 'Server command line' : 'System';
}

export function AdminAuditPage() {
  const [action, setAction] = useState('');
  const actions = useAuditActions();
  const log = useAuditLog(action);
  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Audit log"
        description="A permanent, read-only record of sensitive actions."
      />
      <SelectField
        label="Filter by action"
        value={action}
        onChange={(e) => setAction(e.target.value)}
        className="mb-4 max-w-xs"
      >
        <option value="">All actions</option>
        {(actions.data ?? []).map((a) => (
          <option key={a} value={a}>
            {humanise(a)}
          </option>
        ))}
      </SelectField>

      {log.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : log.error ? (
        <ErrorState
          error={log.error}
          onRetry={() => void log.refetch()}
          retrying={log.isFetching}
        />
      ) : entries.length === 0 ? (
        <EmptyState icon={<ScrollText aria-hidden />} title="No audit entries" />
      ) : (
        <Panel>
          <ol aria-label="Audit entries">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-1 border-b border-dashed border-espresso-100 p-4 last:border-b-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="dark">{humanise(entry.action)}</Badge>
                  <time dateTime={entry.createdAt} className="text-sm text-espresso-500">
                    {formatDateTime(entry.createdAt)}
                  </time>
                </div>
                <p className="text-sm">
                  <span className="text-espresso-500">By</span> {actorLabel(entry)}{' '}
                  <span className="text-espresso-500">on</span> {entry.entityType}{' '}
                  <span className="font-mono text-xs text-espresso-500">
                    {entry.entityId.slice(0, 8)}
                  </span>
                </p>
                {entry.metadata != null && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-espresso-500">Details</summary>
                    <pre className="mt-1 overflow-x-auto rounded bg-cream-200/60 p-2">
                      {JSON.stringify(entry.metadata, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
          {log.hasNextPage && (
            <div className="flex justify-center py-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void log.fetchNextPage()}
                loading={log.isFetchingNextPage}
              >
                Load more
              </Button>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
