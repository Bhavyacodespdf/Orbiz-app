# CampusCart database design

PostgreSQL 16, accessed through Prisma 7.

- **Schema:** [`backend/prisma/schema.prisma`](../backend/prisma/schema.prisma).
- **Migrations:** `backend/prisma/migrations/`.
- **IDs:** UUIDs.
- **Money:** always integer paise.

Tables are added phase by phase, following the plan approved in Phase 0. This file lists what
**exists now**.

## Migrations

| Migration                                     | Phase | Contents                                                                                                                                                                       |
| --------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `20261016055152_auth_identity_roles_sessions` | 3     | `User`, `AuthIdentity`, `UserRole`, `Session`, `AuditLog` and their enums                                                                                                      |
| `20261016062420_outlets_menus_staff`          | 4     | `Outlet`, `StaffAssignment`, `MenuCategory`, `MenuItem`, enums, plus hand-written CHECK constraints                                                                            |
| `20261016092819_counter_payments`             | 7     | `CounterPayment`, plus CHECK amount > 0                                                                                                                                        |
| `20261016085209_cart_orders_wallet_payments`  | 5     | `Cart`, `CartItem`, `Order`, `OrderItem`, `OrderStatusHistory`, `OutletDailyCounter`, `Wallet`, `WalletTransaction`, `PaymentAttempt`, enums, plus financial CHECK constraints |

**Commands** (from the repository root):

```bash
npm run db:migrate -w backend
```

That creates and applies a migration in development. Then apply it to the test database:

```bash
npm run db:migrate:test -w backend
```

In production, use `npm run db:migrate:deploy -w backend`. It only applies existing migrations.

Never reset a database without explicit approval.

## Identity, roles and sessions (Phase 3)

```
User 1─┬─* AuthIdentity      (one per provider; unique provider+subject)
       ├─* UserRole          (unique user+role; revocation kept, not deleted)
       ├─* Session           (hashed token; cascade-deleted with the user)
       └─* AuditLog (actor)
```

### `User`

| Column                 | Notes                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `email`                | Unique, lower-cased. **Never used to link sign-ins.**                                    |
| `emailVerified`        | From the provider. Privileged roles require `true`.                                      |
| `displayName`, `phone` | User-editable.                                                                           |
| `avatarUrl`            | From Google.                                                                             |
| `status`               | `ACTIVE` or `SUSPENDED`. Suspended users can't sign in, and their sessions stop working. |

Users are never deleted. Foreign keys to users use `Restrict`.

### `AuthIdentity`

Maps a provider's stable subject (Google `sub`) to a user.

- `provider` is `GOOGLE` or `DEV`. `DEV` is development/test-only and is used by the developer
  login.
- `@@unique([provider, subject])` makes sign-in idempotent, even for concurrent first sign-ins.
- `@@unique([userId, provider])` allows one Google identity per user.

### `UserRole`

One row per user and role.

- `role`: `STUDENT`, `MANAGER`, `POS` or `ADMIN`.
- `grantedVia`: `DEFAULT` (Student), `ALLOWLIST` (only at account creation), `ADMIN` or `CLI`.
- **Revocation** sets `revokedAt`, `revokedById` and `revokeReason`. The row stays as history. An
  explicit re-grant clears those fields.
- **Active roles** are rows with `revokedAt IS NULL`.

### `Session`

| Column              | Notes                                                                |
| ------------------- | -------------------------------------------------------------------- |
| `tokenHash`         | Unique SHA-256 of the cookie token. The raw token is never stored.   |
| `expiresAt`         | Idle expiry: 7 days, extended on use.                                |
| `absoluteExpiresAt` | Hard limit: 30 days.                                                 |
| `userAgent`         | Truncated to 300 characters. Lets a future "your devices" view work. |

Indexed by `userId` (for sign-out everywhere) and `expiresAt`.

### `AuditLog`

Append-only record of sensitive actions.

- **Fields:** `actorType` (`USER`, `SYSTEM` or `CLI`), `actorUserId`, `action`, `entityType`,
  `entityId`, `metadata` (JSON, never secrets), `createdAt`.
- **Actions so far:** `ACCOUNT_CREATED`, `ROLE_GRANTED`, `ROLE_REVOKED`.
- **Indexes:** `(entityType, entityId)` and `createdAt`.

## Outlets and menus (Phase 4)

