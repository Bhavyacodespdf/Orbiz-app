import { useState, type FormEvent } from 'react';
import { Gauge, Power, Timer } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { SelectField } from '@/components/ui/SelectField';
import { Skeleton } from '@/components/feedback/Skeleton';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import type { StaffOutlet } from '@/services/staff';
import {
  useAccuracy,
  useKitchen,
  useUpdateKitchenSettings,
  useUpdatePrepMinutes,
  type EstimateSource,
  type Kitchen,
} from '@/services/kitchen';
import { StaffGate } from '@/features/staff/StaffGate';
import { OutletPicker } from '@/features/staff/OutletPicker';

const SOURCE: Record<EstimateSource, { label: string; tone: BadgeTone }> = {
  HISTORY: { label: 'From real orders', tone: 'success' },
  CONFIGURED: { label: 'Configured', tone: 'neutral' },
  DEFAULT: { label: 'Default — not configured', tone: 'mustard' },
};

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

function SettingsPanel({ outletId, kitchen }: { outletId: string; kitchen: Kitchen }) {
  const save = useUpdateKitchenSettings(outletId);
  const toast = useToast();
  const [parallel, setParallel] = useState(String(kitchen.settings.kitchenParallelOrders));
  const [maxWait, setMaxWait] = useState(String(kitchen.settings.autoAcceptMaxWaitMinutes));
  const [mode, setMode] = useState(kitchen.settings.autoAcceptMode);
  const [error, setError] = useState<string>();

  function submit(event: FormEvent, override?: 'MANUAL') {
    event.preventDefault();
    const p = Number(parallel);
    const w = Number(maxWait);
    if (!Number.isInteger(p) || p < 1 || p > 20)
      return setError('Parallel orders must be a whole number from 1 to 20.');
    if (!Number.isInteger(w) || w < 5 || w > 120)
      return setError('Maximum wait must be 5–120 minutes.');
    setError(undefined);
    const next = override ?? mode;
    save.mutate(
      { kitchenParallelOrders: p, autoAcceptMode: next, autoAcceptMaxWaitMinutes: w },
      {
        onSuccess: () => {
          setMode(next);
          toast.show({
            tone: 'success',
            title: override ? 'Auto-accept turned off' : 'Kitchen settings saved',
          });
        },
        onError: (e) => setError(describeError(e)),
      },
    );
  }

  return (
    <Panel className="flex flex-col gap-4 p-5">
      <h2 className="flex items-center gap-2 text-lg font-bold">
        <Gauge className="size-5" aria-hidden />
        Kitchen settings
      </h2>
      {kitchen.settings.autoAcceptMode === 'AUTO' && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-(--radius-control) bg-success-50 p-3 text-sm">
          <span>
            <strong>Auto-accept is on.</strong> Eligible prepaid orders are accepted by the rules
            below; everything else waits for staff.
          </span>
          <Button
            variant="danger"
            size="sm"
            icon={<Power className="size-4" aria-hidden />}
            loading={save.isPending}
            onClick={(e) => submit(e, 'MANUAL')}
          >
            Turn off auto-accept
          </Button>
        </div>
      )}
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-3" noValidate>
        <TextField
          label="Orders prepared at once"
          inputMode="numeric"
          value={parallel}
          onChange={(e) => setParallel(e.target.value)}
          hint="How many orders the kitchen works on at the same time."
        />
        <SelectField
          label="Order acceptance"
          value={mode}
          onChange={(e) => setMode(e.target.value as 'MANUAL' | 'AUTO')}
        >
          <option value="MANUAL">Manual — staff accept every order</option>
          <option value="AUTO">Auto — accept eligible orders by rules</option>
        </SelectField>
        <TextField
          label="Auto-accept up to (minutes of wait)"
          inputMode="numeric"
          value={maxWait}
          onChange={(e) => setMaxWait(e.target.value)}
          hint="Orders estimated to wait longer go to staff."
        />
        {error && (
          <p role="alert" className="text-sm font-semibold text-chili-700 sm:col-span-3">
            {error}
          </p>
        )}
        <div className="sm:col-span-3">
          <Button type="submit" loading={save.isPending}>
            Save settings
          </Button>
        </div>
      </form>
      <p className="text-sm text-espresso-500">
        Estimates use your configured preparation times, then learn from real orders. Outlet
        correction: ×{kitchen.calibration.factor}
        {kitchen.calibration.observations > 0
          ? ` (from ${kitchen.calibration.observations} collected ${kitchen.calibration.observations === 1 ? 'order' : 'orders'}${kitchen.calibration.observations < 5 ? '; applied after 5' : ''})`
          : ' (no completed orders yet)'}
        .
      </p>
    </Panel>
  );
}

