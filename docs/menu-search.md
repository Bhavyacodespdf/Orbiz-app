# Menu search & sorting

Students can search and sort dishes in two places:

- **Menu** (`/menu`, new tab in the main navigation): every visible dish on campus, paged.
- **Outlet menu** (`/outlets/:slug`): one outlet's dishes.

Both use one server-side service (`backend/src/modules/menu/menu-search.ts`). Every result comes
from live data: current prices, stock, persisted published reviews and real order records.
Search, filters and sort are kept in the URL (`q`, `sort`, `outlet`, `category`, `veg`, `stock`),
so a result can be shared, refreshed, or reached with Back.

## Search and filters

- **Search** is case-insensitive and matches part of the dish's name, description or category
  name (the campus menu also matches the outlet's name). **Clear search** is the ✕ in the field.
  - If nothing matches, the page says so, with **Clear search and filters**. Clearing keeps the
    chosen sort.
- **Filters:**
  - **Outlet:** campus menu only.
  - **Category:** the campus menu needs an outlet chosen first, since categories belong to an
    outlet.
  - **Veg only.**
  - **In stock only:** dishes that can be ordered now.
- **Visibility is unchanged.** Inactive dishes, categories and archived outlets never appear.
  Sold-out dishes stay visible (as on the normal menu) unless **In stock only** is on.

## Sorting

The options are **Popular · Price: Low to High · Price: High to Low · Quick Reorder · Highest
Rated**. They are pills that wrap on small screens, the chosen one is highlighted, and pressing it
again returns to the outlet's own order. On the outlet page a chosen sort shows one ranked list
instead of category sections.

**Rules shared by every sort:**

- Dishes that can be ordered now come before sold-out ones.
- Ties fall back to the dish name, then its ID, so results and pages are stable.

### Popular

```
score = number of distinct COMPLETED, PAID orders containing the dish in the last 30 days
```

- **What counts:** only collected orders. Cancelled, rejected, no-show and unpaid orders never
  count.
- **No double counting:** an order is counted once per dish (`COUNT(DISTINCT orderId)`), however
  many statuses it went through and however many of the dish it held.
- **New dishes** with no orders score 0 and follow by name. They are never labelled popular.
- **Label:** a **Popular · N orders in 30 days** label appears only when N ≥ 3. The real count is
  returned as `orders30d`.

### Price: Low to High / High to Low

- **Price:** the dish's current `pricePaise` (integer paise; no floats). Old order prices are
  never used.
- **Discounts:** CampusCart has no per-dish discounts. Loyalty points and the scheduled-order fee
  apply at checkout to the whole order, so the menu price is the effective price.

### Quick Reorder (signed-in students)

```
score = orders + 3 × e^(−days since last order × ln 2 / 14)
```

- **Data:** only the signed-in student's own COMPLETED, non-group orders from the last 90 days
  are read. Recency halves every 14 days and is worth up to 3 orders, so a dish ordered today
  outranks one ordered twice three weeks ago. Repeats still add up.
- **What the student sees:** their history per dish: "You've ordered this 2 times · last 12 Oct".
- **Signed out:** the page asks the student to sign in, and the menu shows its usual order.
  Nothing fails.
- **No history** (in the window, among these results): a note explains this and the usual order
  is used.
- **Privacy:** the response is `Cache-Control: private, no-store`. One student's history is
  never used for, or shown to, anyone else.
- Adding a dish uses the normal **Add** button, so the existing cart, checkout, stock checks and
  payment confirmation all apply. The home page's Quick reorder section ([quick-reorder.md](quick-reorder.md))
  still reorders whole meals.

### Highest Rated

The ordering uses three groups:

1. **Established dishes** with 3 or more published reviews, by Bayesian score.
2. **Dishes with 1–2 reviews**, by Bayesian score.
3. **Unrated dishes**, by name.

```
bayesian = (campus mean × 3 + sum of ratings) ÷ (3 + review count)
```

- **Which reviews count:** only `PUBLISHED` reviews; reviews hidden by moderation never count.
- **The campus mean** is the average of every published rating (3.5 if there are none yet).
- **Why the threshold:** a single 5★ review never outranks a dish with ten reviews averaging 4.6.
- **What's shown:** the dish's real average and count ("★ 4.6 · 10 ratings"). The score is only
  used for ordering.
- Ties: more reviews first, then name.

## API

| Request                                                                           | Notes                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/menu?q=&outletId=&category=&dietary=&inStock=&sort=&page=&pageSize=` | Campus menu. Public; Quick Reorder uses the session if there is one. `pageSize` 1–50 (default 24). Returns `{ items, total, page, pageSize, hasMore, sort, quickReorder, popularWindowDays, filters: { outlets, categories } }` |
| `GET /api/v1/outlets/:slug/menu?q=&category=&dietary=&inStock=&sort=`             | Outlet menu (all of one outlet's dishes, unpaged). Adds `total`, `sort`, `quickReorder` and `popularWindowDays` to the existing response                                                                                        |

- **Sort values:** `popular`, `price-asc`, `price-desc`, `quick-reorder`, `highest-rated`. The
  old `rating` is still accepted as `highest-rated`.
- **Validation:** anything else is a `400` (an unknown sort, non-UUID ids, `pageSize` over 50,
  page 0, a search over 60 characters, `inStock` not true/false).
- **What each item carries:** the usual menu fields plus `rating`, `category`, `outlet`,
  `orders30d` and `popular` (Popular only), and `mine` (Quick Reorder only, the viewer's own
  history).
- **Nothing is taken from the client:** no prices, ratings, scores or user IDs. The student comes
  from the session.

## Performance

- **Filtering** happens in one indexed query that selects only the fields needed for ranking.
- **Aggregates** are each one grouped query over the whole matching set, never per dish:
  popularity, the viewer's history, rating summaries and the campus mean.
- **Paging:** after ranking, only the requested page is loaded in full.
- **Indexes:** a new index `OrderItem(menuItemId, orderId)` (migration
  `20261018030000_menu_search_indexes`) backs the popularity and history aggregations, alongside
  the existing `Order(outletId, status, placedAt)` and `FoodReview(menuItemId, status, createdAt)`.
- **No server cache:** results are always current, so there's nothing to invalidate and no new
  infrastructure.
- **Stale responses:** each request carries its full filter set in the React Query key and an
  `AbortSignal`, so a superseded request is cancelled and can't overwrite newer results.
  Changing a filter restarts at page 1.

Ranking happens in memory over the matching dishes. That's fine for campus-sized menus (thousands
of dishes); a much larger catalogue would move ranking into SQL.

## Layout change

The main navigation gained **Menu**, making six items. The inline header navigation now starts at
the `lg` breakpoint, and tablets use the bottom tab bar, so nothing overflows at 768px. The floating
cart bar and toasts moved with it.

## Tests

- **Backend:** `backend/src/modules/menu/menu-search.test.ts` (11 tests).
  - Search: case-insensitive and partial, across dish, category and outlet names; empty results;
    invalid parameters.
  - Price both ways, with live prices, sold-out last, in-stock filter and integer prices.
  - Popularity: distinct collected orders; cancelled and older-than-window orders ignored; label
    threshold.
  - Highest Rated: Bayesian score with the review threshold, hidden reviews excluded, unrated
    last, legacy `rating` alias.
  - Quick Reorder: own recent and repeated dishes first; another student's history never used;
    signed-out and new students fall back.
  - Combined outlet + category + search + dietary + sort; stable paging without overlaps; hidden
    dishes and outlets never shown.
- **Frontend:** `frontend/src/features/menu/MenuSearch.test.tsx` (5 tests).
  - The exact five options; highlighting; server-side search and sort; the sort kept while the
    search changes.
  - Outlet filter; empty state that keeps the sort; Show more; signed-out Quick Reorder note.
  - Outlet page ranked list with Popular labels and "You've ordered this" history.
- **End to end:** `frontend/e2e/menu.spec.ts` on seeded menus at phone width.
  - Price order matches the prices shown; partial, any-case search keeps the sort; empty state;
    no sideways scroll.
  - `quality.spec.ts` now also checks `/menu` and `/menu?sort=quick-reorder` with axe and an
    overflow check at three widths.
