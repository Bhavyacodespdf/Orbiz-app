import type { MenuCategory, MenuItem, Outlet } from '../../generated/prisma/client.js';
import { toOutletSummary } from '../outlets/outlets.serializer.js';
import { inStock, stockStatus } from '../inventory/stock.js';
import { dayOf, decide, isVotable, type PollWithOptions } from './polls.service.js';

type ItemWithCategory = MenuItem & { category: MenuCategory };

/** Public dish details. Never includes anything about who voted. */
export function toDish(item: ItemWithCategory) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    imageUrl: item.imageUrl,
    pricePaise: item.pricePaise,
    dietary: item.dietary,
    isAvailable: inStock(item),
    stockStatus: stockStatus(item),
    /** Can be added to a cart right now. */
    orderable: item.isActive && inStock(item) && item.category.isActive,
    category: { id: item.category.id, name: item.category.name },
  };
}

/** One decimal place, e.g. 42 of 85 → 49.4. */
export const percentage = (part: number, total: number) =>
  total > 0 ? Math.round((part * 1000) / total) / 10 : 0;

/**
 * Where a poll is from the voter's point of view. An OPEN poll past its closing
 * time reads as CLOSED even before the lazy close has been written.
 */
export function pollPhase(poll: PollWithOptions, now: Date) {
  if (poll.status === 'OPEN') {
    if (now < poll.opensAt) return 'UPCOMING' as const;
    if (now < poll.closesAt) return 'VOTING' as const;
    return 'CLOSED' as const;
  }
  return poll.status;
}

function result(poll: PollWithOptions) {
  if (poll.status !== 'FINALIZED' || !poll.outcome) return null;
  return {
    outcome: poll.outcome,
    winnerOptionId: poll.winnerOptionId,
    totalVotes: poll.totalVotes ?? 0,
    winnerVotes: poll.winnerVotes,
    winnerPercentage:
      poll.winnerVotes === null ? null : percentage(poll.winnerVotes, poll.totalVotes ?? 0),
    finalizedAt: poll.finalizedAt,
  };
}

/**
 * The poll as a student sees it. Vote counts appear only once voting has closed,
 * unless the manager chose to show live results. Only aggregates are ever returned.
 */
export function toStudentPoll(
  poll: PollWithOptions,
  counts: Map<string, number>,
  now: Date,
  myOptionId: string | null,
) {
  const phase = pollPhase(poll, now);
  const resultsVisible = phase === 'CLOSED' || phase === 'FINALIZED' || poll.showLiveResults;
  const votesCast = [...counts.values()].reduce((a, b) => a + b, 0);
  return {
    id: poll.id,
    outletId: poll.outletId,
    day: dayOf(poll.day),
    phase,
    opensAt: poll.opensAt,
    closesAt: poll.closesAt,
    serverNow: now,
    resultsVisible,
    votesCast: resultsVisible ? votesCast : null,
    myOptionId,
    options: poll.options.map((o) => {
      const votes = counts.get(o.id) ?? 0;
      return {
        id: o.id,
        dish: toDish(o.menuItem),
        votable: isVotable(o.menuItem),
        votes: resultsVisible ? votes : null,
        percentage: resultsVisible ? percentage(votes, votesCast) : null,
      };
    }),
    result: result(poll),
    version: poll.version,
  };
}

/** The manager's view: live counts always, plus the tie to resolve when there is one. */
export function toManagerPoll(poll: PollWithOptions, counts: Map<string, number>, now: Date) {
  const phase = pollPhase(poll, now);
  const votesCast = [...counts.values()].reduce((a, b) => a + b, 0);
  const counted = poll.options
    .filter((o) => o.menuItem.isActive)
    .map((o) => ({ optionId: o.id, votes: counts.get(o.id) ?? 0 }));
  const decision = decide(counted);
  return {
    id: poll.id,
    outletId: poll.outletId,
    day: dayOf(poll.day),
    status: poll.status,
    phase,
    opensAt: poll.opensAt,
    closesAt: poll.closesAt,
    showLiveResults: poll.showLiveResults,
    openedAt: poll.openedAt,
    closedAt: poll.closedAt,
    serverNow: now,
    votesCast,
    options: poll.options.map((o) => {
      const votes = counts.get(o.id) ?? 0;
      return {
        id: o.id,
        dish: toDish(o.menuItem),
        votable: isVotable(o.menuItem),
        /** False when the dish was withdrawn from the menu: its votes cannot win. */
        counted: o.menuItem.isActive,
        votes,
        percentage: percentage(votes, votesCast),
      };
    }),
    /** Set while a closed poll waits for the manager to choose among tied dishes. */
    tiedOptionIds: poll.status === 'CLOSED' && decision.kind === 'TIE' ? decision.optionIds : null,
    result: result(poll),
    version: poll.version,
    createdAt: poll.createdAt,
  };
}

/** A finalized poll's winner, shown as the outlet's Today's Special. */
export function toSpecial(poll: PollWithOptions & { outlet: Outlet }) {
  const winner = poll.options.find((o) => o.id === poll.winnerOptionId);
  if (!winner || !poll.outcome) return null;
  return {
    pollId: poll.id,
    day: dayOf(poll.day),
    outlet: toOutletSummary(poll.outlet),
    dish: toDish(winner.menuItem),
    outcome: poll.outcome,
    totalVotes: poll.totalVotes ?? 0,
    winnerVotes: poll.winnerVotes ?? 0,
    winnerPercentage: percentage(poll.winnerVotes ?? 0, poll.totalVotes ?? 0),
  };
}
