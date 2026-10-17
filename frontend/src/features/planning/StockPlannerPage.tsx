import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Download,
  History,
  LineChart,
  PackagePlus,
  RefreshCw,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField } from '@/components/ui/SelectField';
import { TextField } from '@/components/ui/TextField';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { describeError } from '@/lib/errors';
import { formatDateTime, timeAgo } from '@/lib/time';
import { newIdempotencyKey } from '@/lib/idempotency';
import { StaffGate } from '@/features/staff/StaffGate';
import { OutletPicker } from '@/features/staff/OutletPicker';
import type { StaffOutlet } from '@/services/staff';
import {
  planExportUrl,
  useGeneratePlan,
  useItemHistory,
  usePlannerOverview,
  usePlanningEvaluation,
  usePlanTransition,
  useRecordReplenishment,
  useUpdatePlanItem,
  useUpdatePlanNotes,
  type Confidence,
  type Plan,
  type PlanItem,
  type PlanStatus,
} from '@/services/planning';

const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const weekdayOf = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
const shortDate = (day: string) =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );
const addDays = (day: string, n: number) =>
  new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const units = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const STATUS_LABEL: Record<PlanStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted for approval',
  APPROVED: 'Approved',
  COMPLETED: 'Completed',
  SUPERSEDED: 'Replaced',
};
const STATUS_TONE: Record<PlanStatus, BadgeTone> = {
  DRAFT: 'neutral',
  SUBMITTED: 'mustard',
  APPROVED: 'success',
  COMPLETED: 'dark',
  SUPERSEDED: 'neutral',
};
const CONFIDENCE: Record<Confidence, { label: string; tone: BadgeTone }> = {
  HIGH: { label: 'High confidence', tone: 'success' },
  MEDIUM: { label: 'Medium confidence', tone: 'neutral' },
  LOW: { label: 'Low confidence', tone: 'mustard' },
  NONE: { label: 'No history', tone: 'chili' },
};
const ITEM_STATUS: Record<PlanItem['status'], { label: string; tone: BadgeTone }> = {
  NEEDS_REVIEW: { label: 'Needs review', tone: 'mustard' },
  APPROVED: { label: 'Approved', tone: 'success' },
  REPLENISHED: { label: 'Restocked', tone: 'success' },
  NOTHING_TO_ADD: { label: 'Nothing to add', tone: 'neutral' },
  COMPLETED: { label: 'Completed', tone: 'dark' },
  SUPERSEDED: { label: 'Replaced', tone: 'neutral' },
};

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'warn';
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-(--radius-control) border border-espresso-100 bg-white p-3">
      <span className="text-xs font-semibold tracking-wide text-espresso-500 uppercase">
        {label}
      </span>
      <span className={tone === 'warn' ? 'text-xl font-bold text-chili-700' : 'text-xl font-bold'}>
        {value}
      </span>
      {hint && <span className="text-xs text-espresso-600">{hint}</span>}
    </div>
  );
}

