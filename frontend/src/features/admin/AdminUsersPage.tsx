import { useState } from 'react';
import { ShieldPlus, Users, X } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SearchField } from '@/components/ui/SearchField';
import { SelectField } from '@/components/ui/SelectField';
import { TextField } from '@/components/ui/TextField';
import { Dialog } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useToast } from '@/components/feedback/toast-context';
import { roleLabels } from '@/config/workspaces';
import { describeError } from '@/lib/errors';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useCurrentUser } from '@/services/auth';
import {
  useAdminUsers,
  useGrantRole,
  useRevokeRole,
  type AdminUser,
  type PrivilegedRole,
} from '@/services/admin';

const PRIVILEGED: PrivilegedRole[] = ['MANAGER', 'POS', 'ADMIN'];

function GrantControl({ user }: { user: AdminUser }) {
  const grant = useGrantRole();
  const toast = useToast();
  const options = PRIVILEGED.filter((r) => !user.roles.includes(r) && user.eligibleFor[r]);
  const [role, setRole] = useState<PrivilegedRole | ''>('');
  if (options.length === 0) return null;
  return (
    <div className="flex items-end gap-2">
      <SelectField
        label={`Role to give ${user.displayName}`}
        hideLabel
        value={role}
        onChange={(e) => setRole(e.target.value as PrivilegedRole)}
        className="w-44"
      >
        <option value="">Add a role…</option>
        {options.map((r) => (
          <option key={r} value={r}>
            {roleLabels[r]}
          </option>
        ))}
      </SelectField>
      <Button
        variant="secondary"
        disabled={!role}
        loading={grant.isPending}
        icon={<ShieldPlus className="size-4" aria-hidden />}
        onClick={() =>
          role &&
          grant.mutate(
            { userId: user.id, role },
            {
              onSuccess: () => {
                setRole('');
                toast.show({
                  tone: 'success',
                  title: `${roleLabels[role]} given to ${user.displayName}`,
                });
              },
              onError: (e) =>
                toast.show({
                  tone: 'error',
                  title: 'Couldn’t give the role',
                  description: describeError(e),
                }),
            },
          )
        }
      >
        Grant
      </Button>
    </div>
  );
}

export function AdminUsersPage() {
  const { data: me } = useCurrentUser();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 300);
  const users = useAdminUsers(q);
  const revoke = useRevokeRole();
  const toast = useToast();
  const [revoking, setRevoking] = useState<{ user: AdminUser; role: PrivilegedRole } | null>(null);
  const [reason, setReason] = useState('');
  const list = users.data?.pages.flatMap((p) => p.users) ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Users & roles"
        description="Manager and POS roles can only be given to verified emails on the server’s allowlists. Every change is recorded in the audit log."
      />
      <SearchField
        label="Search users"
        placeholder="Search by name or email"
        value={search}
        onChange={setSearch}
        className="mb-4 max-w-md"
      />

      {users.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : users.error ? (
        <ErrorState
          error={users.error}
          onRetry={() => void users.refetch()}
          retrying={users.isFetching}
        />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Users aria-hidden />}
          title={q ? `No users match “${q}”` : 'No users yet'}
        />
      ) : (
        <Panel>
          <ul aria-label="Users">
            {list.map((user) => (
              <li
                key={user.id}
                className="flex flex-wrap items-center gap-4 border-b border-dashed border-espresso-100 p-4 last:border-b-0"
              >
                <div className="min-w-0 flex-1 basis-64">
                  <p className="font-semibold">
                    {user.displayName}
                    {user.signInMethod === 'DEV' && (
                      <Badge tone="chili" className="ml-2">
                        Developer account
                      </Badge>
                    )}
                    {user.status === 'SUSPENDED' && <Badge className="ml-2">Suspended</Badge>}
                  </p>
                  <p className="truncate text-sm text-espresso-500">{user.email}</p>
                  {user.assignments.length > 0 && (
                    <p className="mt-1 text-xs text-espresso-500">
                      {user.assignments
                        .map((a) => `${roleLabels[a.role]} at ${a.outlet.name}`)
                        .join(' · ')}
                    </p>
                  )}
                </div>
                <div
                  className="flex flex-wrap items-center gap-1.5"
                  aria-label={`Roles of ${user.displayName}`}
                >
                  {user.roles.map((role) =>
                    role === 'STUDENT' ? (
                      <Badge key={role}>{roleLabels[role]}</Badge>
                    ) : (
                      <span
                        key={role}
                        className="inline-flex items-center gap-1 rounded-full bg-mustard-50 py-0.5 pr-1 pl-2.5 text-xs font-semibold text-mustard-800 ring-1 ring-mustard-100 ring-inset"
                      >
                        {roleLabels[role]}
                        {!(role === 'ADMIN' && user.id === me?.id) && (
                          <button
                            type="button"
                            className="rounded-full p-0.5 hover:bg-mustard-100"
                            aria-label={`Remove ${roleLabels[role]} from ${user.displayName}`}
                            onClick={() => {
                              setRevoking({ user, role: role as PrivilegedRole });
                              setReason('');
                            }}
                          >
                            <X className="size-3" aria-hidden />
                          </button>
                        )}
                      </span>
                    ),
                  )}
                </div>
                <GrantControl user={user} />
              </li>
            ))}
          </ul>
          {users.hasNextPage && (
            <div className="flex justify-center py-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void users.fetchNextPage()}
                loading={users.isFetchingNextPage}
              >
                Load more
              </Button>
            </div>
          )}
        </Panel>
      )}

      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={
          revoking ? `Remove ${roleLabels[revoking.role]} from ${revoking.user.displayName}?` : ''
        }
        description="They will be signed out on every device straight away. Their history stays in the audit log."
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!revoking || reason.trim().length < 3) return;
            revoke.mutate(
              { userId: revoking.user.id, role: revoking.role, reason: reason.trim() },
              {
                onSuccess: () => {
                  toast.show({
                    tone: 'success',
                    title: `${roleLabels[revoking.role]} removed from ${revoking.user.displayName}`,
                  });
                  setRevoking(null);
                },
                onError: (e) =>
                  toast.show({
                    tone: 'error',
                    title: 'Couldn’t remove the role',
                    description: describeError(e),
                  }),
              },
            );
          }}
        >
          <TextField
            label="Reason (recorded in the audit log)"
            value={reason}
            maxLength={200}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
            hint="At least 3 characters."
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setRevoking(null)}
              disabled={revoke.isPending}
            >
              Keep role
            </Button>
            <Button
              type="submit"
              variant="danger"
              loading={revoke.isPending}
              disabled={reason.trim().length < 3}
            >
              Remove role
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
