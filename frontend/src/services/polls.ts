import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './http';
import { dietarySchema, outletSchema, stockStatusSchema } from './outlets';

/*
 * Today's Special voting. Every count, percentage and winner comes from the server,
 * which derives them from persisted votes; the browser never computes or sends them.
 */

export const dishSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  imageUrl: z.string().nullable(),
  pricePaise: z.number().int(),
  dietary: dietarySchema.nullable(),
  isAvailable: z.boolean(),
  stockStatus: stockStatusSchema,
  orderable: z.boolean(),
  category: z.object({ id: z.string(), name: z.string() }),
});
export type Dish = z.infer<typeof dishSchema>;

export const pollOutcomeSchema = z.enum(['WINNER', 'TIE_RESOLVED_BY_MANAGER', 'NO_VOTES']);
export type PollOutcome = z.infer<typeof pollOutcomeSchema>;

export const pollResultSchema = z.object({
  outcome: pollOutcomeSchema,
  winnerOptionId: z.string().nullable(),
  totalVotes: z.number().int(),
  winnerVotes: z.number().int().nullable(),
  winnerPercentage: z.number().nullable(),
  finalizedAt: z.string().nullable(),
});
export type PollResult = z.infer<typeof pollResultSchema>;

const studentOptionSchema = z.object({
  id: z.string(),
  dish: dishSchema,
  votable: z.boolean(),
  /** Null while results are hidden. */
  votes: z.number().int().nullable(),
  percentage: z.number().nullable(),
});
export type StudentPollOption = z.infer<typeof studentOptionSchema>;

export const studentPollSchema = z.object({
  id: z.string(),
  outletId: z.string(),
  day: z.string(),
  phase: z.enum(['UPCOMING', 'VOTING', 'CLOSED', 'FINALIZED']),
  opensAt: z.string(),
  closesAt: z.string(),
  serverNow: z.string(),
  resultsVisible: z.boolean(),
  votesCast: z.number().int().nullable(),
  myOptionId: z.string().nullable(),
  options: z.array(studentOptionSchema),
  result: pollResultSchema.nullable(),
  version: z.number().int(),
});
export type StudentPoll = z.infer<typeof studentPollSchema>;

export const specialSchema = z.object({
  pollId: z.string(),
  day: z.string(),
  outlet: outletSchema,
  dish: dishSchema,
  outcome: pollOutcomeSchema,
  totalVotes: z.number().int(),
  winnerVotes: z.number().int(),
  winnerPercentage: z.number(),
});
export type Special = z.infer<typeof specialSchema>;

const pollResponse = z.object({ poll: studentPollSchema.nullable() });
const votedResponse = z.object({ poll: studentPollSchema });
const specialsResponse = z.object({ day: z.string(), specials: z.array(specialSchema) });
const outletSpecialResponse = z.object({ day: z.string(), special: specialSchema.nullable() });

export const specialsKey = ['specials'] as const;
export const outletPollKey = (slug: string) => ['polls', 'outlet', slug] as const;

/** Today's Specials across all outlets (public). */
export function useTodaysSpecials() {
  return useQuery({
    queryKey: [...specialsKey, 'today'],
    queryFn: async () => specialsResponse.parse(await apiFetch('/specials')),
    staleTime: 60_000,
  });
}

/** One outlet's Today's Special (public). */
export function useOutletSpecial(slug: string) {
  return useQuery({
    queryKey: [...specialsKey, 'outlet', slug],
    queryFn: async () =>
      outletSpecialResponse.parse(await apiFetch(`/outlets/${encodeURIComponent(slug)}/special`)),
    staleTime: 60_000,
  });
}

/** The poll a signed-in student can see at an outlet, or null. Refreshes while voting. */
export function useOutletPoll(slug: string, enabled: boolean) {
  return useQuery({
    queryKey: outletPollKey(slug),
    queryFn: async () =>
      pollResponse.parse(await apiFetch(`/outlets/${encodeURIComponent(slug)}/poll`)).poll,
    enabled,
    refetchInterval: (query) => {
      const phase = query.state.data?.phase;
      return phase === 'VOTING' || phase === 'UPCOMING' ? 30_000 : false;
    },
  });
}

/** Casts or changes the student's vote; the server returns the updated poll. */
export function useVote(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ pollId, optionId }: { pollId: string; optionId: string }) =>
      votedResponse.parse(
        await apiFetch(`/polls/${pollId}/vote`, {
          method: 'POST',
          body: JSON.stringify({ optionId }),
        }),
      ).poll,
    onSuccess: (poll) => queryClient.setQueryData(outletPollKey(slug), poll),
    // A refused vote usually means the poll moved on (closed, dish sold out): re-read it.
    onError: () => void queryClient.invalidateQueries({ queryKey: outletPollKey(slug) }),
  });
}

