import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { buttonClasses, type Size, type Variant } from './button-styles';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  /** Shows a spinner and blocks repeat clicks (e.g. while a request is in flight). */
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant,
  size,
  block,
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonClasses({ variant, size, block }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

interface ButtonLinkProps extends LinkProps {
  variant?: Variant;
  size?: Size;
  block?: boolean;
}

export function ButtonLink({ variant, size, block, className, ...rest }: ButtonLinkProps) {
  return <Link className={cn(buttonClasses({ variant, size, block }), className)} {...rest} />;
}
