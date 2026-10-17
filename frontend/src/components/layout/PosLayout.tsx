import { Link, NavLink, Outlet } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Wordmark } from '@/components/ui/Wordmark';
import { ConnectionStatus } from '@/components/feedback/ConnectionStatus';
import { useRealtimeStatus } from '@/services/realtime';
import { posNav } from '@/config/navigation';
import { cn } from '@/lib/cn';
import { DevAccountBanner } from '@/features/auth/DevAccountBanner';
import { SignOutButton } from '@/features/auth/SignOutButton';

/**
 * POS / cashier shell: full-width, large touch targets, minimal chrome.
 * Built for a counter tablet as much as a desktop.
 */
export function PosLayout() {
  const realtimeState = useRealtimeStatus();
  return (
    <div className="flex min-h-dvh flex-col bg-cream-200">
      <header className="sticky top-0 z-30 bg-espresso-900 text-cream-100">
        <DevAccountBanner />
        <div className="flex h-16 items-center gap-4 px-4 lg:px-6">
          <Link
            to="/"
            aria-label="Back to student app"
            className="rounded-md p-1 text-cream-100/60 hover:text-cream-100"
          >
            <ArrowLeft className="size-5" aria-hidden />
          </Link>
          <Wordmark tone="light" suffix="POS" />
          <ConnectionStatus state={realtimeState} tone="dark" compact className="ml-auto" />
          <SignOutButton
            variant="ghost"
            className="text-cream-100/80! hover:bg-white/10! hover:text-cream-100!"
          />
        </div>
        <nav
          aria-label="POS navigation"
          className="flex gap-1 overflow-x-auto px-3 [scrollbar-width:none] lg:px-5"
        >
          {posNav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex min-h-12 shrink-0 items-center gap-2 rounded-t-(--radius-control) px-3 text-base font-bold whitespace-nowrap transition-colors sm:px-5',
                  isActive
                    ? 'bg-cream-200 text-espresso-900'
                    : 'text-cream-100/70 hover:text-cream-100',
                )
              }
            >
              <Icon className="size-5" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="flex-1 px-4 py-6 lg:px-6">
        <Outlet />
      </main>
    </div>
  );
}
