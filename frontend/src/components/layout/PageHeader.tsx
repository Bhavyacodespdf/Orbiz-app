import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-6 flex flex-wrap items-end justify-between gap-4 md:mb-8', className)}>
      <div className="flex max-w-2xl flex-col gap-1.5">
        {eyebrow && (
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-chili-600">{eyebrow}</p>
        )}
        <h1 className="text-3xl font-extrabold text-espresso-900 md:text-4xl">{title}</h1>
        {description && <div className="text-espresso-500">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
