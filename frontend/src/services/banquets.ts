import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';

/* Banquet bookings. Prices are the server's estimate; nothing is charged at booking. */

export const eventTypeSchema = z.enum([
  'PROJECT_LUNCH',
  'BIRTHDAY',
  'CLUB_EVENT',
  'ACADEMIC_EVENT',
  'OTHER',
]);
export type EventType = z.infer<typeof eventTypeSchema>;
export const bookingStatusSchema = z.enum([
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'REJECTED',
  'CANCELLED',
  'COMPLETED',
]);
export type BookingStatus = z.infer<typeof bookingStatusSchema>;

const lineSchema = z.object({
  menuItemId: z.string(),
  name: z.string(),
  unitPricePaise: z.number().int(),
  quantity: z.number().int(),
  lineTotalPaise: z.number().int(),
});

export const bookingSchema = z.object({
  id: z.string(),
  name: z.string(),
  eventType: eventTypeSchema,
  status: bookingStatusSchema,
  outlet: z.object({ id: z.string(), name: z.string(), location: z.string() }),
  host: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  guestCount: z.number().int(),
  dietaryNotes: z.string(),
  instructions: z.string(),
  contactPhone: z.string().nullable(),
  estimatedTotalPaise: z.number().int(),
  perGuestPaise: z.number().int(),
  items: z.array(lineSchema),
  decisionReason: z.string().nullable(),
  decidedAt: z.string().nullable(),
  history: z.array(
    z.object({
      fromStatus: bookingStatusSchema.nullable(),
      toStatus: bookingStatusSchema,
      actor: z.string(),
      actorRole: z.string(),
      reason: z.string().nullable(),
      at: z.string(),
    }),
  ),
  createdAt: z.string(),
  passToken: z.string().optional(),
});
export type Booking = z.infer<typeof bookingSchema>;

const venueSchema = z.object({
  outletId: z.string(),
  name: z.string(),
  slug: z.string(),
  location: z.string(),
  maxGuests: z.number().int(),
  minNoticeDays: z.number().int(),
  hours: z.array(
    z.object({
      weekday: z.number().int(),
      opensMinute: z.number().int(),
      closesMinute: z.number().int(),
    }),
  ),
});
export type Venue = z.infer<typeof venueSchema>;

export const banquetsKey = ['banquets'] as const;

export function useVenues() {
  return useQuery({
    queryKey: [...banquetsKey, 'venues'],
    queryFn: async () =>
      z.object({ venues: z.array(venueSchema) }).parse(await apiFetch('/banquets/venues')).venues,
  });
}

export function useMyBookings() {
  return useQuery({
    queryKey: [...banquetsKey, 'mine'],
    queryFn: async () =>
      z.object({ bookings: z.array(bookingSchema) }).parse(await apiFetch('/banquets')).bookings,
  });
}

export function useEventPass(bookingId: string) {
  return useQuery({
    queryKey: [...banquetsKey, bookingId, 'pass'],
    queryFn: async () =>
      z.object({ booking: bookingSchema }).parse(await apiFetch(`/banquets/${bookingId}/pass`))
        .booking,
  });
}

export interface PackageLine {
  menuItemId: string;
  quantity: number;
}

export function useQuote(outletId: string | null, guestCount: number, items: PackageLine[]) {
  return useQuery({
    queryKey: [...banquetsKey, 'quote', outletId, guestCount, items],
    queryFn: async () =>
      z
        .object({
          quote: z.object({
            lines: z.array(lineSchema),
            totalPaise: z.number().int(),
            perGuestPaise: z.number().int(),
          }),
        })
        .parse(
          await apiFetch('/banquets/quote', {
            method: 'POST',
            body: JSON.stringify({ outletId, guestCount, items }),
          }),
        ).quote,
    enabled: Boolean(outletId) && guestCount >= 1 && items.length > 0,
  });
}

export interface NewBooking {
  outletId: string;
  name: string;
  eventType: EventType;
  startsAt: string;
  durationMinutes: number;
  guestCount: number;
  dietaryNotes?: string;
  instructions?: string;
  contactPhone?: string | null;
  items: PackageLine[];
  expectedTotalPaise: number;
}

export function useCreateBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewBooking) =>
      z
        .object({ booking: bookingSchema })
        .parse(await apiFetch('/banquets', { method: 'POST', body: JSON.stringify(input) }))
        .booking,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: banquetsKey }),
  });
}

export function useCancelBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (bookingId: string) =>
      z
        .object({ booking: bookingSchema })
        .parse(await apiFetch(`/banquets/${bookingId}/cancel`, { method: 'POST', body: '{}' }))
        .booking,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: banquetsKey }),
  });
}

// ─── Staff ──────────────────────────────────────────────────────────────────

const settingsSchema = z.object({
  enabled: z.boolean(),
  maxGuests: z.number().int(),
  minNoticeDays: z.number().int(),
  maxConcurrentEvents: z.number().int(),
});
export type BanquetSettings = z.infer<typeof settingsSchema>;
const staffKey = (outletId: string) => ['staff', 'banquets', outletId] as const;
const staffBase = (outletId: string) => `/staff/outlets/${outletId}/banquets`;

export function useBanquetSettings(outletId: string) {
  return useQuery({
    queryKey: [...staffKey(outletId), 'settings'],
    queryFn: async () =>
      z
        .object({ settings: settingsSchema.passthrough() })
        .parse(await apiFetch(`${staffBase(outletId)}/settings`)).settings,
  });
}

export function useSaveBanquetSettings(outletId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: BanquetSettings) =>
      apiFetch(`${staffBase(outletId)}/settings`, { method: 'PUT', body: JSON.stringify(body) }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: staffKey(outletId) }),
  });
}

export function useOutletBookings(outletId: string) {
  return useQuery({
    queryKey: [...staffKey(outletId), 'list'],
    queryFn: async () =>
      z.object({ bookings: z.array(bookingSchema) }).parse(await apiFetch(staffBase(outletId)))
        .bookings,
  });
}

export function useDecideBooking(outletId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      bookingId,
      decision,
      reason,
    }: {
      bookingId: string;
      decision: 'confirm' | 'reject' | 'complete';
      reason?: string;
    }) =>
      apiFetch(`${staffBase(outletId)}/${bookingId}/${decision}`, {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {}),
      }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: staffKey(outletId) }),
  });
}

export async function checkPass(outletId: string, token: string) {
  return z
    .object({ valid: z.boolean(), booking: bookingSchema })
    .parse(await apiFetch(`${staffBase(outletId)}/pass/${encodeURIComponent(token)}`));
}

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  PROJECT_LUNCH: 'Project lunch',
  BIRTHDAY: 'Birthday',
  CLUB_EVENT: 'Club event',
  ACADEMIC_EVENT: 'Academic event',
  OTHER: 'Other',
};
export const BOOKING_STATUS: Record<
  BookingStatus,
  { label: string; tone: 'mustard' | 'success' | 'chili' | 'neutral' | 'dark' }
> = {
  PENDING_CONFIRMATION: { label: 'Awaiting confirmation', tone: 'mustard' },
  CONFIRMED: { label: 'Confirmed', tone: 'success' },
  REJECTED: { label: 'Declined', tone: 'chili' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  COMPLETED: { label: 'Completed', tone: 'dark' },
};
