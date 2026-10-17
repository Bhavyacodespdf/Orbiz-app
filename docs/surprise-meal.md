# AI Surprise Meal — Budget Solver

A student sets a budget, a craving mood, a diet and (optionally) an outlet, and gets a combo of
real, orderable dishes that **never costs more than the budget**. They can swap any single dish,
re-spin for a different combo, and add the whole combo to their normal cart.

Open it from the **AI Surprise Meal** card on the home page, or at `/surprise` (sign-in
required).

## What is (and isn't) "AI" here

- **No AI provider ships with CampusCart.** The repository had no BitBot, chatbot or model
  integration and no AI credentials, and adding a paid provider needs separate approval. Every
  combo today comes from the **deterministic recommendation engine** described below. The card
  says so: "Picked by CampusCart's recommendation rules from the live menu (no AI model is
  connected)", and its heading reads "Recommended combo".
- There is **no trained machine-learning model**. Ranking is rule-based scoring with soft
  personalisation from the student's own past orders.
- An **optional AI step** is built in and fully tested with a fake provider (see
  [AI integration](#ai-integration)). If a provider is added later, combos it suggests are
  labelled "AI recommended combo", and only after passing every check.

## The rules (hard constraints)

These are applied by the server from database records and are never relaxed to produce a result:

| Rule                | How                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Budget              | Whole rupees, **₹50–₹1,000** (`surprise.rules.ts`). A combo's total, recomputed from database prices, is always ≤ the budget.                                     |
| Orderable right now | Item active and in stock, category active, outlet active **and OPEN**.                                                                                            |
| Outlet              | A chosen outlet restricts every dish. **All outlets** still yields a single-outlet combo, because a CampusCart cart holds one outlet; the card names that outlet. |
| Veg                 | Only dishes whose menu label is `VEG`. Egg, non-veg and **unlabelled** dishes are excluded.                                                                       |
| Non-Veg             | Every dish must have a menu label (unlabelled dishes are excluded), and the combo contains at least one `NON_VEG` dish. Veg and egg dishes may accompany it.      |
| Any                 | All orderable dishes, including unlabelled ones.                                                                                                                  |

Dietary labels come only from the `MenuItem.dietary` field, never from dish names.

If nothing fits, the response says why (`NO_MATCHING_DISHES`, `NO_NON_VEG`, `BUDGET_TOO_LOW` with
the cheapest matching price, `NO_COMBO_FITS`, `OUTLET_NOT_ACCEPTING`) and the page suggests raising
the budget or changing a filter.

## How a combo is built

```
filter (database) → score each dish → build combos per outlet → pick the best → re-read from the database → explain
```

1. **Filter.** Load orderable dishes (at most 500) for the outlet filter, then apply the diet rule.
2. **Score each dish** (soft signals only):
   - **Mood fit:** words matched against the outlet's own _category_ names. Examples: Quick Bite →
     snacks, rolls, sandwiches; Cafe & Treat → drinks, coffee, desserts; Feast → meals, thalis,
     rice. This is a ranking hint only.
   - **Price shape:** Quick Bite prefers cheaper dishes; Feast and High Protein prefer
     substantial ones.
   - **Personal history:** dishes and categories from the signed-in student's own past orders
     (rejected and cancelled orders excluded) rank higher. History never overrides a rule.
   - **Re-spin:** the previous combo's dishes are penalised, so a re-spin differs when it can.
   - **Variety:** a small random jitter, so re-spins aren't identical.
3. **Build combos.** For each open outlet, 40 randomised greedy passes. Each pass adds the
   highest-ranked dishes that still fit the remaining budget, preferring different categories, up
   to the mood's dish count:

   | Mood         | Dishes (if budget and menu allow) |
   | ------------ | --------------------------------- |
   | Quick Bite   | 1–2                               |
   | High Protein | 1–3                               |
   | Cafe & Treat | 2–3                               |
   | Feast Combo  | 2–4                               |
   - Non-Veg combos start from a non-veg dish.
   - Cafe & Treat combos start from a drink or treat when one fits.
   - A combo is never forced to a fixed size: a budget that fits one dish gets one dish.

4. **Pick the best.** Each candidate combo is scored on dish scores, variety, how well it uses
   the budget for the mood, and whether it differs from the previous combo. The best one wins.
5. **Re-read.** The chosen dishes are loaded again from the database and every rule is checked
   once more before anything is returned.
6. **Explain.** Short reasons built only from facts: how much budget is left, the categories it
   mixes, dishes the student has ordered before, and the mood.

**High Protein.** CampusCart menus record no protein data, so no dish is ever described as high
in protein. This mood favours filling mains, and the page shows a notice saying exactly that.

**Nutrition and preparation time.** Menus don't record calories, protein or preparation times, so
the card shows no such numbers. It says they aren't recorded rather than showing partial or
estimated totals.

## Swapping one dish

1. The current combo is re-read from the database and must still be valid. If a price or
   availability changed, the server replies `409 COMBO_OUT_OF_DATE` and the page suggests a
   re-spin.
2. Money left for the replacement = **budget − total of the other dishes**. Example: a ₹300
   budget with ₹220 in other dishes leaves ₹80.
3. Candidates come from the same outlet, cost no more than that amount, aren't already in the
   combo (the swapped dish included), and keep the combo's diet rule. Swapping the only non-veg
   dish in a Non-Veg combo needs another non-veg dish.
4. Dishes from the same category as the one replaced are preferred (like for like).
5. If nothing fits, the original dish stays, the other dishes are untouched, and the row
   explains why.

## Adding the combo to the tray

`POST /cart/combo` is part of the **existing cart module**. It is not a separate cart:

- **All or nothing:** one transaction re-checks every dish (active, in stock, category, outlet
  open), requires a single outlet, and recomputes the total from live prices. A different total
  is refused with `PRICE_CHANGED` and nothing is added; the page then suggests a re-spin.
- **Existing cart rules:** the one-outlet rule (`CART_OUTLET_CONFLICT`; the page asks before
  replacing a tray from another outlet), plus quantity and line limits.
- **No duplicates:** each combo shown gets its own `Idempotency-Key`. The cart row is locked and
  remembers the last combo key it applied (`Cart.lastComboKey`), so double-clicks, retries and
  concurrent submissions add the combo once. A repeated submission returns `200 { added: false }`.
- **Unchanged checkout:** prices are confirmed again at checkout, and wallet, loyalty points and
  payment rules all apply as usual.

## AI integration

`backend/src/modules/surprise/surprise.ai.ts` defines the `ComboAdvisor` interface. `advisorFor()`
returns `null`, so no provider is configured.

**To add a provider later** (after approval):

1. Implement `ComboAdvisor.suggest(request, signal)` server-side.
2. Read its key from a new environment variable. Never expose it to the frontend, and never log it.
3. Return the advisor from `advisorFor()`.

**What a provider receives:** only budget, mood, diet and up to 80 eligible candidates (ID, name,
category, price, outlet name). It gets no student identity and no order history.

**What happens to its reply:**

- The reply is untrusted. Only `itemIds` (and an optional short explanation, stripped of markup
  and capped at 280 characters) are read.
- Every ID must be one of the candidates sent.
- The suggestion must keep one outlet (and the chosen outlet), the diet rule, and the budget, using
  database prices.
- The combo is then re-read from the database.
- Names, prices, totals, availability or nutrition it mentions are ignored.
- A slow (2.5 s timeout), failing, malformed or invalid reply falls back to the deterministic
  engine, and a short log line records why.
- The AI can never write to the database or change menus, carts or orders.

## Privacy and limits

- **Requires sign-in** (Student role). The student is always the session user; request bodies
  are strict, so no student ID can be passed.
- **Own history only:** order history is read only for that student, used in memory, and never
  returned or stored.
- **Nothing persisted:** no recommendation history, prompts or results are kept.

## Files

| Area     | Files                                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend  | `backend/src/modules/surprise/` (`surprise.rules.ts`, `surprise.engine.ts`, `surprise.ai.ts`, `surprise.service.ts`, `surprise.routes.ts`), `cart.service.ts` / `cart.routes.ts` (`POST /cart/combo`) |
| Database | `Cart.lastComboKey` (migration `20261017120000_cart_combo_key`)                                                                                                                                       |
| Frontend | `frontend/src/services/surprise.ts`, `frontend/src/features/surprise/`, route `/surprise`, home page card                                                                                             |
| Tests    | `surprise.engine.test.ts`, `surprise.ai.test.ts`, `surprise.test.ts` (backend); `SurpriseMealPage.test.tsx`; `frontend/e2e/surprise.spec.ts` and the `/surprise` accessibility sweep                  |

## Manual test

1. Sign in as a student and open **AI Surprise Meal** from the home page.
2. Press **₹80 Snack**, **₹140 Lunch**, **₹200 Power** and **₹300 Feast**, and drag the slider.
   The amount updates, a new combo arrives, and its total is never above the budget. The card
   reads "₹X under your ₹Y budget" or "Budget fully used".
3. Try each mood: Feast gives bigger combos, Cafe & Treat includes a drink when one fits, and
   High Protein shows its notice.
4. Choose **Veg**: only dishes with the green vegetarian mark. Choose **Non-Veg**: at least one
   non-veg dish.
5. Choose an outlet: every dish comes from it. Choose a closed outlet: you're told it isn't taking
   orders.
6. Set ₹50 with Non-Veg: you're told the cheapest matching price.
7. **Swap** a dish: only that row changes and the total stays within budget. Swap until nothing
   fits: the dish stays, with an explanation.
8. **Add Combo to Tray**, then open the cart: the same dishes at the same prices. Click Add
   again: "This combo is already in your tray". With another outlet's items already in the cart,
   you're asked before they're replaced.
