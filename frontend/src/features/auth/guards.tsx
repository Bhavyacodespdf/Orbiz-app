import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { ShieldX } from 'lucide-react';
import { useCurrentUser, type Role } from '@/services/auth';
import { Spinner } from '@/components/feedback/Spinner';
import { ErrorState } from '@/components/feedback/ErrorState';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ButtonLink } from '@/components/ui/Button';

/*
 * These guards only decide what the browser shows. They are a convenience,
 * not security: every API endpoint checks the session and roles itself.
 */

function FullPageSpinner() {
  return (
    <div className="flex min-h-[50dvh] items-center justify-center">
      <Spinner label="Checking your sign-in…" />
    </div>
  );
}

export function AccessDenied({ title = 'You don’t have access to this page' }: { title?: string }) {
  return (
    <main className="mx-auto flex min-h-[70dvh] max-w-lg flex-col justify-center px-4">
      <EmptyState
        icon={<ShieldX aria-hidden />}
        title={title}
        description="Your account doesn’t have the role this area needs. If you think it should, ask the CampusCart administrator."
        action={<ButtonLink to="/">Back to CampusCart</ButtonLink>}
      />
    </main>
  );
}

/** Shows children only to signed-in users; otherwise sends them to the login page. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { data: user, isPending, error, refetch, isFetching } = useCurrentUser();

  if (isPending) return <FullPageSpinner />;
  if (error) {
    return (
      <div className="mx-auto max-w-lg px-4 py-10">
        <ErrorState error={error} onRetry={() => void refetch()} retrying={isFetching} />
      </div>
    );
  }
  if (!user) {
    const returnTo = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }
  return <>{children}</>;
}

/** Shows children only to signed-in users holding one of the given roles. */
export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  return (
    <RequireAuth>
      <RoleCheck roles={roles}>{children}</RoleCheck>
    </RequireAuth>
  );
}

function RoleCheck({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { data: user } = useCurrentUser();
  if (!user?.roles.some((role) => roles.includes(role))) return <AccessDenied />;
  return <>{children}</>;
}