```
Outlet 1─┬─* MenuCategory 1─* MenuItem
         ├─* MenuItem          (composite FK (categoryId, outletId) → MenuCategory(id, outletId))
         └─* StaffAssignment *─1 User
```

### `Outlet`

| Column     | Notes                                                                       |
| ---------- | --------------------------------------------------------------------------- |
| `slug`     | Unique. CHECK: lower-case words joined by hyphens.                          |
| `name`     | CHECK: not blank.                                                           |
| `status`   | `OPEN`, `PAUSED` or `CLOSED` (default). Only `OPEN` accepts orders.         |
| `isActive` | `false` means archived and hidden from students. Outlets are never deleted. |
| `isSample` | `true` only for rows created by the development seed.                       |

### `StaffAssignment`

Links a user to an outlet as `MANAGER` or `POS`, unique per (user, outlet, role).

- **Access needs both** the active role **and** the assignment. Revoking the role makes old
  assignments inert immediately, and they stay as history.

### `MenuCategory`

- Unique `(outletId, name)`.
- Has an extra unique `(id, outletId)` that serves as the target of the composite foreign key
  from `MenuItem`.
- `isActive = false` hides the category and its items from students.

### `MenuItem`

| Column                   | Notes                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pricePaise`             | Integer paise. **CHECK `> 0`**. The API also limits it to ₹1–₹10,000.                                                                           |
| `(categoryId, outletId)` | Composite FK, so the database itself prevents an item from sitting in another outlet's category.                                                |
| `isAvailable`            | Sold out: still shown to students, but can't be ordered.                                                                                        |
| `isActive`               | Deactivated: hidden from students. **Never deleted**, so past orders can keep pointing at it (Phase 5 orders also snapshot the name and price). |
| `dietary`                | `VEG`, `NON_VEG`, `EGG` or null.                                                                                                                |

Other constraints:

- Unique `(outletId, name)`.
- Indexes on `(outletId, isActive)` and `categoryId`.

## Cart, orders, wallet and payments (Phase 5)

```
User 1─1 Cart 1─* CartItem *─1 MenuItem
User 1─* Order 1─* OrderItem          (name + price snapshots)
             1─* OrderStatusHistory
Outlet 1─* OutletDailyCounter         (pickup numbers per IST day)
User 1─1 Wallet 1─* WalletTransaction ─0..1 PaymentAttempt
                                     ─0..1 Order
```

| Table                | Key rules                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cart`               | One per user (`userId` unique). `outletId` is the single outlet of its items, or null when empty. **Stores no prices.**                                                                                                                                                                                                                             |
| `CartItem`           | Unique `(cartId, menuItemId)`. CHECK `quantity BETWEEN 1 AND 10`.                                                                                                                                                                                                                                                                                   |
| `Order`              | Unique `(userId, idempotencyKey)`, which prevents duplicate orders. Unique `(outletId, pickupDay, pickupNumber)`. CHECKs: totals > 0, `totalPaise = subtotalPaise` (no fees, Q7), currency INR, payment method and status compatible. Indexes `(outletId, status, placedAt)` and `(userId, placedAt)`. `version` lets clients ignore stale updates. |
| `OrderItem`          | `name`, `unitPricePaise`, `quantity`, `lineTotalPaise` copied at purchase. CHECK `lineTotal = unitPrice × quantity`, qty 1–10, price > 0.                                                                                                                                                                                                           |
| `OrderStatusHistory` | Append-only (from, to, actor, role, reason, time). The first row is `PLACED`.                                                                                                                                                                                                                                                                       |
| `OutletDailyCounter` | PK `(outletId, day)`. Incremented with one atomic `INSERT … ON CONFLICT DO UPDATE`.                                                                                                                                                                                                                                                                 |
| `Wallet`             | `userId` unique. **CHECK `balancePaise >= 0`**. Currency INR.                                                                                                                                                                                                                                                                                       |
| `WalletTransaction`  | The ledger. CHECKs: amount > 0; type and direction agree; COMPLETED ⇔ `balanceAfterPaise` and `completedAt` set; balance after ≥ 0. Unique `idempotencyKey`, `paymentAttemptId`, `reversesTransactionId`, `(orderId, type)`.                                                                                                                        |
| `PaymentAttempt`     | Provider `MOCK` only. Unique `providerReference` and `(userId, idempotencyKey)`. CHECK amount > 0. `expiresAt` 15 minutes after creation.                                                                                                                                                                                                           |

