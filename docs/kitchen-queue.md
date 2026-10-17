# Live tracking, queue, preparation estimates and auto-accept

Everything here is **rule-based**: configured times, moving averages of real timings, a
deterministic scheduler and explicit rules. No machine learning, RL or external AI is used, and the
UI calls estimates "approximate" or "estimated".

## Lifecycle (unchanged)

`PLACED → ACCEPTED → PREPARING → READY → COMPLETED`, plus `REJECTED`, `CANCELLED` and `NO_SHOW`.

- **Checkout:** the order is taken on at checkout. Stock is deducted and the outlet's rolling
  **10 orders per 3 minutes** capacity is claimed there, once per order, under an advisory lock.
- **Accepting** (staff or auto-accept) is `PLACED → ACCEPTED`. It claims neither again.
- **Handover:** `READY → COMPLETED` only happens through pickup verification
  ([pickup-verification.md](pickup-verification.md)).

## Live tracking (student order page)

- **Progress:** the bar shows the real time of each stage the order reached, from
  `OrderStatusHistory`. A stage is never given a time it didn't record.
- **`GET /orders/:id/tracking`** (owner only) returns the timeline, the actual ready and collection
  times, and the latest estimate (null once ready or ended).
- **Live updates:** `order.updated` and `estimate.updated` socket events trigger a refetch.
  Reconnecting re-reads everything, and a 60-second refresh keeps time-based estimates current.
- **What's shown:**
  - orders ahead ("2 orders ahead of yours" / "Next in line" / "Being prepared now");
  - "Estimated ready around 12:45 — about 9 min (approximate)";
  - "± N min" once the outlet has at least 10 evaluated predictions in 14 days (N = median
    absolute error). This is a data-derived spread, not a calibrated confidence interval.
- **Not yet accepted:** the estimate assumes the outlet accepts now, and the page says so.

## Preparation times (manager: Kitchen → Kitchen timing)

**Configured Preparation Time:** whole minutes, 1–180, per dish. Dishes belong to one outlet, so
one outlet's setting never affects another's.

- It's validated on the server, audited (`MENU_PREP_TIME_UPDATED`), and applied to estimates
  immediately.
- Dishes without one are flagged and use the documented default (10 min) until history exists.
- It is **never overwritten** by learned values.

**Learned time:** an exponential moving average of real **PREPARING → READY** durations.

- **Formula:** `new = 0.2 × observed + 0.8 × previous`. A weight of 0.2 means roughly the last 10
  orders dominate, and one odd order moves the estimate by at most 20%.
- **Which orders count:** only orders with **one dish, one unit**. That's the only case where the
  whole duration belongs to that dish, so multi-dish orders never distort dish statistics.
- **Ignored:** durations under 30 seconds, over 4 hours, missing or negative (logged as invalid).
- **Outliers:** clamped to between ⅓× and 3× the current estimate before averaging.
- **When it's used:** after 5 valid observations.
- **Recorded once:** it's captured inside the READY transition, so retries can't double-count it.

**Estimator hierarchy:**

1. Learned (5 or more observations).
2. Configured.
3. Default.

The table shows which source is in use, the observation count, and the last observed duration.

**Order composition** (no per-station data exists):

```
order minutes = (longest unit + 0.5 × all other units) × outlet calibration
```

- **Outlet calibration:** a moving average of actual ÷ estimated over every collected order. It's
  clamped to 0.5–3 and applied after 5 orders.
- This corrects any systematic error in the composition assumption from real outcomes, without
  pretending to know per-dish times inside multi-dish orders.

**Kitchen capacity:** "orders prepared at once" (1–20) is set by the manager. The default of 1 is
the conservative assumption; no staff count is invented.

## Queue and scheduling

**What counts as kitchen work:** orders that are placed, accepted or preparing. Ready orders wait
for pickup and aren't kitchen work. Terminal orders are excluded. Each order counts once (it's
one row, however many items or history entries it has).

