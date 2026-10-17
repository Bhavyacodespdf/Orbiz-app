import type { ReactNode } from 'react';
import { NotificationBell } from '@/features/notifications/NotificationBell';
import { Link, NavLink, Outlet } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Wordmark } from '@/components/ui/Wordmark';
import type { NavItem } from '@/config/navigation';
import { cn } from '@/lib/cn';
import { useCurrentUser } from '@/services/auth';
import { DevAccountBanner } from '@/features/auth/DevAccountBanner';
import { SignOutButton } from '@/features/auth/SignOutButton';

/**
 * Shared shell for the Manager and Admin consoles: a dark sidebar on desktop,
 * a dark top bar with scrollable tabs on phones and tablets.
 */
export function ConsoleLayout({
  label,
  nav,
  status,
}: {
  label: string;
  nav: NavItem[];
  /** Optional status element shown in the chrome, e.g. the live-connection indicator. */
  status?: ReactNode;
}) {
  const { data: user } = useCurrentUser();
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15.5rem_1fr]">
      <aside className="sticky top-0 z-30 flex flex-col bg-espresso-900 text-cream-100 lg:h-dvh">
        <div className="flex h-14 items-center justify-between gap-3 px-4 lg:h-auto lg:flex-col lg:items-start lg:gap-2 lg:px-5 lg:pt-6 lg:pb-4">
          <Wordmark tone="light" suffix={label} className="text-base sm:text-lg" />
          <div className="flex items-center gap-0.5 sm:gap-1">
            {status}
            <NotificationBell tone="dark" />
            {/* On phones and tablets the sidebar footer is hidden, so offer the same exits here. */}
            <Link
              to="/"
              aria-label="Student app"
              className="rounded-md p-2 text-cream-100/70 hover:text-cream-100 lg:hidden"
            >
              <ArrowLeft className="size-4" aria-hidden />
            </Link>
            {user && (
              <SignOutButton
                compact
                variant="ghost"
                className="h-9 px-2 text-sm text-cream-100/80! hover:bg-white/10! hover:text-cream-100! lg:hidden"
              />
            )}
          </div>
        </div>

        <nav
          aria-label={`${label} navigation`}
          className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:px-3 lg:pb-0"
        >
          {nav.map(({ to, label: itemLabel, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center gap-2.5 rounded-(--radius-control) px-3 py-2 text-sm font-semibold transition-colors',
                  isActive
                    ? 'bg-mustard-500 text-espresso-900'
                    : 'text-cream-100/75 hover:bg-white/8 hover:text-cream-100',
                )
              }
            >
              <Icon className="size-4" aria-hidden />
              {itemLabel}
            </NavLink>
          ))}
        </nav>

        <div className="hidden px-3 pt-6 lg:block">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-(--radius-control) px-3 py-2 text-sm text-cream-100/60 hover:text-cream-100"
          >
            <ArrowLeft className="size-4" aria-hidden />
            Student app
          </Link>
        </div>

        {user && (
          <div className="mt-auto hidden flex-col gap-3 border-t border-white/10 p-4 lg:flex">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{user.displayName}</p>
              <p className="truncate text-xs text-cream-100/60">{user.email}</p>
            </div>
            <SignOutButton variant="secondary" />
          </div>
        )}
      </aside>

      <div className="min-w-0">
        <DevAccountBanner />
        <main className="px-4 py-6 lg:px-10 lg:py-10">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
