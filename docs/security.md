# CampusCart security notes

This records the security controls that **are implemented**, how they're verified, and what's
still planned. A control is listed as tested only if an automated test checks it.

## Authentication

| Control                                    | Implementation                                                                                                                                                                                        | Verified by                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Identity from Google, not from the browser | Server-side Authorization Code flow. The ID token's signature, audience, issuer and expiry are verified with `google-auth-library` (`modules/auth/google.ts`)                                         | Code review only. Automated tests use a fake Google, so **real verification awaits a manual test** |
| CSRF on the OAuth redirect                 | Random `state` in a **signed**, HttpOnly, SameSite=Lax, 10-minute cookie scoped to `/api/v1/auth`. Compared in constant time, and single-use                                                          | `auth.google.test.ts`: forged state, missing cookie, tampered cookie, replay                       |
| Code interception                          | PKCE (S256). The verifier never leaves the server                                                                                                                                                     | Code review                                                                                        |
| Token replay                               | `nonce` generated per sign-in and checked against the ID token                                                                                                                                        | `auth.google.test.ts` (nonce mismatch)                                                             |
| Account linking                            | Accounts are keyed by provider + subject (Google `sub`). A new identity whose email belongs to another account is **refused**, never linked                                                           | `auth.google.test.ts`, `provisioning.test.ts`                                                      |
| Any-domain registration                    | No email-domain checks anywhere                                                                                                                                                                       | `auth.google.test.ts`                                                                              |
| Open redirects                             | `returnTo` must be a same-site path (`/…`, not `//…` or `/\…`), otherwise `/`                                                                                                                         | `auth.google.test.ts`, `LoginPage.test.tsx`                                                        |
| Sign-in rate limit                         | `AUTH_RATE_LIMIT_MAX` attempts per IP per 15 minutes on sign-in routes, in memory (single instance)                                                                                                   | `session.test.ts`                                                                                  |
| Developer login                            | Mounted only when `DEV_LOGIN_ENABLED=true` and `NODE_ENV≠production`. The server refuses to start in production with it enabled. Accounts it creates have a `DEV` identity and are labelled in the UI | `session.test.ts`, `env.test.ts`                                                                   |

## Sessions

- **Server-side sessions** in PostgreSQL (`Session` table).
- The cookie holds a random 256-bit token. The database stores only its **SHA-256 hash**, so a
  leaked database doesn't hand out live sessions.
- **Cookie:** `HttpOnly` (invisible to page scripts), `SameSite=Lax`, and `Secure` plus a
  `__Host-` name prefix in production.
- **Expiry:** 7 days idle (extended at most every 15 minutes of activity), and 30 days absolute
  regardless of activity. Expired sessions are deleted when they're next presented.
- **Roles are re-read from the database on every request.** Nothing about permissions is stored in
  the cookie.
- **Logout** deletes the session row and clears the cookie.
- **Role revocation and suspension:** revocation deletes all the user's sessions. Suspended users'
  sessions are rejected.

Verified by `session.test.ts`: hashed storage, idle and absolute expiry, logout, suspension,
revocation.

## CSRF (API)

Every non-GET API request must:

1. carry `X-Requested-With: CampusCart`. HTML forms can't add custom headers, and cross-origin
   scripts can't without a CORS preflight, which we only allow for `FRONTEND_URL`; and
2. if the browser sends `Origin`, come from `FRONTEND_URL`.

This works together with SameSite=Lax cookies. Verified by `session.test.ts`.

## Authorisation

- `requireAuth` and `requireRole(...)` middleware check the server-side session. Role-protected
  routes return **401** when signed out and **403** for the wrong role. Verified by
  `session.test.ts`.
- **Frontend route guards** (`RequireAuth`, `RequireRole`) only shape the UI. The API is the
  boundary.
- **Profile updates** accept only `displayName` and `phone` (strict schema). Attempts to send
  `email`, `roles` or `status` are rejected with 400 (`profile.test.ts`).
- **Outlet scoping:** `requireOutletRole` (`middleware/outlet-access.ts`) requires the live role
  **and** a `StaffAssignment` for the outlet in the URL. Every item and category lookup is scoped
  by `outletId`, so an ID from another outlet returns 404 (`staff.test.ts`, including a check
  that the test catches the scoping being removed).
- **POS limits:** POS can toggle availability, but can't change prices, create items or change
  outlet status (`staff.test.ts`).
- **Database defence in depth:** a CHECK keeps prices positive, and a composite FK stops items
  using another outlet's category (`staff.test.ts`).
- **Audited changes:** outlet create, update and status changes, item creation, price changes,
  item (de)activation, and staff (un)assignment are all audited.

## Privileged roles

- Allowlists grant Manager/POS **only at account creation**, and only for Google-verified emails.
- Later grants go through `npm run roles` and the Admin screens, with the allowlist as a
  ceiling.
- **Admin** is granted only through the CLI or by another admin. It's never granted by an
  allowlist or by sign-in.
- Every grant and revocation is **audited** (`AuditLog`). Revocation requires a reason and
  ends all sessions.
