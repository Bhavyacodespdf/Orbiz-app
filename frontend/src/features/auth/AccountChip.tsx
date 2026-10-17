import { NavLink } from 'react-router';
import { cn } from '@/lib/cn';
import type { User } from '@/services/auth';

export function Avatar({ user, className }: { user: User; className?: string }) {
  const initial = user.displayName.trim().charAt(0).toUpperCase() || '?';
  return user.avatarUrl ? (
    <img
      src={user.avatarUrl}
      alt=""
      referrerPolicy="no-referrer"
      className={cn('size-8 rounded-full object-cover', className)}
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        'grid size-8 place-items-center rounded-full bg-mustard-500 font-display font-bold text-espresso-900',
        className,
      )}
    >
      {initial}
    </span>
  );
}

/** Compact signed-in indicator for the student header; links to the profile. */
export function AccountChip({ user }: { user: User }) {
  return (
    <NavLink
      to="/profile"
      className={({ isActive }) =>
        cn(
          'hidden items-center gap-2 rounded-full py-1 pr-3 pl-1 text-sm font-semibold transition-colors md:inline-flex',
          isActive ? 'bg-espresso-900 text-cream-100' : 'hover:bg-espresso-50',
        )
      }
    >
      <Avatar user={user} />
      <span className="max-w-32 truncate">
        <span className="sr-only">Your profile: </span>
        {user.displayName}
      </span>
    </NavLink>
  );
}
