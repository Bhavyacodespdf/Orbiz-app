# Scheduled-order no-show policy

A **scheduled** order that is **ready** but not collected within **10 minutes** of its pickup
slot is settled automatically by the server, per item:

| Item classification      | Refund                        | Kept                | Stock                     |
| ------------------------ | ----------------------------- | ------------------- | ------------------------- |
| **Packaged**             | 90% of what was actually paid | 10% convenience fee | Restocked (if resellable) |
| **Handmade**             | None                          | Everything paid     | Not restocked             |
| **Not classified** (old) | Treated as **handmade**       | Everything paid     | Not restocked             |
| ₹10 scheduled-order fee  | Never refunded                | Always              | —                         |

Orders placed for "now" are not affected.

## Classification

- Managers choose **Packaged or handmade** for every menu item (required when adding an item; an
  existing item can be changed in its edit dialog). The Menu page shows the classification and
  flags **Not classified** items. Changes are audited (`MENU_ITEM_CLASSIFICATION_CHANGED`).
- **Snapshot.** Each order line copies the classification when the order is placed
  (`OrderItem.fulfillmentType`). Later menu changes never change an existing order's outcome.
- Existing items were **not** classified by the migration (no data was invented). Until a manager
  classifies them, they are treated as handmade, which never refunds or restocks anything by
  guesswork.

## When it applies

- **Deadline** = `scheduledFor + 10 minutes` (`NO_SHOW_GRACE_MINUTES` in
  `backend/src/modules/noshow/noshow.rules.ts`), checked against the **database clock**.
- **Only `READY` scheduled orders** are processed. An order still Placed, Accepted or Preparing at
  the deadline is the outlet's delay, not the student's: staff see "needs staff attention" and
  handle it with the normal flow.
- **Picked up in time wins.** Staff can confirm pickup (Ready → Completed) right up until the
  worker settles the order. Both use version-checked/locked updates on the same row, so exactly
  one of them succeeds.

## The money

For each line, the amount **actually paid** is worked out first:

1. Loyalty points discount the food only. The discount is spread across lines in proportion to
   their totals (largest-remainder, integer paise), so the line amounts add up exactly.
2. Packaged line: `refund = floor(paid × 90 / 100)`, `fee = paid − refund`.
3. Handmade/unclassified line: `refund = 0`, `fee = 0` (nothing is returned).

- **Points spent are not returned.** The refund is 90% of the money paid, not of the menu price.
- **Wallet orders:** the refund is one `REFUND` wallet transaction (idempotency key
  `noshow-refund:<orderId>`, linked to the original debit). The order's payment status becomes
  **`PARTIALLY_REFUNDED`** (or stays `PAID` if nothing was refundable). A guard refuses any refund
  larger than the debit minus the ₹10 fee.
- **Counter (unpaid) orders:** nothing was charged, so nothing is refunded. Payment becomes
  **`VOID`**. Packaged items are still restocked.
- **Counter orders already paid in cash** are **not** settled automatically: the app can't refund
  cash. Staff and the student see that the order needs settling in person at the counter.
- All amounts are integer paise. The browser sends no amounts and computes nothing.

## Stock

- Packaged, resellable lines get back exactly the units that order deducted (`ORDER_RESTORE`,
  reason `SCHEDULED_ORDER_NO_SHOW`). Untracked items were never deducted, so nothing is restored.
- **Not resellable.** Staff can mark a packaged line of an active scheduled order as **not
  resellable** with a reason (damaged, opened, expired). It is still refunded 90% but not
  restocked. Audited as `ORDER_ITEM_MARKED_UNSUITABLE`.
- The existing `unique(orderId, menuItemId, type)` stops stock being restored twice.

## States and records

- Order status **`NO_SHOW`** ("Not collected in time"), with a status-history row (actor: system,
  or the admin who retried).
- Per line: `noShowPaidPaise`, `noShowRefundPaise`, `noShowFeePaise`, `noShowRestockedQty`.
- `NoShowSettlement` (one per order): `PROCESSED` or `FAILED`, attempts, last error, deadline,
  totals, the refund transaction, and `scheduledFeeRetainedPaise`.
