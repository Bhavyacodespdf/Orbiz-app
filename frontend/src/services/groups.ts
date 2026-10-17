import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';
import { walletKey } from './wallet';

/*
 * Group trays. Every amount comes from the server; the browser sends quantities, the split
 * inputs the host chose, and actions. Payment goes from each member's own wallet to CampusCart.
 */

export const allocationModeSchema = z.enum(['BY_DISH', 'EQUAL', 'PERCENTAGE', 'CUSTOM']);
export type AllocationMode = z.infer<typeof allocationModeSchema>;
export const groupStatusSchema = z.enum(['ACTIVE', 'CHECKOUT', 'ORDERED', 'CANCELLED']);
export type GroupStatus = z.infer<typeof groupStatusSchema>;
const shareStatusSchema = z.enum(['NOTHING_DUE', 'UNPAID', 'PAID', 'REFUNDED']);
export type ShareStatus = z.infer<typeof shareStatusSchema>;

const memberItemSchema = z.object({
  id: z.string(),
  memberId: z.string(),
  menuItemId: z.string(),
  name: z.string(),
  unitPricePaise: z.number().int(),
  quantity: z.number().int(),
  lineTotalPaise: z.number().int(),
  problem: z.enum(['NOT_ON_MENU', 'SOLD_OUT', 'NOT_ENOUGH_STOCK']).nullable(),
});

const splitResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    amounts: z.array(z.object({ id: z.string(), amountPaise: z.number().int() })),
  }),
  z.object({
    ok: z.literal(false),
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()),
  }),
]);

export const groupSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string(),
  status: groupStatusSchema,
  outlet: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    status: z.string(),
    isActive: z.boolean(),
  }),
  host: z.object({ id: z.string(), displayName: z.string() }),
  maxMembers: z.number().int(),
  joinClosesAt: z.string().nullable(),
  allocationMode: allocationModeSchema,
  version: z.number().int(),
  createdAt: z.string(),
  checkoutAt: z.string().nullable(),
  orderedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  order: z
    .object({
      id: z.string(),
      status: z.string(),
      pickupCode: z.string(),
      paymentStatus: z.string(),
    })
    .nullable(),
  me: z.object({ memberId: z.string(), role: z.enum(['HOST', 'MEMBER']) }),
  members: z.array(
    z.object({
      id: z.string(),
      userId: z.string(),
      displayName: z.string(),
      avatarUrl: z.string().nullable(),
      role: z.enum(['HOST', 'MEMBER']),
      joinedAt: z.string(),
      percentBps: z.number().int().nullable(),
      customAmountPaise: z.number().int().nullable(),
      items: z.array(memberItemSchema),
      itemsTotalPaise: z.number().int(),
    }),
  ),
  tray: z.object({
    subtotalPaise: z.number().int(),
    totalPaise: z.number().int(),
    itemCount: z.number().int(),
    problems: z.array(
      z.object({ menuItemId: z.string(), name: z.string(), problem: z.string().nullable() }),
    ),
  }),
  allocationPreview: splitResultSchema.nullable(),
  settlement: z
    .object({
      id: z.string(),
      version: z.number().int(),
      status: z.enum(['OPEN', 'ORDERED', 'VOID']),
      mode: allocationModeSchema,
      subtotalPaise: z.number().int(),
      totalPaise: z.number().int(),
      createdAt: z.string(),
      lines: z.array(
        z.object({
          memberId: z.string(),
          menuItemId: z.string(),
          name: z.string(),
          unitPricePaise: z.number().int(),
          quantity: z.number().int(),
          lineTotalPaise: z.number().int(),
        }),
      ),
      shares: z.array(
        z.object({
          id: z.string(),
          memberId: z.string(),
          userId: z.string(),
          displayName: z.string(),
          amountDuePaise: z.number().int(),
          ownItemsPaise: z.number().int(),
          amountPaidPaise: z.number().int(),
          outstandingPaise: z.number().int(),
          status: shareStatusSchema,
          method: z.literal('WALLET').nullable(),
          transactionId: z.string().nullable(),
          paidAt: z.string().nullable(),
          refundedAt: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  events: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      actor: z.string().nullable(),
      details: z.unknown(),
      at: z.string(),
    }),
  ),
});
export type Group = z.infer<typeof groupSchema>;
export type GroupMember = Group['members'][number];

const groupSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  outlet: z.string(),
  status: groupStatusSchema,
  role: z.enum(['HOST', 'MEMBER']),
  memberCount: z.number().int(),
  myShare: z.object({ amountDuePaise: z.number().int(), status: shareStatusSchema }).nullable(),
  createdAt: z.string(),
});
export type GroupSummary = z.infer<typeof groupSummarySchema>;

export const groupsKey = ['groups'] as const;
const groupResponse = z.object({ group: groupSchema });

export function useGroups() {
  return useQuery({
    queryKey: [...groupsKey, 'list'],
    queryFn: async () =>
      z.object({ groups: z.array(groupSummarySchema) }).parse(await apiFetch('/groups')).groups,
  });
}

export function useGroup(groupId: string) {
  return useQuery({
    queryKey: [...groupsKey, groupId],
    queryFn: async () => groupResponse.parse(await apiFetch(`/groups/${groupId}`)).group,
    // Live updates arrive over the socket; this is only a fallback.
    refetchInterval: 30_000,
  });
}

function useGroupMutation<T>(
  request: (input: T) => Promise<unknown>,
  options: { wallet?: boolean } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: T) => {
      const body = await request(input);
      return body === undefined
        ? null
        : groupResponse
            .extend({
              orderError: z.object({ code: z.string(), message: z.string() }).nullable().optional(),
            })
            .parse(body);
    },
    onSuccess: (data) => {
      if (data) queryClient.setQueryData([...groupsKey, data.group.id], data.group);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: groupsKey });
      if (options.wallet) void queryClient.invalidateQueries({ queryKey: walletKey });
    },
  });
}

export interface NewGroup {
  name: string;
  description?: string;
  outletId: string;
  maxMembers: number;
  joinClosesAt?: string | null;
  allocationMode: AllocationMode;
}

export const useCreateGroup = () =>
  useGroupMutation((input: NewGroup) =>
    apiFetch('/groups', { method: 'POST', body: JSON.stringify(input) }),
  );

export const useJoinGroup = () =>
  useGroupMutation((code: string) =>
    apiFetch('/groups/join', { method: 'POST', body: JSON.stringify({ code }) }),
  );

export const useSetMyItem = (groupId: string) =>
  useGroupMutation(({ menuItemId, quantity }: { menuItemId: string; quantity: number }) =>
    apiFetch(`/groups/${groupId}/items/${menuItemId}`, {
      method: 'PUT',
      body: JSON.stringify({ quantity }),
    }),
  );

export const useSetAllocation = (groupId: string) =>
  useGroupMutation(
    (body: {
      mode: AllocationMode;
      percents?: Record<string, number>;
      amounts?: Record<string, number>;
    }) => apiFetch(`/groups/${groupId}/allocation`, { method: 'PUT', body: JSON.stringify(body) }),
  );

export const useUpdateGroup = (groupId: string) =>
  useGroupMutation(
    (body: Partial<Pick<NewGroup, 'name' | 'description' | 'maxMembers' | 'joinClosesAt'>>) =>
      apiFetch(`/groups/${groupId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  );

export const useRemoveMember = (groupId: string) =>
  useGroupMutation((memberId: string) =>
    apiFetch(`/groups/${groupId}/members/${memberId}`, { method: 'DELETE' }),
  );

export const useStartCheckout = (groupId: string) =>
  useGroupMutation((expectedTotalPaise: number) =>
    apiFetch(`/groups/${groupId}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ expectedTotalPaise }),
    }),
  );

export const usePayMyShare = (groupId: string) =>
  useGroupMutation(
    (idempotencyKey: string) =>
      apiFetch(`/groups/${groupId}/shares/mine/pay`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    { wallet: true },
  );

export const usePlaceGroupOrder = (groupId: string) =>
  useGroupMutation(() => apiFetch(`/groups/${groupId}/order`, { method: 'POST' }));

export const useReopenGroup = (groupId: string) =>
  useGroupMutation(() => apiFetch(`/groups/${groupId}/reopen`, { method: 'POST' }), {
    wallet: true,
  });

export const useCancelGroup = (groupId: string) =>
  useGroupMutation(
    (reason: string) =>
      apiFetch(`/groups/${groupId}/cancel`, {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {}),
      }),
    {
      wallet: true,
    },
  );

/** Codes are shown in two halves for reading aloud. */
export const formatCode = (code: string) => `${code.slice(0, 5)}-${code.slice(5)}`;
