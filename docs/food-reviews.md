# Food ratings & reviews

Students rate dishes they have actually collected, from 1 to 5 stars, with optional written
feedback and four optional quick ratings (taste, portion size, freshness, value for money). Every
average and count is calculated from stored reviews. Nothing is hard-coded or sent by the browser.

## Where it shows

| Surface                                         | What students see                                                                                                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outlet menu (incl. search and category filters) | `★ 4.6 · 128 ratings` or `Not yet rated` under each dish, linking to the dish page. The **Highest Rated** sort ranks dishes by rating ([menu-search.md](menu-search.md#highest-rated)); nothing is hidden |
| Dish page `/outlets/:slug/items/:itemId`        | Average, count, 1–5 star bars, the student's own review (Rate food / Edit / Delete), all reviews (newest, highest or lowest first; 10 at a time with **Show more**), Verified Purchase labels, Report     |
| Order page (collected orders)                   | **Rate your food**, with a Rate link for each dish                                                                                                                                                        |
| My reviews `/reviews` (from Profile)            | Every review the student wrote, with dates, edited marker and whether the outlet hid it                                                                                                                   |
| Surprise Meal combos                            | The rating of each suggested dish                                                                                                                                                                         |
| Kitchen → Reviews `/manage/reviews` (manager)   | Outlet average and distribution, each dish's average and 30-day trend, recent written feedback, moderation                                                                                                |

The home page's outlet search returns outlets rather than dishes, and Today's Special cards don't
show ratings. Neither has a dish card to put a rating on.

## Policy (decided for this release)

- **Who can review:** a signed-in student whose **COMPLETED, PAID** order contains the dish.
  - For a **group order** (it belongs to the host), it's a member who put that dish on the tray.
    The host doesn't qualify for dishes other members added.
  - Placed, accepted, preparing, ready, rejected, cancelled, no-show and unpaid orders never
    qualify.
  - The server checks this in the database on every new review. The client sends only the dish ID
    and the review. Extra fields such as `orderId` or `verifiedPurchase` are rejected.
- **One review per student per dish.** Buying the dish again doesn't add a review; the student
  edits the one they have.
  - A unique constraint on `(userId, menuItemId)` stops double-clicks and concurrent submits from
    making a second row. The loser gets `409 REVIEW_EXISTS` with the existing review's ID.
- **Verified Purchase.** Because only eligible students can write a review, every review is a
  verified purchase. `verifiedPurchase` is set by the server, never by the client. The review
  remembers the latest qualifying order (`orderId`) found when it was written.
- **Edits** update the same row (`updatedAt` changes, `createdAt` doesn't), and the page shows
  "edited".
- **Deleting:** students may delete their own review and may write a new one later if they're
  still eligible.
- **Ownership:** editing or deleting someone else's review returns the same `404` as a missing
  review, so review IDs can't be probed.
- **Publication:** reviews are **published immediately** (post-moderation).
  - Any signed-in student can **report** someone else's review once (reason + optional note).
  - The outlet's **manager** can **hide** a review (a reason is required, and the author sees it),
    **restore** it, or **keep** it (closes the reports).
  - Hidden reviews leave public lists and every rating summary. Editing a hidden review doesn't
    republish it.
  - Every moderation action is written to the audit log (`FOOD_REVIEW_HIDE`, `_RESTORE`, `_KEEP`).
- **Staff limits:** POS staff can't see or change reviews. Nobody, managers included, can edit
  what a student wrote or create a review for someone else. Managers only see reviews of their own
  outlet's dishes.
- **Privacy:** reviewers appear as first name plus last initial ("Asha K."). Emails and full names
  are never returned, to students or managers.

## Ratings maths

- `average = sum of published ratings ÷ number of published ratings`. This is exact for sorting.
- It's rounded half-up to one decimal for display (4.25 → 4.3) and shown as `4.0`, `4.5` etc.
- With no ratings, `average` is `null` and the UI says **Not yet rated**.
- Summaries are calculated on each request with grouped SQL queries over the indexed
  `FoodReview` table. No average or count is stored, so there's no stored total that concurrent
  writes could corrupt, and creating, editing, deleting or hiding a review changes the numbers
  immediately.
- Ratings belong to one `MenuItem`. Every menu item belongs to exactly one outlet, so "Chai" at
  two outlets is two items with separate ratings. A composite foreign key
  `(menuItemId, outletId) → MenuItem(id, outletId)` makes it impossible for a review to name the
  wrong outlet.
- **Manager trend:** each dish's average over the last 30 days is compared with the 30 days
  before. A change of 0.3★ or more is **Improving** or **Declining**; smaller changes are
  **Steady**. If either window has no reviews, the trend is "not enough recent reviews".

## Limits and safeguards

| Rule        | Value                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Rating      | Whole number 1–5 (validated on the server and by a database CHECK)                                  |
| Review text | Optional, ≤ 1000 characters (CHECK). Trimmed; empty means none; control characters are stripped     |
| Report note | Optional, ≤ 300 characters                                                                          |
| Hide reason | Required, ≤ 300 characters                                                                          |
| Rate limit  | Writes to `/menu-items` and `/reviews` share the per-user action limit (`MONEY_RATE_LIMIT_PER_MIN`) |
| Page size   | 1–50 (default 10)                                                                                   |
| Rendering   | Review text is shown as plain text (React escapes it; no HTML or Markdown)                          |

No sentiment analysis or AI-generated reviews.

## API (`/api/v1`)

| Method & path                                                                  | Who                  | Purpose                                                                                                   |
| ------------------------------------------------------------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /menu-items/:itemId`                                                      | anyone               | Dish, category, outlet and `rating` with `distribution`                                                   |
| `GET /menu-items/:itemId/ratings`                                              | anyone               | `{ rating: { average, count, distribution } }`                                                            |
| `GET /menu-items/:itemId/reviews?sort=recent\|highest\|lowest&page=&pageSize=` | anyone               | Published reviews, paged: `{ reviews, page, pageSize, total, hasMore }`                                   |
| `GET /menu-items/:itemId/my-review`                                            | student              | `{ eligible, review }`                                                                                    |
| `POST /menu-items/:itemId/reviews`                                             | student (eligible)   | `{ rating, body?, taste?, portion?, freshness?, value? }` → 201; 403 `NOT_ELIGIBLE`; 409 `REVIEW_EXISTS`  |
| `PATCH /reviews/:reviewId`                                                     | author               | Any subset of the fields above                                                                            |
| `DELETE /reviews/:reviewId`                                                    | author               | 204                                                                                                       |
| `POST /reviews/:reviewId/report`                                               | student (not author) | `{ reason: OFFENSIVE\|SPAM\|NOT_ABOUT_FOOD\|PERSONAL_INFO\|OTHER, note? }` (repeating it changes nothing) |
| `GET /me/reviews?page=&pageSize=`                                              | student              | Own reviews, including hidden ones with the reason                                                        |
| `GET /staff/outlets/:outletId/reviews/summary`                                 | outlet MANAGER       | Average, total, distribution, open reports, per-dish trend, recent feedback                               |
| `GET /staff/outlets/:outletId/reviews?filter=reported\|hidden\|all`            | outlet MANAGER       | Reviews for moderation, with open report counts and reasons                                               |
| `POST /staff/outlets/:outletId/reviews/:reviewId/hide\|restore\|keep`          | outlet MANAGER       | Moderate (`hide` needs `{ reason }`); audited                                                             |

Feedback values are `POOR | OKAY | GREAT` (shown per aspect, e.g. portion "Too small / Just right
/ Generous"). `GET /outlets/:slug/menu` items and Surprise Meal combo items now include
`rating: { average, count }`. The menu's `sort` parameter is described in [menu-search.md](menu-search.md).

## Database

Migration `20261018000000_food_reviews` only adds things; existing data is untouched. It creates:

- `FoodReview`: user, menu item + outlet (composite FK), qualifying order, rating, body, four
  feedback columns, `verifiedPurchase`, `status` (`PUBLISHED | HIDDEN`), moderation fields and
  timestamps.
  - Unique on `(userId, menuItemId)`.
  - Indexed by `(menuItemId, status, createdAt)`, `(outletId, status, createdAt)` and
    `(userId, updatedAt)`.
  - CHECKs: rating 1–5, body length, and a hidden review must record who hid it and when.
- `FoodReviewReport`: unique on `(reviewId, userId)`; deleted with its review.

Apply it with:

```bash
npm run db:migrate:deploy -w backend
```

```bash
npm run db:migrate:test -w backend
```

The E2E database is migrated automatically by the Playwright global setup.

## Tests

- **Backend:** `backend/src/modules/reviews/reviews.test.ts` (27 tests).
  - Eligibility: collected orders count; placed, ready, rejected, cancelled and unpaid counter
    orders don't; another student's purchase doesn't; group members count per dish.
  - Validation: out-of-range, fractional and string ratings, text length, unknown fields.
  - Duplicates: repeated and concurrent submits.
  - Ownership: edit and delete only by the author.
  - Summaries: average, distribution and rounding, including after edits and deletes.
  - Lists and menu: paging and sorting, outlet isolation, sort-by-rating.
  - Moderation and analytics: reports and moderation (incl. POS and other outlets' managers),
    manager analytics, Surprise Meal ratings, short names.
- **Frontend:** `Reviews.test.tsx` (dish page, form, edit, refusal, menu ratings, sorting,
  pagination), `MyReviewsPage.test.tsx`, `ManagerReviewsPage.test.tsx`.
- **End to end:** `frontend/e2e/reviews.spec.ts`.
  - A real counter order is collected, rated from the order page, edited, shown on the menu, seen
    by the manager, then deleted, with axe checks on each page.
  - `quality.spec.ts` also checks `/reviews` and `/manage/reviews`.
