import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowRight, BadgeCheck, MessageSquareText } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { useToast } from '@/components/feedback/toast-context';
import { roleLabels, workspacesFor } from '@/config/workspaces';
import { describeError } from '@/lib/errors';
import { useCurrentUser, useUpdateProfile, type User } from '@/services/auth';
import { Avatar } from '@/features/auth/AccountChip';
import { SignOutButton } from '@/features/auth/SignOutButton';

// Mirrors the backend rules; the server validates again regardless.
const profileFormSchema = z.object({
  displayName: z.string().trim().min(1, 'Name is required').max(60, 'Keep it under 60 characters'),
  phone: z
    .string()
    .trim()
    .refine(
      (v) => v === '' || /^\+?[0-9][0-9 -]{6,18}[0-9]$/.test(v),
      'Enter a valid phone number',
    ),
});
type ProfileFormValues = z.infer<typeof profileFormSchema>;

function ProfileForm({ user }: { user: User }) {
  const update = useUpdateProfile();
  const toast = useToast();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<ProfileFormValues>({
    resolver: zodResolver(profileFormSchema),
    defaultValues: { displayName: user.displayName, phone: user.phone ?? '' },
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={handleSubmit((values) =>
        update.mutate(
          { displayName: values.displayName, phone: values.phone === '' ? null : values.phone },
          {
            onSuccess: (saved) => {
              reset({ displayName: saved.displayName, phone: saved.phone ?? '' });
              toast.show({ tone: 'success', title: 'Profile saved' });
            },
            onError: (error) =>
              toast.show({
                tone: 'error',
                title: 'Could not save',
                description: describeError(error),
              }),
          },
        ),
      )}
    >
      <TextField
        label="Display name"
        hint="Shown to outlet staff on your orders."
        error={errors.displayName?.message}
        {...register('displayName')}
      />
      <TextField
        label="Phone (optional)"
        type="tel"
        autoComplete="tel"
        hint="So the outlet can reach you about an order."
        error={errors.phone?.message}
        {...register('phone')}
      />
      <div>
        <Button type="submit" loading={update.isPending} disabled={!isDirty}>
          Save changes
        </Button>
      </div>
    </form>
  );
}

export function ProfilePage() {
  // Rendered inside <RequireAuth>, so the user is always present here.
  const { data: user } = useCurrentUser();
  if (!user) return null;
  const staffWorkspaces = workspacesFor(user.roles).filter((w) => w.role !== 'STUDENT');

  return (
    <>
      <PageHeader eyebrow="Account" title="Profile" actions={<SignOutButton />} />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex flex-col gap-6">
          <Panel className="flex items-center gap-4 p-5">
            <Avatar user={user} className="size-14 text-xl" />
            <div className="min-w-0">
              <p className="truncate font-display text-xl font-bold">{user.displayName}</p>
              <p className="flex items-center gap-1 truncate text-sm text-espresso-500">
                {user.email}
                {user.emailVerified && (
                  <BadgeCheck
                    className="size-4 shrink-0 text-success-600"
                    aria-label="Verified email"
                  />
                )}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {user.roles.map((role) => (
                  <Badge key={role} tone={role === 'STUDENT' ? 'neutral' : 'mustard'}>
                    {roleLabels[role]}
                  </Badge>
                ))}
                {user.signInMethod === 'DEV' && <Badge tone="chili">Developer account</Badge>}
              </div>
            </div>
          </Panel>

          <Link
            to="/reviews"
            className="flex items-center gap-3 rounded-(--radius-control) border border-espresso-100 bg-cream-50 p-3 transition-colors hover:border-espresso-200"
          >
            <span className="grid size-10 place-items-center rounded-full bg-mustard-50 text-mustard-700">
              <MessageSquareText className="size-5" aria-hidden />
            </span>
            <span className="flex-1">
              <span className="block font-semibold">My reviews</span>
              <span className="block text-sm text-espresso-500">
                See, edit or delete the ratings you’ve given
              </span>
            </span>
            <ArrowRight className="size-4 text-espresso-500" aria-hidden />
          </Link>

          {staffWorkspaces.length > 0 && (
            <section aria-labelledby="workspaces-heading">
              <h2 id="workspaces-heading" className="mb-3 text-lg font-bold">
                Your workspaces
              </h2>
              <ul className="flex flex-col gap-2">
                {staffWorkspaces.map(({ to, label, description, icon: Icon }) => (
                  <li key={to}>
                    <Link
                      to={to}
                      className="flex items-center gap-3 rounded-(--radius-control) border border-espresso-100 bg-cream-50 p-3 transition-colors hover:border-espresso-200"
                    >
                      <span className="grid size-10 place-items-center rounded-full bg-espresso-900 text-mustard-500">
                        <Icon className="size-5" aria-hidden />
                      </span>
                      <span className="flex-1">
                        <span className="block font-semibold">{label}</span>
                        <span className="block text-sm text-espresso-500">{description}</span>
                      </span>
                      <ArrowRight className="size-4 text-espresso-500" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <Panel className="p-5">
          <h2 className="mb-4 text-lg font-bold">Your details</h2>
          <ProfileForm user={user} />
          <p className="mt-4 text-sm text-espresso-500">
            Your email comes from your Google account and can’t be changed here.
          </p>
        </Panel>
      </div>
    </>
  );
}