Wallets are created lazily on first use with ₹0, so no existing users needed migrating.

## Counter payments (Phase 7)

| Column               | Notes                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `orderId`            | **Unique**: one counter payment per order, so a second one is impossible even under concurrency |
| `amountPaise`        | Equals the order total (checked by the API). **CHECK > 0**                                      |
| `recordedById`       | The POS user who received the money                                                             |
| `note`, `recordedAt` | Optional note; when it was recorded                                                             |

Recording also moves `Order.paymentStatus` from `PENDING_COUNTER` to `PAID` with a conditional
update and writes a `COUNTER_PAYMENT_RECORDED` audit entry, all in one transaction.

## Scheduled orders

Migration `20261017160000_scheduled_orders` adds:

- **`Order` fields:** `timing` (enum `OrderTiming`, default `IMMEDIATE`), `scheduledFor`
  (nullable) and `scheduledFeePaise` (default 0), indexed by `(outletId, scheduledFor)`.
- **`Outlet` settings:** `scheduleLeadMinutes`, `scheduleSlotMinutes`, `scheduleDaysAhead` and
  `scheduleSlotCapacity`.
- **A new `OutletHours` table:** one IST time range per weekday per outlet, unique
  `(outletId, weekday)`.

CHECKs:

- `SCHEDULED` ⇔ `scheduledFor` set
- fee = 1000 for scheduled, 0 for immediate
- `total = subtotal − pointsDiscount + scheduledFee`, replacing the earlier version
- valid settings ranges, and `0 ≤ opens < closes ≤ 1440`

Every existing order already satisfied these as `IMMEDIATE`. See
[scheduled-orders.md](scheduled-orders.md).

## Menu item stock

Migration `20261017140000_menu_item_stock` adds `MenuItem.trackInventory`, `stockQuantity`
(NULL exactly when untracked; 0–100,000), `lowStockThreshold` (0–10,000) and `stockUpdatedAt`,
plus the append-only `StockAdjustment` table. Unique `(orderId, menuItemId, type)` means an order
deducts and restores each item at most once, and a CHECK requires an order for order
adjustments. Existing items stay untracked: no quantities are invented. See [stock.md](stock.md).

## Scheduled-order no-shows

Migrations `20261017180000_scheduled_no_show` and `20261017180100_scheduled_no_show_checks` add:

- enum `FoodFulfillment` (`PACKAGED`, `HANDMADE`); nullable `MenuItem.fulfillmentType` (existing
  items left unclassified) and its per-line snapshot `OrderItem.fulfillmentType`
- `OrderStatus.NO_SHOW` and `PaymentStatus.PARTIALLY_REFUNDED` (the payment-state CHECK now
  allows `WALLET` + `PARTIALLY_REFUNDED`)
- per line: `unsuitableForResale`, `unsuitableReason`, `noShowPaidPaise`, `noShowRefundPaise`,
  `noShowFeePaise`, `noShowRestockedQty`
- `NoShowSettlement` (unique `orderId`, unique `refundTransactionId`, `PROCESSED` | `FAILED`,
  attempts, last error, totals)
- CHECKs: no-show only for scheduled orders; `refund + fee = paid ≤ lineTotal`; restocked quantity
  within the line quantity; non-negative settlement amounts

See [no-show-policy.md](no-show-policy.md).

## Group dining, banquets and peer splits

Migrations `20261017230000_group_dining_and_splits`, `…230100_…_checks` and
`…230200_peer_split_participant_order` add the group tray, banquet and peer split models (see
[group-dining.md](group-dining.md)), the `GROUP` payment method, three wallet ledger types, and
raise `OrderItem.quantity` to 200 so a group order fits each dish on one line.

## Weekly stock planning

Migration `20261017220000_weekly_stock_planning` adds `DemandDaily`, `ForecastRun`, `Forecast`,
`StockPlan`, `StockPlanItem`, `StockPlanRevision`, `PlanningDecision`, `PolicyVersion` and
`PlanningJobRun`, plus `StockAdjustment.planItemId` and a unique `StockAdjustment.idempotencyKey`.
CHECKs and partial unique indexes allow one live plan per outlet and week and one active policy.
See [stock-planning.md](stock-planning.md).

## Order capacity

