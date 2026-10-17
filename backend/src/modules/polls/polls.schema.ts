import { z } from 'zod';
import { uuidParam } from '../outlets/outlets.schema.js';

/** A calendar date (YYYY-MM-DD), interpreted in India Standard Time. */
export const pollDay = z.iso.date();

/** An exact instant with a timezone, e.g. 2026-10-16T11:00:00+05:30. */
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const POLL_LIMITS = {
  minOptions: 2,
  maxOptions: 10,
  minWindowMinutes: 5,
  /** How far ahead a poll may be scheduled. */
  daysAhead: 14,
} as const;

const menuItemIds = z
  .array(uuidParam)
  .min(POLL_LIMITS.minOptions, `Choose at least ${POLL_LIMITS.minOptions} dishes`)
  .max(POLL_LIMITS.maxOptions, `Choose at most ${POLL_LIMITS.maxOptions} dishes`)
  .refine((ids) => new Set(ids).size === ids.length, 'Each dish can only be added once');

export const createPollBody = z
  .object({
    day: pollDay,
    opensAt: instant,
    closesAt: instant,
    menuItemIds,
    showLiveResults: z.boolean().default(false),
  })
  .strict();

export const updatePollBody = z
  .object({
    day: pollDay,
    opensAt: instant,
    closesAt: instant,
    menuItemIds,
    showLiveResults: z.boolean(),
  })
  .partial()
  .strict();

export const voteBody = z.object({ optionId: uuidParam }).strict();

export const finalizeBody = z.object({ tieBreakOptionId: uuidParam.optional() }).strict();

export const specialsQuery = z.object({ day: pollDay.optional() });

export const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Only polls for days before this one (cursor for older pages). */
  before: pollDay.optional(),
});

export type CreatePollInput = z.infer<typeof createPollBody>;
export type UpdatePollInput = z.infer<typeof updatePollBody>;
