import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Bell, BellOff, CheckCheck } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/feedback/Skeleton';
import { ErrorState } from '@/components/feedback/ErrorState';
import { cn } from '@/lib/cn';
import { timeAgo } from '@/lib/time';
import { useCurrentUser } from '@/services/auth';
import {
  useMarkAllRead,
  useMarkRead,
  useNotifications,
  useUnreadCount,
  type AppNotification,
} from '@/services/notifications';

function NotificationItem({
  n,
  onOpen,
}: {
  n: AppNotification;
  onOpen: (n: AppNotification) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(n)}
        className={cn(
          'flex w-full items-start gap-3 rounded-(--radius-control) px-3 py-2.5 text-left transition-colors hover:bg-espresso-50',
          !n.read && 'bg-mustard-50',
        )}
      >
        <span
          className={cn(
            'mt-1.5 size-2 shrink-0 rounded-full',
            n.read ? 'bg-transparent' : 'bg-chili-500',
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className={cn('block text-sm', n.read ? 'font-medium' : 'font-bold')}>
            {n.title}
            {!n.read && <span className="sr-only"> (unread)</span>}
          </span>
          <span className="block text-sm text-espresso-700">{n.body}</span>
          <time dateTime={n.createdAt} className="block text-xs text-espresso-500">
            {timeAgo(n.createdAt)}
          </time>
        </span>
      </button>
    </li>
  );
}

/** The bell with an unread badge, opening the inbox. Shown to signed-in users only. */
export function NotificationBell({ tone = 'light' }: { tone?: 'light' | 'dark' }) {
  const { data: user } = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const unread = useUnreadCount(Boolean(user));
  const list = useNotifications(filter, Boolean(user) && open);
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const navigate = useNavigate();
  if (!user) return null;

  const count = unread.data ?? 0;
  const items = list.data?.pages.flatMap((p) => p.notifications) ?? [];

  function openNotification(n: AppNotification) {
    if (!n.read) markRead.mutate(n.id);
    setOpen(false);
    if (n.link) void navigate(n.link);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
        className={cn(
          'relative grid size-9 place-items-center rounded-full transition-colors sm:size-10',
          tone === 'dark'
            ? 'text-cream-100/80 hover:bg-white/10 hover:text-cream-100'
            : 'text-espresso-700 hover:bg-espresso-50',
        )}
      >
        <Bell className="size-5" aria-hidden />
        {count > 0 && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 grid min-w-5 place-items-center rounded-full bg-chili-500 px-1 text-[0.7rem] font-bold text-white"
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Notifications">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="group" aria-label="Show" className="flex gap-1.5">
            {(['all', 'unread'] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  'h-8 rounded-full border px-3 text-sm font-semibold',
                  filter === f
                    ? 'border-espresso-900 bg-espresso-900 text-cream-100'
                    : 'border-espresso-200 bg-cream-50 text-espresso-700',
                )}
              >
                {f === 'all' ? 'All' : 'Unread'}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={<CheckCheck className="size-4" aria-hidden />}
            disabled={count === 0}
            loading={markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            Mark all as read
          </Button>
        </div>
        <div className="-mx-2 max-h-[60vh] overflow-y-auto">
          {list.isPending ? (
            <div className="flex flex-col gap-2 px-2" aria-busy>
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : list.error ? (
            <ErrorState
              title="Couldn’t load notifications"
              error={list.error}
              onRetry={() => void list.refetch()}
              retrying={list.isFetching}
            />
          ) : items.length === 0 ? (
            <p className="flex flex-col items-center gap-2 py-8 text-center text-espresso-500">
              <BellOff className="size-6" aria-hidden />
              {filter === 'unread' ? 'You’re all caught up.' : 'No notifications yet.'}
            </p>
          ) : (
            <ul aria-label="Notifications" className="flex flex-col gap-1">
              {items.map((n) => (
                <NotificationItem key={n.id} n={n} onOpen={openNotification} />
              ))}
            </ul>
          )}
        </div>
        {list.hasNextPage && (
          <Button
            variant="secondary"
            size="sm"
            className="self-center"
            loading={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            Load older
          </Button>
        )}
      </Dialog>
    </>
  );
}
