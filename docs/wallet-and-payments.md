# Wallet and payments

> **Read this first.** CampusCart's wallet currently holds **simulated test funds only**.
> Recharges go through a **mock payment simulator**. No bank, UPI, card or other real money is
> involved, and nothing in the app should be described as a real payment. Real-money funding needs
> a chosen provider, a verified integration, and an assessment of the Indian rules that may apply
> to prepaid wallets (for example, RBI prepaid payment instrument rules). None of that has been done.

## What exists

| Capability                                                                    | Status                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------- |
| One wallet per user, starting at **₹0** (decision Q1)                         | Implemented and tested                            |
| Mock recharge: success, failure, cancel, expiry                               | Implemented and tested                            |
| Recharge limits: **₹99**–₹2,000 per recharge, whole rupees, ₹5,000 wallet cap | Implemented and tested                            |
| Loyalty points: recharge bonuses, redemption at checkout, restore on cancel   | Implemented and tested ([below](#loyalty-points)) |
| Wallet payment at checkout (atomic debit)                                     | Implemented and tested                            |
| Pay-at-counter orders created **unpaid**                                      | Implemented and tested                            |
| Transaction history (paginated) and details                                   | Implemented and tested                            |
| Automatic full refunds on reject or cancel before READY (Q6)                  | Implemented and tested                            |
| POS recording of counter payments (exact total, once, audited)                | Implemented and tested                            |
| Real-time wallet notifications (owner only, no amounts)                       | Implemented and tested                            |
| Real payment provider                                                         | **Not planned until separately approved**         |

## The ledger model

- `Wallet.balancePaise` is the **authoritative running balance**, an integer in paise. The
  database enforces `CHECK (balancePaise >= 0)`.
- `WalletTransaction` is the **ledger**. Every balance change has exactly one `COMPLETED` row,
  written **in the same database transaction** as the balance change, and that row records
  `balanceAfterPaise`.
- **Completed rows are never modified.** Corrections, such as refunds, will be **new** rows that
  point at the original (`reversesTransactionId`, and `orderId` + `type`).
- Database constraints:
  - `amountPaise > 0`
  - type and direction must agree (`RECHARGE`/`REFUND` = credit, `ORDER_DEBIT` = debit)
  - a `COMPLETED` row must have a balance and completion time, and no other status may
  - `idempotencyKey` is unique
  - `(orderId, type)` is unique, which allows at most one debit and one refund per order
- **Every row has `isSimulated`.** It's `true` for everything in this release, and descriptions
  say "simulated — test mode".

## Recharge lifecycle

```
Student → POST /wallet/recharges { amountPaise }  (Idempotency-Key)
   server: validate amount, limits, provider configured
   server: PaymentAttempt PENDING (expires in 15 min) + WalletTransaction RECHARGE PENDING
   ← 201 { recharge, nextAction: MOCK_SIMULATOR }
Student picks an outcome in the clearly labelled "Test payment simulator"
   → POST /payments/mock/:id/outcome { SUCCESS | FAILURE | CANCEL }
   server, one transaction:
     claim:  UPDATE attempt SET status=… WHERE id=… AND status='PENDING' AND not expired
             (0 rows → already settled or expired → return current state, change nothing)
     SUCCESS → credit: UPDATE wallet … WHERE balance + amount <= cap
               → ledger row COMPLETED with balanceAfter
               (cap exceeded at this moment → attempt FAILED, nothing credited)
     FAILURE / CANCEL → attempt and ledger row FAILED / CANCELLED, no credit
   ← { changed, recharge, wallet }
```

Pending attempts past `expiresAt` become `EXPIRED`. This is checked lazily when the user's wallet
data is next read, with no background timers.

**Why a recharge can only ever be credited once:**

1. Starting a recharge with the same `Idempotency-Key` returns the same attempt, and the key is
   unique per user. Reusing it with a different amount gives `409 IDEMPOTENCY_KEY_REUSED`.
2. Only the request that moves the attempt out of `PENDING` can credit. PostgreSQL serialises
   concurrent `UPDATE`s of that row, so every other request updates 0 rows.
3. The recharge's ledger row is unique per attempt (`paymentAttemptId` and
   `idempotencyKey = recharge:<attemptId>`).

**Tests:** `wallet.test.ts` covers success, failure and cancel, repeated and concurrent outcomes,
expiry, limits, and privacy.

## Wallet payment at checkout

The whole of checkout is **one database transaction** (`orders/checkout.service.ts`):

1. Lock the student's cart row (`SELECT … FOR UPDATE`). Concurrent checkouts of the same cart
   queue here.
2. If an order with this `Idempotency-Key` already exists, return it. This covers double-clicks
   and retries.
3. Re-validate: the cart isn't empty, the outlet is active and `OPEN`, and every item is active,
   in an active category, available, and from that outlet.
4. Price everything on the server from the live menu. If the total differs from
   `expectedTotalPaise`, return `409 PRICE_CHANGED` with the new total.
5. Take the next pickup number for the outlet that day (atomic upsert; IST calendar day).
6. Create the order, order-item snapshots and the first status-history row.
7. **Wallet only:**
   `UPDATE "Wallet" SET balance = balance − total WHERE id = … AND balance >= total`.
   - 0 rows means `409 INSUFFICIENT_BALANCE` with the balance and shortfall, and the **whole
     transaction rolls back**: no order, no debit, cart unchanged, pickup number not consumed.
   - Otherwise it writes the `ORDER_DEBIT` ledger row, and the order is `PAID`.
8. Empty the cart. Commit.

**Two simultaneous orders against one balance:** the `UPDATE … WHERE balance >= total` locks the
wallet row. The second debit waits, then re-evaluates the condition against the reduced balance and
fails cleanly if there isn't enough. The `CHECK (balancePaise >= 0)` would reject any bug that slipped
past.

**Tests:**

- `wallet.test.ts`: 10 parallel ₹30 debits against ₹100, where exactly 3 succeed.
- `checkout.test.ts`:
  - parallel checkouts give one order
  - same-key duplicates give one order and one debit
  - a database failure injected _after_ the debit leaves no order, no debit, the balance unchanged
    and the cart intact

## Refunds (Phase 6)

**When:** a wallet-paid order that is **REJECTED** (manager), **CANCELLED by a manager** after
accepting, or **CANCELLED by the student** while PLACED is refunded in full **automatically**, in
the same transaction as the status change:

1. A conditional update moves the order. If someone else changed it first, this request fails
   with `409 ORDER_CHANGED` and nothing is refunded.
2. The original `ORDER_DEBIT` row is read, and is **never modified**.
3. The amount is credited back. The refund is **not** limited by the ₹5,000 cap, because money
   already paid must always be returnable.
4. A new `REFUND` row is written, linked by `reversesTransactionId`, with
   `idempotencyKey = order-refund:<orderId>`.
5. The order becomes `paymentStatus = REFUNDED`.
6. Staff actions are audited (`ORDER_REJECTED` / `ORDER_CANCELLED_BY_STAFF`, with the reason and
   amount).

**Never twice:** `unique(orderId, type)` and the conditional status update make a second refund
impossible. Three simultaneous reject/cancel attempts produce exactly one refund (tested).

**Not refunded:**

- Orders that reach READY or COMPLETED. There's no transition to cancel them.
- Partial refunds.
- Orders already paid at the counter. They can't be cancelled in the app, and cash refunds happen
  offline.
- Unpaid counter orders that are cancelled become `VOID`, and the wallet isn't touched.

## Pay at the counter

- The order is created with `paymentStatus = PENDING_COUNTER`. It's **never** marked paid just by
  being created.
- A database CHECK allows only compatible combinations: `WALLET` with `PAID`/`REFUNDED`, and
  `COUNTER` with `PENDING_COUNTER`/`PAID`/`VOID`.
- The student can't change payment status. There's no such field or endpoint.
- **Recording the payment (Phase 7):** only POS staff assigned to the outlet can record it, after
  the order is accepted, for exactly the order total, once per order. It's audited.
- **On screen:** the POS screen asks the cashier to confirm they have _actually received_ the
  money first.
- **Completing the order:** until payment is recorded, the order **can't be marked COMPLETED**
  (`409 PAYMENT_REQUIRED`). Once it's paid at the counter, it can't be cancelled in the app.

## Provider abstraction (adding a real provider later)

`modules/payments/providers.ts` defines `RechargeProvider`:

- `name`
- `isSimulated`
- `prepareRecharge(amount)`, which returns the provider reference and the browser's next action

The wallet service owns all money rules and calls the provider only to prepare a payment. Outcomes
reach `settleRecharge()`, which applies them idempotently.

To add a real provider, for example Razorpay, **after approval**:

1. Implement `RechargeProvider` to create a provider-side order, with credentials only in
   `backend/.env`.
2. Add a webhook route that **verifies the provider's signature** and then calls `settleRecharge()`
   with the verified outcome. A browser redirect is never treated as proof of payment.
3. Map the provider's pending, uncertain and failed states. The webhook may arrive more than once,
   and that's already safe.
4. Keep separate test and live keys, set `isSimulated = false` for real attempts, and never store
   card numbers, UPI PINs or CVVs. A provider-hosted checkout means CampusCart never sees them.
5. Do a real end-to-end test before calling it working.

**Mock mode safety:**

- `PAYMENT_MOCK_ENABLED=true` with `NODE_ENV=production` stops the server from starting.
- `rechargeProviderFor()` also returns no provider in production.
- When mock mode is off, the simulator route isn't mounted at all (404) and recharge returns
  `503 RECHARGE_UNAVAILABLE`.

All of this is tested in `wallet.test.ts` and `env.test.ts`.

## Limits and configuration

| Variable                    | Default  | Meaning                                                                                                |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `PAYMENT_MOCK_ENABLED`      | `false`  | Turns on the test-mode simulator. Refused in production                                                |
| `WALLET_RECHARGE_MIN_PAISE` | `9900`   | Minimum per recharge. **₹99 is a fixed floor in code**: a lower value is ignored, a higher one applies |
| `WALLET_RECHARGE_MAX_PAISE` | `200000` | ₹2,000 maximum per recharge                                                                            |
| `WALLET_MAX_BALANCE_PAISE`  | `500000` | ₹5,000 maximum balance                                                                                 |

Wallets don't expire, and there are no transfers between wallets or manual adjustments. Those were
not approved.

## Loyalty points

Students earn points for recharging certain exact amounts, and spend them as a discount on
orders. **1 point = ₹1 off an order.** Points are not money: they are kept apart from the wallet
balance, can't be withdrawn or transferred, and are shown separately everywhere. Every point earned
so far comes from **simulated** test-mode recharges and is marked `isSimulated`.

All the numbers live in one module, `backend/src/modules/loyalty/loyalty.rules.ts`. The API sends
the bonus table to the app for previews, so it isn't copied into the frontend.

### Earning: recharge bonuses

| Recharge (exactly) | Bonus points | Worth |
| -----------------: | -----------: | ----: |
|               ₹500 |           10 |   ₹10 |
|             ₹1,000 |           25 |   ₹25 |
|             ₹1,300 |           30 |   ₹30 |
|             ₹1,500 |           40 |   ₹40 |

- **Any other amount earns 0 points.** There is no rounding and no "nearest slab": ₹99, ₹501 and
  ₹1,400 earn nothing.
- The bonus is fixed and stored on the payment attempt (`PaymentAttempt.bonusPoints`) when the
  recharge starts, so the student gets exactly what the screen promised.
- Points are awarded **only** inside the same transaction that credits a recharge verified as
  SUCCEEDED. Starting a recharge, or a pending, failed, cancelled, expired or over-the-cap
  recharge, awards nothing.
- **Exactly once:** settlement first claims the attempt (only one caller can move it out of
  PENDING), and the points ledger has a unique `paymentAttemptId`. Repeated or concurrent
  callbacks can't award twice.
- Earlier recharges made before this feature earn nothing retroactively.

### Spending: redemption at checkout

- The student chooses how many points to use. The server checks:
  - **eligible amount:** the whole order subtotal (CampusCart has no taxes or fees), but **at
    least ₹1 is always paid with money**, so the most points usable is `subtotal − ₹1`, in whole
    rupees;
  - **balance:** a conditional `UPDATE … SET pointsBalance = pointsBalance − n WHERE pointsBalance >= n`.
- Points are taken in the **same transaction** as the order, the wallet debit (or the unpaid
  counter order) and the cart clearing. If anything fails, nothing is saved and no points are lost.
- **No double spending:** the cart lock serialises a student's checkouts, the conditional update
  re-checks the balance after waiting for the row lock, the same idempotency key returns the
  original order without spending again, and the database refuses a negative balance.
- The order stores `pointsRedeemed` and `pointsDiscountPaise`; CHECK constraints keep
  `discount = points × ₹1` and `total = subtotal − discount`. The wallet is debited, or the counter
  collects, only the discounted total.
- Both payment methods can use points.

### Getting points back

When an order ends REJECTED or CANCELLED, the points spent on it are returned in the same
transaction as the status change (and the wallet refund, for wallet-paid orders). Completed orders
keep their discount.

**Exactly once:** the status change is version-checked and can happen only once, and the points
ledger allows one restoration per order (`unique(orderId, type)`).

### The points ledger

`LoyaltyTransaction` rows are never modified. Every change to `Wallet.pointsBalance` has one:

| Type              | Direction | Linked to                                 | Idempotency key             |
| ----------------- | --------- | ----------------------------------------- | --------------------------- |
| `EARNED_RECHARGE` | CREDIT    | the payment attempt                       | `loyalty-earn:{attemptId}`  |
| `REDEEMED_ORDER`  | DEBIT     | the order                                 | `loyalty-redeem:{orderId}`  |
| `RESTORED_ORDER`  | CREDIT    | the order, and the redemption it reverses | `loyalty-restore:{orderId}` |

Each row stores `pointsBalanceAfter`. Students see their own history at `GET /wallet/points` and
on the wallet page ("Points activity").

### Manual test

1. Sign in as a student and open **Wallet**. Money and loyalty points are shown in separate cards.
2. Type `98` and press **Add**: the form refuses it (minimum ₹99). The server refuses it too.
3. Type `1400`: the preview says no bonus. Choose **₹1,000 +25 points**: the preview says 25 points.
4. Press **Add ₹1,000**, then **Simulate failed payment**: no money and no points.
5. Repeat with **Simulate successful payment**: ₹1,000 and 25 points, a "Recharge bonus" row in
   Points activity, and a toast saying the points were earned (test mode).
6. Add ₹40 of items from an outlet and open **Checkout**. Enter 20 points: the ticket shows
   −₹20 and "To pay ₹20". Enter more than allowed: the button is disabled with an explanation.
7. Pay. The order shows the discount and "Total paid ₹20". The wallet shows ₹980 and 5 points.
8. Cancel the order. The wallet shows ₹1,000 and 25 points again, with "Used at checkout" and
   "Returned (order cancelled)" rows.

## Scheduled-order fee

A scheduled order adds a fixed ₹10 to the order total. It is calculated on the server and paid in
the same wallet debit or counter payment as the food, so the debit always equals the stored total.

When a paid scheduled order is rejected or cancelled, the food is refunded but the ₹10 fee is
**kept** (business decision, 2026-10-17): the REFUND entry is the total minus ₹10, and its
description says so. This is the only exception to the full-refund policy; orders placed for now
are refunded in full. The rule is `REFUND_SCHEDULED_FEE_ON_CANCEL = false` in
`backend/src/modules/scheduling/scheduling.rules.ts`. See [scheduled-orders.md](scheduled-orders.md).

## Group shares and peer transfers

- **Group trays:** each member pays their own share to CampusCart (`GROUP_SHARE_PAYMENT`, one per
  share). The group's order (`paymentMethod GROUP`) is placed only once every share is paid.
  Refunds reverse each member's own payment (`REFUND`, unique `reversesTransactionId`).
- **Peer splits:** a repayment debits the payer (`PEER_TRANSFER_OUT`) and credits the expense
  owner (`PEER_TRANSFER_IN`, subject to the owner's wallet cap) in one transaction. Cancelling a
  split reverses each repayment with linked `REVERSAL` entries.
- **Simulated:** all of this is simulated money. Person-to-person transfers on a closed campus
  wallet need regulatory and finance review before real money is involved.

See [group-dining.md](group-dining.md).