**Scheduler** (`scheduleQueue`, deterministic list scheduling over the outlet's parallel places):

1. Orders being prepared hold a place until _started + minutes_ (at least "now").
2. Waiting orders are served by _(key time, placed time, id)_:
   - for "order now" orders, the key time is when they were placed;
   - for scheduled orders, it's _scheduled time − minutes_.

   So a scheduled order placed yesterday doesn't jump ahead of today's orders, and it's planned
   for its slot.

3. Each takes the earliest free place, starting no earlier than its release time.
4. If more orders are in progress than places, waiting orders only get the configured number of
   places.

**Position and "orders ahead":**

- **Position:** 0 means being prepared and 1 means next. It's an ordering, not a promise.
- **Orders ahead:** the orders that will be prepared before this one.
- **Not the same as:** pickup backlog (ready orders) or the rolling acceptance count. These are
  kept separate.

**Recalculation:** `recalculateOutlet` runs under a per-outlet advisory lock.

- **When:** after every order change, configuration change and handover, plus every 30 seconds in
  the operations worker.
- **What it writes:** an `OrderEstimate` per active order. Estimates of orders that left the
  kitchen are removed.
- **Live updates:** changed estimates emit `estimate.updated` to the owner and the outlet's staff.

**Staff board:** POS and Manager tickets show "Queue #2 · ready ~12:45" or "Preparing · ready
~12:45", with **Delayed** when a preparing order is 5 or more minutes past its estimate.

**ETA notices:** a student is notified when their estimate moves by 5 or more minutes, at most
twice per order.

## Predictions and accuracy (Kitchen timing → Estimate accuracy)

**Snapshots:** `OrderPrediction` records what was predicted at **acceptance** and at **preparation
start** (once each). Its context holds only what was known then: position, orders ahead, minutes,
places, calibration, and whether the order was scheduled. At READY the actual time and the
absolute error are filled in. This is the dataset for a future supervised model, with no future
timestamps used as inputs.

**Dashboard** (7, 14 or 30 days), computed only from predictions that have an outcome:

- **Accepted → ready** and **preparing → ready** are reported separately. Each shows the mean and
  median absolute error, the share within ±3 min, and the sample count.
- **Late orders:** more than 5 min after the estimate.
- **Per-day:** orders placed and errors.
- **Auto-accept outcomes.**

Below 5 evaluated predictions it says "Not enough completed orders to evaluate estimate accuracy
yet."

## Rule-based auto-accept

**Mode:** Kitchen timing → Order acceptance: **Manual** (default for every outlet) or **Auto**.
Saving is audited (`KITCHEN_SETTINGS_UPDATED`). "Turn off auto-accept" is the kill switch, and
the rule is re-checked inside the acceptance transaction, so it takes effect immediately.

**An order is accepted automatically only if every rule passes:**

- the outlet is in Auto mode, active and open;
- the order is prepaid (wallet or group). Counter orders involve cash, so staff handle them;
- every dish is still on the menu, and untracked dishes aren't marked sold out (counted stock was
  already taken at checkout);
- the order was counted against the rolling capacity at checkout;
- it has an estimate, and the estimated wait is at most the manager's limit (5–120 min, default
  30);
- for scheduled orders: the estimate is within 5 min of the slot.

**How:**

- `decideAutoAccept` first claims a unique `AutoAcceptDecision` row, so retries and concurrent
  workers decide once.
- It then calls the **same `transitionOrder`** service staff use, with a narrowly scoped system
  actor (only `PLACED → ACCEPTED`). Its guard re-checks the rules inside the transaction.
- **Recorded as automatic:** the history row reads "Accepted automatically (auto-accept-v1)" with
  no user, and the audit log records `ORDER_AUTO_ACCEPTED`.
- **On any failure:** the order stays with staff exactly as in manual mode (never rejected; payment
  untouched). The reason is stored, staff get `STAFF_MANUAL_REVIEW`, and managers are alerted after
  repeated fallbacks.
- **If staff acted first:** the decision becomes `ALREADY_HANDLED`.
- **When it runs:** right after checkout or group placement commits, plus a worker sweep for any
  undecided placed order (crash recovery).

## Operations worker

Every 30 seconds (`backend/src/modules/operations/operations.worker.ts`), with state only in the
database, multi-instance safe, and isolated steps:

1. Auto-accept sweep.
2. Queue recalculation for outlets with kitchen work.
3. Almost-ready alerts. The order is re-checked under a row lock, so a ready or cancelled order
   gets none.
4. Scheduled reminders, based on the slot and the no-show deadline. They never change an order;
   the existing no-show worker alone decides no-shows.
5. Delay alerts.
6. Notification delivery retries.

## API

| Request                                                                                                               | Who                     |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `GET /orders/:orderId/tracking`                                                                                       | Owner                   |
| `GET /staff/outlets/:outletId/orders` (now with `estimate`)                                                           | Assigned POS or manager |
| `GET /staff/outlets/:outletId/kitchen`                                                                                | Outlet manager          |
| `PATCH /staff/outlets/:outletId/kitchen/items/:menuItemId` `{ prepMinutes: 1–180 \| null }`                           | Outlet manager          |
| `PUT /staff/outlets/:outletId/kitchen/settings` `{ kitchenParallelOrders, autoAcceptMode, autoAcceptMaxWaitMinutes }` | Outlet manager          |
| `GET /staff/outlets/:outletId/kitchen/accuracy?days=1–90`                                                             | Outlet manager          |

## Database (migration `20261018040000_notifications_queue_autoaccept`)

The migration only adds things:

- **New tables:** `Notification`, `PrepTimeStat`, `OutletKitchenStat`, `OrderEstimate`,
  `OrderPrediction` (unique per order and kind), and `AutoAcceptDecision` (unique per order).
- **New columns:** `MenuItem.prepMinutes` and `prepUpdatedAt`, and the outlet kitchen settings.
  Existing outlets default to MANUAL, 1 place, and a 30-minute limit.
- **CHECKs:** on the ranges.

```bash
npm run db:migrate:deploy -w backend
```

## Future ML (not implemented)

Once enough clean predictions with outcomes exist, a supervised model (for example, gradient
boosting) could be compared against this baseline in shadow mode, using the snapshot features.
It should switch over only if its error is clearly lower. RL isn't part of this design.

## Known limitations

- **No per-station or staffing data:** capacity is the manager's "orders prepared at once".
- **Dish-level learning** needs single-dish orders. Mixed orders improve only the outlet
  calibration.
- **Web Push** isn't enabled (see [notifications.md](notifications.md)).
