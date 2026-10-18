import { cn } from '@/lib/cn';

export function Wordmark({
  className,
  tone = 'dark',
  suffix,
}: {
  className?: string;
  tone?: 'dark' | 'light';
  /** Small label after the name, e.g. "Kitchen" or "POS". */
  suffix?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-baseline gap-2 font-display text-xl font-extrabold tracking-tight',
        tone === 'dark' ? 'text-espresso-900' : 'text-cream-100',
        className,
      )}
    >
      <span>
        Or<span className={tone === 'dark' ? 'text-chili-500' : 'text-chili-400'}>biz</span>
        <span className="text-mustard-500">.</span>
      </span>
      {suffix && (
        <span
          className={cn(
            'font-sans text-[0.68rem] font-bold uppercase tracking-[0.16em]',
            tone === 'dark' ? 'text-espresso-500' : 'text-mustard-300',
          )}
        >
          {suffix}
        </span>
      )}
    </span>
  );
}
