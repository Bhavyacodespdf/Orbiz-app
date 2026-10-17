import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';
import { roleSchema } from './auth';
import { outletSchema } from './outlets';

/* Administrator API. Every call is checked server-side for the ADMIN role and audited. */

export const adminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  emailVerified: z.boolean(),
  status: z.enum(['ACTIVE', 'SUSPENDED']),
  signInMethod: z.enum(['GOOGLE', 'DEV']),
  roles: z.array(roleSchema),
  eligibleFor: z.object({ MANAGER: z.boolean(), POS: z.boolean(), ADMIN: z.boolean() }),
  assignments: z.array(
    z.object({
      id: z.string(),
      role: z.enum(['MANAGER', 'POS']),
      outlet: z.object({ id: z.string(), name: z.string() }),
    }),
  ),
  createdAt: z.string(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;
export type PrivilegedRole = 'MANAGER' | 'POS' | 'ADMIN';

export function useAdminUsers(q: string) {
  return useInfiniteQuery({
    queryKey: ['admin', 'users', q],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (q) params.set('q', q);
      if (pageParam) params.set('cursor', pageParam);
      return z
        .object({ users: z.array(adminUserSchema), nextCursor: z.string().nullable() })
        .parse(await apiFetch(`/admin/users?${params}`));
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}

function useAdminMutation<TInput>(request: (input: TInput) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function useGrantRole() {
  return useAdminMutation(({ userId, role }: { userId: string; role: PrivilegedRole }) =>
    apiFetch(`/admin/users/${userId}/roles`, { method: 'POST', body: JSON.stringify({ role }) }),
  );
}

export function useRevokeRole() {
  return useAdminMutation(
    ({ userId, role, reason }: { userId: string; role: PrivilegedRole; reason: string }) =>
      apiFetch(`/admin/users/${userId}/roles/${role}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
  );
}

// ─── Outlets ─────────────────────────────────────────────────────────────────

export const adminOutletSchema = outletSchema.extend({ isActive: z.boolean() });
export type AdminOutlet = z.infer<typeof adminOutletSchema>;

export function useAdminOutlets() {
  return useQuery({
    queryKey: ['admin', 'outlets'],
    queryFn: async () =>
      z.object({ outlets: z.array(adminOutletSchema) }).parse(await apiFetch('/admin/outlets'))
        .outlets,
  });
}

export interface OutletInput {
  name: string;
  description: string;
  location: string;
}

export function useCreateOutlet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: OutletInput) =>
      apiFetch('/admin/outlets', { method: 'POST', body: JSON.stringify(input) }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
      void queryClient.invalidateQueries({ queryKey: ['outlets'] });
    },
  });
}

export function useUpdateOutlet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      outletId,
      ...changes
    }: Partial<OutletInput> & {
      outletId: string;
      isActive?: boolean;
      status?: 'OPEN' | 'PAUSED' | 'CLOSED';
    }) =>
      apiFetch(`/admin/outlets/${outletId}`, { method: 'PATCH', body: JSON.stringify(changes) }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
      void queryClient.invalidateQueries({ queryKey: ['outlets'] });
    },
  });
}

const staffSchema = z.object({
  staff: z.array(
    z.object({
      id: z.string(),
      role: z.enum(['MANAGER', 'POS']),
      user: z.object({ id: z.string(), email: z.string(), displayName: z.string() }),
      createdAt: z.string(),
    }),
  ),
});
export type OutletStaff = z.infer<typeof staffSchema>['staff'][number];

export function useOutletStaff(outletId: string | null) {
  return useQuery({
    queryKey: ['admin', 'outlets', outletId, 'staff'],
    queryFn: async () =>
      staffSchema.parse(await apiFetch(`/admin/outlets/${outletId}/staff`)).staff,
    enabled: Boolean(outletId),
  });
}

export function useAssignStaff(outletId: string) {
  return useAdminMutation((input: { email: string; role: 'MANAGER' | 'POS' }) =>
    apiFetch(`/admin/outlets/${outletId}/staff`, { method: 'POST', body: JSON.stringify(input) }),
  );
}

export function useUnassignStaff(outletId: string) {
  return useAdminMutation((assignmentId: string) =>
    apiFetch(`/admin/outlets/${outletId}/staff/${assignmentId}`, { method: 'DELETE' }),
  );
}

// ─── Audit log ───────────────────────────────────────────────────────────────

export const auditEntrySchema = z.object({
  id: z.string(),
  actorType: z.enum(['USER', 'SYSTEM', 'CLI']),
  actor: z.object({ id: z.string(), email: z.string(), displayName: z.string() }).nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  metadata: z.unknown(),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export function useAuditLog(action: string) {
  return useInfiniteQuery({
    queryKey: ['admin', 'audit', action],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (action) params.set('action', action);
      if (pageParam) params.set('cursor', pageParam);
      return z
        .object({ entries: z.array(auditEntrySchema), nextCursor: z.string().nullable() })
        .parse(await apiFetch(`/admin/audit-logs?${params}`));
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useAuditActions() {
  return useQuery({
    queryKey: ['admin', 'audit', 'actions'],
    queryFn: async () =>
      z.object({ actions: z.array(z.string()) }).parse(await apiFetch('/admin/audit-logs/actions'))
        .actions,
  });
}

export const noShowSettlementSchema = z.object({
  orderId: z.string(),
  pickupCode: z.string(),
  outlet: z.string(),
  orderStatus: z.string(),
  status: z.enum(['PROCESSED', 'FAILED']),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  pickupDeadline: z.string(),
  processedAt: z.string().nullable(),
  refundPaise: z.number().int(),
  convenienceFeePaise: z.number().int(),
  restockedUnits: z.number().int(),
  updatedAt: z.string(),
});
export type NoShowSettlement = z.infer<typeof noShowSettlementSchema>;

export function useNoShowSettlements(status: 'FAILED' | 'PROCESSED') {
  return useQuery({
    queryKey: ['admin', 'no-shows', status],
    queryFn: async () =>
      z
        .object({ settlements: z.array(noShowSettlementSchema) })
        .parse(await apiFetch(`/admin/no-shows?status=${status}`)).settlements,
  });
}

/** Re-runs the server's no-show policy for one order. No amounts are sent: the server computes them. */
export function useRetryNoShow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (orderId: string) =>
      z
        .object({ processed: z.boolean() })
        .parse(await apiFetch(`/admin/no-shows/${orderId}/retry`, { method: 'POST' })),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}
