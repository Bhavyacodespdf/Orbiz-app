import { useId, type ReactNode, type Ref, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string;
  hideLabel?: boolean;
  ref?: Ref<HTMLSelectElement>;
}

export function SelectField({
  label,
  hint,
  error,
  hideLabel,
  className,
  children,
  ref,
  ...rest
}: SelectFieldProps) {
  const id = useId();
  const describedBy =
    cn(Boolean(hint) && !error && `${id}-hint`, Boolean(error) && `${id}-error`) || undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={id}
        className={cn('text-sm font-semibold text-espresso-900', hideLabel && 'sr-only')}
      >
        {label}
      </label>
      <div className="relative">
        <select
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'h-11 w-full appearance-none rounded-(--radius-control) border bg-cream-50 pr-9 pl-3 text-espresso-900 outline-none focus:border-chili-500 focus:ring-2 focus:ring-chili-100',
            error ? 'border-chili-500' : 'border-espresso-200',
          )}
          {...rest}
        >
          {children}
        </select>
        <ChevronDown
          className="pointer-events-none absolute top-3.5 right-3 size-4 text-espresso-500"
          aria-hidden
        />
      </div>
      {hint && !error && (
        <p id={`${id}-hint`} className="text-sm text-espresso-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm font-medium text-chili-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
