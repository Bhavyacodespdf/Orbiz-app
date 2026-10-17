import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { DietaryMark } from '@/components/ui/DietaryMark';
import { Price } from '@/components/ui/Price';
import { Badge } from '@/components/ui/Badge';
import { describeError } from '@/lib/errors';
import { cn } from '@/lib/cn';
import type { StaffMenu } from '@/services/staff';
import type { ManagerPoll, PollInput } from '@/services/polls';
import { fromIstInput, istDay, toIstInput } from '@/features/specials/poll-format';

export const MIN_DISHES = 2;
export const MAX_DISHES = 10;

const schema = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date'),
    opensAt: z.string().min(1, 'Choose when voting opens'),
    closesAt: z.string().min(1, 'Choose when voting closes'),
    showLiveResults: z.boolean(),
    menuItemIds: z
      .array(z.string())
      .min(MIN_DISHES, `Choose between ${MIN_DISHES} and ${MAX_DISHES} dishes.`)
      .max(MAX_DISHES, `Choose between ${MIN_DISHES} and ${MAX_DISHES} dishes.`),
  })
  .refine((v) => v.closesAt > v.opensAt, {
    path: ['closesAt'],
    message: 'Voting must close after it opens',
  });
type Values = z.infer<typeof schema>;

/**
 * Create or edit a DRAFT poll. Times are entered and shown in India Standard Time,
 * the app's calendar policy. The server re-validates everything.
 */
export function PollEditorDialog({
  open,
  poll,
  menu,
  saving,
  error,
  onSave,
  onClose,
}: {
  open: boolean;
  poll: ManagerPoll | null;
  menu: StaffMenu | undefined;
  saving: boolean;
  error: unknown;
  onSave: (input: PollInput) => void;
  onClose: () => void;
}) {
  const {
    register,
    handleSubmit,
    reset,
    control,
    setValue,
    formState: { errors, isSubmitted },
  } = useForm<Values>({ resolver: zodResolver(schema) });
  const selected = useWatch({ control, name: 'menuItemIds' }) ?? [];

  useEffect(() => {
    if (!open) return;
    // Default to a 10:00–12:00 IST window: today if it hasn't started yet, else tomorrow.
    const nowMs = Date.now();
    const lateToday = toIstInput(new Date(nowMs).toISOString()).slice(11) >= '10:00';
    const today = istDay(lateToday ? nowMs + 24 * 60 * 60 * 1000 : nowMs);
    reset(
      poll
        ? {
            day: poll.day,
            opensAt: toIstInput(poll.opensAt),
            closesAt: toIstInput(poll.closesAt),
            showLiveResults: poll.showLiveResults,
            menuItemIds: poll.options.map((o) => o.dish.id),
          }
        : {
            day: today,
            opensAt: `${today}T10:00`,
            closesAt: `${today}T12:00`,
            showLiveResults: false,
            menuItemIds: [],
          },
    );
  }, [open, poll, reset]);

  const activeCategories = new Set(
    (menu?.categories ?? []).filter((c) => c.isActive).map((c) => c.id),
  );
  const candidates = (menu?.items ?? []).filter(
    (i) => i.isActive && activeCategories.has(i.categoryId),
  );
  const categoryName = (id: string) => menu?.categories.find((c) => c.id === id)?.name ?? '';

  function toggle(id: string) {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    setValue('menuItemIds', next, { shouldValidate: isSubmitted });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={poll ? 'Edit draft poll' : 'New Today’s Special poll'}
      description="Students vote between the dishes you pick. When voting closes, the dish with the most votes becomes that day’s special."
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={handleSubmit((values) =>
          onSave({
            day: values.day,
            opensAt: fromIstInput(values.opensAt),
            closesAt: fromIstInput(values.closesAt),
            menuItemIds: values.menuItemIds,
            showLiveResults: values.showLiveResults,
          }),
        )}
      >
        <TextField
          label="Special for"
          type="date"
          error={errors.day?.message}
          {...register('day')}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Voting opens"
            type="datetime-local"
            error={errors.opensAt?.message}
            {...register('opensAt')}
          />
          <TextField
            label="Voting closes"
            type="datetime-local"
            error={errors.closesAt?.message}
            {...register('closesAt')}
          />
        </div>
        <p className="-mt-2 text-xs text-espresso-500">
          Times are India Standard Time. Voting can open from the day before and must close by the
          end of the special’s date.
        </p>

        <fieldset>
          <legend className="mb-1 text-sm font-semibold">
            Dishes{' '}
            <span className="font-normal text-espresso-500">
              ({selected.length} chosen, {MIN_DISHES}–{MAX_DISHES})
            </span>
          </legend>
          {candidates.length === 0 ? (
            <p className="text-sm text-espresso-500">
              This outlet has no active dishes yet. Add some on the Menu page first.
            </p>
          ) : (
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
              {candidates.map((item) => {
                const checked = selected.includes(item.id);
                return (
                  <li key={item.id}>
                    <label
                      className={cn(
                        'flex items-center gap-3 rounded-(--radius-control) border px-3 py-2',
                        item.isAvailable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
                        checked ? 'border-chili-500 bg-chili-50/60' : 'border-espresso-100',
                      )}
                    >
                      <input
                        type="checkbox"
                        className="accent-chili-500"
                        checked={checked}
                        disabled={!item.isAvailable && !checked}
                        onChange={() => toggle(item.id)}
                      />
                      {item.dietary && <DietaryMark dietary={item.dietary} />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{item.name}</span>
                        <span className="block text-xs text-espresso-500">
                          {categoryName(item.categoryId)}
                        </span>
                      </span>
                      {!item.isAvailable && <Badge tone="neutral">Sold out</Badge>}
                      <Price paise={item.pricePaise} className="text-sm" />
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {errors.menuItemIds && (
            <p role="alert" className="mt-1 text-sm font-medium text-chili-600">
              {errors.menuItemIds.message}
            </p>
          )}
        </fieldset>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 accent-chili-500"
            {...register('showLiveResults')}
          />
          <span>
            Show live vote counts to students
            <span className="block text-espresso-500">
              Off by default, so early results don’t sway later voters. Counts are always shown once
              voting closes.
            </span>
          </span>
        </label>

        {error ? (
          <p role="alert" className="text-sm font-medium text-chili-600">
            {describeError(error)}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            {poll ? 'Save draft' : 'Create draft'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
