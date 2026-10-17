# Today's Special voting

Students vote between dishes chosen by an outlet's manager. When voting closes, the dish with
the most votes becomes that outlet's **Today's Special** for the poll's date. The special is shown
on the home page and on the outlet page.

Every count, percentage and winner is calculated on the server from the persisted vote rows.
The browser only sends "I vote for option X"; it never sends totals, winners, owners or times.

## Who can do what

| Action                                          | Student | Manager (assigned to the outlet) | POS | Admin |
| ----------------------------------------------- | :-----: | :------------------------------: | :-: | :---: |
| See Today's Special                             |   ✅    |                ✅                | ✅  |  ✅   |
| See the outlet's open poll and vote             |   ✅    |        ✅ (as a student)         | ✅  |  ✅   |
| Create, edit, open, close, finalize, view polls |   ❌    |                ✅                | ❌  |  ❌¹  |

- Voting needs sign-in and the Student role, which every account has. One account, one vote.
- ¹ No new role was added. An administrator who needs to run polls assigns themselves to the
  outlet as a manager (**Admin → Outlets**), exactly as for menu management.
- Management uses the existing `requireOutletRole(MANAGER)` guard: the live role **and** an
  assignment to that outlet. Another outlet's poll IDs return 404.

## Lifecycle

```
DRAFT ──open──► OPEN ──close (manual, or automatically at the closing time)──► CLOSED ──finalize──► FINALIZED
  edit / delete           votes accepted only while OPEN and opensAt ≤ now < closesAt
```

| State     | Meaning                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| DRAFT     | Being prepared. Invisible to students. Dishes, dates and times can be edited; can be deleted.                          |
| OPEN      | Published. Students see it as "upcoming" before `opensAt`, and can vote until `closesAt`. Dishes and times are frozen. |
| CLOSED    | No more votes. Normally lasts only a moment; it stays here only when there is a tie.                                   |
| FINALIZED | The result is stored and can never change.                                                                             |

**No scheduler is needed.** When the closing time has passed, the next request that touches the
poll closes it (a conditional `UPDATE … WHERE status = 'OPEN' AND closesAt <= now`) and finalizes
an unambiguous result. Any page that shows the poll or the special makes such a request. A
manager can also close voting early.

## Time and date policy

- A poll belongs to one **calendar date in India Standard Time** (`Asia/Kolkata`), the same policy
  as pickup numbers. Outlets have no timezone setting.
