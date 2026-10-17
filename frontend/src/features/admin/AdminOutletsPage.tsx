import { useState } from 'react';
import { Plus, Store, Trash2, UserPlus } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { StatusSign } from '@/components/ui/StatusSign';
import { TextField } from '@/components/ui/TextField';
import { SelectField } from '@/components/ui/SelectField';
import { Dialog } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { Spinner } from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/toast-context';
import { roleLabels } from '@/config/workspaces';
import { describeError } from '@/lib/errors';
import {
  useAdminOutlets,
  useAssignStaff,
  useCreateOutlet,
  useOutletStaff,
  useUnassignStaff,
  useUpdateOutlet,
  type AdminOutlet,
} from '@/services/admin';

function OutletDialog({
  outlet,
  open,
  onClose,
}: {
  outlet: AdminOutlet | null;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={outlet ? `Edit ${outlet.name}` : 'New outlet'}>
      {/* Mounted fresh each time the dialog opens, so its fields start from the outlet. */}
      {open && <OutletForm key={outlet?.id ?? 'new'} outlet={outlet} onClose={onClose} />}
    </Dialog>
  );
}

function OutletForm({ outlet, onClose }: { outlet: AdminOutlet | null; onClose: () => void }) {
  const create = useCreateOutlet();
  const update = useUpdateOutlet();
  const toast = useToast();
  const [name, setName] = useState(outlet?.name ?? '');
  const [location, setLocation] = useState(outlet?.location ?? '');
  const [description, setDescription] = useState(outlet?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const saving = create.isPending || update.isPending;

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return setError('Name is required.');
        const input = {
          name: name.trim(),
          location: location.trim(),
          description: description.trim(),
        };
        const done = {
          onSuccess: () => {
            toast.show({
              tone: 'success',
              title: outlet ? 'Outlet updated' : 'Outlet created (closed until a manager opens it)',
            });
            onClose();
          },
          onError: (e: unknown) => setError(describeError(e)),
        };
        if (outlet) update.mutate({ outletId: outlet.id, ...input }, done);
        else create.mutate(input, done);
      }}
    >
      <TextField
        label="Name"
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
      />
      <TextField
        label="Location"
        value={location}
        maxLength={120}
        onChange={(e) => setLocation(e.target.value)}
      />
      <TextField
        label="Description"
        value={description}
        maxLength={300}
        onChange={(e) => setDescription(e.target.value)}
      />
      {error && (
        <p role="alert" className="text-sm font-medium text-chili-600">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          {outlet ? 'Save' : 'Create outlet'}
        </Button>
      </div>
    </form>
  );
}

function StaffPanel({ outlet }: { outlet: AdminOutlet }) {
  const staff = useOutletStaff(outlet.id);
  const assign = useAssignStaff(outlet.id);
  const unassign = useUnassignStaff(outlet.id);
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'MANAGER' | 'POS'>('MANAGER');

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-(--radius-control) bg-cream-200/60 p-3">
      {staff.isPending ? (
        <Spinner />
      ) : staff.error ? (
        <ErrorState error={staff.error} onRetry={() => void staff.refetch()} />
      ) : staff.data.length === 0 ? (
        <p className="text-sm text-espresso-500">No staff assigned yet.</p>
      ) : (
        <ul aria-label={`Staff at ${outlet.name}`} className="flex flex-col gap-1">
          {staff.data.map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-sm">
              <Badge tone="mustard">{roleLabels[s.role]}</Badge>
              <span className="min-w-0 flex-1 truncate">
                {s.user.displayName} · {s.user.email}
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${s.user.displayName} (${roleLabels[s.role]})`}
                loading={unassign.isPending && unassign.variables === s.id}
                onClick={() =>
                  unassign.mutate(s.id, {
                    onError: (e) =>
                      toast.show({
                        tone: 'error',
                        title: 'Couldn’t remove',
                        description: describeError(e),
                      }),
                  })
                }
                icon={<Trash2 className="size-4" aria-hidden />}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!email.trim()) return;
          assign.mutate(
            { email: email.trim(), role },
            {
              onSuccess: () => {
                setEmail('');
                toast.show({ tone: 'success', title: `Assigned to ${outlet.name}` });
              },
              onError: (e) =>
                toast.show({
                  tone: 'error',
                  title: 'Couldn’t assign',
                  description: describeError(e),
                }),
            },
          );
        }}
      >
        <TextField
          label="Staff email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="min-w-56 flex-1"
          hint="They must already hold the role."
        />
        <SelectField
          label="As"
          value={role}
          onChange={(e) => setRole(e.target.value as 'MANAGER' | 'POS')}
          className="w-36"
        >
          <option value="MANAGER">Manager</option>
          <option value="POS">POS / Cashier</option>
        </SelectField>
        <Button
          type="submit"
          variant="secondary"
          loading={assign.isPending}
          icon={<UserPlus className="size-4" aria-hidden />}
        >
          Assign
        </Button>
      </form>
    </div>
  );
}

export function AdminOutletsPage() {
  const outlets = useAdminOutlets();
  const update = useUpdateOutlet();
  const toast = useToast();
  const [editing, setEditing] = useState<{ outlet: AdminOutlet | null } | null>(null);
  const [staffFor, setStaffFor] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Outlets"
        actions={
          <Button
            onClick={() => setEditing({ outlet: null })}
            icon={<Plus className="size-4" aria-hidden />}
          >
            New outlet
          </Button>
        }
      />
      {outlets.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : outlets.error ? (
        <ErrorState
          error={outlets.error}
          onRetry={() => void outlets.refetch()}
          retrying={outlets.isFetching}
        />
      ) : outlets.data.length === 0 ? (
        <EmptyState
          icon={<Store aria-hidden />}
          title="No outlets yet"
          description="Create the first outlet, then assign a manager to it."
        />
      ) : (
        <ul aria-label="Outlets" className="flex flex-col gap-3">
          {outlets.data.map((outlet) => (
            <li key={outlet.id}>
              <Panel className="p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-display text-lg font-bold">
                      {outlet.name} <StatusSign status={outlet.status} />
                      {!outlet.isActive && <Badge tone="chili">Archived</Badge>}
                      {outlet.isSample && <Badge tone="mustard">Sample data</Badge>}
                    </p>
                    <p className="text-sm text-espresso-500">
                      {outlet.location || 'No location set'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing({ outlet })}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-expanded={staffFor === outlet.id}
                      onClick={() => setStaffFor(staffFor === outlet.id ? null : outlet.id)}
                    >
                      Staff
                    </Button>
                    <Button
                      size="sm"
                      variant={outlet.isActive ? 'danger' : 'secondary'}
                      loading={update.isPending && update.variables?.outletId === outlet.id}
                      onClick={() =>
                        update.mutate(
                          { outletId: outlet.id, isActive: !outlet.isActive },
                          {
                            onSuccess: () =>
                              toast.show({
                                tone: 'success',
                                title: outlet.isActive
                                  ? `${outlet.name} archived`
                                  : `${outlet.name} restored`,
                              }),
                            onError: (e) =>
                              toast.show({
                                tone: 'error',
                                title: 'Couldn’t update',
                                description: describeError(e),
                              }),
                          },
                        )
                      }
                    >
                      {outlet.isActive ? 'Archive' : 'Restore'}
                    </Button>
                  </div>
                </div>
                {staffFor === outlet.id && <StaffPanel outlet={outlet} />}
              </Panel>
            </li>
          ))}
        </ul>
      )}
      <OutletDialog
        open={editing !== null}
        outlet={editing?.outlet ?? null}
        onClose={() => setEditing(null)}
      />
    </>
  );
}
