import { cn } from '@/lib/cn';

export type OutletStatus = 'OPEN' | 'PAUSED' | 'CLOSED';

const styles: Record<OutletStatus, { label: string; sign: string; lamp: string }> = {
  OPEN: {
    label: 'Open',
    sign: 'border-success-600 text-success-600',
    lamp: 'bg-success-600 shadow-[0_0_0_3px] shadow-success-600/20',
  },
  PAUSED: {
    label: 'Paused',
    sign: 'border-mustard-700 text-mustard-700',
    lamp: 'bg-mustard-500',
  },
  CLOSED: {
    label: 'Closed',
    sign: 'border-espresso-400 text-espresso-500',
    lamp: 'bg-espresso-400',
  },
};

/** Diner-style "OPEN / CLOSED" sign for an outlet's operating status. */
export function StatusSign({ status, className }: { status: OutletStatus; className?: string }) {
  const style = styles[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border-[1.5px] px-2 py-0.5 font-display text-[0.7rem] font-bold uppercase tracking-[0.14em]',
        style.sign,
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', style.lamp)} aria-hidden />
      {style.label}
    </span>
  );
}
