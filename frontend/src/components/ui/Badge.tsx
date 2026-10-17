import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type BadgeTone = 'neutral' | 'chili' | 'mustard' | 'success' | 'dark';

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-espresso-50 text-espresso-700 ring-espresso-100',
  chili: 'bg-chili-50 text-chili-700 ring-chili-100',
  mustard: 'bg-mustard-50 text-mustard-800 ring-mustard-100',
  success: 'bg-success-50 text-success-600 ring-success-600/15',
  dark: 'bg-espresso-900 text-cream-100 ring-espresso-900',
};

export function Badge({
  tone = 'neutral',
  icon,
  children,
  className,
}: {
  tone?: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
        tones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
