import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

export function Spinner({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cn('flex items-center gap-2 text-espresso-500', className)}>
      <LoaderCircle className="size-5 animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}
