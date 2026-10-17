import { CircleAlert, RefreshCw } from 'lucide-react';
import { describeError } from '@/lib/errors';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

export function ErrorState({
  error,
  title = 'Could not load this',
  onRetry,
  retrying = false,
  className,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-start gap-3 rounded-(--radius-panel) border border-chili-100 bg-chili-50 p-5',
        className,
      )}
    >
      <div className="flex items-center gap-2 font-bold text-chili-700">
        <CircleAlert className="size-5" aria-hidden />
        {title}
      </div>
      <p className="text-espresso-700">{describeError(error)}</p>
      {onRetry && (
        <Button
          variant="secondary"
          size="sm"
          onClick={onRetry}
          loading={retrying}
          icon={<RefreshCw className="size-4" aria-hidden />}
        >
          Try again
        </Button>
      )}
    </div>
  );
}
