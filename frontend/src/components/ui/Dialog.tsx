import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}

/**
 * Modal dialog built on the native <dialog> element, which gives focus
 * trapping, Escape-to-close and an accessible modal role for free.
 */
export function Dialog({ open, onClose, title, description, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal?.();
      // showModal() focuses the first focusable element; prefer an explicitly marked one.
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && dialog.open) dialog.close?.();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the <dialog> element itself.
        if (event.target === ref.current) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md animate-fade-in rounded-(--radius-panel) bg-cream-50 p-0 text-espresso-900 shadow-lift"
    >
      {open && (
        <div className="flex flex-col gap-4 p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <h2 id={titleId} className="text-xl font-bold">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="-m-1 rounded-md p-1 text-espresso-500 hover:bg-espresso-50 hover:text-espresso-900"
              aria-label="Close dialog"
            >
              <X className="size-5" aria-hidden />
            </button>
          </div>
          {description && (
            <div id={descriptionId} className="text-espresso-700">
              {description}
            </div>
          )}
          {children}
          {footer && (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{footer}</div>
          )}
        </div>
      )}
    </dialog>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Asks before doing something the user might regret, e.g. clearing a cart. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      footer={
        <>
          {/* Start on the safe choice so a stray Enter never confirms. */}
          <Button variant="secondary" onClick={onCancel} disabled={loading} data-autofocus>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
