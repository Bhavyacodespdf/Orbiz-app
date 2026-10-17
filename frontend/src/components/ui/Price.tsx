import { formatINR } from '@/lib/money';
import { cn } from '@/lib/cn';

/** Displays a server-provided amount in paise as INR with aligned digits. */
export function Price({ paise, className }: { paise: number; className?: string }) {
  return <span className={cn('tabular font-semibold', className)}>{formatINR(paise)}</span>;
}