function PrepRow({ outletId, dish }: { outletId: string; dish: Kitchen['dishes'][number] }) {
  const update = useUpdatePrepMinutes(outletId);
  const toast = useToast();
  const [value, setValue] = useState(dish.prepMinutes === null ? '' : String(dish.prepMinutes));
  const [error, setError] = useState<string>();
  const dirty = value !== (dish.prepMinutes === null ? '' : String(dish.prepMinutes));

  function save() {
    const trimmed = value.trim();
    const minutes = trimmed === '' ? null : Number(trimmed);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 180)) {
      setError('Whole minutes, 1–180');
      return;
    }
    setError(undefined);
    update.mutate(
      { menuItemId: dish.id, prepMinutes: minutes },
      {
        onSuccess: () =>
          toast.show({ tone: 'success', title: `${dish.name}: preparation time saved` }),
        onError: (e) => setError(describeError(e)),
      },
    );
  }

  return (
    <tr className="border-b border-dashed border-espresso-100 align-top last:border-b-0">
      <td className="py-2 pr-3">
        <span className="font-semibold">{dish.name}</span>
        <span className="block text-xs text-espresso-500">{dish.category}</span>
      </td>
      <td className="py-2 pr-3">
        <div className="flex items-start gap-2">
          <TextField
            label={`Configured Preparation Time for ${dish.name} (minutes)`}
            className="w-24 [&_label]:sr-only"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            error={error}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!dirty}
            loading={update.isPending}
            onClick={save}
            aria-label={`Save preparation time for ${dish.name}`}
          >
            Save
          </Button>
        </div>
        {dish.prepUpdatedAt && (
          <span className="text-xs text-espresso-500">Updated {shortDate(dish.prepUpdatedAt)}</span>
        )}
      </td>
      <td className="py-2 pr-3 text-sm">
        {dish.history ? (
          <>
            {dish.history.emaMinutes} min
            <span className="block text-xs text-espresso-500">
              {dish.history.observations} valid{' '}
              {dish.history.observations === 1 ? 'order' : 'orders'}
              {dish.history.lastDurationMinutes !== null &&
                ` · last ${dish.history.lastDurationMinutes} min`}
            </span>
          </>
        ) : (
          <span className="text-espresso-500">No single-dish orders yet</span>
        )}
      </td>
      <td className="py-2 text-sm">
        <span className="font-semibold">{dish.estimate.minutes} min</span>
        <Badge tone={SOURCE[dish.estimate.source].tone} className="mt-1 block w-fit">
          {SOURCE[dish.estimate.source].label}
        </Badge>
      </td>
    </tr>
  );
}

