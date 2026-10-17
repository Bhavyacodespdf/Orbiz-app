# CampusCart API contracts

Base path: `/api/v1`. All bodies are JSON.

**Conventions**

- **Errors:** always `{ "error": { "code": string, "message": string, "details"?: unknown } }`.
- **Authentication:** session cookie (`cc_session`, or `__Host-cc_session` in production), set by
  the sign-in endpoints. Browsers send it automatically, and fetch calls must use
  `credentials: 'include'`.
- **CSRF:** every non-GET request must send `X-Requested-With: CampusCart`. If an `Origin` header
  is present it must equal `FRONTEND_URL`. Otherwise the response is `403 CSRF_REJECTED`.
- **Common errors:** `400 VALIDATION_ERROR`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`,
  `403 CSRF_REJECTED`, `404 NOT_FOUND`, `413 PAYLOAD_TOO_LARGE`, `429 RATE_LIMITED`,
  `500 INTERNAL_ERROR`.

## Health

### `GET /health`

| Status | Body                                                                                   |
| ------ | -------------------------------------------------------------------------------------- |
| 200    | `{ "status": "ok", "database": { "status": "up", "latencyMs": number }, "time": ISO }` |
| 503    | `{ "status": "degraded", "database": { "status": "down" }, "time": ISO }`              |

## Authentication

### The `User` object

```json
{
  "id": "uuid",
  "email": "asha@example.com",
  "emailVerified": true,
  "displayName": "Asha",
  "avatarUrl": "https://… | null",
  "phone": "+91 98765 43210 | null",
  "roles": ["STUDENT", "MANAGER", "POS", "ADMIN"],
  "signInMethod": "GOOGLE | DEV"
}
```

`roles` lists only currently active roles. Every account has `STUDENT`.

### `GET /auth/providers`

Returns which sign-in methods are available: `200 { "google": boolean, "devLogin": boolean }`.

### `GET /auth/google?returnTo=/path`

Starts Google sign-in. It sets the signed `cc_oauth` state cookie, then responds **303** to
Google's consent screen.

- `returnTo` must be a same-site path, otherwise `/`.
- If Google isn't configured, it responds 303 to `FRONTEND_URL/login?error=GOOGLE_NOT_CONFIGURED`.
- Rate-limited.

### `GET /auth/google/callback?code=…&state=…`

Google redirects here. On success it creates the account if needed, starts a session (setting the
`cc_session` cookie) and responds **303** to `FRONTEND_URL + returnTo`.

On failure it responds 303 to `FRONTEND_URL/login?error=<CODE>`:

| Code                         | Meaning                                                               |
| ---------------------------- | --------------------------------------------------------------------- |
| `GOOGLE_NOT_CONFIGURED`      | Server has no Google credentials                                      |
| `GOOGLE_CANCELLED`           | User declined on Google's screen                                      |
| `OAUTH_STATE_INVALID`        | Missing, forged, tampered or reused state, or nonce mismatch          |
| `GOOGLE_VERIFICATION_FAILED` | Code exchange or ID-token verification failed                         |
| `EMAIL_CONFLICT`             | Another account already uses this email (accounts aren't auto-linked) |
| `ACCOUNT_SUSPENDED`          | Account is suspended                                                  |

### `POST /auth/dev-login` (development and test only)

Exists only when `DEV_LOGIN_ENABLED=true` and `NODE_ENV≠production`; otherwise 404.
Rate-limited.

- **Request:** `{ "email": string, "displayName"?: string }`
- **200:** `{ "user": User }`, and sets the session cookie. The account gets a `DEV` identity.
  Allowlists apply on creation.
- **409 `EMAIL_CONFLICT`:** the email belongs to an account with a different identity.

### `GET /auth/me`

- **200:** `{ "user": User }`
- **401:** signed out, or the session expired or was revoked.

### `POST /auth/logout`

Deletes the session and clears the cookie. Returns **204**. It's safe to call when already
signed out.

## Profile

### `GET /me/profile`

Requires sign-in. Returns `200 { "user": User }`.

### `PATCH /me/profile`

Requires sign-in. The request may contain only these fields:

| Field         | Rules                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------- |
| `displayName` | 1–60 characters after trimming                                                                |
| `phone`       | Digits, spaces, dashes and an optional leading `+`, 8–20 characters. `""` or `null` clears it |

Any other field (`email`, `roles`, `status`, …) gives `400 VALIDATION_ERROR`. Success returns
`200 { "user": User }`.

## Outlets and menus (public, no sign-in)

Archived outlets, deactivated categories and deactivated items are never returned here. Sold-out
items **are** returned, with `isAvailable: false`.

### The `Outlet` object

```json
{
  "id": "uuid",
  "slug": "night-owl-cafe",
  "name": "Night Owl Café",
  "description": "…",
  "location": "Library block",
  "imageUrl": null,
  "status": "OPEN | PAUSED | CLOSED",
  "acceptingOrders": true,
  "isSample": true
}
```

- `acceptingOrders` is `true` only when the status is `OPEN`.
- `isSample` is `true` only for rows created by the development seed. The UI labels them
  "Sample data".

### `GET /outlets?q=`

Lists active outlets, `OPEN` first, then alphabetical.

- `q` (optional, at most 60 characters) matches outlet name, description, location, or the name of
  any visible menu item. It isn't case-sensitive.
- Returns `200 { "outlets": Outlet[] }`.

### `GET /outlets/:slug`

Returns `200 { "outlet": Outlet }`, or `404` when the outlet is unknown or archived.

### `GET /outlets/:slug/menu?q=&category=&dietary=`

All filters run on the server:

- `q` searches item names and descriptions.
- `category` is a category ID.
- `dietary` is `VEG`, `NON_VEG` or `EGG`.

Response `200`:

```json
{
  "outlet": Outlet,
  "categories": [{ "id": "uuid", "name": "Snacks", "sortOrder": 10 }],
  "items": [{
    "id": "uuid", "categoryId": "uuid", "name": "Samosa", "description": "…",
    "pricePaise": 1500, "dietary": "VEG | NON_VEG | EGG | null",
    "isAvailable": true, "imageUrl": null
  }]
}
```

- `categories` lists every active category, for filter chips.
- `items` holds only the matching items, ordered by category and then by item.
- Errors: `400` for an invalid filter, `404` for an unknown or archived outlet.

## Staff outlet operations (`/staff/outlets`, sign-in required)

Every `/:outletId/...` route requires two things: the user **currently holds** the named role,
**and** they're **assigned** to that outlet with it.

- No role or no assignment gives `403`.
- A malformed ID gives `404`.
- An item or category ID that belongs to another outlet gives `404`.

| Method & path                                 | Role           | Body                                                                                 | Result                                                                               |
| --------------------------------------------- | -------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `GET /staff/outlets`                          | any            | none                                                                                 | `{ outlets: [{ outlet, roles: ["MANAGER","POS"] }] }`: the caller's assigned outlets |
| `GET /:outletId/menu`                         | MANAGER or POS | none                                                                                 | Full menu including inactive rows (`isActive`, `sortOrder` included)                 |
| `PATCH /:outletId/status`                     | MANAGER        | `{ status }`                                                                         | Updated outlet. Audited (`OUTLET_STATUS_CHANGED`)                                    |
| `POST /:outletId/categories`                  | MANAGER        | `{ name, sortOrder? }`                                                               | `201 { category }`                                                                   |
| `PATCH /:outletId/categories/:categoryId`     | MANAGER        | `{ name?, sortOrder?, isActive? }`                                                   | `{ category }`                                                                       |
| `POST /:outletId/items`                       | MANAGER        | `{ categoryId, name, description?, pricePaise, dietary?, isAvailable?, sortOrder? }` | `201 { item }`. Audited                                                              |
| `PATCH /:outletId/items/:itemId`              | MANAGER        | any of the create fields, plus `isActive`                                            | `{ item }`. Price changes and (de)activation are audited                             |
| `PATCH /:outletId/items/:itemId/availability` | MANAGER or POS | `{ isAvailable }`                                                                    | `{ item }`                                                                           |

**Validation:**

- `pricePaise` must be an integer from 100 to 1,000,000 (₹1 to ₹10,000). Strings and fractions
  are rejected.
- Names are trimmed and can't be blank.
- Unknown fields give `400`.
- A duplicate name within an outlet gives `409 DUPLICATE_NAME`.

## Admin outlet management (`/admin/outlets`, ADMIN only)

| Method & path                                         | Body                                                     | Result                                                                                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/outlets`                                  | none                                                     | All outlets including archived (`isActive`)                                                                                               |
| `POST /admin/outlets`                                 | `{ name, description?, location?, status? }`             | `201 { outlet }`. The slug comes from the name and is made unique (`-2`, `-3`, …). Status defaults to `CLOSED`. Audited                   |
| `PATCH /admin/outlets/:outletId`                      | `{ name?, description?, location?, status?, isActive? }` | `{ outlet }`. `isActive: false` archives the outlet. Audited                                                                              |
| `GET /admin/outlets/:outletId/staff`                  | none                                                     | `{ staff: [{ id, role, user: { id, email, displayName }, createdAt }] }`                                                                  |
| `POST /admin/outlets/:outletId/staff`                 | `{ email, role: "MANAGER" \| "POS" }`                    | `201` when created, `200` when already assigned. `404 USER_NOT_FOUND`, or `409 ROLE_REQUIRED` if the user doesn't hold that role. Audited |
| `DELETE /admin/outlets/:outletId/staff/:assignmentId` | none                                                     | `204`. Audited                                                                                                                            |

