import { useNavigate } from 'react-router';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { useLogout } from '@/services/auth';

export function SignOutButton({
  variant = 'secondary',
  className,
  compact = false,
}: {
  variant?: 'secondary' | 'ghost';
  className?: string;
  /** Icon only on phones (the label stays available to screen readers). */
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const logout = useLogout();
  const toast = useToast();

  return (
    <Button
      variant={variant}
      className={className}
      loading={logout.isPending}
      icon={<LogOut className="size-4" aria-hidden />}
      onClick={() => {
        // Leave any protected page first, so signing out lands on the home page
        // rather than being bounced to the login page by that page's guard.
        navigate('/', { replace: true });
        // The promise form still reports errors after this button unmounts.
        logout.mutateAsync().catch((error: unknown) =>
          toast.show({
            tone: 'error',
            title: 'Could not sign out',
            description: describeError(error),
          }),
        );
      }}
    >
      {compact ? <span className="sr-only sm:not-sr-only">Sign out</span> : 'Sign out'}
    </Button>
  );
}
