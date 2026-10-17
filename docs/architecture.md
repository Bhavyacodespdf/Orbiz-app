# CampusCart architecture

## Overview

```
Browser (React SPA) ──HTTPS + session cookie──► Express API /api/v1 ──Prisma──► PostgreSQL
        ▲                                             │
        └────────── Socket.IO (same cookie) ◄─────────┘   events sent only after a DB commit
```

CampusCart is a **modular monolith**: one backend process whose code is split into feature
modules, plus a separate React single-page app.

**The database is the source of truth.** The browser never decides prices, balances, payment
results or permissions. It shows what the API returns. Socket events only say "something changed,
fetch it again".

In development the browser talks only to Vite (port 5173). Vite proxies `/api` and `/socket.io` to
the backend (port 4000), so cookies are same-origin. Production should keep that same shape, with
the frontend and API on one site behind a reverse proxy.

## Backend (`backend/src`)

**Request pipeline** (`app.ts`, in order):

1. Pino request logging (secrets redacted)
2. Helmet security headers
3. CORS restricted to `FRONTEND_URL`
4. 100 kB JSON limit
5. Cookie parsing
6. CSRF check (custom header plus origin) on every state-changing call
7. Session loading
8. Per-user rate limit on money and order actions
9. Routes
10. 404 handler
11. Central error handler: errors are always `{ error: { code, message, details? } }`, and
    unexpected errors become a generic 500

**Modules** (`modules/`). Each has its routes, service functions and Zod schemas, with tests
alongside.

