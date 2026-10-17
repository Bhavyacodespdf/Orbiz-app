# CampusCart

A college canteen ordering and outlet-management web app.

- **Students** sign in with any Google account, browse campus outlets and order food. They pay
  from an in-app wallet or at the counter, earn **loyalty points** on bonus recharge amounts and
  spend them at checkout, get a budget-safe **AI Surprise Meal** combo, **schedule orders** for a later pickup slot
  (₹10 per scheduled order), and follow their order
  live until pickup.
  They rate and review dishes they've collected (verified purchases only); real averages show on
  every menu.
  They can reorder a previous meal in one tap and see combos built from their own order history.
  At pickup they show a QR or 6-digit code; staff verify it and confirm the handover.
  The campus Menu searches every dish and sorts by Popular, price, Quick Reorder or Highest Rated.
  They get persistent notifications and live tracking with a queue position and an approximate ready time.
- **Managers** run their outlet's order board, menu, stock and opening status, and hold student votes
  that decide each day's **Today's Special**.
- **POS cashiers** process a live counter queue, record counter payments, and restock or mark
  items sold out.
- **Administrators** manage roles, outlets, staff assignments and the audit log.

> **About money:** the wallet holds **simulated test funds only**. Recharges go through a clearly
> labelled **mock payment simulator**. No bank, UPI or card payment exists anywhere in this
> project. See [docs/wallet-and-payments.md](docs/wallet-and-payments.md) before connecting any
> real payment provider.

**Status:** all nine planned phases are built and verified. What works, what was tested and
what remains is summarised in [docs/implementation-plan.md](docs/implementation-plan.md) and
[docs/security.md](docs/security.md).

## Tech stack

| Layer    | Technology                                                                          |
| -------- | ----------------------------------------------------------------------------------- |
| Frontend | React 19, Vite 8, TypeScript, Tailwind CSS 4, React Router 7, TanStack Query 5, Zod |
| Backend  | Node.js 22, Express 5, TypeScript, Zod 4, Pino, Socket.IO 4                         |
| Database | PostgreSQL 16 via Prisma 7 (`pg` driver adapter)                                    |
| Auth     | Google OAuth 2.0 (Authorization Code + PKCE), server-side sessions                  |
| Tests    | Vitest, Supertest, React Testing Library, Playwright with axe-core                  |

## Prerequisites

- **Node.js 22+** and npm 10+. Check with `node --version`.
- **PostgreSQL 16** running locally. On macOS with Homebrew:
  ```bash
  brew install postgresql@16
  ```
  ```bash
  brew services start postgresql@16
  ```
  Check it's accepting connections:
  ```bash
  pg_isready
  ```
- **Google Chrome**, only needed for the end-to-end tests.

## First-time setup

These steps were tested on a fresh copy of the repository during Phase 9.

**1. Install dependencies** from the repository root. This also generates the Prisma client:

```bash
npm install
```

**2. Create the databases.** `campuscart_dev` is for development; `campuscart_test` is only for
automated tests:

```bash
createdb campuscart_dev
```

```bash
createdb campuscart_test
```

**3. Create the environment files** from the examples:

```bash
cp backend/.env.example backend/.env
```

```bash
cp backend/.env.example backend/.env.test
```

```bash
cp frontend/.env.example frontend/.env
```

Then edit them.

- **In both backend files:**
  - Replace `YOUR_MAC_USERNAME` in `DATABASE_URL` with your macOS username (from `whoami`).
  - Set `SESSION_SECRET` to a fresh random value from `openssl rand -base64 48`.
- **In `backend/.env.test` only:**
  - Point `DATABASE_URL` at `campuscart_test`. The test runner refuses to run against any other
    database name.
  - Set `NODE_ENV=test`, `LOG_LEVEL=silent`, `DEV_LOGIN_ENABLED=true`,
    `AUTH_RATE_LIMIT_MAX=10000` and `MONEY_RATE_LIMIT_PER_MIN=10000`.
- **For local development without Google credentials:** set `DEV_LOGIN_ENABLED=true` in
  `backend/.env`. This adds a clearly labelled developer login. Don't use your real Google email
  with it, because that address would then belong to a developer account in your local database.
- **For real Google sign-in:** follow [docs/google-oauth-setup.md](docs/google-oauth-setup.md).

**4. Apply the database migrations:**

