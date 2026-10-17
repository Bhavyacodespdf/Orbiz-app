# CampusCart implementation plan

This records the Phase 0 architecture plan, **approved on 2026-10-16 with all recommended
decisions (Q1–Q9)**. Later phases must follow it. Changes need explicit approval and are logged at
the bottom.

## Phase roadmap

Each phase ends with a report and stops for explicit approval before the next phase.

| Phase | Scope                                                                         | Status                                                |
| ----- | ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| 0     | Architecture and planning                                                     | ✅ Approved                                           |
| 1     | Project foundation: workspace, backend, frontend, Prisma, tests, health       | ✅ Approved                                           |
| 2     | Design system and app shells (Student / Manager / POS / Admin)                | ✅ Approved                                           |
| 3     | Google OAuth, sessions, roles, allowlists, admin CLI, protected routes        | ✅ Approved (real Google sign-in verified 2026-10-16) |
| 4     | Outlets, categories, menu items, search, menu management, dev seed            | ✅ Approved                                           |
| 5     | 5a cart, checkout, pay-at-counter · 5b wallet, mock recharge, wallet checkout | ✅ Approved                                           |
| 6     | Order history, status transitions, Socket.IO, reconnection recovery           | ✅ Approved                                           |
| 7     | Manager, POS and Admin interfaces, counter payments, audit log                | ✅ Approved                                           |
| 8     | Integration, security review, responsive and accessibility refinement         | ✅ Approved                                           |
| 9     | Final verification and documentation                                          | ✅ Done, awaiting your review                         |

## Approved decisions

| #   | Decision                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | New wallets start at **₹0**. Dev seed data gets balances only through real mock recharges via the service, never by writing balances directly.                                                                                                                         |
| Q2  | Recharge min **₹10**, max **₹2,000** per recharge, wallet cap **₹5,000**, all env-configurable. Presets ₹100 / 200 / 500 / 1,000, plus a custom amount.                                                                                                                |
| Q3  | A **dev/test-only login route** for local work and Playwright, requiring `NODE_ENV≠production` and `DEV_LOGIN_ENABLED=true`. The server refuses to start in production if it's enabled (already enforced in `env.ts`). Labelled in the UI.                             |
| Q4  | Allowlists grant MANAGER/POS **only when a new account is created** with a Google-verified email on the list. For existing accounts, an Admin grants the role, and only to allowlisted emails (the list is the ceiling). Changing a list never changes existing users. |
| Q5  | Manager, POS and Admin accounts **keep the STUDENT role** (cart, wallet, ordering).                                                                                                                                                                                    |
| Q6  | Wallet-paid orders are **automatically fully refunded to the wallet** when REJECTED or CANCELLED before READY. No refunds after READY or COMPLETED, no partial refunds, no manual adjustments. A counter-paid order can't be cancelled in-app.                         |
| Q7  | **No taxes, fees or discounts.** Menu prices are final and inclusive.                                                                                                                                                                                                  |
| Q8  | **No Docker.** Use the local Homebrew PostgreSQL 16 with databases `campuscart_dev` and `campuscart_test`.                                                                                                                                                             |
| Q9  | Late-Night Diner palette (cream `#FDFBF7`, chili `#C83E2A`, mustard `#E6A133`, espresso `#2B1E1A`), **Bricolage Grotesque** headings and **Figtree** body (self-hosted), a per-outlet daily **pickup code**, no QR.                                                    |

## Core technical decisions

- **Money:** integer **paise** everywhere (`Int`, ₹1 = 100), `currency = 'INR'`, never floats.
- **Sessions:** server-side sessions in PostgreSQL. The cookie holds a random 256-bit token
  (`HttpOnly`, `SameSite=Lax`, `Secure` in production) and the DB stores only its SHA-256 hash.
  Roles are re-read from the DB on every request, so revocation is immediate.
- **CSRF:** SameSite=Lax, a strict `Origin` check, and a required
  `X-Requested-With: CampusCart` header on state-changing requests.
- **Google OAuth:** server-side Authorization Code flow with PKCE, `state` and `nonce`, via
  `google-auth-library`. Accounts are keyed by Google `sub`, **never auto-linked by email**. Any
  email domain can register as a Student. Unverified emails are never given privileged roles.
- **First Admin:** server-side CLI `npm run admin:grant -w backend -- --email …`. The user must
  have signed in once with a verified Google email, and the action is audited. There's no public
  admin registration.
- **Role revocation:** an Admin revokes the role, which records a reason, deletes sessions and
  disconnects sockets. The revoked row blocks automatic re-granting.
