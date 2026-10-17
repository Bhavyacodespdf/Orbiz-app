import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { ShoppingBag } from 'lucide-react';
import { Wordmark } from '@/components/ui/Wordmark';
import { ButtonLink } from '@/components/ui/Button';
import { studentNav } from '@/config/navigation';
import { workspacesFor } from '@/config/workspaces';
import { cn } from '@/lib/cn';
import { useCurrentUser } from '@/services/auth';
import { useCart } from '@/services/cart';
import { AccountChip } from '@/features/auth/AccountChip';
import { DevAccountBanner } from '@/features/auth/DevAccountBanner';
import { useOrderReadyAlerts } from '@/features/pickup/useOrderReadyAlerts';
import { NotificationBell } from '@/features/notifications/NotificationBell';

/** Links to the staff areas this user can open (Kitchen / POS / Admin). */
function WorkspaceLinks() {
  const { data: user } = useCurrentUser();
  const staff = workspacesFor(user?.roles ?? []).filter((w) => w.role !== 'STUDENT');
  if (staff.length === 0) return null;
  return (
    <nav aria-label="Workspaces" className="hidden items-center gap-1 lg:flex">
      {staff.map(({ to, label, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-semibold text-espresso-500 hover:bg-espresso-50 hover:text-espresso-900"
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );
}

function CartLink() {
  const { data: cart } = useCart();
  const count = cart?.itemCount ?? 0;
  return (
    <NavLink
      to="/cart"
      aria-label={count > 0 ? `Cart, ${count} ${count === 1 ? 'item' : 'items'}` : 'Cart'}
      className={({ isActive }) =>
        cn(
          'inline-flex h-10 items-center gap-2 rounded-full px-4 font-semibold transition-colors',
          isActive
            ? 'bg-espresso-900 text-cream-100'
            : 'bg-chili-500 text-white shadow-press hover:bg-chili-600',
        )
      }
    >
      <ShoppingBag className="size-4" aria-hidden />
      Cart
      {count > 0 && (
        <span className="tabular grid min-w-5 place-items-center rounded-full bg-mustard-500 px-1.5 text-xs font-bold text-espresso-900">
          {count}
        </span>
      )}
    </NavLink>
  );
}

function AccountArea() {
  const location = useLocation();
  const { data: user, isPending } = useCurrentUser();
  if (isPending) return <span className="hidden w-24 md:block" aria-hidden />;
  if (user) return <AccountChip user={user} />;
  const returnTo = encodeURIComponent(`${location.pathname}${location.search}`);
  return (
    <ButtonLink to={`/login?returnTo=${returnTo}`} variant="secondary" size="sm">
      Sign in
    </ButtonLink>
  );
}

/**
 * Student app shell: top navigation on tablet/desktop, a bottom tab bar on
 * phones. The cart is always one tap away.
 */
export function StudentLayout() {
  useOrderReadyAlerts();
  return (
    <div className="min-h-dvh">
      <DevAccountBanner />
      <header className="sticky top-0 z-30 border-b border-espresso-100 bg-cream-100/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4">
          <Link to="/" aria-label="CampusCart home" className="rounded-md">
            <Wordmark />
          </Link>

          <nav aria-label="Main" className="hidden flex-1 items-center gap-1 lg:flex">
            {studentNav
              .filter((item) => item.to !== '/profile')
              .map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      'relative rounded-md px-3 py-2 text-[0.95rem] font-semibold transition-colors',
                      isActive
                        ? 'text-espresso-900 after:absolute after:inset-x-3 after:-bottom-[13px] after:h-[3px] after:rounded-full after:bg-mustard-500'
                        : 'text-espresso-500 hover:text-espresso-900',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
          </nav>

          <div className="ml-auto flex items-center gap-2 lg:ml-0">
            <WorkspaceLinks />
            <NotificationBell />
            <AccountArea />

            <CartLink />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pt-6 pb-28 md:pt-10 lg:pb-16">
        <Outlet />
      </main>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-espresso-100 bg-cream-50/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <ul className="mx-auto grid max-w-lg grid-cols-6">
          {studentNav.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex h-16 flex-col items-center justify-center gap-1 text-xs font-semibold',
                    isActive ? 'text-chili-600' : 'text-espresso-500',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={cn(
                        'grid h-7 w-12 place-items-center rounded-full transition-colors',
                        isActive && 'bg-chili-50',
                      )}
                    >
                      <Icon className="size-5" aria-hidden />
                    </span>
                    {label}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
