import type { Dish, ManagerPoll, Special, StudentPoll, StudentPollOption } from '@/services/polls';
import { makeOutlet } from './outlets';

export function makeDish(overrides: Partial<Dish> = {}): Dish {
  return {
    id: 'i1',
    name: 'Paneer Wrap',
    description: 'Grilled paneer, mint chutney.',
    imageUrl: null,
    pricePaise: 9000,
    dietary: 'VEG',
    isAvailable: true,
    stockStatus: overrides.isAvailable === false ? 'SOLD_OUT' : 'AVAILABLE',
    orderable: true,
    category: { id: 'c1', name: 'Mains' },
    ...overrides,
  };
}

export function makeOption(overrides: Partial<StudentPollOption> = {}): StudentPollOption {
  return {
    id: 'opt1',
    dish: makeDish(),
    votable: true,
    votes: null,
    percentage: null,
    ...overrides,
  };
}

export const SERVER_NOW = '2026-10-16T06:00:00.000Z'; // 11:30 am IST

export function makePoll(overrides: Partial<StudentPoll> = {}): StudentPoll {
  return {
    id: 'p1',
    outletId: 'o1',
    day: '2026-10-16',
    phase: 'VOTING',
    opensAt: '2026-10-16T04:30:00.000Z',
    closesAt: '2026-10-16T06:42:00.000Z', // 12:12 pm IST, 42 min after SERVER_NOW
    serverNow: SERVER_NOW,
    resultsVisible: false,
    votesCast: null,
    myOptionId: null,
    options: [
      makeOption(),
      makeOption({
        id: 'opt2',
        dish: makeDish({
          id: 'i2',
          name: 'Veg Burger',
          pricePaise: 7000,
          category: { id: 'c2', name: 'Snacks' },
        }),
      }),
    ],
    result: null,
    version: 2,
    ...overrides,
  };
}

export function makeSpecial(overrides: Partial<Special> = {}): Special {
  return {
    pollId: 'p1',
    day: '2026-10-16',
    outlet: makeOutlet(),
    dish: makeDish(),
    outcome: 'WINNER',
    totalVotes: 85,
    winnerVotes: 42,
    winnerPercentage: 49.4,
    ...overrides,
  };
}

export function makeManagerPoll(overrides: Partial<ManagerPoll> = {}): ManagerPoll {
  return {
    id: 'p1',
    outletId: 'o1',
    day: '2026-10-16',
    status: 'DRAFT',
    phase: 'DRAFT',
    opensAt: '2026-10-16T04:30:00.000Z',
    closesAt: '2026-10-16T06:30:00.000Z',
    showLiveResults: false,
    openedAt: null,
    closedAt: null,
    serverNow: SERVER_NOW,
    votesCast: 0,
    options: [
      { id: 'opt1', dish: makeDish(), votable: true, counted: true, votes: 0, percentage: 0 },
      {
        id: 'opt2',
        dish: makeDish({ id: 'i2', name: 'Veg Burger', pricePaise: 7000 }),
        votable: true,
        counted: true,
        votes: 0,
        percentage: 0,
      },
    ],
    tiedOptionIds: null,
    result: null,
    version: 1,
    createdAt: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}