- **Wallet ledger:** `Wallet.balancePaise` (CHECK ≥ 0) plus an immutable `WalletTransaction`
  ledger, changed in the same DB transaction. Debits use a conditional
  `UPDATE … WHERE balance >= amount`, which makes overspending impossible under concurrency.
  `unique(orderId, type)` allows one debit and one refund per order.
- **Idempotency:** every money-moving POST requires an `Idempotency-Key`. Unique constraints turn
  retries into "return the existing result".
- **Mock payments:** the outcome route is only mounted when `PAYMENT_MOCK_ENABLED=true`. Every
  mock row has `isSimulated = true` and the UI labels it "Simulated, not real money". Production
  refuses to start with mock enabled (already enforced).
- **Real-time:** Socket.IO authenticated by the session cookie. The server assigns rooms
  (`user:{id}`, `outlet:{id}:staff`) and clients can't choose them. Events carry minimal payloads
  and are sent only after commit. Clients refetch over REST on every (re)connect.

## Order and payment states

```
Order:   PLACED → ACCEPTED → PREPARING → READY → COMPLETED
         PLACED → REJECTED                      (staff, reason required)
         PLACED → CANCELLED                     (student, only while PLACED)
         ACCEPTED | PREPARING → CANCELLED       (manager only, reason required)

         READY → NO_SHOW                        (scheduled only, system, 10 min after the slot)

Payment: PENDING_COUNTER | PAID | REFUNDED | PARTIALLY_REFUNDED | VOID
```

## Business rules

| Rule                    | Decision                                                              |
| ----------------------- | --------------------------------------------------------------------- |
| Closed or paused outlet | Menu is browsable; checkout rejected                                  |
| Outlets per cart        | One. Adding from another outlet asks before clearing                  |
| Unavailable item        | Checkout rejected (409) listing the items                             |
| Price changed           | Checkout rejected (409 PRICE_CHANGED); student re-confirms            |
| Quantities              | 1–10 per item, at most 20 distinct items                              |
| Menu deletion           | Never hard-deleted. Deactivated; orders keep name and price snapshots |
| Wallet expiry/transfers | None                                                                  |
| Retention               | Orders, ledger and audit log kept indefinitely                        |
| Counter payment         | POS for an assigned outlet only, once per order, audited              |
| Completing an order     | Only when paid (counter orders need the POS to record payment first)  |
| Refunds and wallet cap  | Refunds always go through, even above the ₹5,000 cap                  |

## Permissions summary

| Capability                                  | Student | Manager  |         POS          | Admin |
| ------------------------------------------- | :-----: | :------: | :------------------: | :---: |
| Browse; own cart, orders and wallet         |   ✅    |    ✅    |          ✅          |  ✅   |
| Outlet order queue                          |   ❌    | assigned |       assigned       | read  |
| Accept / advance order status               |   ❌    | assigned | assigned (no reject) |  ❌   |
| Reject, or cancel after accept              |   ❌    | assigned |          ❌          |  ❌   |
| Record counter payment                      |   ❌    |    ❌    |       assigned       |  ❌   |
| Menu and prices                             |   ❌    | assigned |  availability only   |  ❌   |
| Outlet open/closed                          |   ❌    | assigned |          ❌          |  ✅   |
| Outlets, staff assignment, roles, audit log |   ❌    |    ❌    |          ❌          |  ✅   |
| Change any wallet balance                   |   ❌    |    ❌    |          ❌          |  ❌   |

## Change log

- 2026-10-16: Plan approved (Q1–Q9 as recommended). Phase 1 started.
- 2026-10-16: Phase 1 approved. Phase 2 started.
- 2026-10-16: Phase 2 approved. Phase 3 started. Wallet creation at sign-up moved to Phase 5 (no wallet tables yet).
- 2026-10-16: Real Google sign-in verified manually. Phase 4 started.
- 2026-10-16: Phase 4 built the staff menu-management and admin outlet APIs (tested). Their screens remain in Phase 7, as planned.
- 2026-10-16: Phase 4 approved. Phase 5 started.
- 2026-10-16: Phase 5 added `GET /orders/:id` early, so the confirmation page shows a persisted order. The order list, transitions and refunds remain Phase 6. Wallets are created on first use (₹0) instead of at sign-up.
- 2026-10-16: Phase 5 approved. Phase 6 started.
- 2026-10-16: Phase 6 proposes two rules for approval. (1) READY → COMPLETED requires the order to be paid, so counter orders need the Phase 7 payment recording first. (2) Refunds aren't limited by the ₹5,000 wallet cap.
- 2026-10-16: Both Phase 6 rules approved: COMPLETED requires the order to be PAID, and refunds aren't limited by the wallet cap.
- 2026-10-16: Phase 6 approved. Phase 7 started.
- 2026-10-16: Phase 7 approved. Phase 8 started.
- 2026-10-16: Phase 7 used `POST …/roles/:role/revoke` (with a reason body) instead of `DELETE` for admin revocation, so a reason can always be sent. Admins can't remove their own Admin role.
- 2026-10-16: Phase 8 approved. Phase 9 started.
- 2026-10-16: Phase 9 setup check, following the README on a fresh copy of the repository,
  found that `npm install` failed before `.env` existed, because Prisma's config required
  `DATABASE_URL` just to generate the client. Fixed, so only commands that connect need it. The
  README also now raises `MONEY_RATE_LIMIT_PER_MIN` in `.env.test`.