## Cart (`/cart`, Student role required)

There is one cart per user, and it holds items from **one outlet** only. The cart never stores
prices: every response is priced live from the menu.

The `Cart` object:

```json
{
  "outlet": { "id", "slug", "name", "status", "acceptingOrders" } | null,
  "items": [{ "menuItemId", "name", "dietary", "unitPricePaise", "quantity", "lineTotalPaise", "isOrderable" }],
  "itemCount": 3, "subtotalPaise": 7500, "totalPaise": 7500,
  "issues": [{ "menuItemId", "name", "reason": "SOLD_OUT | NO_LONGER_ON_MENU" }],
  "canCheckout": true
}
```

| Method & path                    | Body                                                                                                      | Result / errors                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /cart`                      | none                                                                                                      | `{ cart }`, including `loyalty: { availablePoints, maxRedeemablePoints, pointValuePaise }` (what checkout would accept now)                                                                                                                                                                                                                                                             |
| `POST /cart/items`               | `{ menuItemId, quantity? (1–10, default 1), replaceCart? }`                                               | `{ cart }`. `404` item not on menu. `409 ITEM_UNAVAILABLE`, `OUTLET_NOT_ACCEPTING`, `QUANTITY_LIMIT`, `CART_FULL` (20 lines), `CART_OUTLET_CONFLICT` (details: `currentOutlet`, `newOutlet`; resend with `replaceCart: true` to start a new cart)                                                                                                                                       |
| `PATCH /cart/items/:menuItemId`  | `{ quantity }` (1–10)                                                                                     | `{ cart }`                                                                                                                                                                                                                                                                                                                                                                              |
| `DELETE /cart/items/:menuItemId` | none                                                                                                      | `{ cart }`                                                                                                                                                                                                                                                                                                                                                                              |
| `DELETE /cart`                   | none                                                                                                      | `{ cart }` (empty)                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /cart/combo`               | `{ items: [{ menuItemId, quantity }] (1–6), expectedTotalPaise, replaceCart? }`, header `Idempotency-Key` | Adds a whole combo in one transaction. `201 { cart, added: true }`; `200 { cart, added: false }` when the same key was already applied. `409 ITEMS_UNAVAILABLE` (`details.items`), `PRICE_CHANGED` (`details.totalPaise`, live prices), `OUTLET_NOT_ACCEPTING`, `CART_OUTLET_CONFLICT`, `QUANTITY_LIMIT`, `CART_FULL`; `400 MIXED_OUTLETS`. Nothing is added unless everything is valid |

