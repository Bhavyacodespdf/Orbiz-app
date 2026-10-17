import { Minus, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';

export function QuantityStepper({
  name,
  quantity,
  max = 10,
  busy = false,
  onChange,
  onRemove,
  className,
}: {
  name: string;
  quantity: number;
  max?: number;
  busy?: boolean;
  onChange: (quantity: number) => void;
  onRemove: () => void;
  className?: string;
}) {
  const button =
    'grid size-9 place-items-center rounded-full text-espresso-900 transition-colors hover:bg-espresso-50 disabled:opacity-40';
  return (
    <div
      role="group"
      aria-label={`Quantity of ${name}`}
      className={cn(
        'inline-flex h-10 items-center gap-1 rounded-full border border-espresso-200 bg-cream-50 px-0.5',
        busy && 'opacity-70',
        className,
      )}
    >
      {quantity <= 1 ? (
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={onRemove}
          aria-label={`Remove ${name}`}
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => onChange(quantity - 1)}
          aria-label={`One fewer ${name}`}
        >
          <Minus className="size-4" aria-hidden />
        </button>
      )}
      <span className="tabular min-w-6 text-center font-bold" aria-live="polite">
        {quantity}
      </span>
      <button
        type="button"
        className={button}
        disabled={busy || quantity >= max}
        onClick={() => onChange(quantity + 1)}
        aria-label={`One more ${name}`}
      >
        <Plus className="size-4" aria-hidden />
      </button>
    </div>
  );
}
