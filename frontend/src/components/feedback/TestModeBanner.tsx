import { FlaskConical } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Shown wherever simulated money appears. Mock recharges never move real
 * money, and the UI must never suggest otherwise.
 */
export function TestModeBanner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-(--radius-control) border border-mustard-300 bg-mustard-50 px-4 py-3 text-sm text-mustard-800',
        className,
      )}
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>
        <strong className="font-bold">Test mode — simulated funds.</strong> Wallet balances and
        recharges here are for development and demonstration only. No real money, UPI, card or bank
        payment is involved.
      </p>
    </div>
  );
}