function AccuracyPanel({ outletId }: { outletId: string }) {
  const [days, setDays] = useState(14);
  const accuracy = useAccuracy(outletId, days);
  return (
    <Panel className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <Timer className="size-5" aria-hidden />
          Estimate accuracy
        </h2>
        <SelectField
          label="Period"
          value={String(days)}
          onChange={(e) => setDays(Number(e.target.value))}
          className="w-40"
        >
          <option value="7">Last 7 days</option>
          <option value="14">Last 14 days</option>
          <option value="30">Last 30 days</option>
        </SelectField>
      </div>
      {accuracy.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : accuracy.error ? (
        <ErrorState
          error={accuracy.error}
          onRetry={() => void accuracy.refetch()}
          retrying={accuracy.isFetching}
        />
      ) : !accuracy.data.enoughData ? (
        <p className="text-espresso-700">
          Not enough completed orders to evaluate estimate accuracy yet.
        </p>
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-3">
            {(
              [
                ['Accepted → ready', accuracy.data.acceptToReady],
                ['Preparing → ready', accuracy.data.prepStartToReady],
              ] as const
            ).map(([label, s]) => (
              <div key={label} className="rounded-(--radius-control) bg-cream-200 p-3">
                <dt className="text-sm font-semibold">{label}</dt>
                <dd className="text-sm text-espresso-700">
                  {s.evaluated === 0 ? (
                    'No evaluated orders'
                  ) : (
                    <>
                      Average error {s.meanAbsErrorMinutes} min · median {s.medianAbsErrorMinutes}{' '}
                      min
                      <span className="block">
                        {s.withinTolerancePct}% within ±{accuracy.data.toleranceMinutes} min ·{' '}
                        {s.evaluated} orders
                      </span>
                    </>
                  )}
                </dd>
              </div>
            ))}
            <div className="rounded-(--radius-control) bg-cream-200 p-3">
              <dt className="text-sm font-semibold">Late orders</dt>
              <dd className="text-sm text-espresso-700">
                {accuracy.data.lateOrders} ready more than {accuracy.data.lateThresholdMinutes} min
                after the estimate
                <span className="block">
                  Auto-accept: {accuracy.data.autoAccept.ACCEPTED ?? 0} accepted ·{' '}
                  {accuracy.data.autoAccept.MANUAL_REVIEW ?? 0} sent to staff
                </span>
              </dd>
            </div>
          </dl>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Accuracy by day</caption>
            <thead>
              <tr className="border-b border-espresso-100 text-espresso-500">
                <th className="py-1 font-semibold">Day</th>
                <th className="py-1 font-semibold">Orders</th>
                <th className="py-1 font-semibold">Evaluated</th>
                <th className="py-1 font-semibold">Average error</th>
              </tr>
            </thead>
            <tbody>
              {accuracy.data.perDay.map((d) => (
                <tr key={d.day} className="border-b border-dashed border-espresso-100">
                  <td className="py-1">{d.day}</td>
                  <td className="py-1">{d.ordersPlaced}</td>
                  <td className="py-1">{d.evaluated}</td>
                  <td className="py-1">
                    {d.meanAbsErrorMinutes === null ? '—' : `${d.meanAbsErrorMinutes} min`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  );
}

function KitchenManager({
  current,
  outlets,
  select,
}: {
  current: StaffOutlet;
  outlets: StaffOutlet[];
  select: (id: string) => void;
}) {
  const outletId = current.outlet.id;
  const kitchen = useKitchen(outletId);
  const missing = kitchen.data?.dishes.filter((d) => d.prepMinutes === null).length ?? 0;
  return (
    <>
      <PageHeader
        eyebrow="Kitchen"
        title="Kitchen timing"
        description="Preparation times, capacity and order acceptance. Estimates are rule-based and approximate."
        actions={<OutletPicker outlets={outlets} selectedId={outletId} onSelect={select} />}
      />
      {kitchen.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : kitchen.error ? (
        <ErrorState
          error={kitchen.error}
          onRetry={() => void kitchen.refetch()}
          retrying={kitchen.isFetching}
        />
      ) : (
        <div className="flex flex-col gap-6">
          <SettingsPanel
            key={JSON.stringify(kitchen.data.settings)}
            outletId={outletId}
            kitchen={kitchen.data}
          />
          <Panel className="flex flex-col gap-3 p-5">
            <h2 className="text-lg font-bold">Preparation times</h2>
            {missing > 0 && (
              <p className="rounded-(--radius-control) bg-mustard-50 p-2 text-sm text-mustard-800">
                {missing} {missing === 1 ? 'dish has' : 'dishes have'} no configured time and use
                the default until enough real orders are recorded.
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left">
                <caption className="sr-only">Preparation time per dish</caption>
                <thead>
                  <tr className="border-b border-espresso-100 text-sm text-espresso-500">
                    <th className="py-2 pr-3 font-semibold">Dish</th>
                    <th className="py-2 pr-3 font-semibold">Configured Preparation Time (min)</th>
                    <th className="py-2 pr-3 font-semibold">Learned from orders</th>
                    <th className="py-2 font-semibold">Used for estimates</th>
                  </tr>
                </thead>
                <tbody>
                  {kitchen.data.dishes.map((d) => (
                    <PrepRow key={`${d.id}:${d.prepMinutes}`} outletId={outletId} dish={d} />
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <AccuracyPanel outletId={outletId} />
        </div>
      )}
    </>
  );
}

export function ManagerKitchenPage() {
  return (
    <StaffGate role="MANAGER">
      {(ctx) => <KitchenManager key={ctx.current.outlet.id} {...ctx} />}
    </StaffGate>
  );
}
