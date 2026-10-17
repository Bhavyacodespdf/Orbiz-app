import { useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { StatusSign, type OutletStatus } from '@/components/ui/StatusSign';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { cn } from '@/lib/cn';
import { useSetOutletStatus, type StaffOutlet } from '@/services/staff';
import { StaffGate } from '@/features/staff/StaffGate';
import { OutletPicker } from '@/features/staff/OutletPicker';
import { PickupHoursPanel } from '@/features/scheduling/PickupHoursPanel';

const OPTIONS: { status: OutletStatus; title: string; detail: string }[] = [
  { status: 'OPEN', title: 'Open', detail: 'Students can place orders.' },
  {
    status: 'PAUSED',
    title: 'Paused',
    detail: 'Menu stays visible; new orders are refused. Orders already placed are unaffected.',
  },
  { status: 'CLOSED', title: 'Closed', detail: 'Menu stays visible; ordering is unavailable.' },
];

function OutletSettings({
  current,
  outlets,
  select,
}: {
  current: StaffOutlet;
  outlets: StaffOutlet[];
  select: (id: string) => void;
}) {
  const setStatus = useSetOutletStatus(current.outlet.id);
  const toast = useToast();
  const [choice, setChoice] = useState<OutletStatus>(current.outlet.status);
  const changed = choice !== current.outlet.status;

  return (
    <>
      <PageHeader
        eyebrow="Kitchen"
        title="Outlet"
        description={current.outlet.location || undefined}
        actions={
          <OutletPicker
            outlets={outlets}
            selectedId={current.outlet.id}
            onSelect={(id) => {
              select(id);
            }}
          />
        }
      />
      <Panel className="max-w-xl p-5">
        <div className="mb-4 flex items-center gap-3">
          <h2 className="text-xl font-bold">{current.outlet.name}</h2>
          <StatusSign status={current.outlet.status} />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-semibold">Taking orders?</legend>
          {OPTIONS.map((option) => (
            <label
              key={option.status}
              className={cn(
                'flex cursor-pointer gap-3 rounded-(--radius-control) border-2 p-3',
                choice === option.status
                  ? 'border-chili-500 bg-chili-50/60'
                  : 'border-espresso-100 hover:border-espresso-200',
              )}
            >
              <input
                type="radio"
                name="status"
                value={option.status}
                checked={choice === option.status}
                onChange={() => setChoice(option.status)}
                className="mt-1 accent-chili-500"
              />
              <span>
                <span className="block font-semibold">{option.title}</span>
                <span className="block text-sm text-espresso-500">{option.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Button
          className="mt-4"
          disabled={!changed}
          loading={setStatus.isPending}
          onClick={() =>
            setStatus.mutate(choice, {
              onSuccess: () =>
                toast.show({
                  tone: 'success',
                  title: `${current.outlet.name} is now ${choice.toLowerCase()}`,
                }),
              onError: (e) =>
                toast.show({
                  tone: 'error',
                  title: 'Couldn’t change the status',
                  description: describeError(e),
                }),
            })
          }
        >
          Save status
        </Button>
      </Panel>
      <PickupHoursPanel outletId={current.outlet.id} />
    </>
  );
}

export function ManagerOutletPage() {
  return (
    <StaffGate role="MANAGER">
      {(ctx) => (
        <OutletSettings key={`${ctx.current.outlet.id}:${ctx.current.outlet.status}`} {...ctx} />
      )}
    </StaffGate>
  );
}