## Scheduled orders

Slots, the ₹10 fee, rescheduling, staff filters and pickup-hours settings are in
[scheduled-orders.md](scheduled-orders.md#api).

- **Order objects and summaries** include `timing` (`IMMEDIATE` | `SCHEDULED`), `scheduledFor` and
  `scheduledFeePaise`.
- **`POST /orders`** accepts an optional `scheduledFor`.
- **The cart** includes `canSchedule`.

**No-shows.** Ready scheduled orders not collected within 10 minutes become `NO_SHOW` and are
settled per item (packaged 90% refund, handmade none, ₹10 fee kept). Orders add `pickupDeadline`
and `noShow`, items add `fulfillmentType`, `unsuitableForResale` and `noShow`; payment status can
be `PARTIALLY_REFUNDED`. Staff can mark a line not resellable and admins can retry failed
settlements. See [no-show-policy.md](no-show-policy.md#api).

## Group trays, banquets and peer splits

`/groups`, `/banquets`, `/staff/outlets/:outletId/banquets` and `/splits`. Every endpoint,
error and rule is in [group-dining.md](group-dining.md). Orders may now have
`paymentMethod: "GROUP"`, and wallet transactions may be `GROUP_SHARE_PAYMENT`,
`PEER_TRANSFER_OUT` or `PEER_TRANSFER_IN`.

## Weekly Stock Planner (`/staff/outlets/:outletId/planning`, assigned MANAGER or POS)

Demand history, forecasts, weekly plans (versioned, with overrides, approval and linked restocks),
outcomes and evaluation. Every endpoint is in [stock-planning.md](stock-planning.md).

## Menu item stock (`/staff/outlets/:outletId/inventory`, assigned MANAGER or POS)

Stock statuses, permissions, rules and every endpoint are in [stock.md](stock.md#api). Related
changes elsewhere:

- **Menu items:** public menu items now include `stockStatus`, and `isAvailable` means "orderable
  now". Staff menu items add `soldOutManually`, `trackInventory`, `stockQuantity`,
  `lowStockThreshold` and `stockUpdatedAt`.
- **Cart:** cart lines include `stockStatus`. Cart issues can be `NOT_ENOUGH_STOCK` (with
  `available`). `POST /cart/items`, `PATCH /cart/items/:id` and `POST /cart/combo` can return
  `409 INSUFFICIENT_STOCK` (`details.available`).
- **Checkout:** `POST /orders` can return `409 INSUFFICIENT_STOCK` (`details.items`:
  `[{ menuItemId, name, available, requested }]`).
- **Real-time:** event `stock.updated` `{ outletId, menuItemIds }` is sent to everyone, with no
  quantities.

## Surprise Meal (`/surprise-meal`, Student role required)

The budget solver. Read-only: it never changes menus, carts or orders. See
[surprise-meal.md](surprise-meal.md).

| Method & path    | Body                                                                          | Result                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /options`   | none                                                                          | `{ budget: { minPaise, maxPaise, stepPaise, presets: [{ label, budgetPaise }] }, moods, diets, aiAvailable }` |
| `POST /generate` | `{ budgetPaise, mood, diet, outletId \| null, avoidItemIds? }`                | `{ combo \| null, reason \| null, notices: string[] }`                                                        |
| `POST /swap`     | `{ budgetPaise, mood, diet, outletId \| null, itemIds (1–4), replaceItemId }` | `{ swapped, message, combo, notices }`. `409 COMBO_OUT_OF_DATE` if the current combo no longer holds          |

- `budgetPaise`: whole rupees, ₹50–₹1,000. `mood`: `QUICK_BITE | HIGH_PROTEIN | CAFE_TREAT | FEAST`.
  `diet`: `ANY | VEG | NON_VEG`. Anything else is `400 VALIDATION_ERROR`.
- `combo`: `{ source: "RULES" | "AI", outlet: { id, name, slug }, items: [{ id, name, description, pricePaise, dietary, imageUrl, category: { id, name } }], itemCount, totalPaise, budgetPaise, remainingPaise, reasons: string[], nutrition: { available: false, note } }`.
  `totalPaise` is always ≤ `budgetPaise`.
- `reason` (when `combo` is null): `{ code, message, cheapestPaise? }` with codes
  `NO_MATCHING_DISHES`, `NO_NON_VEG`, `BUDGET_TOO_LOW`, `NO_COMBO_FITS`, `OUTLET_NOT_ACCEPTING`.

## Orders (`/orders`, Student role required)

### `POST /orders`: checkout

- **Headers:** `Idempotency-Key` is required (8–100 characters, `[A-Za-z0-9_-]`). Repeating a key
  returns the original order with status `200`.
- **Body:** `{ "paymentMethod": "WALLET" | "COUNTER", "expectedTotalPaise": int, "pointsToRedeem"?: int ≥ 0 }`.
  `expectedTotalPaise` is the total **after** the points discount (1 point = ₹1).
- **201:** `{ order }`

Errors:

| Status & code                  | Meaning                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 IDEMPOTENCY_KEY_REQUIRED` | Missing or malformed key                                                                                                                                                                          |
| `409 CART_EMPTY`               | Nothing to order                                                                                                                                                                                  |
| `409 OUTLET_NOT_ACCEPTING`     | Outlet closed or paused                                                                                                                                                                           |
| `409 ITEMS_UNAVAILABLE`        | `details.items`: `[{ menuItemId, name }]`                                                                                                                                                         |
| `409 PRICE_CHANGED`            | `details.totalPaise` is the current total                                                                                                                                                         |
| `409 INSUFFICIENT_BALANCE`     | `details`: `{ balancePaise, totalPaise, shortfallPaise }`. Nothing was saved                                                                                                                      |
| `400 POINTS_EXCEED_ORDER`      | More points than the order allows (at least ₹1 must be paid). `details.maxPoints`                                                                                                                 |
| `409 INSUFFICIENT_POINTS`      | `details`: `{ pointsBalance, requested }`. Nothing was saved                                                                                                                                      |
| `429 ORDER_CAPACITY_FULL`      | Outlet has taken 10 orders in the last 3 minutes. `details`: `{ retryAt, retryAfterSeconds }`, plus a `Retry-After` header. Nothing was saved or charged ([order-capacity.md](order-capacity.md)) |

### `GET /orders/:orderId`

Returns `{ order }` for the caller's own order. Anyone else's order, or a malformed ID, gives `404`.

### The `Order` object

```json
{
  "id", "pickupCode": "N-007",
  "outlet": { "id", "slug", "name", "location" },
  "status": "PLACED | ACCEPTED | PREPARING | READY | COMPLETED | REJECTED | CANCELLED",
  "paymentMethod": "WALLET | COUNTER",
  "paymentStatus": "PENDING_COUNTER | PAID | REFUNDED | VOID",
  "items": [{ "menuItemId", "name", "unitPricePaise", "quantity", "lineTotalPaise" }],
  "subtotalPaise", "pointsRedeemed", "pointsDiscountPaise", "totalPaise" (subtotal − discount),
  "currency": "INR", "cancelReason", "version",
  "placedAt", "updatedAt",
  "statusHistory": [{ "fromStatus", "toStatus", "reason", "at" }]
}
```

`items` are snapshots and don't change when the menu changes.

### `GET /orders?view=active|past&limit=1–50&cursor=`

The caller's own orders, newest first.

- `active` covers PLACED, ACCEPTED, PREPARING and READY. `past` covers COMPLETED, REJECTED and
  CANCELLED.
- Returns `{ orders: OrderSummary[], nextCursor }`, where `OrderSummary` is
  `{ id, pickupCode, outlet: { id, slug, name }, status, paymentMethod, paymentStatus, totalPaise, itemCount, placedAt, version }`.

### `POST /orders/:orderId/cancel`

The student cancels their own order.

- **Body:** `{ "reason"?: string }`
- **When:** only while the order is `PLACED`. Otherwise `409 TOO_LATE_TO_CANCEL`. Another
  student's order gives `404`.
- **Wallet orders** are refunded automatically (see refunds below). **Unpaid counter orders**
  become `VOID`.
- **Returns** `{ order }`.

## Staff order queue (`/staff/outlets/:outletId/orders`, assigned MANAGER or POS)

| Method & path                | Result                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /?view=active`          | The live queue, oldest first (first come, first served). Each row is an `OrderSummary` plus `customer: { displayName }`, and no contact details |
| `GET /?view=history&cursor=` | Finished orders, newest first, paginated                                                                                                        |
| `GET /:orderId`              | `{ order }`: the full order plus `customer` and `allowedNextStatuses` for the caller's roles at this outlet                                     |
| `POST /:orderId/transition`  | Body `{ to, reason? }`. Returns `{ order }`                                                                                                     |

**Transitions** (approved Phase 0 rules; anything else is `409 INVALID_TRANSITION` with
`details.allowed`):

| From → To                        | Who                                | Reason                                                                                                            |
| -------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| PLACED → ACCEPTED                | Manager, POS                       | none                                                                                                              |
| PLACED → REJECTED                | Manager                            | required                                                                                                          |
| PLACED → CANCELLED               | The student (`/orders/:id/cancel`) | optional                                                                                                          |
| ACCEPTED → PREPARING → READY     | Manager, POS                       | none                                                                                                              |
| ACCEPTED / PREPARING → CANCELLED | Manager                            | required                                                                                                          |
| READY → COMPLETED                | Manager, POS                       | none. Requires `paymentStatus = PAID`, otherwise `409 PAYMENT_REQUIRED` (POS records counter payments, see below) |

Other errors:

- `400 REASON_REQUIRED`
- `403` when the role isn't allowed (for example POS rejecting)
- `409 ORDER_CHANGED` when someone else changed the order at the same moment: refresh and retry
- `409 COUNTER_PAID` when cancelling an order already paid at the counter

### `POST /staff/outlets/:outletId/orders/:orderId/counter-payment`

**POS only**, and the caller must be assigned to the outlet with the POS role. It records money
**actually received** at the counter.

- **Body:** `{ "amountPaise": int, "note"?: string }`. The amount must equal the order total.
- **Returns** `{ order }` with `paymentStatus: "PAID"` and
  `counterPayment: { amountPaise, recordedAt }`.

| Error                    | Meaning                                               |
| ------------------------ | ----------------------------------------------------- |
| `403`                    | Not POS at this outlet (managers included)            |
| `409 ORDER_NOT_ACCEPTED` | The order must be accepted first                      |
| `409 AMOUNT_MISMATCH`    | `details.totalPaise` is the amount to collect         |
| `409 ALREADY_PAID`       | One payment per order, even under concurrent requests |
| `409 NOT_COUNTER_ORDER`  | The order was paid from the wallet                    |
| `409 ORDER_NOT_PAYABLE`  | The order was cancelled or rejected                   |

It's audited as `COUNTER_PAYMENT_RECORDED`. The staff order detail also shows `recordedBy` and
`canRecordPayment`.

**Acting role:** for someone holding both Manager and POS, the history records the
least-privileged role that permits the step.

**Refunds:** REJECTED or CANCELLED on a wallet-paid order refunds the full amount to the wallet,
in the same transaction. It's a separate `REFUND` ledger row and the order becomes `REFUNDED`.
Each order can be refunded at most once.

## Wallet (`/wallet`, Student role required)

There's no endpoint that sets a balance or writes a credit or debit directly.

| Method & path                                 | Result                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /wallet`                                 | `{ wallet: { id, balancePaise, currency, loyalty: { pointsBalance, pointValuePaise, rechargeBonusSlabs: [{ amountPaise, points }] }, recharge: { available, mode: "MOCK" \| null, isSimulated, minPaise, maxPaise, maxBalancePaise } } }`. The wallet is created at ₹0 and 0 points on first use. `minPaise` is at least ₹99       |
| `GET /wallet/points?limit=1–50&cursor=`       | `{ pointsBalance, transactions: LoyaltyTransaction[], nextCursor }`: the caller's own points ledger, newest first                                                                                                                                                                                                                  |
| `GET /wallet/transactions?limit=1–50&cursor=` | `{ transactions: Transaction[], nextCursor }`, newest first                                                                                                                                                                                                                                                                        |
| `GET /wallet/transactions/:id`                | `{ transaction }` (own only, otherwise `404`)                                                                                                                                                                                                                                                                                      |
| `POST /wallet/recharges`                      | Header `Idempotency-Key`. Body `{ amountPaise }`. Returns `201 { recharge, nextAction: { type: "MOCK_SIMULATOR" } }`, or `200` for a repeated key. Errors: `400 AMOUNT_NOT_WHOLE_RUPEES`, `400 AMOUNT_OUT_OF_RANGE` (below ₹99 or above the maximum), `409 WALLET_LIMIT`, `409 IDEMPOTENCY_KEY_REUSED`, `503 RECHARGE_UNAVAILABLE` |
| `GET /wallet/recharges/:id`                   | `{ recharge }` (own only)                                                                                                                                                                                                                                                                                                          |

**LoyaltyTransaction:**

```json
{ "id", "type": "EARNED_RECHARGE | REDEEMED_ORDER | RESTORED_ORDER", "direction": "CREDIT | DEBIT",
  "points", "pointsBalanceAfter", "rechargeId", "orderId", "description", "isSimulated", "createdAt" }
```

**Transaction:**

```json
{ "id", "type": "RECHARGE | ORDER_DEBIT | REFUND | REVERSAL", "direction": "CREDIT | DEBIT",
  "amountPaise", "balanceAfterPaise" (null unless COMPLETED),
  "status": "PENDING | COMPLETED | FAILED | CANCELLED | EXPIRED",
  "description", "orderId", "rechargeId", "isSimulated", "createdAt", "completedAt" }
```

**Recharge:**

```json
{ "id", "amountPaise", "currency", "status": "PENDING | SUCCEEDED | FAILED | CANCELLED | EXPIRED",
  "bonusPoints" (promised; awarded only on SUCCEEDED), "provider": "MOCK", "providerReference", "isSimulated", "failureReason", "expiresAt", "createdAt", "completedAt" }
```

## Mock payment simulator (test mode only)

### `POST /payments/mock/:rechargeId/outcome`

- **Exists only** when `PAYMENT_MOCK_ENABLED=true` outside production. Otherwise `404`.
- **Body:** `{ "outcome": "SUCCESS" | "FAILURE" | "CANCEL" }`
- **Who:** only the recharge's owner. Anyone else gets `404`.
- **Returns:** `{ changed, recharge, wallet: { id, balancePaise, currency } }`. If the recharge was
  already settled or has expired, `changed` is `false` and nothing changes.

No real money moves. See [wallet-and-payments.md](wallet-and-payments.md).

## Admin users and audit log (ADMIN only)

| Method & path                                              | Body                                      | Result                                                                                                                                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/users?q=&limit=&cursor=`                       | none                                      | `{ users, nextCursor }`. Each user: `{ id, email, displayName, emailVerified, status, signInMethod, roles, eligibleFor: { MANAGER, POS, ADMIN }, assignments: [{ id, role, outlet: { id, name } }], createdAt }` |
| `POST /admin/users/:userId/roles`                          | `{ role: "MANAGER" \| "POS" \| "ADMIN" }` | `201` granted, `200` already held. `409 NOT_ALLOWLISTED` / `EMAIL_NOT_VERIFIED`. The user's live connection is moved into the right outlet rooms straight away                                                   |
| `POST /admin/users/:userId/roles/:role/revoke`             | `{ reason }` (at least 3 characters)      | `{ changed, sessionsEnded }`. Ends every session and live connection immediately. `409 SELF_REVOKE` (you can't remove your own Admin) and `409 LAST_ADMIN`                                                       |
| `GET /admin/audit-logs?action=&entityType=&limit=&cursor=` | none                                      | `{ entries: [{ id, actorType, actor: { id, email, displayName } \| null, action, entityType, entityId, metadata, createdAt }], nextCursor }`, newest first. **Read-only**: no edit or delete endpoints exist     |
| `GET /admin/audit-logs/actions`                            | none                                      | `{ actions: string[] }`, the action names that have been recorded                                                                                                                                                |

Staff assignment changes (`POST/DELETE /admin/outlets/:id/staff`) and archiving an outlet also
update the affected users' live outlet rooms immediately.

## Today's Special voting

Rules, lifecycle and the tie policy are in [todays-special.md](todays-special.md). Every count,
percentage and winner below is computed by the server from persisted votes. No response ever
identifies who voted for what.

### Public (no sign-in)

| Endpoint                          | Response                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /specials?day=YYYY-MM-DD`    | `{ day, specials: Special[] }` for active outlets with a finalized winner. `day` defaults to today (IST) |
| `GET /outlets/:slug/special?day=` | `{ day, special: Special \| null }`. 404 for an unknown or archived outlet                               |

`Special`: `{ pollId, day, outlet, dish, outcome: "WINNER" | "TIE_RESOLVED_BY_MANAGER", totalVotes, winnerVotes, winnerPercentage }`.
`dish`: `{ id, name, description, imageUrl, pricePaise, dietary, isAvailable, orderable, category: { id, name } }`.

### Students (sign-in required)

| Endpoint                   | Body           | Response / errors                                                                                                                                                                      |
| -------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /outlets/:slug/poll`  | none           | `{ poll: StudentPoll \| null }`: an open poll (voting now, or opening within a day), else today's non-draft poll                                                                       |
| `POST /polls/:pollId/vote` | `{ optionId }` | `{ poll: StudentPoll }`. Casts or changes the caller's vote (idempotent). 404 unknown/draft poll or option not in this poll; 409 `POLL_NOT_OPEN`, `POLL_CLOSED`, `OPTION_NOT_ELIGIBLE` |

`StudentPoll`: `{ id, outletId, day, phase: "UPCOMING" | "VOTING" | "CLOSED" | "FINALIZED", opensAt, closesAt, serverNow, resultsVisible, votesCast, myOptionId, options: [{ id, dish, votable, votes, percentage }], result, version }`.
`votesCast`, `votes` and `percentage` are `null` while results are hidden.
`result`: `{ outcome, winnerOptionId, totalVotes, winnerVotes, winnerPercentage, finalizedAt } | null`.

Votes count towards the per-user action rate limit.

### Managers (`/staff/outlets/:outletId/polls`, assigned MANAGER only)

| Endpoint                 | Body                                                               | Notes                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`                  | `?limit=1–100&before=YYYY-MM-DD`                                   | `{ polls: ManagerPoll[], nextBefore }`, newest date first                                                                                                                |
| `POST /`                 | `{ day, opensAt, closesAt, menuItemIds (2–10), showLiveResults? }` | 201 DRAFT. Times are ISO instants with an offset. 400 `INVALID_POLL`, `OPTION_NOT_ELIGIBLE` (`details.invalidMenuItemIds`); 409 `POLL_EXISTS`                            |
| `GET /:pollId`           | none                                                               | `{ poll: ManagerPoll }`                                                                                                                                                  |
| `PATCH /:pollId`         | any of the create fields                                           | DRAFT only, else 409 `POLL_NOT_EDITABLE`                                                                                                                                 |
| `DELETE /:pollId`        | none                                                               | 204. DRAFT only                                                                                                                                                          |
| `POST /:pollId/open`     | `{}`                                                               | DRAFT → OPEN. 409 `INVALID_POLL_STATE`; 400 if the window has passed or fewer than 2 dishes are available                                                                |
| `POST /:pollId/close`    | `{}`                                                               | OPEN → CLOSED now, then finalizes an unambiguous result. Repeating it changes nothing                                                                                    |
| `POST /:pollId/finalize` | `{ tieBreakOptionId? }`                                            | Idempotent. 409 `POLL_NOT_CLOSED`, `TIE_NEEDS_DECISION` (`details.tiedOptionIds`), `NOT_A_TIE`, `POLL_ALREADY_FINALIZED`; 400 if the choice isn't one of the tied dishes |

`ManagerPoll` adds `status`, `showLiveResults`, `openedAt`, `closedAt`, `createdAt`, live `votes`
and `percentage` on every option, `counted` (false for a dish withdrawn from the menu) and
`tiedOptionIds` (set while a closed poll waits for a tie decision).

## Food ratings & reviews

See [food-reviews.md](food-reviews.md#api-apiv1) for every endpoint, its rules and error codes.
`GET /outlets/:slug/menu` items carry `rating: { average, count }` and accept `sort=rating`.

## Quick Reorder & saved combos

See [quick-reorder.md](quick-reorder.md#api-apiv1-student-role-required) for `/reorder/*` and `/saved-combos`.

## Pickup verification

See [pickup-verification.md](pickup-verification.md#server-rules) for `/orders/:orderId/pickup` and `/staff/outlets/:outletId/pickup/*`. The generic transition endpoint refuses `READY → COMPLETED` with `409 PICKUP_VERIFICATION_REQUIRED`; the owner receives an `order.ready` event (order number and outlet only).

## Menu search & sorting

See [menu-search.md](menu-search.md#api) for `GET /menu` (campus-wide, paged) and the `sort`/`inStock` parameters of `GET /outlets/:slug/menu`.

## Notifications, tracking and kitchen timing

See [notifications.md](notifications.md#api-apiv1menotifications-any-signed-in-user-own-inbox-only) and [kitchen-queue.md](kitchen-queue.md#api). New socket events: `notification.created` (to the user) and `estimate.updated` (to the owner and outlet staff), both carrying IDs only.

## Real-time events (Socket.IO)

**Connection:** path `/socket.io` on the same origin as the API. The browser sends its session
cookie automatically.

**Handshake.** The server rejects the connection with:

- `UNAUTHENTICATED` when there's no valid session
- `ORIGIN_NOT_ALLOWED` when the `Origin` isn't `FRONTEND_URL`, which prevents cross-site
  WebSocket hijacking

**Rooms are assigned by the server.** There's no event for joining a room.

| Room                      | Members                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `user:{userId}`           | All of that user's connections                                                                                |
| `session:{sessionId}`     | Connections of one session (used to end it on logout)                                                         |
| `outlet:{outletId}:staff` | Users who **currently** hold Manager/POS **and** are assigned to that outlet, as of the moment they connected |

**Events.** These are notifications only: clients re-read the data over REST. All are sent
**after** the database transaction commits.

| Event             | Sent to                                                                               | Payload                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ready`           | The connecting socket                                                                 | `{ rooms }`, sent once room membership is set. Clients refetch on this, so changes missed while offline are recovered |
| `order.created`   | Outlet staff                                                                          | `{ orderId, outletId, pickupCode, status, paymentStatus, version, updatedAt }`                                        |
| `order.updated`   | The order's owner and outlet staff                                                    | Same as above                                                                                                         |
| `wallet.updated`  | The wallet owner                                                                      | `{ reason: "RECHARGE" \| "ORDER_DEBIT" \| "REFUND" }`. No amounts or balances                                         |
| `session.revoked` | One session or user                                                                   | `{}`, then the server disconnects                                                                                     |
| `poll.updated`    | Everyone (status changes); outlet staff (vote activity, drafts; at most 1/s per poll) | `{ pollId, outletId, status, version }`. Never votes or voters                                                        |

**Duplicates and ordering:** clients compare `version` with their cached order and ignore anything
not newer.

**Revocation:**

- **Logout** ends that session's sockets immediately.
- Sessions ended elsewhere (a CLI role revocation, expiry, suspension) are picked up by a re-check
  every 60 seconds, and those sockets are disconnected.
- Role grants, staff assignments and outlet archiving update the user's rooms on their current
  connection (`access.changed`). No reconnect is needed.

## Not provided by design

- Endpoints to set wallet balances or write ledger rows.
- Endpoints to edit or delete audit entries.
- Endpoints for suspending users. This wasn't in the approved scope; suspension exists only as
  a database status.
