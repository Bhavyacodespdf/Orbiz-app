import { cn } from '@/lib/cn';

export type ConnectionState = 'live' | 'connecting' | 'offline' | 'unavailable';

const states: Record<ConnectionState, { label: string; dot: string; text: string }> = {
  live: { label: 'Live', dot: 'bg-success-600 animate-pulse', text: 'text-success-600' },
  connecting: {
    label: 'Reconnecting…',
    dot: 'bg-mustard-500 animate-pulse',
    text: 'text-mustard-700',
  },
  offline: {
    label: 'Offline — showing last saved state',
    dot: 'bg-chili-500',
    text: 'text-chili-600',
  },
  unavailable: {
    label: 'Live updates off',
    dot: 'bg-espresso-400',
    text: 'text-espresso-500',
  },
};

/**
 * Honest indicator of the real-time connection, driven by the actual socket
 * state (services/realtime.ts). "unavailable" means no connection is open,
 * e.g. while signed out.
 */
export function ConnectionStatus({
  state,
  tone = 'light',
  compact = false,
  className,
}: {
  state: ConnectionState;
  tone?: 'light' | 'dark';
  /** On small screens show only the dot; the label stays available to screen readers. */
  compact?: boolean;
  className?: string;
}) {
  const s = states[state];
  return (
    <span
      role="status"
      title={s.label}
      className={cn(
        'inline-flex items-center gap-2 text-xs font-semibold',
        tone === 'dark' ? 'text-cream-100/80' : s.text,
        className,
      )}
    >
      <span className={cn('size-2 shrink-0 rounded-full', s.dot)} aria-hidden />
      <span className={cn(compact && 'max-sm:sr-only')}>{s.label}</span>
    </span>
  );
}