| Module       | Responsibility                                                                                                                                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`       | Google OAuth with PKCE, state and nonce; account provisioning (allowlists, no email linking); hashed server sessions; developer login (non-production)                                                                                                                                                   |
| `users`      | Profile; audited role grant and revoke (service, CLI, admin API); admin user list; audit log reads                                                                                                                                                                                                       |
| `outlets`    | Public browsing and search; assigned-staff menu management; admin outlets and staff assignment                                                                                                                                                                                                           |
| `cart`       | One-outlet cart that stores IDs and quantities only and is priced live; atomic, idempotent combo add                                                                                                                                                                                                     |
| `scheduling` | Scheduled orders: IST pickup hours and slot generation, slot validation and capacity, the ₹10 fee rule, rescheduling ([scheduled-orders.md](scheduled-orders.md))                                                                                                                                        |
| `groups`     | Group trays: members, contributions, exact split formulas, frozen checkouts, per-member wallet payments, one order when all have paid, share refunds ([group-dining.md](group-dining.md))                                                                                                                |
| `banquets`   | Banquet bookings: outlet rules, hours and clash checks, price snapshots, manager decisions, event passes                                                                                                                                                                                                 |
| `splits`     | Peer splits: wallet-to-wallet repayments with locking, idempotency and reversals                                                                                                                                                                                                                         |
| `planning`   | Weekly Stock Planner: demand history from orders and the stock ledger, baseline forecasts, versioned plans with overrides and approval, restocks through the inventory service, RL experience records, offline training with holdout validation, scheduled jobs ([stock-planning.md](stock-planning.md)) |
| `capacity`   | Order capacity: at most 10 orders per outlet in any rolling 3 minutes, enforced under a per-outlet database lock at checkout ([order-capacity.md](order-capacity.md))                                                                                                                                    |
| `noshow`     | Scheduled-order no-shows: 10-minute grace, per-item refund and restock rules, the background worker, admin retry ([no-show-policy.md](no-show-policy.md))                                                                                                                                                |
| `inventory`  | Menu item stock: derived status rules, staff stock APIs, atomic order deduction and one-time restoration, stock history ([stock.md](stock.md))                                                                                                                                                           |
| `surprise`   | Surprise Meal budget solver: deterministic combo engine, optional validated AI step ([surprise-meal.md](surprise-meal.md))                                                                                                                                                                               |
| `orders`     | Transactional checkout; pickup codes; order lifecycle with refunds; staff queue; counter payments                                                                                                                                                                                                        |
| `wallet`     | Wallet and ledger primitives (atomic conditional credit and debit); recharge lifecycle; history                                                                                                                                                                                                          |
| `payments`   | `RechargeProvider` interface; mock adapter; test-only simulator route                                                                                                                                                                                                                                    |
| `polls`      | Today's Special voting: poll lifecycle, votes, server-side winner selection and tie resolution ([todays-special.md](todays-special.md))                                                                                                                                                                  |
| `health`     | `GET /health` with a database check                                                                                                                                                                                                                                                                      |

**Authorisation:**

- `requireAuth`, `requireRole(...)`: roles are re-read from the database on every request.
- `requireOutletRole(...)`: the live role **and** an assignment to the outlet in the URL.
- Every lookup is also scoped by owner or outlet, so another user's or outlet's ID returns 404.

**Money:**

- Integer paise everywhere.
- Balance changes are conditional `UPDATE`s inside the same transaction as their ledger row.
- Idempotency keys and unique constraints make retries safe.
- CHECK constraints are the last line of defence.

[wallet-and-payments.md](wallet-and-payments.md) has the full design.

**Real-time** (`realtime/`):

- **Handshake:** the session cookie plus a check that the origin is our own site.
- **Rooms**, assigned by the server only:
  - `user:{id}`
  - `session:{id}`
  - `outlet:{id}:staff`, only for a live role plus an assignment
- **Events** go out through `RealtimePublisher`. Routes call it **after** their transaction
  returns, and payloads contain IDs, status and a version only.
- **Poll events** (`poll.updated`): status changes go to everyone; vote activity only to the
  outlet's staff room, throttled to one per second per poll.
- **Access changes** (grants, assignments, archiving) resync a connected user's rooms.
- **Revocation** disconnects immediately through the admin API. Other session endings (CLI
  revocation, expiry, suspension) are caught by a 60-second re-check.
- **Wiring:** in `server.ts`, Express is the HTTP server's handler and Socket.IO is attached
  afterwards, so it owns `/socket.io` (WebSocket and long-polling). A deferred publisher bridges
  the two.

**Configuration** (`config/env.ts`):

- Every variable is validated once at startup.
- Production refuses mock payments, the developer login and missing Google credentials.

## Frontend (`frontend/src`)

- **Routing** (`app/router.tsx`):
  - student shell at `/`: home, outlet menus, cart, checkout, orders, wallet, profile
  - `/manage` for managers, `/pos` for POS, `/admin` for admins
  - `/login`
  - `/design`, development only
  - guards (`RequireAuth`, `RequireRole`) shape the UI only; the API enforces everything
- **Server state:** TanStack Query hooks in `services/` validate every response with Zod. 4xx
  responses aren't retried.
- **Cache on user switch:** sign-in and sign-out drop the previous user's cached data but keep the
  current-user entry, so long-lived watchers such as the live connection see the change. Signing
  out navigates to the public home page **before** ending the session, so a protected page's guard
  can't bounce the user to the login page.
- **Live updates** (`services/realtime.ts`):
  - one socket while signed in, with an honest connection state
  - refetches everything on (re)connect, and invalidates queries on events
  - ignores stale versions and events from a previous connection
- **Money-moving actions** (checkout, recharge) send an `Idempotency-Key` created once per user
  intent, so retries can't double-charge.
- **Design system:** tokens in `styles/index.css`, components in `components/`. See
  [design-system.md](design-system.md).

## Testing

| Layer                    | Where                                        | What it proves                                                                        |
| ------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| Backend unit/integration | `backend/src/**/*.test.ts` (real test DB)    | Rules, permissions, concurrency, refunds, sockets, route-protection inventory         |
| Frontend unit/component  | `frontend/src/**/*.test.tsx` (mocked API)    | Screens, guards, forms, error/empty/loading states, real-time client logic            |
| End-to-end               | `frontend/e2e/` (Playwright, Chrome, e2e DB) | Full journeys across student, cashier and manager; responsive and accessibility sweep |

Test databases are protected by name guards: `_test` for unit tests and `_e2e` for the E2E reset.
