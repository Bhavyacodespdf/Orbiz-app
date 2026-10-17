# Menu item stock

Every menu item has a stock status, worked out on the server from database fields and enforced
wherever an item can be ordered or recommended.

| Status        | Meaning                                          | Orderable? |
| ------------- | ------------------------------------------------ | :--------: |
| **AVAILABLE** | In stock                                         |     ✅     |
| **LOW STOCK** | Counted, and at or below its low-stock threshold |     ✅     |
| **SOLD OUT**  | Marked sold out by staff, or 0 units left        |     ❌     |

Students see "Few left" for low stock and never see exact quantities. Staff see quantities,
thresholds and a badge with the same three statuses everywhere.

## Data model

Built on the existing `MenuItem.isAvailable` switch (staff "sold out") rather than a second system.
Migration `20261017140000_menu_item_stock` adds:

| Field / table                | Notes                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MenuItem.trackInventory`    | Quantity counting is **opt-in per item**. Default `false`.                                                                                         |
| `MenuItem.stockQuantity`     | Units on hand. `NULL` exactly when not tracked (CHECK); 0–100,000 (CHECK).                                                                         |
| `MenuItem.lowStockThreshold` | LOW STOCK at or below this. 0–10,000 (CHECK), default 0 (no alert).                                                                                |
| `MenuItem.stockUpdatedAt`    | Last quantity change.                                                                                                                              |
| `StockAdjustment` (new)      | Append-only history: item, outlet, type, signed change, quantity before and after, order (for order changes), staff member and role, reason, time. |

**The status is derived, never stored**, so it can't drift (`backend/src/modules/inventory/stock.ts`):

```
isAvailable = false (marked sold out)        → SOLD OUT   (stays until staff restore it)
tracked and stockQuantity <= 0               → SOLD OUT
tracked and stockQuantity <= threshold       → LOW STOCK
otherwise                                    → AVAILABLE
```

**Existing items are not given invented quantities.** After the migration every item is untracked
and behaves exactly as before: available unless marked sold out. A manager starts counting an
item by entering the units actually on hand (see [Setting up](#setting-up-stock)).

## Who can do what

The existing outlet-role checks apply: the live role **and** an assignment to the outlet. Another
outlet's item IDs return 404.

| Action                                         | Manager | POS | Student |
| ---------------------------------------------- | :-----: | :-: | :-----: |
| View stock, quantities, history                |   ✅    | ✅  |   ❌    |
| Restock (add units)                            |   ✅    | ✅  |   ❌    |
| Remove units (reason required: waste, damage…) |   ✅    | ✅  |   ❌    |
| Mark sold out / make available                 |   ✅    | ✅  |   ❌    |
| Start or stop counting an item                 |   ✅    | ❌  |   ❌    |
| Set the low-stock threshold                    |   ✅    | ❌  |   ❌    |
| Replace the quantity with a stock count        |   ✅    | ❌  |   ❌    |

Screens: **Kitchen → Stock** (`/manage/stock`) and **Counter → Stock** (`/pos/stock`). The Menu page's
availability switch is the same "sold out" switch.

## Rules that keep the numbers right

- **No lost or negative updates.** Every quantity change is one conditional `UPDATE … RETURNING`
  on the item row:
  - restock: `+n`, up to 100,000
  - removal: `−n`, only `WHERE stockQuantity >= n`
  - order: `−qty`, only `WHERE stockQuantity >= qty`

  PostgreSQL locks the row, so simultaneous changes queue up and each sees the result of the last.

- **Stock counts don't overwrite other changes.** A count is applied only if the quantity is still
  the one the manager saw (`expectedQuantity`). Otherwise the server replies `409 STOCK_CHANGED`
  with the current figure.
- **Marked sold out stays sold out.** Restocking never undoes it. Staff restore it explicitly, either
  with "Make available" or by ticking "Also make it available again" when restocking. Making an
  item with 0 units available still shows it sold out until it's restocked.
- **History for everything.** Each change writes a `StockAdjustment` in the same transaction.
  Starting or stopping counting also writes an audit-log entry.

## Orders

CampusCart creates an order and takes payment in **one transaction**. A wallet debit happens
there, and a pay-at-counter order is created unpaid on purpose. So stock is taken **when the
order is placed**, inside that transaction:

- **Counted items are decremented atomically** (lines in a fixed order, so two multi-item orders
  can't deadlock). Concurrent orders can't oversell: the last units go to the first orders to
  commit, and the rest get `409 INSUFFICIENT_STOCK` with how many are left.
- **A failed payment saves nothing.** If anything fails (insufficient wallet balance, a price change,
  not enough stock, not enough points), the whole transaction rolls back. No order, no debit, no
  stock taken. There is no separate reservation step to recover from.
- **Each deduction is recorded** as `ORDER_DEDUCTION`. The student is the actor.

**Rejected or cancelled orders** get back exactly what they took, in the same transaction as the
status change (and any wallet refund or points restoration):

- Only items that were actually deducted are restored. Untracked items never were.
- Restored at most once. The status change can only happen once (version-checked), and
  `unique(orderId, menuItemId, type)` prevents a second `ORDER_RESTORE` row.
- If counting was switched off in between, the restoration is recorded with no quantity, so
  nothing is invented.

**Completed orders** keep their stock deducted.

**Scheduled no-shows** restore packaged, resellable lines once (`ORDER_RESTORE`, reason
`SCHEDULED_ORDER_NO_SHOW`); handmade and "not resellable" lines are not restored. See
[no-show-policy.md](no-show-policy.md).

## Everywhere else

The one status definition is used by:

| Where                                    | Behaviour                                                                                                                                                                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Student menu (`GET /outlets/:slug/menu`) | `stockStatus` per item; `isAvailable` means orderable now. No quantities.                                                                                                                                                                                             |
| Cart                                     | Adding a sold-out item: `409 ITEM_UNAVAILABLE`. Adding or raising above what's left: `409 INSUFFICIENT_STOCK` ("Only 3 left"). Items that sell out while in a cart stay there, flagged `SOLD_OUT` or `NOT_ENOUGH_STOCK` (with how many are left), and block checkout. |
| Checkout                                 | Re-checks everything and takes stock atomically (above).                                                                                                                                                                                                              |
| AI Surprise Meal                         | Combos and swaps use only orderable items. Low-stock items may appear. Adding a combo to the tray re-checks stock.                                                                                                                                                    |
| Today's Special polls                    | Sold-out dishes can't be offered or voted for.                                                                                                                                                                                                                        |
| BitBot                                   | **Doesn't exist in this codebase.** Any future recommender should use `inStockWhere` / `stockStatus` from `stock.ts`.                                                                                                                                                 |

**Live updates.** After every committed change (staff action, order, cancellation), the server
sends `stock.updated { outletId, menuItemIds }` to all connected users. It carries IDs only, no
quantities. The app then re-reads menus, staff stock and menu screens, the cart, specials and
polls. The server re-checks stock on every order regardless.

## API

All under `/api/v1/staff/outlets/:outletId`, for staff assigned to the outlet.

| Method & path                           | Body                                                                                                                                                              | Who                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `GET /inventory?q=&categoryId=&status=` | none. Returns `{ items: InventoryItem[], counts: { AVAILABLE, LOW_STOCK, SOLD_OUT } }`                                                                            | Manager, POS                             |
| `GET /inventory/:itemId/history`        | none. Returns the latest 50 changes                                                                                                                               | Manager, POS                             |
| `POST /inventory/:itemId/adjustments`   | `{ type: "RESTOCK", quantity, reason?, markAvailable? }` · `{ type: "REMOVAL", quantity, reason }` · `{ type: "COUNT_SET", quantity, expectedQuantity, reason? }` | COUNT_SET: Manager; others: Manager, POS |
| `PATCH /inventory/:itemId/threshold`    | `{ lowStockThreshold }`                                                                                                                                           | Manager                                  |
| `POST /inventory/:itemId/tracking`      | `{ enabled: true, quantity, lowStockThreshold? }` or `{ enabled: false }`                                                                                         | Manager                                  |
| `PATCH /items/:itemId/availability`     | `{ isAvailable }`: the existing sold-out switch, now recorded in the stock history and broadcast                                                                  | Manager, POS                             |

- **Item responses:** `{ item: InventoryItem }`, with `trackInventory`, `stockQuantity`,
  `lowStockThreshold`, `soldOutManually`, `stockStatus`, `soldOutReason` and `stockUpdatedAt`.
- **Errors:**
  - `400` for invalid numbers (negative, zero where not allowed, fractions, above the limits) or a
    removal without a reason
  - `409 NOT_TRACKED`, `ALREADY_TRACKED`, `INSUFFICIENT_STOCK`, `STOCK_CHANGED`
  - `403` for actions above the caller's role

## Weekly Stock Planner

The planner (`/pos/planner`, `/manage/planner`) reads this ledger to build demand history and
recommends weekly quantities. Its **Record restock** button is an ordinary RESTOCK through this
service, linked to the plan line with a retry-safe key. See [stock-planning.md](stock-planning.md).

## Setting up stock

After deploying, nothing changes until a manager opts items in:

1. Open **Kitchen → Stock** and choose **Settings** on an item.
2. Count the units actually on hand, enter them, set the low-stock threshold, and choose **Start
   counting stock**.
3. From then on:
   - orders take units automatically
   - cancellations give them back
   - staff restock with **Restock**, record waste with **Remove**
   - managers correct drift with **Stock count**

Items that are never counted keep working as before: available until someone marks them sold out.

## Manual test

1. As a manager, start counting an item with 2 units and a threshold of 5. It shows **Low stock**,
   "2 left".
2. As a student, the menu shows **Few left**. Try to add 3: refused ("Only 2 left"). Order 2.
3. As another student, the item shows **Sold out** with no Add button. The manager's screen shows 0.
4. As a cashier, **Restock** 10. The item can be ordered again.
5. Cancel the first student's order. The stock goes back up by 2, once.
6. **Mark sold out**, then restock: it stays sold out until **Make available**.
7. Open **History** for the item to see every change, who made it and why.