- Managers enter times in IST. They are stored as exact instants.
- The date can be today or up to 14 days ahead. Voting may open from the day before (for example,
  vote in the evening for tomorrow's special) and must close by the end of the poll's date.
  The window is at least 5 minutes.
- **One poll per outlet per date** (database unique key), so two specials for the same outlet and
  date are impossible.
- **All window checks use the database clock**, never the browser's. Countdowns in the app follow
  the server's time too.
- **No poll for a date means no special for that outlet that day.** Nothing falls back to a
  default dish.

## Choosing the winner

When a poll is finalized, the server counts the persisted votes per dish:

| Situation                     | Result                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One dish has the most votes   | Finalized automatically: `WINNER`. Totals and the winning percentage are stored.                                                                                          |
| Nobody voted                  | Finalized automatically: `NO_VOTES`. **There is no special for that day.** The database refuses a winner on such a poll. Nothing is invented.                             |
| Two or more dishes tie on top | **Not decided automatically.** The poll waits in CLOSED and the manager chooses one of the tied dishes. The server recomputes the tied set and accepts only one of those. |

**Tie policy.** A tie is resolved by the outlet manager choosing among the tied dishes only. The
outcome is stored as `TIE_RESOLVED_BY_MANAGER`, written to the audit log with the tied options,
and shown to students: "Tied at 12 votes — chosen by the outlet manager". Nothing is ever
decided by row order, ID order or timing.

**Changed votes.** A student who changes their vote updates their single vote row, so only their
latest choice counts.

**Withdrawn dishes.** If a dish is **deactivated** (removed from the menu) after voting started,
its votes are not counted towards the result. A dish that is only **sold out** can still win,
because being out of stock is temporary. Students can't cast new votes for a sold-out or
deactivated dish.

**Retries.** Finalizing locks the poll row and, if it is already FINALIZED, returns the stored
result unchanged. Running it again, or many times at once, can't change the winner.

## Result visibility

- **Managers** always see live counts.
- **Students** see counts and percentages only after voting closes, unless the manager turned on
  "Show live vote counts to students" for that poll. It's off by default so early results don't
  sway later voters.
- Nobody ever sees who voted for what. Students see only their own choice.

## Integrity and concurrency

| Risk                                                        | Protection                                                                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate votes (double clicks, retries, parallel requests) | Unique `(pollId, userId)`. Votes are an `INSERT … ON CONFLICT DO UPDATE`, so they collapse into one row.                                                            |
| Voting for someone else                                     | The voter is always the session user. The body accepts only `optionId` (strict schema).                                                                             |
| A vote racing with closing                                  | A vote locks the poll row `FOR SHARE` and re-checks status and window. Closing needs a row lock, so it waits for in-flight votes, and every later vote sees CLOSED. |
| A dish from another outlet or poll                          | Composite foreign keys: option → `(menuItemId, outletId)` and `(pollId, outletId)`; vote → `(optionId, pollId)`; winner → `(winnerOptionId, pollId)`.               |
| Inconsistent results                                        | CHECK constraints: result exists ⇔ FINALIZED; no winner ⇔ `NO_VOTES`; `NO_VOTES` requires 0 counted votes; winner votes ≤ total.                                    |
| Client-assigned winners                                     | There is no endpoint that accepts a winner or totals. Finalize accepts only a tie choice, checked against the server's own tie.                                     |
| Managing another outlet's poll                              | `requireOutletRole(MANAGER)` plus every lookup scoped by outlet ID.                                                                                                 |

Vote counts are never stored as running totals. The only stored numbers are the snapshot taken at
finalization, which can't drift because votes can't change after closing.

## Real-time updates

`poll.updated` carries `{ pollId, outletId, status, version }` only — never votes or voters.

- **Status changes** (opened, closed, finalized, including automatic ones) go to every connected
  user, since Today's Special is public anyway.
- **Vote activity and draft edits** go only to that outlet's staff room, at most once per second
  per poll, always ending on the latest state.
- Clients re-read over REST. Students' open polls also refresh every 30 seconds, and managers'
  lists every 15 seconds while a poll is live, so nothing depends on the socket.

## Audit log

`POLL_CREATED`, `POLL_UPDATED`, `POLL_DELETED`, `POLL_OPENED`, `POLL_CLOSED` and `POLL_FINALIZED`
(with outcome, totals, winner and any tied options). Automatic finalization is recorded with the
`SYSTEM` actor. Individual votes are not audited; they are the vote rows themselves.

## Where things are

| Area     | Files                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database | `backend/prisma/schema.prisma` (`DailyPoll`, `DailyPollOption`, `DailyPollVote`), migration `20261016180000_daily_polls`                                                                                                        |
| Backend  | `backend/src/modules/polls/` (schemas, service, serializer, routes), `backend/src/realtime/` (`pollUpdated`)                                                                                                                    |
| Frontend | `frontend/src/services/polls.ts`, `frontend/src/features/specials/`, `frontend/src/features/manager/ManagerSpecialsPage.tsx` and `PollEditorDialog.tsx`                                                                         |
| Tests    | `backend/src/modules/polls/*.test.ts`, `backend/src/realtime/socket.test.ts`, `frontend/src/features/specials/Specials.test.tsx`, `frontend/src/features/manager/ManagerSpecialsPage.test.tsx`, `frontend/e2e/specials.spec.ts` |

The endpoints are listed in [api-contracts.md](api-contracts.md#todays-special-voting).

## Setup

Nothing extra. Apply the migrations as usual:

```bash
npm run db:migrate:deploy -w backend
```

```bash
npm run db:migrate:test -w backend
```

The migration only adds tables, two enums, one redundant unique key on `MenuItem (id, outletId)`
and CHECK constraints. It doesn't change or remove existing data.

## Manual test

1. Sign in as a manager assigned to an outlet and open **Kitchen → Specials**.
2. **New poll**: pick a date, a voting window that includes now, and two or more dishes. Create
   the draft, check the preview card, then **Open voting**.
3. In other browsers (or private windows), sign in as two or three students, open the outlet page
   and vote. Change one vote. Students shouldn't see counts unless live results were turned on.
4. Watch the counts change on the manager's card.
5. **Close voting now**. The card shows the winner and totals. The outlet page shows the special
   banner, and the home page shows it in "Today's specials" when the poll is for today.
6. Repeat with an exact tie to see the tie choice, and with no votes to see "no special".

## Known limitations

- A poll whose closing time has passed is closed by the next request that touches it, not at the
  exact second. Votes after the closing time are refused regardless, and the result is the same.
- Student pages learn about vote counts by refreshing (every 30 seconds while voting) rather than
  per-vote socket events, to avoid broadcasting vote activity to every connected user.
- History shows a manager's 30 most recent polls.
