import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import type { DailyPollOutcome, DailyPollStatus } from '../../generated/prisma/enums.js';
import { isUniqueViolation, type Database, type DbClient } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { recordAudit, type AuditActor } from '../../lib/audit.js';
import { istDay } from '../orders/pickup.js';
import { inStock, inStockWhere, type StockFields } from '../inventory/stock.js';
import { noopPublisher, type RealtimePublisher } from '../../realtime/publisher.js';
import { POLL_LIMITS, type CreatePollInput, type UpdatePollInput } from './polls.schema.js';

/*
 * Today's Special voting.
 *
 * Lifecycle: DRAFT → OPEN → CLOSED → FINALIZED.
 *  - Only OPEN polls whose window contains the DATABASE clock accept votes.
 *  - An OPEN poll whose closing time has passed is closed lazily by the next read or
 *    action that touches it (a conditional UPDATE), so no background job is needed.
 *  - Closed polls are finalized automatically when the result is unambiguous (one
 *    leader, or nobody voted). A tie waits for the outlet manager to choose among the
 *    tied dishes only. Nothing is ever decided by row order.
 *
 * Race safety: a vote locks the poll row FOR SHARE and re-checks status and window;
 * closing needs a row lock, so it waits for votes already in flight and every later
 * vote sees CLOSED. Finalization locks the row FOR UPDATE and returns the stored
 * result when it has already run, so retries can never change the winner.
 */

export const pollInclude = {
  options: {
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { menuItem: { include: { category: true } } },
  },
} satisfies Prisma.DailyPollInclude;

export type PollWithOptions = Prisma.DailyPollGetPayload<{ include: typeof pollInclude }>;

const badPoll = (message: string, details?: unknown) =>
  new AppError(400, 'INVALID_POLL', message, details);
const wrongState = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

// ─── Time ───────────────────────────────────────────────────────────────────

/**
 * The database clock. Voting windows are always judged by this, never the client.
 * clock_timestamp() (not the transaction-start now()) so that, read right after a row
 * lock, it is later than every change that had to finish before the lock was granted.
 *
 * Timestamp columns hold UTC wall time without a zone (Prisma's convention) while the
 * database session may run in another zone, so raw SQL always converts with
 * AT TIME ZONE 'UTC' before reading, comparing or writing those columns.
 */
export async function dbNow(db: DbClient): Promise<Date> {
  const rows = await db.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
  return rows[0]!.now;
}

/** Midnight at the start of an IST calendar date. */
export const istDayStart = (day: string) => new Date(`${day}T00:00:00+05:30`);

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A @db.Date column comes back as UTC midnight of that date. */
export const dateColumn = (day: string) => new Date(`${day}T00:00:00Z`);
export const dayOf = (value: Date) => value.toISOString().slice(0, 10);

/**
 * Window rules: the special's date is today or up to 14 days ahead; voting may open
 * from the day before and must close by the end of that date (IST); at least 5 minutes.
 */
function validateWindow(day: string, opensAt: Date, closesAt: Date, now: Date) {
  const today = istDay(now);
  if (day < today) throw badPoll('That date has already passed.');
  if (day > addDays(today, POLL_LIMITS.daysAhead)) {
    throw badPoll(`Polls can be scheduled up to ${POLL_LIMITS.daysAhead} days ahead.`);
  }
  const start = istDayStart(day);
  const end = istDayStart(addDays(day, 1));
  if (opensAt.getTime() < start.getTime() - 24 * 60 * 60 * 1000) {
    throw badPoll('Voting can open at most one day before the special’s date.');
  }
  if (closesAt.getTime() > end.getTime()) {
    throw badPoll('Voting must close by the end of the special’s date (IST).');
  }
  if (closesAt.getTime() - opensAt.getTime() < POLL_LIMITS.minWindowMinutes * 60 * 1000) {
    throw badPoll(`Voting must stay open for at least ${POLL_LIMITS.minWindowMinutes} minutes.`);
  }
  if (closesAt.getTime() <= now.getTime()) throw badPoll('The closing time has already passed.');
}

/** A dish students can vote for right now: active, in stock, in an active category. */
export const votableItem = { isActive: true, category: { isActive: true }, ...inStockWhere };

export function isVotable(
  item: StockFields & { isActive: boolean; category: { isActive: boolean } },
) {
  return item.isActive && inStock(item) && item.category.isActive;
}

