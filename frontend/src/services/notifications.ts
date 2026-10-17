import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';

/** The signed-in user's persistent inbox. Socket events only tell us to refetch it. */

const notificationSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  entity: z.object({ type: z.string(), id: z.string() }).nullable(),
  read: z.boolean(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type AppNotification = z.infer<typeof notificationSchema>;

const pageSchema = z.object({
  notifications: z.array(notificationSchema),
  unread: z.number().int(),
  nextCursor: z.string().nullable(),
});

export const notificationsKey = ['notifications'] as const;

export function useUnreadCount(enabled: boolean) {
  return useQuery({
    queryKey: [...notificationsKey, 'unread'],
    queryFn: async () =>
      z.object({ unread: z.number().int() }).parse(await apiFetch('/me/notifications/unread-count'))
        .unread,
    enabled,
    // A slow safety net; live updates arrive over the socket.
    refetchInterval: 60_000,
  });
}

export function useNotifications(filter: 'all' | 'unread', enabled: boolean) {
  return useInfiniteQuery({
    queryKey: [...notificationsKey, 'list', filter],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      pageSchema.parse(
        await apiFetch(
          `/me/notifications?filter=${filter}&limit=20${pageParam ? `&cursor=${pageParam}` : ''}`,
        ),
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}

function useInvalidateNotifications() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: notificationsKey });
}

export function useMarkRead() {
  const invalidate = useInvalidateNotifications();
  return useMutation({
    mutationFn: async (id: string) =>
      apiFetch(`/me/notifications/${id}/read`, { method: 'POST', body: '{}' }),
    onSettled: invalidate,
  });
}

export function useMarkAllRead() {
  const invalidate = useInvalidateNotifications();
  return useMutation({
    mutationFn: async () => apiFetch('/me/notifications/read-all', { method: 'POST', body: '{}' }),
    onSettled: invalidate,
  });
}
