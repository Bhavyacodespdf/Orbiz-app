# Quick Reorder & favourite combos

Signed-in students can put a previous meal back in their tray in one tap, and see combos built
from their own order history. Reordering only fills the **existing cart**. Nothing is charged,
ordered or reserved until the student checks out through the normal checkout.

## Where it shows

| Surface                          | What students see                                                                                                                                                                                                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home → **Quick reorder**         | Up to 6 recent collected meals: "Your previous lunch", date, outlet, dishes with photos and quantities, availability, last total vs today's total, **Reorder** and **Customize**. Identical repeats are one card ("Ordered 3 times in the last 90 days"). **Older orders** links to past orders |
| Home → **Your favourite combos** | Saved combos first, then combos mined from history with their real counts and pattern (e.g. "Usually for lunch, often on Tuesdays"). With no repeat history: an honest empty state, plus **Popular on campus** clearly marked "Not personalised"                                                |
| Order page (collected orders)    | **Reorder** and **Customize**                                                                                                                                                                                                                                                                   |

Signed-out visitors see none of this.

## One-tap reorder

1. **Reorder** asks the server for a preview (`POST /reorder/preview`). The server checks
   ownership, reads each dish's live menu record, price, stock and outlet status, and returns a
   status for every line.
2. **If nothing changed** (every dish available at the old price, outlet open), the dishes are
   added straight away. The student sees an **Added to your tray** summary with **Review tray**.
3. **Otherwise** the student reviews first:
   - what will be added at today's prices, including "was ₹20, now ₹25" and "Only 2 left — adding
     2 of 3";
   - what can't be added, and why;
   - optional alternatives (same outlet and category, in stock), each one the student's own
     explicit choice;
   - the same dish at another outlet, but only if that outlet is open and has it in stock.

   The student can add the rest or cancel. A dish is never substituted silently.

4. The add (`POST /reorder/cart`) goes through the **existing cart service** (`addCombo`).
   - The total must still match what the student reviewed (else `PRICE_CHANGED`, and the UI shows
     a fresh preview).
   - Every dish is re-checked.
   - The one-outlet tray rule applies: `CART_OUTLET_CONFLICT` asks "Start a new tray?" and never
     discards silently.
   - Stock and the 10-per-dish limit are enforced.
   - An `Idempotency-Key` makes retries and double-clicks add once.
5. **Checkout is unchanged.** It recomputes prices and adds the scheduled-order fee if one
   applies (there are no taxes or fees otherwise, decision Q7). It deducts stock and pays from
   the wallet or at the counter, and applies the outlet's **10 orders per rolling 3 minutes**
   limit, counted once per order. If the outlet is full, checkout returns `429` with a retry
   time and the tray is kept. Cancellations, refunds and scheduled orders follow their existing
   lifecycles.

**Which orders can be reordered:** the student's own **COMPLETED** orders. Other students'
orders return `404`. Placed, cancelled, rejected and no-show orders return
`409 ORDER_NOT_REORDERABLE`. Group orders are also excluded, because they belong to the host and
contain other members' choices.

## Customize

Students can:

- change quantities (1–10), remove dishes, and add dishes from the same outlet;
- see the server-calculated total after every change (`POST /reorder/preview` with `items`);
- add the result to the tray, or **save it as a combo**.

The backend enforces stock, quantity and menu rules again on every add.

## Favourite combos: deterministic scoring (no machine learning)

**Data:** the student's own COMPLETED, non-group orders from the last **90 days** (at most 200).
No other student's data is used.

**Candidates.** Each needs at least **2** matching orders:

| Kind     | Meaning                                           | Name                     |
| -------- | ------------------------------------------------- | ------------------------ |
| `BASKET` | The exact same set of 2+ dishes ordered again     | "Masala chai + Veg puff" |
| `PAIR`   | Two dishes that appear together in several orders | "Masala chai + Veg puff" |
| `SINGLE` | One dish ordered in several orders                | "Your usual Masala chai" |

**Redundant candidates are dropped:**

- a pair or single that only appeared inside a larger combo seen just as often;
- a pair with the same dishes as a basket, keeping whichever was seen more often (the basket on
  a tie).

**Quantities** come from the most recent matching order.

**Score:**

```
score = (2 × support + 3 × recency + 1 × itemFrequency) × (0.25 + 0.75 × availableShare)
```

| Term             | Definition                                                                    |
| ---------------- | ----------------------------------------------------------------------------- |
| `support`        | Orders containing the whole candidate                                         |
| `recency`        | e^(−days since the latest such order × ln 2 / 14), so it halves every 14 days |
| `itemFrequency`  | Mean share of the student's orders that contain each dish                     |
| `availableShare` | Dishes that can be added right now ÷ dishes in the candidate                  |

**How the score is used:**

- A candidate with **no** available dish is dropped, so an unavailable dish can't dominate.
- The top 6 are shown, ties broken by a stable key.
- **Patterns** are shown only when at least 2 matching orders and at least 2/3 of them share an
  IST meal time (breakfast before 11:00, lunch 11–16, snack 16–19, dinner 19–23, late night) or
  a weekday.

**Fallback for students without repeat history:** dishes collected by the most **different
students** in the last **30 days**, across all orders.