// ─── Manager ─────────────────────────────────────────────────────────────────

const managerOptionSchema = z.object({
  id: z.string(),
  dish: dishSchema,
  votable: z.boolean(),
  /** False when the dish was withdrawn from the menu: its votes cannot win. */
  counted: z.boolean(),
  votes: z.number().int(),
  percentage: z.number(),
});
export type ManagerPollOption = z.infer<typeof managerOptionSchema>;

export const pollStatusSchema = z.enum(['DRAFT', 'OPEN', 'CLOSED', 'FINALIZED']);
export type PollStatus = z.infer<typeof pollStatusSchema>;

export const managerPollSchema = z.object({
  id: z.string(),
  outletId: z.string(),
  day: z.string(),
  status: pollStatusSchema,
  phase: z.enum(['DRAFT', 'UPCOMING', 'VOTING', 'CLOSED', 'FINALIZED']),
  opensAt: z.string(),
  closesAt: z.string(),
  showLiveResults: z.boolean(),
  openedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  serverNow: z.string(),
  votesCast: z.number().int(),
  options: z.array(managerOptionSchema),
  /** Set while a closed poll waits for the manager to choose among tied dishes. */
  tiedOptionIds: z.array(z.string()).nullable(),
  result: pollResultSchema.nullable(),
  version: z.number().int(),
  createdAt: z.string(),
});
export type ManagerPoll = z.infer<typeof managerPollSchema>;

const managerListResponse = z.object({
  polls: z.array(managerPollSchema),
  nextBefore: z.string().nullable(),
});
const managerPollResponse = z.object({ poll: managerPollSchema });

export interface PollInput {
  day: string;
  /** ISO instants with an explicit offset, e.g. 2026-10-17T11:00:00+05:30. */
  opensAt: string;
  closesAt: string;
  menuItemIds: string[];
  showLiveResults: boolean;
}

export type PollAction =
  { action: 'open' | 'close' } | { action: 'finalize'; tieBreakOptionId?: string };

export const managerPollsKey = (outletId: string) => ['polls', 'staff', outletId] as const;

const pollsPath = (outletId: string) => `/staff/outlets/${outletId}/polls`;

/** The outlet's polls, newest date first, with live counts. Refreshes while any is live. */
export function useManagerPolls(outletId: string) {
  return useQuery({
    queryKey: managerPollsKey(outletId),
    queryFn: async () => managerListResponse.parse(await apiFetch(pollsPath(outletId))),
    refetchInterval: (query) =>
      query.state.data?.polls.some((p) => p.status === 'OPEN' || p.status === 'CLOSED')
        ? 15_000
        : false,
  });
}

function usePollMutation<TInput, TOutput>(
  outletId: string,
  request: (input: TInput) => Promise<TOutput>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: managerPollsKey(outletId) });
      void queryClient.invalidateQueries({ queryKey: ['polls', 'outlet'] });
      void queryClient.invalidateQueries({ queryKey: specialsKey });
    },
  });
}

const parsePoll = async (request: Promise<unknown>) =>
  managerPollResponse.parse(await request).poll;

export function useCreatePoll(outletId: string) {
  return usePollMutation(outletId, (input: PollInput) =>
    parsePoll(apiFetch(pollsPath(outletId), { method: 'POST', body: JSON.stringify(input) })),
  );
}

export function useUpdatePoll(outletId: string) {
  return usePollMutation(outletId, ({ pollId, input }: { pollId: string; input: PollInput }) =>
    parsePoll(
      apiFetch(`${pollsPath(outletId)}/${pollId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    ),
  );
}

export function useDeletePoll(outletId: string) {
  return usePollMutation(outletId, (pollId: string) =>
    apiFetch(`${pollsPath(outletId)}/${pollId}`, { method: 'DELETE' }),
  );
}

/** Open, close or finalize. The server computes every result; the client only names a tied dish. */
export function usePollAction(outletId: string) {
  return usePollMutation(outletId, ({ pollId, ...rest }: PollAction & { pollId: string }) =>
    parsePoll(
      apiFetch(`${pollsPath(outletId)}/${pollId}/${rest.action}`, {
        method: 'POST',
        body: JSON.stringify(
          rest.action === 'finalize' && rest.tieBreakOptionId
            ? { tieBreakOptionId: rest.tieBreakOptionId }
            : {},
        ),
      }),
    ),
  );
}