- The last active administrator can't be revoked.

Verified by `roles.test.ts` and `provisioning.test.ts`.

## Money and orders (Phase 5)

| Risk                                                         | Control                                                                                                                                         | Verified by                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Client-supplied prices or totals                             | Cart stores only IDs and quantities. Checkout prices from the live menu. Strict schemas reject `pricePaise`, `paymentStatus` and similar fields | `cart.test.ts`, `checkout.test.ts`                             |
| Duplicate orders or debits (double-click, retry)             | Required `Idempotency-Key`, unique `(userId, key)`, re-checked after taking the cart lock                                                       | `checkout.test.ts` (sequential and concurrent)                 |
| Concurrent overspending                                      | Conditional `UPDATE … WHERE balance >= amount` under a row lock, plus `CHECK balance >= 0`                                                      | `wallet.test.ts`, `checkout.test.ts`                           |
| Orphaned debit after a failure                               | Order, debit, ledger row and cart clearing all in one transaction                                                                               | `checkout.test.ts` (database failure injected after the debit) |
| Duplicate recharge credit                                    | Idempotent start, conditional claim out of PENDING, unique ledger key per attempt                                                               | `wallet.test.ts` (8 concurrent outcomes give 1 credit)         |
| Reading or settling another user's wallet, recharge or order | Every query is scoped by the session user. Foreign IDs give 404                                                                                 | `wallet.test.ts`, `checkout.test.ts`, `cart.test.ts`           |
| Simulated money mistaken for real                            | `isSimulated` on every row; "simulated" in descriptions and the UI; test-mode banner; simulator dialog says "No real money moves"               | `wallet.test.ts` #22, UI tests                                 |
| Mock payments in production                                  | Server won't start; provider lookup returns none; route not mounted when disabled                                                               | `env.test.ts`, `wallet.test.ts` #21                            |
| Counter order treated as paid                                | Created `PENDING_COUNTER`; DB CHECK on method and status; no student endpoint changes it                                                        | `checkout.test.ts` #19                                         |

## Orders and real-time (Phase 6)

| Risk                                       | Control                                                                                                            | Verified by                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Invalid or out-of-order status changes     | A single transition table; anything else is `409 INVALID_TRANSITION`                                               | `transitions.test.ts`                                       |
| Wrong role making a change                 | Rules list roles per transition. POS can't reject or cancel; students can only cancel their own order while PLACED | `transitions.test.ts`                                       |
| Two staff acting at once                   | Conditional update on `(status, version)`; the loser gets `409 ORDER_CHANGED`                                      | `transitions.test.ts`                                       |
| Double refund                              | `unique(orderId, type)` plus the conditional update                                                                | `transitions.test.ts` (3 concurrent attempts give 1 refund) |
| Completing unpaid counter orders           | `PAYMENT_REQUIRED` until payment is recorded                                                                       | `transitions.test.ts`                                       |
| Unauthenticated sockets                    | Session cookie validated at the handshake                                                                          | `socket.test.ts`                                            |
| Cross-site WebSocket hijacking             | Handshake `Origin` must equal `FRONTEND_URL`                                                                       | `socket.test.ts`                                            |
| Subscribing to others' data                | No client-controlled rooms; the server joins `user:`, `session:` and assigned `outlet:` rooms only                 | `socket.test.ts` (join attempts ignored)                    |
| Leaking private data in events             | Payloads carry IDs, status and version only. Wallet events carry no amounts                                        | `socket.test.ts`                                            |
| Events for uncommitted changes             | Published only after the transaction returns. A failed request publishes nothing                                   | `socket.test.ts`                                            |
| Live access after logout or revocation     | Logout disconnects that session; a periodic re-check disconnects revoked or expired sessions                       | `socket.test.ts`                                            |
| Long-polling transport crashing the server | Socket.IO attached after Express so it owns `/socket.io`                                                           | `socket.test.ts` (polling test; it failed before the fix)   |

## Staff and admin consoles (Phase 7)