async function validateMenuItems(db: DbClient, outletId: string, ids: string[]) {
  const found = await db.menuItem.findMany({
    where: { id: { in: ids }, outletId, ...votableItem },
    select: { id: true },
  });
  const ok = new Set(found.map((i) => i.id));
  const invalid = ids.filter((id) => !ok.has(id));
  if (invalid.length > 0) {
    throw new AppError(
      400,
      'OPTION_NOT_ELIGIBLE',
      'Every dish must be an active, available item from this outlet.',
      { invalidMenuItemIds: invalid },
    );
  }
}

// ─── Row locks ──────────────────────────────────────────────────────────────

interface LockedRow {
  id: string;
  outletId: string;
  status: DailyPollStatus;
  opensAt: Date;
  closesAt: Date;
  winnerOptionId: string | null;
  outletActive: boolean;
}

type LockedPoll = LockedRow & { now: Date };

/** Locks the poll row so status changes wait for (and are seen by) this transaction. */
async function lockPollForUpdate(tx: DbClient, pollId: string, outletId?: string) {
  const rows = await tx.$queryRaw<LockedRow[]>`
    SELECT p."id", p."outletId", p."status", p."opensAt", p."closesAt", p."winnerOptionId",
           o."isActive" AS "outletActive"
    FROM "DailyPoll" p JOIN "Outlet" o ON o."id" = p."outletId"
    WHERE p."id" = ${pollId}::uuid
    FOR UPDATE OF p`;
  const row = rows[0];
  if (!row || (outletId && row.outletId !== outletId)) throw notFound('Poll not found');
  return { ...row, now: await dbNow(tx) } satisfies LockedPoll;
}

/** Shared lock: many votes can proceed together, but none can overlap a status change. */
async function lockPollForShare(tx: DbClient, pollId: string) {
  const rows = await tx.$queryRaw<LockedRow[]>`
    SELECT p."id", p."outletId", p."status", p."opensAt", p."closesAt", p."winnerOptionId",
           o."isActive" AS "outletActive"
    FROM "DailyPoll" p JOIN "Outlet" o ON o."id" = p."outletId"
    WHERE p."id" = ${pollId}::uuid
    FOR SHARE OF p`;
  return rows[0] ? ({ ...rows[0], now: await dbNow(tx) } satisfies LockedPoll) : null;
}

// ─── Results ────────────────────────────────────────────────────────────────

export type Decision =
  | { kind: 'NO_VOTES'; total: 0 }
  | { kind: 'WINNER'; optionId: string; votes: number; total: number }
  | { kind: 'TIE'; optionIds: string[]; votes: number; total: number };

/** Pure: the result implied by vote counts of the options that may win. */
export function decide(counted: { optionId: string; votes: number }[]): Decision {
  const total = counted.reduce((sum, o) => sum + o.votes, 0);
  if (total === 0) return { kind: 'NO_VOTES', total: 0 };
  const top = Math.max(...counted.map((o) => o.votes));
  const leaders = counted
    .filter((o) => o.votes === top)
    .map((o) => o.optionId)
    .sort();
  return leaders.length === 1
    ? { kind: 'WINNER', optionId: leaders[0]!, votes: top, total }
    : { kind: 'TIE', optionIds: leaders, votes: top, total };
}

/** Votes per option, straight from the persisted vote rows. */
export async function voteCounts(db: DbClient, pollId: string): Promise<Map<string, number>> {
  const groups = await db.dailyPollVote.groupBy({
    by: ['optionId'],
    where: { pollId },
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.optionId, g._count._all]));
}

/**
 * Options that can win: their dish is still on the menu (not deactivated). A dish
 * that is only sold out can still win. Votes for withdrawn dishes are not counted.
 */
async function countedTally(db: DbClient, pollId: string) {
  const options = await db.dailyPollOption.findMany({
    where: { pollId, menuItem: { isActive: true } },
    select: { id: true, _count: { select: { votes: true } } },
  });
  return options.map((o) => ({ optionId: o.id, votes: o._count.votes }));
}

export async function currentDecision(db: DbClient, pollId: string) {
  return decide(await countedTally(db, pollId));
}

// ─── Manager actions ────────────────────────────────────────────────────────

const auditPoll = (
  tx: DbClient,
  actor: AuditActor,
  action: string,
  pollId: string,
  metadata: Prisma.InputJsonValue,
) => recordAudit(tx, { actor, action, entityType: 'DailyPoll', entityId: pollId, metadata });

const pollExists = () => wrongState('POLL_EXISTS', 'This outlet already has a poll for that date.');

