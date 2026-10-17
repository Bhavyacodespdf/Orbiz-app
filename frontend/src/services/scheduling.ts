import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';

/*
 * Scheduled orders: the slots an outlet offers (worked out on the server from its pickup
 * hours, in India Standard Time) and the manager's pickup-hours settings.
 */

const slotsSchema = z.object({
  timezone: z.string(),
  feePaise: z.number().int(),
  leadMinutes: z.number().int(),
  slotMinutes: z.number().int(),
  days: z.array(
    z.object({
      date: z.string(),
      hours: z.object({ opensMinute: z.number().int(), closesMinute: z.number().int() }).nullable(),
      slots: z.array(z.object({ startsAt: z.string(), label: z.string(), available: z.boolean() })),
    }),
  ),
});
export type SlotOptions = z.infer<typeof slotsSchema>;

export function useSlots(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['slots', slug],
    queryFn: async () =>
      slotsSchema.parse(await apiFetch(`/outlets/${encodeURIComponent(slug!)}/slots`)),
    enabled: Boolean(slug) && enabled,
    // Slots move with the clock; refresh while the student is choosing.
    refetchInterval: 60_000,
  });
}

export const weekdayHoursSchema = z.object({
  weekday: z.number().int(),
  opensMinute: z.number().int(),
  closesMinute: z.number().int(),
});
export type WeekdayHours = z.infer<typeof weekdayHoursSchema>;

const scheduleSchema = z.object({
  leadMinutes: z.number().int(),
  slotMinutes: z.number().int(),
  daysAhead: z.number().int(),
  slotCapacity: z.number().int().nullable(),
  hours: z.array(weekdayHoursSchema),
});
export type OutletSchedule = z.infer<typeof scheduleSchema>;

const scheduleKey = (outletId: string) => ['staff', 'schedule', outletId] as const;

export function useOutletSchedule(outletId: string) {
  return useQuery({
    queryKey: scheduleKey(outletId),
    queryFn: async () =>
      z
        .object({ schedule: scheduleSchema })
        .parse(await apiFetch(`/staff/outlets/${outletId}/schedule`)).schedule,
  });
}

export function useSaveSchedule(outletId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (schedule: OutletSchedule) =>
      z.object({ schedule: scheduleSchema }).parse(
        await apiFetch(`/staff/outlets/${outletId}/schedule`, {
          method: 'PUT',
          body: JSON.stringify(schedule),
        }),
      ).schedule,
    onSuccess: (schedule) => {
      queryClient.setQueryData(scheduleKey(outletId), schedule);
      void queryClient.invalidateQueries({ queryKey: ['slots'] });
    },
  });
}