Migration `20261017200000_outlet_order_capacity` adds `OutletOrderAcceptance` (`orderId` primary
key, `outletId`, `acceptedAt`, index on `(outletId, acceptedAt)`). It holds one row per order an
outlet took on, written in the checkout transaction. See [order-capacity.md](order-capacity.md).

## Surprise Meal

Migration `20261017120000_cart_combo_key` adds one nullable column, `Cart.lastComboKey`: the
idempotency key of the last combo added in one go, so a repeated submission adds nothing. The
budget solver itself stores nothing: no recommendation history, prompts or results.

## Loyalty points

Migrations `20261017090000_loyalty_points` and `20261017090100_loyalty_order_total` are additive.
Existing rows get 0 points, 0 bonus and no discount, and already satisfy every new constraint.

| Change                                              | Notes                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Wallet.pointsBalance`                              | CHECK ≥ 0. Changes only with a `LoyaltyTransaction` row, through a conditional `UPDATE`                                                                                                                                                                                   |
| `PaymentAttempt.bonusPoints`                        | The bonus promised when the recharge started. CHECK ≥ 0                                                                                                                                                                                                                   |
| `Order.pointsRedeemed`, `Order.pointsDiscountPaise` | CHECKs: points ≥ 0; discount = points × 100; `totalPaise = subtotalPaise − pointsDiscountPaise`; when points are used, total ≥ ₹1. The earlier `total = subtotal` CHECK was replaced by the discount-aware one                                                            |
| `LoyaltyTransaction` (new)                          | The points ledger. CHECKs: points > 0; balance after ≥ 0; only `REDEEMED_ORDER` is a DEBIT; each type has exactly its links (attempt, or order, plus the reversed row for a restoration). Unique `idempotencyKey`, `paymentAttemptId`, `reversesId` and `(orderId, type)` |

See [wallet-and-payments.md](wallet-and-payments.md#loyalty-points).

## Today's Special voting

Migration `20261016180000_daily_polls` is additive: three tables, enums `DailyPollStatus` and
`DailyPollOutcome`, CHECK constraints, and a unique key `MenuItem (id, outletId)` that every row
already satisfied (the ID was already unique). See [todays-special.md](todays-special.md).

| Table             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DailyPoll`       | Outlet, IST `day`, status, voting window, `showLiveResults`, lifecycle timestamps, result (`outcome`, `winnerOptionId`, `totalVotes`, `winnerVotes`), `createdById`, `version`. **Unique `(outletId, day)`.** CHECKs: `closesAt > opensAt`; result exists ⇔ FINALIZED; no winner ⇔ `NO_VOTES`; `NO_VOTES` has 0 votes; winner votes between 1 and the total. Winner FK `(winnerOptionId, id) → DailyPollOption (id, pollId)` |
| `DailyPollOption` | A dish in a poll. FKs `(pollId, outletId) → DailyPoll` and `(menuItemId, outletId) → MenuItem`, so a dish from another outlet can't be offered. Unique `(pollId, menuItemId)`                                                                                                                                                                                                                                                |
| `DailyPollVote`   | One row per student per poll: **unique `(pollId, userId)`**. FK `(optionId, pollId) → DailyPollOption`, so a vote can't point at another poll's option. Changing a vote updates the row                                                                                                                                                                                                                                      |

A finalized poll with a winner **is** that outlet's Today's Special for the date; there is no
separate table. Live counts are always `COUNT`s of vote rows.

## Development seed data

```bash
npm run db:seed -w backend
```

- **Refuses to run** unless `NODE_ENV=development` and the database name ends in `_dev`.
- **Creates** 3 fictional outlets (two open, one closed), their categories, and 17 items. One item
  is sold out, to show that state. Every outlet has `isSample = true`.
- **Never overwrites:** it's idempotent and only creates rows that are missing, so edits made in
  the app (prices, availability, status) survive a re-run.
- **Staff assignments:** it assigns users who **already hold** Manager/POS to the sample outlets.
  It never creates users, roles, wallet balances, orders or payments.
- **Audited:** each seed run that changes something writes a `SAMPLE_DATA_SEEDED` audit entry.
- **Empty database:** the app works without the seed. It shows "No outlets yet".

The code is in `backend/src/scripts/sample-data.ts`, with the entry point at `backend/prisma/seed.ts`.

## Deferred from the Phase 0 plan

- **Wallet creation on sign-up** became "created on first use" in Phase 5, at the approved ₹0.