| Risk                                       | Control                                                                                                                               | Verified by                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Marking orders paid without taking money   | Counter payment is POS-only and outlet-scoped, exact total, once per order (unique), audited; the UI asks for "received" confirmation | `counter-payment.test.ts` (#20), `PosPages.test.tsx` |
| Managers or students recording payments    | `403` for any non-POS caller; there's no student route at all                                                                         | `counter-payment.test.ts`                            |
| Admin lockout                              | No self-removal of Admin; the last admin can't be revoked                                                                             | `admin-users.test.ts`, `roles.test.ts`               |
| Privilege escalation beyond the allowlists | The grant API enforces the allowlist ceiling and a verified email; the UI only offers eligible roles                                  | `admin-users.test.ts`, `AdminPages.test.tsx`         |
| Revoked staff keeping live access          | Revocation ends sessions **and** disconnects sockets immediately                                                                      | `admin-users.test.ts`, `socket.test.ts`              |
| Stale outlet access on live connections    | Assign, unassign and archive resync rooms immediately                                                                                 | `socket.test.ts`                                     |
| Misattributed actions                      | History records the least-privileged role that permitted the step                                                                     | `transitions.test.ts`                                |
| Audit tampering                            | The audit log is read-only over the API; there are no edit or delete routes                                                           | `admin-users.test.ts`                                |
| Data in staff views                        | The queue shows only the customer's display name; email and phone aren't exposed                                                      | `transitions.test.ts`                                |

## General hardening (Phase 1)

- Helmet security headers, `x-powered-by` disabled, a 100 kB JSON body limit, and CORS limited to
  `FRONTEND_URL` with credentials.
- Safe error responses: unexpected errors return a generic 500 and are logged server-side.
- Logs redact cookies, authorization headers, and `password` / `token` / `secret` fields.
- Environment validated at startup. Production refuses mock payments, the developer login, and
  missing Google credentials.

## Phase 8 security review (2026-10-16)

These are the checks actually performed, and their results.

### Static sweeps

| Check                                                                             | Result                                                                                                                        |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Seat-related code                                                                 | None                                                                                                                          |
| Hard-coded emails in application code                                             | Only `you@example.com` in CLI help text. Allowlists come only from env                                                        |
| Hard-coded prices outside the development sample data and tests                   | None                                                                                                                          |
| `dangerouslySetInnerHTML`, `eval`, `innerHTML`, `new Function`                    | None                                                                                                                          |
| Unsafe raw SQL (`$queryRawUnsafe`, `$executeRawUnsafe`)                           | Only in test and e2e reset helpers, with table names read from the catalog. 19 tagged (parameterised) raw queries in app code |
| Secrets in the production frontend bundle (Google secret, DB URL, session secret) | None found                                                                                                                    |
| `VITE_*` variables used                                                           | Only `import.meta.env.DEV`                                                                                                    |
| Real `.env` files tracked by git                                                  | None (all ignored)                                                                                                            |
| `npm audit`                                                                       | 0 vulnerabilities                                                                                                             |

### Automated tests added

- `tests/route-protection.test.ts`, an inventory of **all 46 protected routes**:
  - every one returns 401 when signed out
  - staff and admin routes return 403 for a student
  - every state-changing route returns `CSRF_REJECTED` without the header
  - wallet-adjustment or webhook-style paths that don't exist return 404
- `lib/logger.test.ts`: cookies, authorization headers, idempotency keys and `Set-Cookie`
  headers are redacted from request logs.
- `middleware/rate-limit.test.ts`: per-user limit on money and order actions.

### Defects found and fixed

1. **Missing rate limits on money endpoints.** The Phase 0 plan promised them, but only sign-in
   was limited. Recharges, checkouts, cancellations and payment outcomes are now limited per user
   (`MONEY_RATE_LIMIT_PER_MIN`, default 20).
2. **Proxy trust was fixed to `loopback`.** Behind a reverse proxy on another host, every user
   would have shared one sign-in limit. It's now configurable (`TRUST_PROXY`).
3. **Accessibility: colour contrast.** Sold-out and hidden menu items were faded with opacity
   below WCAG AA. They now use accessible colours, a strikethrough and badges.
4. **Accessibility: accessible name.** The profile chip's accessible name didn't contain its
   visible text. Fixed.

### Production-mode check

The real server was started with `NODE_ENV=production`:

- **Refuses to start** with `PAYMENT_MOCK_ENABLED=true`, with `DEV_LOGIN_ENABLED=true`, and
  without the Google credentials.
- **With a safe config:**
  - `/auth/providers` returns `devLogin: false`; `POST /auth/dev-login` and the mock payment
    route both return **404**
  - headers include HSTS, CSP, `X-Content-Type-Options`, `X-Frame-Options` and
    `Referrer-Policy`, and `X-Powered-By` is absent
  - `Access-Control-Allow-Origin` only ever names `FRONTEND_URL`
  - the OAuth state cookie is `HttpOnly; Secure; SameSite=Lax`, scoped to `/api/v1/auth`, with
    a 10-minute lifetime

### End-to-end (Playwright, real Chrome, isolated `campuscart_e2e` database)

- `e2e/journey.spec.ts` covers the brief's 14 journey steps plus a manager rejection with an
  automatic refund.
- `e2e/quality.spec.ts` covers every screen for every role at 375, 768 and 1280px: no horizontal
  overflow, and **no serious or critical axe-core WCAG 2.1 A/AA violations**.

### Not covered by automated checks

- Real Google sign-in. It was verified manually once (Phase 3); E2E uses the developer login.
- Manual screen-reader and keyboard-only testing.
- Load testing.
- A professional penetration test.
- **Database constraints:** 19 CHECK constraints and 42 unique indexes exist in the schema. Each
  financial one has at least one test that relies on it.

## Known limitations

- Rate limiting is in memory, so it's per process. Multiple backend instances would need a shared
  store (for example Redis), which hasn't been added.
- Production hosting (TLS termination, serving the built frontend, process management) isn't
  part of this repository yet.