```bash
npm run db:migrate:deploy -w backend
```

```bash
npm run db:migrate:test -w backend
```

**5. (Optional) Add sample outlets and menus** to the development database. They're labelled
"Sample data" in the app. The app also works with an empty database.

```bash
npm run db:seed -w backend
```

**6. (Optional) Make yourself an administrator.** Sign in once, then:

```bash
npm run admin:grant -w backend -- --email you@example.com
```

From then on, roles, outlets and staff assignments are managed in the **Admin** screens at
`/admin`. The `npm run roles -w backend -- grant|revoke …` command remains available for whoever
runs the server.

## Running the app

Start the backend (port 4000) and frontend (port 5173) together:

```bash
npm run dev
```

Open <http://localhost:5173>. In development, <http://localhost:5173/design> shows the design system,
links to every screen, and a live API and database health check.

The browser only talks to Vite on port 5173. Vite forwards `/api` and `/socket.io` to the
backend, so cookies and live updates work as one site.

**Trying the staff screens without a second Google account.** The `backend-staff-test`
configuration in `.claude/launch.json` starts the backend with `staff.dev@example.com` added to
both staff allowlists. It does this through process environment variables, so your
`backend/.env` is not changed. Sign in as that email with the developer login, then assign it to
an outlet from **Admin → Outlets**.

## Who can do what

| Role          | How they get it                                                                             | What they can do                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Student       | Every account                                                                               | Browse, cart, checkout, wallet, own orders, cancel while placed                                                                  |
| Manager       | New account with a verified email in `MANAGER_ALLOWED_EMAILS`, or granted later by an admin | For **assigned outlets**: order board, accept/reject/cancel, menu, prices and stock, open/pause/close                            |
| POS / Cashier | New account with a verified email in `POS_ALLOWED_EMAILS`, or granted later by an admin     | For **assigned outlets**: order queue, accept and advance, record counter payments, restock and mark items sold out or available |
| Administrator | Only through `npm run admin:grant` or another admin                                         | Users and roles, outlets, staff assignments, audit log                                                                           |

Changing an allowlist never changes existing accounts. Details are in
[docs/google-oauth-setup.md](docs/google-oauth-setup.md).

## Quality checks

| Command                   | What it does                                              |
| ------------------------- | --------------------------------------------------------- |
| `npm test`                | Backend and frontend unit and integration tests           |
| `npm run lint`            | ESLint for both packages                                  |
| `npm run typecheck`       | TypeScript type checking for both packages                |
| `npm run build`           | Production builds (`backend/dist`, `frontend/dist`)       |
| `npm run format:check`    | Prettier formatting check                                 |
| `npm run e2e -w frontend` | Playwright end-to-end and accessibility tests (see below) |

Backend tests use the real `campuscart_test` database and never touch `campuscart_dev`.

### End-to-end tests (Playwright)

These run the real backend and frontend in **Google Chrome**, against a separate database
(`campuscart_e2e`) on separate ports (4100 and 5174). Your dev data and dev servers are never
touched. Chrome must be installed; no extra browser download is needed.

One-time setup:

```bash
createdb campuscart_e2e
```

Run:

```bash
npm run e2e -w frontend
```

The suite covers:

- the full student, cashier and manager journey: sign-in, mock recharges, wallet and counter
  payments, live updates, refunds, and access control
- a sweep of every screen at phone, tablet and laptop widths, checking layout overflow and running
  axe-core accessibility checks

Each run first resets `campuscart_e2e` using `backend/src/scripts/e2e-reset.ts`. That script
refuses any database whose name doesn't end in `_e2e`. Sign-in uses the developer login, so these
tests don't cover real Google sign-in.

## Project layout