- This is an aggregate count only, and a dish needs at least **3 students** to appear. It never
  says who.
- It's shown under "Popular on campus — Not personalised".

**Surprise Meal** already ranks dishes using the same student's order history (dish and category
counts). Quick Reorder doesn't change it, and neither feature needs an external AI service.

## API (`/api/v1`, Student role required)

| Method & path                     | Purpose                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /reorder/history?limit=1–20` | Quick Reorder cards (default 6), with live line statuses, `previousTotalPaise`, `currentTotalPaise`, `timesOrdered`                                                                                                                                    |
| `GET /reorder/combos?outletId=`   | `{ windowDays, personalized, combos[], popular[] }`                                                                                                                                                                                                    |
| `POST /reorder/preview`           | `{ orderId }` \| `{ savedComboId }` \| `{ items }` → per-line `status` (`AVAILABLE`, `LIMITED`, `SOLD_OUT`, `NO_LONGER_ON_MENU`, `OUTLET_UNAVAILABLE`), `addableQuantity`, historical vs current price, `alternatives`, `elsewhere`, totals. Read-only |
| `POST /reorder/cart`              | Header `Idempotency-Key`. `{ items, expectedTotalPaise, replaceCart, source }` → `{ cart, added }` (201 when added, 200 for a repeat)                                                                                                                  |
| `GET /saved-combos`               | The student's saved combos with live prices and availability                                                                                                                                                                                           |
| `POST /saved-combos`              | `{ name, items }` (one outlet, dishes on the menu; at most 12 combos; unique name → `409 COMBO_NAME_TAKEN`)                                                                                                                                            |
| `PATCH /saved-combos/:comboId`    | `{ name?, items? }` (owner only, otherwise 404)                                                                                                                                                                                                        |
| `DELETE /saved-combos/:comboId`   | 204 (owner only)                                                                                                                                                                                                                                       |

**How these map to the example routes in the request:**

- `GET /me/reorder-history` → `GET /reorder/history`
- `GET /me/favorite-combos` → `GET /reorder/combos`
- `POST /orders/:orderId/reorder` and `POST /combos/:comboId/reorder` → `POST /reorder/preview`
  followed by `POST /reorder/cart`. Splitting them lets the student see changes before anything
  enters the tray.

Writes share the per-user action rate limit.

## Database (migration `20261018010000_quick_reorder`)

The migration only adds things; order records stay the source of truth for purchases.

- **`SavedMealCombo`:** owner, outlet, name, timestamps.
  - Unique `(userId, name)`, so a retried save can't duplicate.
  - Unique `(id, outletId)`, so every item must come from the combo's outlet.
  - Indexed `(userId, updatedAt)`.
- **`SavedMealComboItem`:** menu item reference + quantity only (CHECK 1–10).
  - No prices are stored.
  - Composite FKs to the combo and to `MenuItem(id, outletId)`.
- **`ReorderEvent`:** one row per successful reorder into the cart (source, order or saved combo,
  outlet, item count, current-price total).
  - Unique `(userId, idempotencyKey)`, so retries record once.
  - Deleting a saved combo keeps its events (`savedComboId` becomes null).

Nothing is stored for recommendations: they are computed from orders on each request.

Apply it with:

```bash
npm run db:migrate:deploy -w backend
```

```bash
npm run db:migrate:test -w backend
```

## Tests

- **Backend:** `backend/src/modules/reorder/reorder.test.ts` (20 tests).
  - History: own orders only, folding repeats, cancelled and open orders excluded.
  - Preview: 404 for another student's order, 409 for ineligible orders, sold-out, removed and
    low-stock dishes, alternatives, the same dish elsewhere only when open and in stock, mixed
    outlets and quantity checks.
  - Adding: current prices, idempotent add and analytics, stale total, unavailable dish, another
    student's source, partial reorder, outlet conflict, quantity and stock limits.
  - Checkout: the capacity limit still applies and the cart is kept, and the order is counted
    once.
  - Combos: counts over the window, recency, unavailable combos dropped, popular fallback
    threshold and privacy.
  - Pure scoring rules.
  - Saved combos: ownership, live prices, edits, delete, validation.
- **Frontend:** `frontend/src/features/reorder/Reorder.test.tsx` (8 tests).
  - One-tap add.
  - Review with a price change, a sold-out dish and an alternative.
  - Tray conflict with the same idempotency key.
  - Favourite combos with real counts.
  - Popular fallback labelling and empty state.
  - Hidden when signed out.
  - Customize with a server total and saving.
  - Order page button.
- **End to end:** `frontend/e2e/reorder.spec.ts`.
  - A real collected order is reordered from the home page, reviewed in the tray, checked out
    normally, then cancelled.
  - axe runs on the home page with the new sections.

## Known limitations

- **Group orders** aren't offered for reorder.
- **History window:** history and combos look back 90 days; older orders stay on the Orders page.
- **Dietary or budget preferences:** none are stored on profiles, so the score can't use them
  (Surprise Meal asks for them per request).
- **Saved combos:** a saved combo whose dishes are later removed from the menu still shows; the
  removed dishes are marked "No longer on the menu" and aren't added.
