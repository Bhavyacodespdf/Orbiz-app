import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import { cn } from '@/lib/cn';

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string;
  /** Content shown inside the field before the input, e.g. "₹". */
  adornment?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

export function TextField({
  label,
  hint,
  error,
  adornment,
  className,
  ref,
  ...rest
}: TextFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-semibold text-espresso-900">
        {label}
      </label>
      <div
        className={cn(
          'flex h-11 items-center gap-2 rounded-(--radius-control) border bg-cream-50 px-3 transition-colors focus-within:border-chili-500 focus-within:ring-2 focus-within:ring-chili-100',
          error ? 'border-chili-500' : 'border-espresso-200',
          rest.disabled && 'bg-cream-200 opacity-70',
        )}
      >
        {adornment && <span className="font-semibold text-espresso-500">{adornment}</span>}
        <input
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={cn(hintId, errorId) || undefined}
          className="h-full w-full min-w-0 bg-transparent text-espresso-900 outline-none placeholder:text-espresso-500 disabled:cursor-not-allowed"
          {...rest}
        />
      </div>
      {hint && !error && (
        <p id={hintId} className="text-sm text-espresso-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm font-medium text-chili-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