- Audit log: `ORDER_NO_SHOW_PROCESSED` with the full breakdown.
- Database CHECKs: no-show only for scheduled orders, `refund + fee = paid ≤ line total` per line,
  restocked quantity within the line quantity, and non-negative settlement amounts.

## The worker

`startNoShowWorker` runs inside the API process every 60 seconds (started in `server.ts`, stopped
on shutdown).

- **Restarts.** It keeps no state in memory: each pass queries the database for overdue `READY`
  orders, so anything missed while the server was down is picked up on the next pass.
- **Several instances.** Each order is settled in its own transaction that locks the row with
  `FOR UPDATE SKIP LOCKED` and re-checks `status = READY`. Two instances can't settle the same
  order; the second skips it.
- **Idempotent.** Re-running does nothing: the order is no longer `READY`, and the unique refund
  key, unique settlement row and unique stock restore stop any duplicate.
- **Failures** roll back the whole settlement (no partial refund or restock). A `FAILED`
  settlement records the attempt and error, and the order stays `READY`, so the next pass tries
  again.
- After commit it sends the usual live updates: `order.updated`, `wallet.updated` (refund) and
  `stock.updated`.

## Who sees what

- **Students** (order page): the collect-by time; after the deadline, "the no-show policy is being
  applied" (no amount is claimed before the server records it); once settled, each item's
  outcome, the total refunded and that the ₹10 fee is kept. Their order list shows "Not collected
  in time".
- **Manager board and POS:** ready scheduled cards show "Collect by …" or "Grace period over".
  The order dialog shows each line's classification, the deadline, attention states, the
  "Mark not resellable" action and the settled outcome including restocked units.
- **Admins** (**Admin → No-shows**, `/admin/no-shows`): failed and processed settlements, with
  **Retry**. Retrying re-runs the same server policy (nobody types an amount) and is audited
  (`NO_SHOW_RETRY_REQUESTED`).

## API

| Method & path                                                                    | Who          | Notes                                                                 |
| -------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------- |
| `POST /staff/outlets/:outletId/orders/:orderId/items/:menuItemId/not-resellable` | Manager, POS | `{ reason }` (3–200 chars). Packaged lines of active scheduled orders |
| `GET /admin/no-shows?status=FAILED\|PROCESSED`                                   | Admin        | Latest 100 settlements                                                |
| `POST /admin/no-shows/:orderId/retry`                                            | Admin        | `{ processed, order }`. `processed: false` = nothing to do            |

- **Order objects** add `pickupDeadline`, `noShow` (`status`, `processedAt`, `refundPaise`,
  `convenienceFeePaise`, `scheduledFeeRetainedPaise`, `restockedUnits`), and per item
  `fulfillmentType`, `unsuitableForResale` and `noShow` (`paidPaise`, `refundPaise`, `feePaise`,
  `restockedQuantity`). Summaries add `pickupDeadline`.
- **Menu items** (staff) accept and return `fulfillmentType: "PACKAGED" | "HANDMADE" | null`.

## Limitations

- No email or push notification: students see the outcome in the app (live update) only.
- Only `READY` orders are settled automatically; late orders still in the kitchen need staff.
- Counter orders already paid in cash are left for staff to settle in person.
- No partial pickup: an order is either collected or settled as a whole.
- "Not resellable" is a manual staff judgement; nothing checks the food itself.
- Loyalty points spent on a no-show order are not returned.
- A settlement that keeps failing is retried every minute until it succeeds or an admin
  investigates; there is no automatic give-up.
- No end-to-end (browser) test drives a real no-show: it needs the clock to pass a deadline, and
  the E2E suite has no database access. The backend tests cover it against a real database.

## Manual test

1. As a manager, classify a counted item as **Packaged** and another as **Handmade**.
2. As a student, schedule an order with both for the nearest slot and pay from the wallet.
3. As staff, accept, prepare and mark it **Ready**. The card shows "Collect by …".
4. Wait until 10 minutes after the slot (up to a minute more for the worker). The order becomes
   **Not collected in time**. The student sees 90% of the packaged line refunded, the handmade
   line not refunded and the ₹10 fee kept; the wallet shows the refund; the packaged stock goes
   back up.
5. Repeat, but mark the packaged line **Not resellable** first: it is refunded but not restocked.
