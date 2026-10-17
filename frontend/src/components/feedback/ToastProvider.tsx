import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ToastContext, type ToastInput, type ToastTone } from './toast-context';

interface Toast extends ToastInput {
  id: number;
}

const toneStyles: Record<ToastTone, { icon: ReactNode; accent: string }> = {
  success: {
    icon: <CircleCheck className="size-5 text-success-600" aria-hidden />,
    accent: 'border-l-success-600',
  },
  error: {
    icon: <CircleAlert className="size-5 text-chili-500" aria-hidden />,
    accent: 'border-l-chili-500',
  },
  info: {
    icon: <Info className="size-5 text-mustard-600" aria-hidden />,
    accent: 'border-l-mustard-500',
  },
};

const AUTO_DISMISS_MS = 5000;

/** Short-lived notifications, announced to screen readers via a live region. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-2), { ...input, id }]);
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 sm:items-end lg:bottom-6"
      >
        {toasts.map((toast) => {
          const tone = toneStyles[toast.tone ?? 'info'];
          return (
            <div
              key={toast.id}
              role={toast.tone === 'error' ? 'alert' : 'status'}
              className={cn(
                'pointer-events-auto flex w-full max-w-sm animate-toast-in items-start gap-3 rounded-(--radius-control) border border-l-4 border-espresso-100 bg-cream-50 p-3.5 shadow-lift',
                tone.accent,
              )}
            >
              {tone.icon}
              <div className="flex-1">
                <p className="font-semibold text-espresso-900">{toast.title}</p>
                {toast.description && (
                  <p className="text-sm text-espresso-500">{toast.description}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="rounded p-0.5 text-espresso-500 hover:text-espresso-900"
                aria-label="Dismiss notification"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
