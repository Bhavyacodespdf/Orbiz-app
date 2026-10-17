import type { ReactNode } from 'react';
import { Store } from 'lucide-react';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { Skeleton } from '@/components/feedback/Skeleton';
import type { StaffOutlet, StaffRole } from '@/services/staff';
import { useOutletSelection } from './useOutletSelection';

/**
 * Loads the user's assigned outlets for a role and renders children for the
 * selected one, or an honest "not assigned" state.
 */
export function StaffGate({
  role,
  children,
}: {
  role: StaffRole;
  children: (context: {
    current: StaffOutlet;
    outlets: StaffOutlet[];
    select: (id: string) => void;
  }) => ReactNode;
}) {
  const { query, outlets, selected, select } = useOutletSelection(role);
  if (query.isPending) return <Skeleton className="h-64 w-full" />;
  if (query.error) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  if (!selected) {
    return (
      <EmptyState
        icon={<Store aria-hidden />}
        title="You’re not assigned to an outlet yet"
        description={`An administrator needs to assign you to an outlet as ${role === 'MANAGER' ? 'a manager' : 'POS staff'}.`}
      />
    );
  }
  return <>{children({ current: selected, outlets, select })}</>;
}
