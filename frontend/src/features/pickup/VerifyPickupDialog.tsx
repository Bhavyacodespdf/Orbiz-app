import { useState, type FormEvent } from 'react';
import { CircleCheck, Keyboard, PackageCheck, QrCode } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { cn } from '@/lib/cn';
import { formatINR } from '@/lib/money';
import { ApiError } from '@/services/http';
import {
  useConfirmHandover,
  useVerifyPickup,
  type VerifiedPickup,
  type VerifyRequest,
} from '@/services/pickup';
import { QrScanner } from './QrScanner';

type Step =
  | { kind: 'enter' }
  | { kind: 'verified'; data: VerifiedPickup }
  | { kind: 'done'; pickupCode: string; at: string };

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const left = (error.details as { attemptsLeft?: number } | undefined)?.attemptsLeft;
    if (error.code === 'PICKUP_NO_MATCH' && typeof left === 'number') {
      return `${error.message} ${left > 0 ? `${left} ${left === 1 ? 'try' : 'tries'} left before a short cooldown.` : 'Next mistake starts a short cooldown.'}`;
    }
    return error.message;
  }
  return describeError(error);
}

/**
 * Verify Pickup for serving staff: scan the student's QR or type their code, check the matched
 * order, then press "Confirm handover". Checking a code never hands anything over by itself.
 */
export function VerifyPickupDialog({
  open,
  outletId,
  outletName,
  onClose,
}: {
  open: boolean;
  outletId: string;
  outletName: string;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'CODE' | 'QR'>('CODE');
  const [code, setCode] = useState('');
  const [inputError, setInputError] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'enter' });
  const verify = useVerifyPickup(outletId);
  const confirm = useConfirmHandover(outletId);
  const toast = useToast();

  function reset() {
    setStep({ kind: 'enter' });
    setCode('');
    setError(null);
    setInputError(undefined);
    verify.reset();
    confirm.reset();
  }
  function close() {
    reset();
    onClose();
  }

  function check(request: VerifyRequest) {
    setError(null);
    verify.mutate(request, {
      onSuccess: (data) => setStep({ kind: 'verified', data }),
      onError: (e) => setError(errorText(e)),
    });
  }

  function submitCode(event: FormEvent) {
    event.preventDefault();
    const digits = code.replace(/\s+/g, '');
    if (!/^\d+$/.test(digits)) {
      setInputError('Use digits only.');
      return;
    }
    if (digits.length !== 6 && digits.length !== 8) {
      setInputError('Pickup codes are 6 digits.');
      return;
    }
    check({ method: 'CODE', code: digits });
  }

  function confirmHandover(data: VerifiedPickup) {
    confirm.mutate(data.challengeToken, {
      onSuccess: (res) => {
        const at = res.handover?.handedOverAt ?? new Date().toISOString();
        setStep({ kind: 'done', pickupCode: data.order.pickupCode, at });
        toast.show({ tone: 'success', title: `${data.order.pickupCode} handed over` });
      },
      onError: (e) => {
        if (
          e instanceof ApiError &&
          ['PICKUP_CHALLENGE_EXPIRED', 'PICKUP_CHALLENGE_INVALID'].includes(e.code)
        ) {
          reset();
        }
        setError(errorText(e));
      },
    });
  }

  const tab = (value: 'CODE' | 'QR', label: string, Icon: typeof QrCode) => (
    <button
      type="button"
      aria-pressed={mode === value}
      onClick={() => {
        setMode(value);
        setError(null);
      }}
      className={cn(
        'inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-full border text-sm font-semibold',
        mode === value
          ? 'border-espresso-900 bg-espresso-900 text-cream-100'
          : 'border-espresso-200 bg-cream-50 text-espresso-700',
      )}
    >
      <Icon className="size-4" aria-hidden />
      {label}
    </button>
  );

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Verify pickup"
      description={`${outletName} · Check the student’s code, then confirm the handover.`}
    >
      {step.kind === 'enter' && (
        <div className="flex flex-col gap-4">
          <div role="group" aria-label="How to verify" className="flex gap-2">
            {tab('CODE', 'Enter code', Keyboard)}
            {tab('QR', 'Scan QR', QrCode)}
          </div>
          {mode === 'CODE' ? (
            <form onSubmit={submitCode} className="flex flex-col gap-3" noValidate>
              <TextField
                label="Student’s pickup code"
                inputMode="numeric"
                autoComplete="off"
                maxLength={9}
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setInputError(undefined);
                }}
                error={inputError}
                data-autofocus
                className="[&_input]:text-2xl [&_input]:tracking-[0.2em]"
              />
              <Button type="submit" loading={verify.isPending}>
                Verify code
              </Button>
            </form>
          ) : (
            <QrScanner onResult={(payload) => check({ method: 'QR', payload })} />
          )}
          {error && (
            <p
              role="alert"
              className="rounded-(--radius-control) bg-chili-50 p-3 text-sm text-chili-700"
            >
              {error}
            </p>
          )}
        </div>
      )}

      {step.kind === 'verified' && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-display text-4xl font-extrabold tabular">
              {step.data.order.pickupCode}
            </p>
            <Badge tone="success">Ready for pickup</Badge>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-espresso-500">Student</dt>
            <dd className="font-semibold">{step.data.order.customer.displayName}</dd>
            <dt className="text-espresso-500">Outlet</dt>
            <dd>{outletName}</dd>
            {step.data.order.scheduledFor && (
              <>
                <dt className="text-espresso-500">Scheduled</dt>
                <dd>
                  {new Date(step.data.order.scheduledFor).toLocaleTimeString('en-IN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </dd>
              </>
            )}
          </dl>
          <ul
            aria-label="Items"
            className="divide-y divide-dashed divide-espresso-100 rounded-(--radius-control) border border-espresso-100"
          >
            {step.data.order.items.map((i) => (
              <li key={i.menuItemId} className="flex justify-between px-3 py-2 text-sm">
                <span>{i.name}</span>
                <span className="font-semibold tabular">× {i.quantity}</span>
              </li>
            ))}
          </ul>
          {!step.data.canConfirm && (
            <p
              role="alert"
              className="rounded-(--radius-control) bg-mustard-50 p-3 text-sm text-mustard-800"
            >
              Take {formatINR(step.data.order.paymentDuePaise)} at the counter first: record the
              payment from the order in the queue, then confirm here.
            </p>
          )}
          <p className="text-xs text-espresso-500">
            Check the order number on the bag matches before handing it over.
          </p>
          {error && (
            <p
              role="alert"
              className="rounded-(--radius-control) bg-chili-50 p-3 text-sm text-chili-700"
            >
              {error}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={reset} disabled={confirm.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => confirmHandover(step.data)}
              loading={confirm.isPending}
              disabled={!step.data.canConfirm}
              icon={<PackageCheck className="size-4" aria-hidden />}
            >
              Confirm handover
            </Button>
          </div>
        </div>
      )}

      {step.kind === 'done' && (
        <div className="flex flex-col items-center gap-3 text-center">
          <CircleCheck className="size-10 text-success-600" aria-hidden />
          <p role="status" className="text-lg font-bold">
            {step.pickupCode} handed over at{' '}
            {new Date(step.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={close}>
              Done
            </Button>
            <Button onClick={reset}>Verify another</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