- 2026-10-16: Today's Special voting designed and approved: manager-only management through
  existing outlet assignments, ties resolved by the manager among the tied dishes (disclosed to
  students), no special when nobody votes, live counts hidden from students by default.
- 2026-10-17: Today's Special voting built in five phases (database and API, student UI, manager
  UI, real-time, tests and docs). See [todays-special.md](todays-special.md).
- 2026-10-17: Wallet recharge minimum raised to ₹99 (a fixed floor in code; whole rupees only) and
  loyalty points added: exact-slab recharge bonuses (₹500→10, ₹1,000→25, ₹1,300→30, ₹1,500→40,
  otherwise 0), 1 point = ₹1 at checkout with at least ₹1 always paid, allowed for wallet and
  counter orders, and returned once when an order is rejected or cancelled. See
  [wallet-and-payments.md](wallet-and-payments.md#loyalty-points).
- 2026-10-17: AI Surprise Meal — Budget Solver added (see [surprise-meal.md](surprise-meal.md)).
  No AI provider is bundled: combos come from a deterministic engine, with an optional,
  validated AI step for later. Menus have no nutrition or prep-time data, so none is shown.
- 2026-10-17: Menu item stock added (see [stock.md](stock.md)). Counting is opt-in per item (no
  quantities were invented for existing items). Stock is taken atomically when an order is
  placed (the same transaction as payment) and returned once if the order is rejected or
  cancelled. The existing "sold out" switch is the manual override.
- 2026-10-17: Scheduled orders added (see [scheduled-orders.md](scheduled-orders.md)). Outlets
  had no opening hours, so managers now set pickup hours. Until they do, no slots are offered. The
  fixed ₹10 fee is part of the order total and paid at placement.
- 2026-10-17: Decision: the ₹10 scheduled-order fee is kept when a scheduled order is cancelled
  or rejected. The refund is the total minus ₹10; the food is still refunded in full.
- 2026-10-17: Scheduled-order no-show policy added (see [no-show-policy.md](no-show-policy.md)).
  Ready scheduled orders not collected within 10 minutes are settled per item by a background
  worker: packaged items 90% refunded and restocked, handmade items not refunded, the ₹10 fee
  kept. Menu items are classified by managers; unclassified items count as handmade.
- 2026-10-17: Order capacity added (see [order-capacity.md](order-capacity.md)). Each outlet takes
  on at most 10 orders in any rolling 3 minutes, counted once at checkout (the acceptance event)
  under a per-outlet PostgreSQL lock. Refused checkouts get `429 ORDER_CAPACITY_FULL` with a
  retry time; nothing is created or charged.
- 2026-10-17: Weekly Stock Planner added (see [stock-planning.md](stock-planning.md)). Demand
  history is recomputed from orders and the stock ledger, with stockout days marked censored. A
  weekday-pattern baseline forecasts next week, and plans recommend forecast + safety stock − stock
  on hand for human review, approval and recorded restocks. Approved lines are stored as RL
  experience with outcomes and rewards after the week. A learned policy can be trained and
  validated offline on demand, but none is active: there isn't enough real data yet.
- 2026-10-17: Group Repast & Splits added (see [group-dining.md](group-dining.md)). Decisions:
  - Group trays are paid "shares first, then order": each member pays their own share to
    CampusCart, and one order is placed when all have paid. Any refund goes back share by share.
  - Peer splits move money wallet to wallet (simulated funds; real money would need regulatory
    review).
  - Banquet bookings follow per-outlet manager rules and need manager confirmation.
  - The existing styling is kept.