function ItemDetail({ outletId, item, plan }: { outletId: string; item: PlanItem; plan: Plan }) {
  const history = useItemHistory(outletId, item.menuItem.id);
  const restock = useRecordReplenishment(outletId, plan.id);
  const [qty, setQty] = useState(String(Math.max(0, item.finalQty - item.replenishedQty) || ''));
  const [key, setKey] = useState(newIdempotencyKey);
  const [message, setMessage] = useState<string | null>(null);
  const recent = history.data?.days.slice(-28) ?? [];
  const peak = Math.max(1, ...recent.map((d) => Math.max(d.demand, d.forecast ?? 0)));

  return (
    <div className="flex flex-col gap-4 border-t border-dashed border-espresso-100 bg-cream-50/60 p-4 text-sm">
      <div>
        <h4 className="mb-2 font-sans font-bold">Daily forecast</h4>
        <ul
          className="grid grid-cols-4 gap-2 sm:grid-cols-7"
          aria-label={`Daily forecast for ${item.menuItem.name}`}
        >
          {item.dailyForecast.map((d) => (
            <li
              key={d.date}
              className="rounded-(--radius-control) border border-espresso-100 bg-white p-2 text-center"
            >
              <div className="text-xs text-espresso-500">{WEEKDAY[weekdayOf(d.date)]}</div>
              <div className="font-bold">{units(d.quantity)}</div>
              <div className="text-[0.7rem] text-espresso-500">
                {units(d.lower)}–{units(d.upper)}
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-espresso-500">
          Ranges are 80% intervals. Forecasts are estimates, not guaranteed sales.
        </p>
      </div>

      <div>
        <h4 className="mb-1 font-sans font-bold">Why this recommendation</h4>
        <ul className="list-disc space-y-1 pl-5 text-espresso-800">
          {item.explanation.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {item.overridden && (
          <p className="mt-2 text-espresso-700">
            <strong>Changed by staff</strong> from {item.recommendedQty} to {item.finalQty}: “
            {item.overrideReason}”
          </p>
        )}
      </div>

      <div>
        <h4 className="mb-2 font-sans font-bold">Last 4 weeks</h4>
        {history.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : history.error ? (
          <p className="text-chili-700">{describeError(history.error)}</p>
        ) : recent.length === 0 ? (
          <p className="text-espresso-600">No recorded days yet.</p>
        ) : (
          <>
            <div
              className="flex h-20 items-end gap-0.5"
              role="img"
              aria-label={`Daily demand for ${item.menuItem.name} over the last ${recent.length} day${recent.length === 1 ? '' : 's'}`}
            >
              {recent.map((d) => (
                <div
                  key={d.date}
                  title={`${d.date}: ${d.demand} ordered${d.forecast !== null ? `, forecast ${units(d.forecast)}` : ''}${d.censored ? ' (sold out part of the day)' : ''}${!d.outletActive ? ' (no orders at the outlet)' : ''}`}
                  className={`min-w-1 flex-1 rounded-t ${d.censored ? 'bg-chili-300' : 'bg-espresso-700'}`}
                  style={{ height: `${Math.max(2, (d.demand / peak) * 100)}%` }}
                />
              ))}
            </div>
            <p className="mt-1 text-xs text-espresso-500">
              Red bars: sold out part of the day (sales understate demand). Total{' '}
              {recent.reduce((a, d) => a + d.demand, 0)} ordered.
            </p>
          </>
        )}
      </div>

      {item.outcome && (
        <div>
          <h4 className="mb-2 font-sans font-bold">Forecast vs actual</h4>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left">
              <thead className="text-xs text-espresso-500">
                <tr>
                  <th className="py-1 font-semibold">Day</th>
                  <th className="py-1 font-semibold">Forecast</th>
                  <th className="py-1 font-semibold">Actual</th>
                  <th className="py-1 font-semibold">Sold</th>
                  <th className="py-1 font-semibold">Wasted</th>
                </tr>
              </thead>
              <tbody>
                {item.outcome.daily.map((d) => (
                  <tr key={d.date} className="border-t border-espresso-100">
                    <td className="py-1">
                      {WEEKDAY[weekdayOf(d.date)]}{' '}
                      {d.censored && <Badge tone="chili">Sold out</Badge>}
                    </td>
                    <td className="py-1">{units(d.forecast)}</td>
                    <td className="py-1">{d.actual}</td>
                    <td className="py-1">{d.fulfilled}</td>
                    <td className="py-1">{d.wasted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-espresso-700">
            Week: forecast {units(item.outcome.forecastUnits)}, actual {item.outcome.demandUnits}{' '}
            (off by {units(item.outcome.absError)}); {item.outcome.replenishedUnits} restocked,{' '}
            {item.outcome.wastedUnits} wasted
            {item.outcome.leftoverUnits !== null
              ? `, ${item.outcome.leftoverUnits} left at the end`
              : ''}
            .
          </p>
        </div>
      )}

      {plan.status === 'APPROVED' && (
        <div className="flex flex-wrap items-end gap-2">
          {item.tracked ? (
            <>
              <TextField
                label={`Units actually added for ${item.menuItem.name}`}
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="w-56"
              />
              <Button
                size="md"
                icon={<PackagePlus className="size-4" aria-hidden />}
                loading={restock.isPending}
                disabled={!qty || Number(qty) < 1}
                onClick={() =>
                  restock.mutate(
                    { planItemId: item.id, quantity: Number(qty), idempotencyKey: key },
                    {
                      onSuccess: () => {
                        setMessage(`Recorded ${qty} added to stock.`);
                        setKey(newIdempotencyKey());
                        setQty('');
                      },
                      onError: (e) => setMessage(describeError(e)),
                    },
                  )
                }
              >
                Record restock
              </Button>
              {message && (
                <span role="status" className="text-sm">
                  {message}
                </span>
              )}
            </>
          ) : (
            <p className="text-espresso-600">
              Stock isn’t counted for this item, so restocks can’t be recorded here. A manager can
              start counting it on the Stock page.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function OverrideDialog({
  item,
  onClose,
  onSave,
  saving,
  error,
}: {
  item: PlanItem;
  onClose: () => void;
  onSave: (finalQty: number, reason: string) => void;
  saving: boolean;
  error: unknown;
}) {
  const [qty, setQty] = useState(String(item.finalQty));
  const [reason, setReason] = useState(item.overrideReason ?? '');
  const n = qty === '' ? NaN : Number(qty);
  const changed = !Number.isNaN(n) && n !== item.recommendedQty;
  const valid =
    !Number.isNaN(n) && n >= 0 && n <= 100_000 && (!changed || reason.trim().length >= 3);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Quantity for ${item.menuItem.name}`}
      description={`Recommended: ${item.recommendedQty}. Changing it needs a reason; the original recommendation is kept.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} disabled={!valid} onClick={() => onSave(n, reason.trim())}>
            Save quantity
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField
          label="Final quantity"
          inputMode="numeric"
          value={qty}
          onChange={(e) => setQty(e.target.value.replace(/\D/g, '').slice(0, 6))}
          data-autofocus
        />
        <TextField
          label="Reason for the change"
          hint={
            changed
              ? 'Required when you change the recommendation'
              : 'Not needed when you keep the recommendation'
          }
          value={reason}
          maxLength={300}
          onChange={(e) => setReason(e.target.value)}
        />
        {error ? (
          <p role="alert" className="text-sm text-chili-700">
            {describeError(error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function PlanTable({
  outletId,
  plan,
  editable,
}: {
  outletId: string;
  plan: Plan;
  editable: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<PlanItem | null>(null);
  const update = useUpdatePlanItem(outletId, plan.id);
  return (
    <Panel className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] text-left text-sm">
          <thead className="bg-cream-200/60 text-xs text-espresso-600">
            <tr>
              <th className="p-3 font-semibold">Item</th>
              <th className="p-3 font-semibold">Current stock</th>
              <th className="p-3 font-semibold">Forecast (week)</th>
              <th className="p-3 font-semibold">Incoming</th>
              <th className="p-3 font-semibold">Safety stock</th>
              <th className="p-3 font-semibold">Recommended</th>
              <th className="p-3 font-semibold">Final quantity</th>
              <th className="p-3 font-semibold">Status</th>
            </tr>
          </thead>
          {plan.items.map((item) => {
            const expanded = open === item.id;
            return (
              <tbody key={item.id} className="border-t border-espresso-100">
                <tr className="align-top">
                  <td className="p-3">
                    <button
                      type="button"
                      className="flex items-start gap-1 text-left font-semibold hover:underline"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : item.id)}
                    >
                      {expanded ? (
                        <ChevronDown className="mt-0.5 size-4 shrink-0" aria-hidden />
                      ) : (
                        <ChevronRight className="mt-0.5 size-4 shrink-0" aria-hidden />
                      )}
                      <span>
                        {item.menuItem.name}
                        <span className="block text-xs font-normal text-espresso-500">
                          {item.menuItem.category.name}
                        </span>
                      </span>
                    </button>
                    <div className="mt-1 flex flex-wrap gap-1 pl-5">
                      <Badge tone={CONFIDENCE[item.confidence].tone}>
                        {CONFIDENCE[item.confidence].label}
                      </Badge>
                      {item.excessRisk && <Badge tone="mustard">Wastage risk</Badge>}
                    </div>
                  </td>
                  <td className="p-3">
                    {item.tracked ? (
                      <>
                        {item.menuItem.stockQuantity ?? item.currentStock}
                        {item.menuItem.stockQuantity !== item.currentStock && (
                          <span className="block text-xs text-espresso-500">
                            {item.currentStock} when planned
                          </span>
                        )}
                        {item.menuItem.stockStatus !== 'AVAILABLE' && (
                          <Badge
                            tone={item.menuItem.stockStatus === 'SOLD_OUT' ? 'chili' : 'mustard'}
                            className="mt-1"
                          >
                            {item.menuItem.stockStatus === 'SOLD_OUT' ? 'Sold out' : 'Low stock'}
                          </Badge>
                        )}
                      </>
                    ) : (
                      <span className="text-espresso-500">Not counted</span>
                    )}
                  </td>
                  <td className="p-3">{units(item.forecastUnits)}</td>
                  <td
                    className="p-3 text-espresso-500"
                    title="CampusCart has no purchase orders yet, so nothing is recorded as on the way."
                  >
                    {item.expectedIncoming}
                  </td>
                  <td className="p-3">{item.safetyStock}</td>
                  <td className="p-3 font-semibold">{item.recommendedQty}</td>
                  <td className="p-3">
                    <span className="font-bold">{item.finalQty}</span>
                    {item.overridden && <Badge className="ml-1">Changed</Badge>}
                    {editable && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-1"
                        onClick={() => setEditing(item)}
                        aria-label={`Change quantity for ${item.menuItem.name}`}
                      >
                        Edit
                      </Button>
                    )}
                    {plan.status === 'APPROVED' && item.tracked && item.finalQty > 0 && (
                      <span className="block text-xs text-espresso-500">
                        {item.replenishedQty} restocked
                      </span>
                    )}
                  </td>
                  <td className="p-3">
                    <Badge tone={ITEM_STATUS[item.status].tone}>
                      {ITEM_STATUS[item.status].label}
                    </Badge>
                  </td>
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={8} className="p-0">
                      <ItemDetail outletId={outletId} item={item} plan={plan} />
                    </td>
                  </tr>
                )}
              </tbody>
            );
          })}
        </table>
      </div>
      {editing && (
        <OverrideDialog
          item={editing}
          saving={update.isPending}
          error={update.error}
          onClose={() => {
            update.reset();
            setEditing(null);
          }}
          onSave={(finalQty, reason) =>
            update.mutate(
              { planItemId: editing.id, finalQty, ...(reason ? { reason } : {}) },
              { onSuccess: () => setEditing(null) },
            )
          }
        />
      )}
    </Panel>
  );
}

function Notes({ outletId, plan }: { outletId: string; plan: Plan }) {
  const [notes, setNotes] = useState(plan.notes);
  const save = useUpdatePlanNotes(outletId, plan.id);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <TextField
        label="Notes for this week"
        value={notes}
        maxLength={2000}
        onChange={(e) => setNotes(e.target.value)}
        className="min-w-64 flex-1"
      />
      <Button
        variant="secondary"
        loading={save.isPending}
        disabled={notes.trim() === plan.notes}
        onClick={() => save.mutate(notes.trim())}
      >
        Save notes
      </Button>
    </div>
  );
}

function Revisions({ plan }: { plan: Plan }) {
  return (
    <details className="text-sm">
      <summary className="flex cursor-pointer items-center gap-2 font-semibold">
        <History className="size-4" aria-hidden /> Revision history ({plan.revisions.length})
      </summary>
      <ol className="mt-2 space-y-1">
        {plan.revisions.map((r) => (
          <li key={r.id} className="text-espresso-700">
            <time dateTime={r.at} className="text-espresso-500">
              {formatDateTime(r.at)}
            </time>{' '}
            · {r.actor ?? 'System'}
            {r.actorRole ? ` (${r.actorRole === 'POS' ? 'counter' : 'manager'})` : ''}:{' '}
            {r.kind === 'STATUS' && r.toStatus ? `status → ${STATUS_LABEL[r.toStatus]}` : null}
            {r.kind === 'CREATED' && 'generated the plan'}
            {(r.kind === 'OVERRIDE' || r.kind === 'RESET_TO_RECOMMENDATION') &&
              `${r.itemName}: ${r.fromQty} → ${r.toQty}`}
            {r.kind === 'REPLENISHED' &&
              `${r.itemName}: restocked (${r.fromQty} → ${r.toQty} recorded)`}
            {r.kind === 'NOTES' && 'updated the notes'}
            {r.reason && r.kind !== 'NOTES' ? ` — “${r.reason}”` : ''}
          </li>
        ))}
      </ol>
    </details>
  );
}

function Accuracy({ outletId }: { outletId: string }) {
  const [show, setShow] = useState(false);
  const evaluation = usePlanningEvaluation(outletId, show);
  return (
    <details className="text-sm" onToggle={(e) => setShow((e.target as HTMLDetailsElement).open)}>
      <summary className="flex cursor-pointer items-center gap-2 font-semibold">
        <LineChart className="size-4" aria-hidden /> Forecast accuracy and stock policy
      </summary>
      {evaluation.isPending ? (
        <Skeleton className="mt-2 h-16 w-full" />
      ) : evaluation.error ? (
        <p className="mt-2 text-chili-700">{describeError(evaluation.error)}</p>
      ) : (
        <div className="mt-2 space-y-2 text-espresso-800">
          {evaluation.data.last8Weeks.evaluatedForecasts === 0 ? (
            <p>
              No forecast has reached its day yet, so there is nothing to measure. Accuracy appears
              once forecast days pass.
            </p>
          ) : (
            <p>
              Last 8 weeks, {evaluation.data.last8Weeks.evaluatedForecasts} item-days measured:
              typical error <strong>{evaluation.data.last8Weeks.mae} units</strong> a day (MAE)
              {evaluation.data.last8Weeks.wape !== null && (
                <>
                  , <strong>{Math.round(evaluation.data.last8Weeks.wape * 100)}%</strong> of actual
                  demand (WAPE)
                </>
              )}
              . {evaluation.data.last8Weeks.excludedForecasts} sold-out or closed days aren’t
              counted, because their sales aren’t true demand.
            </p>
          )}
          <p>
            Recommendations use the{' '}
            <strong>
              {evaluation.data.policy.inUse.learned
                ? `learned policy ${evaluation.data.policy.inUse.version}`
                : 'baseline rule'}
            </strong>
            {evaluation.data.policy.inUse.learned
              ? ', which beat the baseline on held-out past weeks.'
              : ' (forecast + safety stock − stock on hand). A learned policy is only used after it beats this rule on enough real past weeks.'}{' '}
            Finished decisions recorded: {evaluation.data.policy.decisions.FINALIZED ?? 0}.
          </p>
        </div>
      )}
    </details>
  );
}

function Planner({
  current,
  outlets,
  select,
  area,
}: {
  current: StaffOutlet;
  outlets: StaffOutlet[];
  select: (id: string) => void;
  area: 'Kitchen' | 'Counter';
}) {
  const outletId = current.outlet.id;
  const [week, setWeek] = useState<string | null>(null);
  const overview = usePlannerOverview(outletId, week);
  const data = overview.data;
  const plan = data?.plan ?? null;
  const generate = useGeneratePlan(outletId);
  const transition = usePlanTransition(outletId, plan?.id ?? '');
  const [actionError, setActionError] = useState<unknown>(null);

  const weeks = useMemo(() => {
    if (!data) return [];
    const list: string[] = [];
    for (let d = data.week.firstPlannable; d <= data.week.lastPlannable; d = addDays(d, 7))
      list.push(d);
    return list;
  }, [data]);

  const run = (action: 'submit' | 'approve' | 'complete') => {
    setActionError(null);
    transition.mutate(action, { onError: setActionError });
  };

  return (
    <>
      <PageHeader
        eyebrow={area}
        title="Weekly Stock Planner"
        description="How much of each item to prepare or buy for the coming week, from real orders and stock history. Forecasts are estimates, not guaranteed sales; nothing here changes live stock until you record a restock."
        actions={<OutletPicker outlets={outlets} selectedId={outletId} onSelect={select} />}
      />
      {overview.isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : overview.error ? (
        <ErrorState
          error={overview.error}
          onRetry={() => void overview.refetch()}
          retrying={overview.isFetching}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <SelectField
              label="Week"
              value={data!.week.start}
              onChange={(e) => setWeek(e.target.value)}
              className="w-64"
            >
              {weeks.map((w) => (
                <option key={w} value={w}>
                  {shortDate(w)} – {shortDate(addDays(w, 6))}
                </option>
              ))}
            </SelectField>
            {plan && (
              <Badge tone={STATUS_TONE[plan.status]} className="mb-2.5">
                {STATUS_LABEL[plan.status]} · v{plan.version}
              </Badge>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
            <Stat
              label="Forecast demand"
              value={plan ? units(plan.totals.forecastUnits) : '—'}
              hint="units, all items, the week"
            />
            <Stat
              label="To replenish"
              value={plan ? String(plan.totals.itemsNeedingReplenishment) : '—'}
              hint={plan ? `${plan.totals.finalUnits} units planned` : undefined}
            />
            <Stat
              label="Low / sold out now"
              value={`${data!.stock.LOW_STOCK} / ${data!.stock.SOLD_OUT}`}
              hint="live stock"
              tone={data!.stock.SOLD_OUT > 0 ? 'warn' : undefined}
            />
            <Stat
              label="Wastage risk"
              value={plan ? String(plan.totals.excessRiskItems) : '—'}
              hint="stock well above the week’s need"
            />
            <Stat
              label="History"
              value={`${data!.dataSufficiency.daysWithOrders}/${data!.dataSufficiency.windowDays} days`}
              hint={
                plan
                  ? `${plan.totals.lowConfidenceItems} items with little or no history`
                  : 'days with orders, last 8 weeks'
              }
              tone={data!.dataSufficiency.daysWithOrders < 14 ? 'warn' : undefined}
            />
            <Stat
              label="Last forecast"
              value={data!.latestForecast ? timeAgo(data!.latestForecast.createdAt) : 'Never'}
              hint={
                data!.demandUpdatedAt
                  ? `Sales data updated ${timeAgo(data!.demandUpdatedAt)}`
                  : undefined
              }
            />
          </div>

          {data!.dataSufficiency.daysWithOrders < 14 && (
            <p
              role="note"
              className="flex items-start gap-2 rounded-(--radius-control) bg-mustard-50 px-3 py-2 text-sm text-mustard-800"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              Only {data!.dataSufficiency.daysWithOrders}{' '}
              {data!.dataSufficiency.daysWithOrders === 1 ? 'day' : 'days'} with orders in the last
              8 weeks. Forecasts will be rough until more history builds up — check them against
              your own experience.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {(!plan || plan.status === 'DRAFT' || plan.status === 'SUBMITTED') && (
              <Button
                icon={<RefreshCw className="size-4" aria-hidden />}
                loading={generate.isPending}
                onClick={() => {
                  setActionError(null);
                  generate.mutate(data!.week.start, { onError: setActionError });
                }}
              >
                {plan ? 'Refresh forecast (new version)' : 'Generate forecast and plan'}
              </Button>
            )}
            {plan?.status === 'DRAFT' && (
              <Button
                variant="secondary"
                loading={transition.isPending && transition.variables === 'submit'}
                onClick={() => run('submit')}
              >
                Submit for approval
              </Button>
            )}
            {plan &&
              (plan.status === 'DRAFT' || plan.status === 'SUBMITTED') &&
              data!.role === 'MANAGER' && (
                <Button
                  variant="secondary"
                  icon={<ClipboardCheck className="size-4" aria-hidden />}
                  loading={transition.isPending && transition.variables === 'approve'}
                  onClick={() => run('approve')}
                >
                  Approve plan
                </Button>
              )}
            {plan?.status === 'APPROVED' && (
              <Button
                variant="secondary"
                loading={transition.isPending && transition.variables === 'complete'}
                onClick={() => run('complete')}
              >
                Mark preparation completed
              </Button>
            )}
            {plan && (
              <a
                href={planExportUrl(outletId, plan.id)}
                download
                className="inline-flex h-11 items-center gap-2 rounded-(--radius-control) px-4 font-semibold text-espresso-700 hover:bg-espresso-50"
              >
                <Download className="size-4" aria-hidden /> Export CSV
              </a>
            )}
          </div>
          {plan?.status === 'SUBMITTED' && data!.role === 'POS' && (
            <p className="text-sm text-espresso-700">
              Waiting for the outlet’s manager to approve.
            </p>
          )}
          {actionError ? (
            <p role="alert" className="text-sm text-chili-700">
              {describeError(actionError)}
            </p>
          ) : null}

          {!plan ? (
            <EmptyState
              icon={<LineChart aria-hidden />}
              title="No plan for this week yet"
              description="Generate a forecast to see recommended quantities. You can review and change every number before it’s approved."
            />
          ) : (
            <>
              <PlanTable
                outletId={outletId}
                plan={plan}
                editable={plan.status === 'DRAFT' || plan.status === 'SUBMITTED'}
              />
              {plan.outcome && (
                <p className="text-sm text-espresso-800">
                  <strong>Week finished:</strong> forecast {units(plan.outcome.forecastUnits)},
                  actual demand {plan.outcome.demandUnits}
                  {plan.outcome.wape !== null &&
                    ` (${Math.round(plan.outcome.wape * 100)}% off overall)`}
                  ; {plan.outcome.stockoutDays} item-days sold out, {plan.outcome.wastedUnits} units
                  wasted. Open an item for its day-by-day comparison.
                </p>
              )}
              <p className="text-xs text-espresso-500">
                Forecast made {formatDateTime(plan.forecastRun.createdAt)} from history{' '}
                {shortDate(plan.forecastRun.historyFrom)}–{shortDate(plan.forecastRun.historyTo)} (
                {plan.forecastRun.model} {plan.forecastRun.modelVersion}); recommendations by the{' '}
                {plan.policy.name === 'baseline'
                  ? 'baseline rule'
                  : `learned policy ${plan.policy.version}`}
                .{plan.approvedBy && ` Approved by ${plan.approvedBy}.`}
              </p>
              {plan.status !== 'SUPERSEDED' && (
                <Notes key={plan.id} outletId={outletId} plan={plan} />
              )}
              <Revisions plan={plan} />
            </>
          )}
          <Accuracy outletId={outletId} />
        </div>
      )}
    </>
  );
}

export function PosStockPlannerPage() {
  return (
    <StaffGate role="POS">
      {(ctx) => <Planner key={ctx.current.outlet.id} {...ctx} area="Counter" />}
    </StaffGate>
  );
}

export function ManagerStockPlannerPage() {
  return (
    <StaffGate role="MANAGER">
      {(ctx) => <Planner key={ctx.current.outlet.id} {...ctx} area="Kitchen" />}
    </StaffGate>
  );
}