```
CampusCart/
├── backend/
│   ├── prisma/            schema.prisma, migrations/, seed.ts (dev sample data)
│   ├── prisma.config.ts
│   └── src/
│       ├── app.ts         Express app (routes, middleware), built without opening a port
│       ├── server.ts      HTTP server + Socket.IO
│       ├── config/        environment validation
│       ├── lib/           Prisma client, logger, errors, audit, crypto, idempotency
│       ├── middleware/    session, roles, outlet access, CSRF, rate limits, errors
│       ├── modules/       auth · users · outlets · cart · orders · wallet · payments · polls ·
│       │                  surprise · inventory · scheduling · health
│       ├── realtime/      Socket.IO server, rooms, post-commit publisher
│       ├── scripts/       roles CLI, sample data, e2e reset
│       └── tests/         test database guard, helpers, route-protection inventory
├── frontend/
│   ├── e2e/               Playwright journey + responsive/accessibility sweep
│   ├── playwright.config.ts
│   └── src/
│       ├── app/           App, router, providers
│       ├── components/    ui/ (design system) · feedback/ · layout/ (shells)
│       ├── features/      discovery · menu · cart · checkout · orders · wallet · profile ·
│       │                  auth · manager · pos · admin · staff (shared) · specials · dev (design page)
│       ├── services/      API hooks (auth, outlets, cart, wallet, orders, staff, admin) + realtime
│       └── lib/ hooks/ config/ styles/ test/
└── docs/                  architecture, plan, database, API, security, payments, OAuth, design
```

## Configuration and secrets

- Real values live in `.env` files, which are **git-ignored**. Only `.env.example` files are
  committed; each variable is explained there.
- Every `VITE_*` variable is bundled into the browser's JavaScript, so **never** put secrets there.
  The frontend needs none.
- The backend validates its configuration at startup and exits with a clear message if something
  is wrong. In production (`NODE_ENV=production`) it **refuses to start** when:
  - mock payments are enabled
  - the developer login is enabled
  - any Google credential is missing
- Behind a reverse proxy, set `TRUST_PROXY` so rate limits see the real visitor IP.

## Documentation

| Document                                                   | What's in it                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [docs/implementation-plan.md](docs/implementation-plan.md) | Approved decisions, business rules, phase history                            |
| [docs/architecture.md](docs/architecture.md)               | How the system fits together                                                 |
| [docs/database-design.md](docs/database-design.md)         | Tables, constraints, migrations, seed data                                   |
| [docs/api-contracts.md](docs/api-contracts.md)             | Every endpoint and real-time event                                           |
| [docs/security.md](docs/security.md)                       | Security controls, the Phase 8 review, known limitations                     |
| [docs/wallet-and-payments.md](docs/wallet-and-payments.md) | Wallet ledger, mock recharge, refunds, counter payments, providers           |
| [docs/google-oauth-setup.md](docs/google-oauth-setup.md)   | Google Cloud setup, allowlists, first admin, revoking access                 |
| [docs/design-system.md](docs/design-system.md)             | Colours, type, components, shells                                            |
| [docs/todays-special.md](docs/todays-special.md)           | Today's Special voting: lifecycle, tie policy, integrity, testing            |
| [docs/surprise-meal.md](docs/surprise-meal.md)             | Surprise Meal budget solver: algorithm, AI seam, limits, testing             |
| [docs/stock.md](docs/stock.md)                             | Menu item stock: statuses, permissions, order deduction, setup               |
| [docs/scheduled-orders.md](docs/scheduled-orders.md)       | Scheduled orders: pickup hours, slots, ₹10 fee, refunds, testing             |
| [docs/no-show-policy.md](docs/no-show-policy.md)           | No-shows: 10-minute grace, packaged/handmade refunds, worker                 |
| [docs/order-capacity.md](docs/order-capacity.md)           | Order capacity: 10 orders per outlet per rolling 3 minutes                   |
| [docs/stock-planning.md](docs/stock-planning.md)           | Weekly Stock Planner: forecasting, plans, RL experience, training            |
| [docs/group-dining.md](docs/group-dining.md)               | Group trays, banquet bookings, peer splits: rules, money, API                |
| [docs/food-reviews.md](docs/food-reviews.md)               | Food ratings & reviews: eligibility, one-per-dish, moderation, API           |
| [docs/quick-reorder.md](docs/quick-reorder.md)             | Quick Reorder, favourite & saved combos: scoring, cart rules, API            |
| [docs/pickup-verification.md](docs/pickup-verification.md) | Secure pickup: QR + numeric code, verify then confirm, lockouts, audit       |
| [docs/menu-search.md](docs/menu-search.md)                 | Menu search & sorting: Popular, price, Quick Reorder, Highest Rated          |
| [docs/notifications.md](docs/notifications.md)             | Persistent notifications: outbox, events, inbox API, delivery and retries    |
| [docs/kitchen-queue.md](docs/kitchen-queue.md)             | Live tracking, queue scheduler, preparation estimates, auto-accept, accuracy |
