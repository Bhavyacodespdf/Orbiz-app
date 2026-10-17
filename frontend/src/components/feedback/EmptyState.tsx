import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-(--radius-panel) border-2 border-dashed border-espresso-100 px-6 py-10 text-center',
        className,
      )}
    >
      {icon && (
        <div className="grid size-12 place-items-center rounded-full bg-mustard-50 text-mustard-700 [&>svg]:size-6">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-bold text-espresso-900">{title}</h3>
      {description && <div className="max-w-sm text-espresso-500">{description}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