export async function createPoll(
  db: Database,
  outletId: string,
  input: CreatePollInput,
  actor: AuditActor & { userId: string },
) {
  try {
    return await db.$transaction(async (tx) => {
      validateWindow(input.day, input.opensAt, input.closesAt, await dbNow(tx));
      await validateMenuItems(tx, outletId, input.menuItemIds);
      const poll = await tx.dailyPoll.create({
        data: {
          outletId,
          day: dateColumn(input.day),
          opensAt: input.opensAt,
          closesAt: input.closesAt,
          showLiveResults: input.showLiveResults,
          createdById: actor.userId,
        },
      });
      await tx.dailyPollOption.createMany({
        data: input.menuItemIds.map((menuItemId, sortOrder) => ({
          pollId: poll.id,
          outletId,
          menuItemId,
          sortOrder,
        })),
      });
      await auditPoll(tx, actor, 'POLL_CREATED', poll.id, {
        outletId,
        day: input.day,
        menuItemIds: input.menuItemIds,
      });
      return poll.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw pollExists();
    throw error;
  }
}

export async function updateDraft(
  db: Database,
  outletId: string,
  pollId: string,
  patch: UpdatePollInput,
  actor: AuditActor,
) {
  try {
    await db.$transaction(async (tx) => {
      const locked = await lockPollForUpdate(tx, pollId, outletId);
      if (locked.status !== 'DRAFT') {
        throw wrongState('POLL_NOT_EDITABLE', 'Only a draft poll can be edited.');
      }
      const current = await tx.dailyPoll.findUniqueOrThrow({ where: { id: pollId } });
      const day = patch.day ?? dayOf(current.day);
      const opensAt = patch.opensAt ?? current.opensAt;
      const closesAt = patch.closesAt ?? current.closesAt;
      validateWindow(day, opensAt, closesAt, locked.now);
      if (patch.menuItemIds) {
        await validateMenuItems(tx, outletId, patch.menuItemIds);
        await tx.dailyPollOption.deleteMany({ where: { pollId } });
        await tx.dailyPollOption.createMany({
          data: patch.menuItemIds.map((menuItemId, sortOrder) => ({
            pollId,
            outletId,
            menuItemId,
            sortOrder,
          })),
        });
      }
      await tx.dailyPoll.update({
        where: { id: pollId },
        data: {
          day: dateColumn(day),
          opensAt,
          closesAt,
          ...(patch.showLiveResults !== undefined && { showLiveResults: patch.showLiveResults }),
          version: { increment: 1 },
        },
      });
      await auditPoll(tx, actor, 'POLL_UPDATED', pollId, {
        outletId,
        changed: Object.keys(patch),
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw pollExists();
    throw error;
  }
}

export async function deleteDraft(
  db: Database,
  outletId: string,
  pollId: string,
  actor: AuditActor,
) {
  await db.$transaction(async (tx) => {
    const locked = await lockPollForUpdate(tx, pollId, outletId);
    if (locked.status !== 'DRAFT') {
      throw wrongState('POLL_NOT_EDITABLE', 'Only a draft poll can be deleted.');
    }
    await tx.dailyPollOption.deleteMany({ where: { pollId } });
    await tx.dailyPoll.delete({ where: { id: pollId } });
    await auditPoll(tx, actor, 'POLL_DELETED', pollId, { outletId });
  });
}

export async function openPoll(db: Database, outletId: string, pollId: string, actor: AuditActor) {
  await db.$transaction(async (tx) => {
    const locked = await lockPollForUpdate(tx, pollId, outletId);
    if (locked.status !== 'DRAFT') {
      throw wrongState('INVALID_POLL_STATE', 'Only a draft poll can be opened.');
    }
    if (locked.closesAt.getTime() <= locked.now.getTime()) {
      throw badPoll('The closing time has already passed. Edit the draft first.');
    }
    const votable = await tx.dailyPollOption.count({
      where: { pollId, menuItem: votableItem },
    });
    if (votable < POLL_LIMITS.minOptions) {
      throw badPoll(
        `At least ${POLL_LIMITS.minOptions} of the dishes must be available before opening.`,
      );
    }
    await tx.dailyPoll.update({
      where: { id: pollId },
      data: { status: 'OPEN', openedAt: locked.now, version: { increment: 1 } },
    });
    await auditPoll(tx, actor, 'POLL_OPENED', pollId, { outletId });
  });
}

/** Ends voting now. Closing an already-closed poll changes nothing. */
export async function closePoll(
  db: Database,
  outletId: string,
  pollId: string,
  actor: AuditActor,
  realtime: RealtimePublisher = noopPublisher,
) {
  await db.$transaction(async (tx) => {
    const locked = await lockPollForUpdate(tx, pollId, outletId);
    if (locked.status === 'DRAFT') {
      throw wrongState('INVALID_POLL_STATE', 'A draft poll has not been opened yet.');
    }
    if (locked.status !== 'OPEN') return;
    const closedAt =
      locked.closesAt.getTime() <= locked.now.getTime() ? locked.closesAt : locked.now;
    await tx.dailyPoll.update({
      where: { id: pollId },
      data: { status: 'CLOSED', closedAt, version: { increment: 1 } },
    });
    await auditPoll(tx, actor, 'POLL_CLOSED', pollId, {
      outletId,
      closedAt: closedAt.toISOString(),
    });
  });
  await settlePolls(db, [pollId], realtime);
}

export type FinalizeResult =
  | { kind: 'FINALIZED' | 'ALREADY_FINALIZED' }
  | { kind: 'NEEDS_TIE_DECISION'; tiedOptionIds: string[] };

/**
 * Determines and stores the winner from persisted votes. Safe to retry: once a poll
 * is FINALIZED the stored result is returned unchanged. `automatic` is the system
 * settling an unambiguous result; a tie then waits for a manager.
 */
export async function finalizePoll(
  db: Database,
  pollId: string,
  options: {
    actor: AuditActor;
    outletId?: string;
    tieBreakOptionId?: string;
    automatic?: boolean;
  },
): Promise<FinalizeResult> {
  const outcome = await db.$transaction(async (tx) => {
    const locked = await lockPollForUpdate(tx, pollId, options.outletId);

    if (locked.status === 'FINALIZED') {
      if (options.tieBreakOptionId && options.tieBreakOptionId !== locked.winnerOptionId) {
        throw wrongState('POLL_ALREADY_FINALIZED', 'This poll already has a result.');
      }
      return { kind: 'ALREADY_FINALIZED' } as const;
    }
    if (locked.status === 'DRAFT') {
      throw wrongState('POLL_NOT_CLOSED', 'Open and close the poll before finalizing it.');
    }
    if (locked.status === 'OPEN') {
      if (locked.closesAt.getTime() > locked.now.getTime()) {
        throw wrongState('POLL_NOT_CLOSED', 'Voting is still open. Close the poll first.');
      }
      await tx.dailyPoll.update({
        where: { id: pollId },
        data: { status: 'CLOSED', closedAt: locked.closesAt, version: { increment: 1 } },
      });
    }

    const decision = await currentDecision(tx, pollId);
    let winnerOptionId: string | null = null;
    let result: DailyPollOutcome;
    if (decision.kind === 'NO_VOTES') {
      result = 'NO_VOTES';
    } else if (decision.kind === 'WINNER') {
      if (options.tieBreakOptionId && options.tieBreakOptionId !== decision.optionId) {
        throw wrongState('NOT_A_TIE', 'There is no tie: one dish has the most votes.');
      }
      result = 'WINNER';
      winnerOptionId = decision.optionId;
    } else {
      if (!options.tieBreakOptionId) {
        // Commit the close (if any) and report the tie; never pick a winner silently.
        return { kind: 'NEEDS_TIE_DECISION', tiedOptionIds: decision.optionIds } as const;
      }
      if (!decision.optionIds.includes(options.tieBreakOptionId)) {
        throw badPoll('Choose one of the tied dishes.', { tiedOptionIds: decision.optionIds });
      }
      result = 'TIE_RESOLVED_BY_MANAGER';
      winnerOptionId = options.tieBreakOptionId;
    }

    await tx.dailyPoll.update({
      where: { id: pollId },
      data: {
        status: 'FINALIZED',
        outcome: result,
        winnerOptionId,
        totalVotes: decision.total,
        winnerVotes: decision.kind === 'NO_VOTES' ? null : decision.votes,
        finalizedAt: locked.now,
        version: { increment: 1 },
      },
    });
    await auditPoll(tx, options.actor, 'POLL_FINALIZED', pollId, {
      outletId: locked.outletId,
      outcome: result,
      winnerOptionId,
      totalVotes: decision.total,
      ...(decision.kind === 'TIE' && { tiedOptionIds: decision.optionIds }),
    });
    return { kind: 'FINALIZED' } as const;
  });

  if (outcome.kind === 'NEEDS_TIE_DECISION' && !options.automatic) {
    throw wrongState(
      'TIE_NEEDS_DECISION',
      'Two or more dishes tied for the most votes. Choose one of them.',
      { tiedOptionIds: outcome.tiedOptionIds },
    );
  }
  return outcome;
}

/**
 * Brings polls up to date with the clock: closes OPEN polls whose time is up, then
 * finalizes any closed poll whose result is unambiguous. Idempotent. Every status it
 * changes is announced after the change has committed.
 */
export async function settlePolls(
  db: Database,
  pollIds: string[],
  realtime: RealtimePublisher = noopPublisher,
) {
  if (pollIds.length === 0) return;
  const before = new Map(
    (
      await db.dailyPoll.findMany({
        where: { id: { in: pollIds } },
        select: { id: true, status: true },
      })
    ).map((p) => [p.id, p.status]),
  );
  await db.$executeRaw`
    UPDATE "DailyPoll"
    SET "status" = 'CLOSED', "closedAt" = "closesAt", "version" = "version" + 1, "updatedAt" = (now() AT TIME ZONE 'UTC')
    WHERE "id" = ANY(${pollIds}::uuid[]) AND "status" = 'OPEN'
      AND "closesAt" <= (now() AT TIME ZONE 'UTC')`;
  const closed = await db.dailyPoll.findMany({
    where: { id: { in: pollIds }, status: 'CLOSED' },
    select: { id: true },
  });
  for (const { id } of closed) {
    await finalizePoll(db, id, { actor: { type: 'SYSTEM' }, automatic: true });
  }
  const after = await db.dailyPoll.findMany({
    where: { id: { in: pollIds } },
    select: { id: true, outletId: true, status: true, version: true },
  });
  for (const poll of after) {
    if (before.get(poll.id) !== poll.status) realtime.pollUpdated(poll, 'status');
  }
}

/** Settles every poll matching `where` that may be due. */
export async function settleDue(
  db: Database,
  where: Prisma.DailyPollWhereInput,
  realtime: RealtimePublisher = noopPublisher,
) {
  const now = await dbNow(db);
  const due = await db.dailyPoll.findMany({
    where: {
      ...where,
      OR: [{ status: 'OPEN', closesAt: { lte: now } }, { status: 'CLOSED' }],
    },
    select: { id: true },
  });
  await settlePolls(
    db,
    due.map((p) => p.id),
    realtime,
  );
}

// ─── Student actions ────────────────────────────────────────────────────────

/**
 * Casts or changes the student's vote. One row per student per poll (unique key), so
 * repeated or concurrent submissions collapse into one vote and the latest choice wins.
 */
export async function castVote(
  db: Database,
  input: { pollId: string; optionId: string; userId: string },
) {
  await db.$transaction(async (tx) => {
    const poll = await lockPollForShare(tx, input.pollId);
    if (!poll || poll.status === 'DRAFT' || !poll.outletActive) throw notFound('Poll not found');
    if (poll.status !== 'OPEN' || poll.now.getTime() >= poll.closesAt.getTime()) {
      throw wrongState('POLL_CLOSED', 'Voting has closed for this poll.');
    }
    if (poll.now.getTime() < poll.opensAt.getTime()) {
      throw wrongState('POLL_NOT_OPEN', 'Voting has not opened yet.');
    }
    const option = await tx.dailyPollOption.findFirst({
      where: { id: input.optionId, pollId: input.pollId },
      include: { menuItem: { include: { category: true } } },
    });
    if (!option) throw notFound('That dish is not part of this poll.');
    if (!isVotable(option.menuItem)) {
      throw wrongState('OPTION_NOT_ELIGIBLE', 'That dish is not available to vote for right now.');
    }
    await tx.$executeRaw`
      INSERT INTO "DailyPollVote" ("id", "pollId", "optionId", "userId", "createdAt", "updatedAt")
      VALUES (${randomUUID()}::uuid, ${input.pollId}::uuid, ${input.optionId}::uuid,
              ${input.userId}::uuid, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
      ON CONFLICT ("pollId", "userId")
      DO UPDATE SET "optionId" = EXCLUDED."optionId", "updatedAt" = now() AT TIME ZONE 'UTC'`;
  });
}

/**
 * The poll a student should see for an outlet: an open poll that is accepting votes
 * or opens within the next day (soonest first), otherwise today's (IST) poll in any
 * non-draft state, otherwise none.
 */
export async function currentPollId(db: Database, outletId: string): Promise<string | null> {
  const now = await dbNow(db);
  const soon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const open = await db.dailyPoll.findFirst({
    where: { outletId, status: 'OPEN', closesAt: { gt: now }, opensAt: { lte: soon } },
    orderBy: [{ opensAt: 'asc' }, { day: 'asc' }],
    select: { id: true },
  });
  if (open) return open.id;
  const today = await db.dailyPoll.findFirst({
    where: { outletId, day: dateColumn(istDay(now)), status: { not: 'DRAFT' } },
    select: { id: true },
  });
  return today?.id ?? null;
}
