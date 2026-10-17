# Weekly Stock Planner: demand forecasting and stock planning

POS staff and managers open **Counter → Stock planner** (`/pos/planner`) or **Kitchen → Stock
planner** (`/manage/planner`) to see how much of each item to prepare or buy for the coming week:

- why each number was recommended
- room to change it, with a reason
- approval, and recording what was actually restocked
- after the week, a comparison of forecast and reality

> Forecasts are estimates, not guaranteed sales. Nothing in the planner changes live stock. Only
> **Record restock** does, and it goes through the normal inventory service and ledger.

## What exists, and what doesn't

**Built on the data CampusCart really has:**

- order lines (with each order's IST collection day, status, timing and prices)
- the order status history (who cancelled)
- the append-only stock ledger (`StockAdjustment`: restocks, removals, order deductions and
  restores, counts, tracking and sold-out switches)
- menu items, with their category and packaged/handmade classification

**Not in CampusCart, so not used or invented:**

- purchase costs, so there are no money figures, and the reward is in units
- supplier lead times, pack sizes or minimum order quantities
- expiry dates or storage capacity (beyond the existing 100,000-unit stock limit)
- purchase orders (so **expected incoming stock is always 0**)
- holidays or promotions
- budgets
- lost-sale attempts (a student refused at "Add" isn't logged)

Each is a single field or rule to add once the data exists.

## Data flow

```
orders + status history ─┐
stock ledger ────────────┼─► DemandDaily (recomputed per item per IST day)
                         │        │
                         │        ▼
                         │   ForecastRun / Forecast (as-of today; only days before it)
                         │        │
                         │        ▼
live stock ──────────────┴─► StockPlan / StockPlanItem (recommendation, staff decision)
                                  │ approve
                                  ▼
                             PlanningDecision (state + action, frozen)
                                  │ "Record restock" ──► inventory service ──► StockAdjustment
                                  │ week ends
                                  ▼
             outcome + reward ──► PolicyVersion (offline training, explicit only)
```

Code: `backend/src/modules/planning/`.

| File                  | Purpose                                             |
| --------------------- | --------------------------------------------------- |
| `dates.ts`            | IST business dates, Monday weeks                    |
| `planning.rules.ts`   | Every parameter                                     |
| `demand.service.ts`   | Demand history                                      |
| `forecast.service.ts` | Forecasting and evaluation                          |
| `plan.service.ts`     | Plans, overrides, approval, restocks, outcomes, CSV |
| `policy.ts`           | Actions, state, reward, replay                      |
| `train.ts`            | Offline training                                    |
| `planning.jobs.ts`    | Scheduled jobs                                      |
| `planning.routes.ts`  | API                                                 |

## Database (migration `20261017220000_weekly_stock_planning`)

| Model               | What it holds                                                                                                                                                                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DemandDaily`       | Per outlet, item and **IST collection day** (`Order.pickupDay`, the day the kitchen prepares for): see below                                                                                                                                                                                                                |
| `ForecastRun`       | One forecasting run: outlet, target week, **as-of date** (history strictly before it), history range, model and version, trigger (MANUAL/AUTO), and the evaluation once the days have passed                                                                                                                                |
| `Forecast`          | Per item and target day: quantity, 80% interval, confidence, horizon, the **full feature snapshot**, and later the actual demand and absolute error. Never overwritten: each run is a new set of rows                                                                                                                       |
| `StockPlan`         | Outlet, week (Mon–Sun), **version**, status (DRAFT → SUBMITTED → APPROVED → COMPLETED, or SUPERSEDED), forecast run, policy and version, totals, notes, who created/submitted/approved/completed it and when, and the week's outcome                                                                                        |
| `StockPlanItem`     | Daily forecast, current stock, expected incoming (0), safety stock, target, action, the **original recommendation** (never changed), the final quantity, override flag and reason, explanation, units actually restocked, and the outcome                                                                                   |
| `StockPlanRevision` | Append-only: creation, every quantity change (from → to, reason, who), notes, status changes and restocks                                                                                                                                                                                                                   |
| `PlanningDecision`  | Reinforcement-learning experience: state at decision time, candidate actions, action, policy/version, recommended and approved quantity, and after the week the restocked units, demand, fulfilled, stockout days, estimated lost, wasted, leftover, reward components and reward, plus status (PENDING/FINALIZED/EXCLUDED) |
| `PolicyVersion`     | A trained policy: artifact (state bucket → action), reward config, dataset (decision IDs for train/holdout, exclusions), evaluation and status (REJECTED/VALIDATED/ACTIVE/RETIRED)                                                                                                                                          |
| `PlanningJobRun`    | Job bookkeeping: unique (job, key), status, attempts, last error                                                                                                                                                                                                                                                            |

**`DemandDaily` fields:**

- units ordered, split into: cancelled by the student, rejected or cancelled by the outlet,
  fulfilled, no-show, still open
- scheduled vs immediate units
- demand value
- ledger movements by day: deducted, restored, replenished, wasted (= `REMOVAL`)
- opening and closing counted stock
- **stockout minutes** and **censored**
- whether the outlet had any orders that day
- category and classification

**`StockAdjustment` gains `planItemId` and a unique `idempotencyKey`,** used for planner restocks
only.

**Indexes:**

- outlet + item + date (unique)
- outlet + forecast target date
- plan + item (unique)
- ledger + time
- decision + policy + period

**Integrity rules:**

- CHECKs: counts add up, quantities are non-negative, the week is Monday + 6 days, an override
  needs a reason, plan restocks are RESTOCK entries with a key, and finalized decisions have a
  reward
- **one live plan per outlet and week** (partial unique index)
- **one active policy** (partial unique index)

## Demand history: counted once, stockouts kept honest

- **Recomputed, not incremented.** Each row is the full recomputation from orders and the ledger,
  upserted. An order moving PLACED → ACCEPTED → … → COMPLETED, a retried job, or two workers at
  once all produce the same row. Nothing is ever counted twice.
- **What "demand" means.** Demand = units ordered − units the student cancelled.
  - Outlet rejections still count as demand: it was wanted but not met.
  - Fulfilled sales, cancellations, rejections and no-shows are kept separately.
- **Stockouts.** The ledger is replayed to rebuild, minute by minute, when each item couldn't be
  ordered: marked sold out, or counted and at 0.
  - Any such time marks the day **censored**, because sales then understate demand.
  - The forecaster leaves censored days out instead of treating them as low or zero demand. If
    an item has only censored days, they are used as a minimum and marked low confidence.
- **Closed days.** Days when the outlet had no orders at all are treated as probably closed and
  left out of the estimates.
- **Before an item existed** there are no rows, so the forecaster never sees invented zeros.

## Forecasting (baseline)

Model `weekday-ewma-baseline` 1.0.0:

```
demand(day) = level × weekdayFactor(weekday)
level         = exponentially weighted mean of recent de-seasonalised demand
                (last 28 days, half-life 7 days)
weekdayFactor = mean demand on that weekday ÷ overall mean
                (needs ≥ 2 observations; bounded 0.25–3; otherwise 1)
interval      = ± 1.28 σ (80%), σ from the de-seasonalised residuals
```

- **History** is the 56 days **before the as-of date** (today, IST). The query is
  `businessDate < asOf`, so a forecast can't see the day it's made on or anything later. The
  feature snapshot stored with every forecast records exactly what it used.
- **Confidence:**
  - **HIGH:** ≥ 35 usable days, and ≥ 4 of each target weekday
  - **MEDIUM:** ≥ 14 usable days
  - **LOW:** anything less, or only sold-out days
  - **NONE:** no history at all
- **New items with no history** use the mean daily demand of other items in the same category
  (marked NONE, "uses the average of other items in its category"). With nothing to go on, the
  forecast is 0 and the explanation asks staff to set a quantity from experience.
- **Evaluation:**
  - When a forecast's day passes, its actual demand and absolute error are stored.
  - When all of a run's days have passed, the run gets **MAE** (units per item-day), **WAPE**
    (Σ|error| ÷ Σactual) and **bias**.
  - Censored and closed days are excluded, because their sales aren't true demand.
  - WAPE is **undefined (null)** when there was no actual demand, never 0 or ∞. MAE has no such
    problem but isn't scale-free.
- **Why no fancier model:** with the data available (the dev database has a single day of orders),
  a more complex model can't be shown to do better. The forecaster is one function
  (`forecastItem`) with a versioned name, so a better one can replace it and be compared on the
  same stored actuals.

## The recommendation

Over the plan's week (Monday–Sunday):

```
F            = Σ daily forecasts for the week
safety stock = ⌈1.28 × σ_week⌉, with σ_week = √Σσ_day²          (~90% of weeks covered)
               ⌈20% × F⌉ when variability can't be estimated yet
target       = ⌈F + safety⌉                                     (the buffer is added ONCE)
projected    = max(0, stock now − forecast sales before Monday)  (counted items only)
need         = max(0, target − projected − expected incoming)   (incoming is 0: no purchase orders)
```

- Quantities are whole units, never negative, and never push stock past the 100,000 limit.
- **Items whose stock isn't counted** can't subtract stock, so their recommendation is the
  amount to prepare or buy over the week, and the planner says so.
- **Handmade items** get a note to prepare fresh daily from the daily figures.
- The table shows current stock (live, and as planned), forecast, incoming, safety stock,
  recommendation, final quantity and status. Expanding a row shows:
  - the daily forecasts with ranges
  - the explanation
  - the last 4 weeks (sold-out days highlighted)
  - after the week, forecast against actual by day

## Reinforcement learning: what is implemented, and the safeguards

**Actions** are discrete multiples of the item's need: NONE (0), SMALL (0.5×), MEDIUM (1×, the
baseline) and LARGE (1.5×). Each is capped by the stock limit, and every action's quantity is
stored with the decision.

**State** comes from the stored forecast snapshot and plan line, so it holds only what was known
when the plan was made:

- confidence, weekly forecast and σ, safety stock
- current and projected stock
- the baseline need
- stockout rate, recent demand, wastage in the last 28 days
- classification

**Reward**, in units, because no cost data exists (`REWARD_WEIGHTS` in `planning.rules.ts`):

```
reward = 1 × fulfilled − 2 × estimated lost − 1 × wasted − 0.1 × leftover
```

- A lost sale weighs twice a sale: a student is disappointed and the sale is gone.
- Waste costs the unit.
- Leftover stock costs a little to hold.
- **Estimated lost** = units the outlet refused + on sold-out days, the forecast minus what sold.
  The second part is an _estimate_, because true demand on those days wasn't observed.

**Lifecycle:**

1. **Baseline first.** Plans use the rule above (always MEDIUM, NONE when nothing is needed).
   This is what runs today.
2. **Experience.** When a manager approves a plan, each line's state, candidates, action and
   quantities are frozen in `PlanningDecision`.
3. **Outcomes.** After the week ends and its demand is aggregated, demand, fulfilled, stockout
   days, wastage, leftover, the restocked amount and the reward are filled in.
   - Lines whose stock isn't counted are **EXCLUDED** (`STOCK_NOT_COUNTED`): with no stock data
     the decision can't be judged.
   - Unfinished weeks stay **PENDING**. Nothing unobserved is ever treated as zero.
4. **Offline training, only when run explicitly:** `npm run planning -w backend -- train`.
   - **Data:** finalized decisions from weeks **without stockouts**, where observed demand is
     true demand.
   - **Method:** a tabular contextual bandit over the state buckets confidence × variability.
     Each action is replayed historically (opening stock + that action's quantity against the
     week's actual demand), and each bucket with ≥ 5 examples takes the best action. Every other
     bucket keeps MEDIUM.
   - **Evaluation:** on a **time-based holdout** (the newest ≥ 20%, at least 10 decisions,
     never splitting a week).
   - **Validation bar:** the learned policy must beat the baseline's mean reward by ≥ 2% without
     lowering the service level by more than 2 points.
   - Needs **≥ 40 training + 10 holdout** usable decisions. Otherwise the run is recorded as
     `REJECTED` / `INSUFFICIENT_DATA`.
   - The artifact, the dataset (decision IDs) and the evaluation are stored in `PolicyVersion`.
5. **Activation is explicit** (`train --activate`, or `activate --version <v>`), and only a
   validated policy can be activated. At most one is active (database index).
   `planning -- deactivate` returns to the baseline. If the active policy is missing or its
   artifact is invalid, the baseline is used. The plan records which policy and version made
   each recommendation.
6. **Never autonomous.** The policy only recommends quantities for human review. It can't change
   stock, place orders, or bypass the stock limit.

**Current status:** no policy has been trained on real data. The dev database has 1 day of orders
and no completed planning weeks, so `train` reports `INSUFFICIENT_DATA` and the baseline is in
use. Learning can only start once real weeks are planned, approved and finished. **No claim is
made that the learned approach beats the baseline;** the safeguards exist to measure that when the
data exists. Historical replay assumes demand doesn't depend on stock, which holds only for
stockout-free weeks (the only ones used). Wastage can't be replayed counterfactually, so replay
rewards use the leftover penalty instead.

## API (`/api/v1/staff/outlets/:outletId/planning`, assigned MANAGER or POS)

| Method & path                                                 | Notes                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /overview?weekStart=`                                    | Week and plannable range, the caller's role here, the live plan, live stock counts, the latest forecast, when demand was last computed, data sufficiency, the policy in use                           |
| `GET /demand?from&to&menuItemId&limit&cursor`                 | Historical demand rows, newest first. At most 120 days per request; `limit` 1–500; keyset cursor                                                                                                      |
| `GET /items/:menuItemId/history?days=`                        | Daily demand/sales/stock for one item, with the latest earlier forecast for each day                                                                                                                  |
| `POST /plans {weekStart}`                                     | Forecast + plan for a future Monday within 4 weeks. A previous draft becomes SUPERSEDED. `409 PLAN_LOCKED` once approved                                                                              |
| `GET /plans?weekStart=` · `GET /plans/:id`                    | Plans (every version) · one plan with items and revisions                                                                                                                                             |
| `PATCH /plans/:id/items/:planItemId {finalQty, reason?}`      | DRAFT/SUBMITTED only. A reason (≥ 3 chars) is required when it differs from the recommendation. Every change becomes a revision                                                                       |
| `PATCH /plans/:id {notes}`                                    | Notes (revisioned)                                                                                                                                                                                    |
| `POST /plans/:id/submit` · `/approve` · `/complete`           | DRAFT→SUBMITTED (anyone) · →APPROVED (**manager only**; creates the decision records) · APPROVED→COMPLETED. Each happens once (row lock); a repeat is `409`                                           |
| `POST /plans/:id/items/:planItemId/replenishments {quantity}` | **`Idempotency-Key` header required.** APPROVED plans and counted items only. A real RESTOCK through the inventory service, linked to the line; a repeated key returns `200` without restocking again |
| `GET /plans/:id/export.csv`                                   | CSV (spreadsheet formulas neutralised)                                                                                                                                                                |
| `GET /evaluation`                                             | Forecast accuracy (MAE/WAPE/bias, last 8 weeks, plus per run), the policy in use, the latest trained policy and its verdict, decision counts                                                          |

- **Access:** the outlet comes from the path and is checked against the caller's live role +
  assignment. IDs are looked up only within that outlet, so another outlet's plan is `404`.
  Quantities are validated (whole numbers 0–100,000), and dates must be real `YYYY-MM-DD` days.
- **Live updates:** restocks broadcast `stock.updated`, so student menus, stock pages and the
  planner refresh.

## Scheduled jobs

`startPlanningWorker` runs every 15 minutes in the API process; `planning -- run-jobs` runs one
pass by hand. All state is in PostgreSQL, so restarts just continue.

1. **Demand:** a one-time backfill (up to 365 days, recorded as job `demand-backfill`), then the
   last 3 days on every pass.
2. **Automatic forecast** for next week, from Friday (IST), once per outlet and week
   (`auto-forecast:<outlet>:<week>`).
3. **Forecast evaluation** for days that have passed.
4. **Plan outcomes and decision rewards** for weeks that have ended.

**Safety:**

- Job units are claimed through a unique row. A failed or stale (30 min) claim is retried.
- Every write is either a recomputation or a conditional update (`WHERE status = 'PENDING'`,
  `outcome IS NULL`, …), so concurrent instances and repeats are harmless.
- Training is **never** scheduled.

## Commands

```bash
npm run db:migrate:deploy -w backend          # apply migrations (dev)
npm run db:migrate:test -w backend            # apply migrations (test database)
npm run dev -w backend                        # API + planning worker
npm run planning -w backend -- status         # forecasts, decisions, policies
npm run planning -w backend -- run-jobs       # one pass of the jobs now
npm run planning -w backend -- train          # train + evaluate (never activates)
npm run planning -w backend -- train --activate
npm run planning -w backend -- activate --version <v>
npm run planning -w backend -- deactivate
npm test -w backend -- src/modules/planning   # planner tests
```

## Integration with the rest of CampusCart

- **Live stock, statuses, checkout, scheduled orders, cancellations and no-shows** are untouched.
  The planner only reads them.
- **Restocks** use `adjustStockTx`, the same locked update and ledger write as a manual restock,
  so menu availability, Low Stock/Sold Out, cart checks and AI Surprise Meal pick up the new
  stock immediately.
- **No-show restocks, order deductions and restores** already sit in the ledger and feed demand
  history. Wastage is the ledger's REMOVAL.

## Limitations caused by missing data

- **Very little history.** The dev database has one day of orders, so every forecast there is
  low confidence and the planner says so. Accuracy can only be measured after forecast days
  pass.
- **Stockout and closed-day detection** is per calendar day (00:00–24:00 IST): pickup hours
  aren't used, so a late-night sell-out still marks the day censored, which errs towards caution.
- **Untracked items** have no stock figures: their recommendations are "how much to prepare",
  and they can't produce learning data.
- **No partial information** on lost demand (refused "Add to tray" attempts aren't logged).
- **Initial state before an item's first ledger entry** is inferred from that entry or, without
  any, from the item's current state.

## Future work (not implemented)

- **Purchase orders:** expected incoming stock, supplier lead times, pack sizes and MOQs, costs,
  and a money-based reward and budgets.
- **Expiry and shelf life** for packaged stock.
- **Holiday, exam and event calendars** as forecast features.
- **Logging refused cart attempts** to measure lost demand directly.
- **A richer forecaster** once enough history exists to show it beats the baseline.
- **Exploration** (e.g. small randomised action choices with logged propensities) for unbiased
  off-policy evaluation. Today's replay evaluation depends on the stockout-free-week assumption.
