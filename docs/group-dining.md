# Group Repast & Splits: group trays, banquet bookings and peer splits

Students open **Groups** (bottom navigation, `/groups`). Three tabs, all backed by real persisted
data:

- **Group Tray:** order together at one outlet; everyone pays their own share
- **Banquet:** pre-book catering for events; the outlet confirms
- **Splits:** repay a friend who paid for something shared

**Join code:** opens a dialog for a group's code. Invite links (`/groups/join/<code>`) join
directly after sign-in.

**Decisions made for this feature** (2026-10-17):

- **Group payment is "shares first, then order".**
- **Peer splits are real wallet-to-wallet transfers.**
- **Existing CampusCart styling.** The reference screenshots were never received.
- **Banquet rules are set per outlet by its manager.**

**Money:**

- Integer paise everywhere.
- **No taxes, fees, group discounts or loyalty points apply** (decision Q7; loyalty points can't
  be spent on group orders), so a group's total is its food subtotal.
- Wallet funds are **simulated** in this release, like every CampusCart balance.

## Group trays

```
ACTIVE ── host: checkout ──► CHECKOUT ── every share paid ──► ORDERED
  ▲                             │
  └──── host: reopen ───────────┤        reopen / cancel refund every paid share
CANCELLED ◄─────────────────────┘
```

1. **Create** (any student): name, outlet, optional description, size (2–20), optional
   joining deadline and split formula.
   - The server generates a **10-character join code** from 31 unambiguous characters
     (~8 × 10¹⁴ codes).
   - Joining is **rate-limited** to 20 attempts per person per 10 minutes.
2. **Join** with the code (case and dashes don't matter).
   - **Refused** with: unknown code `404 INVALID_JOIN_CODE`, past the deadline
     `410 JOIN_CODE_EXPIRED`, `409 GROUP_FULL`, `409 GROUP_NOT_JOINABLE` (after checkout), or
     `403 REMOVED_FROM_GROUP`.
   - **Privacy:** anyone who isn't an active member gets `404` for everything about the group.
3. **Add food.** Each member sets quantities of real menu items from the group's outlet (1–10
   each).
   - The server checks the item is on the menu, not sold out, and that the group's **combined**
     quantity fits counted stock.
   - Stock isn't taken yet: the existing inventory deducts it when the order is placed.
4. **Split formula** (host only, before checkout). Every change is recorded with before and after
   (`ALLOCATION_CHANGED` event).
   - **By dish:** each person pays for what they added.
   - **Equal:** `floor(total ÷ n)` each; leftover paise go one each to the first people in the
     fixed order (host, then by join time).
   - **Percentage:** basis points (0.01%) that must total exactly 100%. Amounts use the largest
     remainder method, so they add up to the total exactly.
   - **Custom:** amounts that must add up to the tray total exactly. The error shows the
     difference.
5. **Checkout** (host). Inside one locked transaction the server:
   - re-reads prices and availability
   - checks the outlet is open
   - requires the total the host was shown (`409 PRICE_CHANGED` otherwise)
   - computes the split and freezes it in a versioned `GroupSettlement`: lines at those prices,
     each member's share, inputs and member order

   The tray is then locked (`409 GROUP_LOCKED`). Repeated confirmations for the same total are
   harmless, and later price changes never touch the frozen amounts.

6. **Pay your share.** Each member pays exactly their share from **their own wallet to
   CampusCart**: a `GROUP_SHARE_PAYMENT` debit with ledger key `group-share:<shareId>`, so a share
   can never be charged twice.
   - Too little money: `409 INSUFFICIENT_BALANCE`, nothing is charged.
   - A ₹0 share is "Nothing due".
   - Nobody can mark someone else as paid: there is no manual "mark paid", only real wallet
     payments recorded by the server.
7. **The order.** When the last share is paid, the server places **one** order through the
   normal steps:
   - outlet open
   - order capacity (10 per 3 minutes)
   - pickup number
   - atomic stock deduction
   - members' quantities combined per dish, at the frozen prices

   It's `paymentMethod = GROUP`, `paymentStatus = PAID`, owned by the host (who sees it in Orders);
   members see its pickup code on the group page.

   **If it can't be placed** (a dish sold out meanwhile, outlet paused, capacity full), the
   payments stand and the host can **Place the order** again later or **Reopen** the tray, which
   refunds everyone.

8. **Refunds.** Reopen, cancel, and an outlet **rejecting or cancelling** the group order each
   refund every paid share to its payer.
   - Each refund is a `REFUND` that reverses that member's own payment (`reversesTransactionId`
     is unique, so each is refunded at most once).
   - Stock is restored by the existing order flow.

**Live updates:** every change sends `social.updated` to the group's members over Socket.IO
(IDs only), with a 30-second refresh as a fallback.

**Payment vs reimbursement:** the group page says clearly that a share payment goes to
CampusCart; settling up between friends afterwards is a separate thing (Splits).

## Banquet bookings

- **Venues:** outlets whose manager turned banquets on (**Kitchen → Banquets**).
  - **Rules per outlet:** most guests per event, minimum notice in days, and events allowed at
    the same time.
  - Events must start and finish inside the outlet's **pickup hours** that day.
- **Plan event:**
  - **The request:** venue, name, type (project lunch, birthday, club event, academic event,
    other), start (IST, 15-minute steps), duration (30 minutes to 6 hours), guests, dietary
    requirements, special instructions, optional phone.
  - **Menu package:** real menu items with quantities, shown as `Paneer Tikka Wrap (x4)`.
  - **Estimate:** the server prices the package live (`POST /banquets/quote`) and shows the
    total and per-guest amount. The booking must match it (`409 PRICE_CHANGED` otherwise).
  - **Snapshot:** a price and menu snapshot is saved with the booking, so later menu changes
    never alter it.
  - **No charges:** nothing is charged, and there is no deposit (not supported).
- **Checks:**
  - `TOO_SOON`, `TOO_FAR` (more than 90 days), `TOO_MANY_GUESTS`, `OUTSIDE_HOURS`,
    `SLOT_UNAVAILABLE` (overlapping pending or confirmed events reach the limit)
  - `BANQUETS_UNAVAILABLE`, `ITEM_UNAVAILABLE`
  - A per-outlet advisory lock serialises requests, so two at once can't both take the last
    place.
- **Lifecycle:**
  - `PENDING_CONFIRMATION` → `CONFIRMED` or `REJECTED` (manager; a reason is required to reject)
  - → `COMPLETED` (manager, once started)
  - the host can `CANCEL` before the start
  - Confirming re-checks clashes against confirmed events.
  - Every change goes in `BanquetStatusHistory` with actor and role; staff decisions are also
    in the audit log.
- **Event pass:**
  - **Host:** the pass page shows the booking and a secret pass code (32 random URL-safe
    characters, unique). Only the host can read it.
  - **Staff:** staff of **that outlet** check a code (**Banquets → Check an event pass**). It's
    valid only while CONFIRMED, and the code is never echoed back.
  - **Read-only:** changing a URL can't reveal or modify anyone else's booking (`404`).
- **No reserved bays:** CampusCart has no seating or bay data, so there's no bay selection.

## Peer splits

- **New split** (the owner paid the bill):
  - title, total, date, optional due date and note
  - method: **equal / percentage / custom**
  - participants by their **CampusCart email**; unknown emails are listed back, nothing is
    created
  - **"I had a share too"** includes the owner, whose share is marked as already covered
- **Calculation:** amounts come from the same exact allocation as group trays (rounding goes to
  people in the listed order, owner first).
- **Cards show:**
  - the full expense ("₹1,200 in total · paid by …")
  - each person's share and status
  - for the owner, **still to be repaid to you**
  - for a participant, **your share · you've paid · you owe**
- **Settle via wallet:** pay all or part of what you owe (at least ₹1, never more than owed:
  `409 OVERPAYMENT`). One transaction:
  - locks the participant row, then both wallets in a fixed order (so opposite transfers can't
    deadlock)
  - debits the payer (`PEER_TRANSFER_OUT`) and credits the owner (`PEER_TRANSFER_IN`), up to the
    owner's ₹5,000 wallet cap (`409 RECIPIENT_WALLET_FULL`, nothing moves)
  - writes a `PeerSplitSettlement` with both ledger IDs
  - **Retries:** the `Idempotency-Key` makes retries return the original. Reusing a key for a
    different amount is `409`.
- **Editing:** the owner can change the title, note and due date. **Amounts and people are fixed
  once created:** to change them, cancel and create a new split.
- **Cancelling** (owner): every repayment is sent back with two `REVERSAL` entries linked to the
  originals. Nothing is deleted; settlements become `REVERSED`.
  - Refused (`409 OWNER_BALANCE_TOO_LOW`, nothing changes) if the owner's wallet can't cover it.
  - Audited.
- **Privacy:** only the owner and participants can see a split. A participant sees only their
  own repayments, while the owner sees all.

> **Real-money note.** Person-to-person transfers between closed campus wallets may be
> restricted for real money (prepaid instrument rules). Today all funds are simulated. Get
> regulatory and finance review before connecting a real payment provider.

## Data model

Migrations:

- `20261017230000_group_dining_and_splits`
- `20261017230100_group_dining_and_splits_checks` (uses the new enum values)
- `20261017230200_peer_split_participant_order`

| Model                  | Notes                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GroupTray`            | Unique code, outlet, host, status, size, deadline, formula, version, order (unique)                                                           |
| `GroupMember`          | Unique (group, user); HOST/MEMBER; ACTIVE/LEFT/REMOVED; percentage/custom inputs. One host per group (partial unique index)                   |
| `GroupItem`            | Unique (member, dish); FK to the outlet's own menu item; quantity 1–10                                                                        |
| `GroupSettlement`      | Versioned checkout: formula, inputs, totals. Status OPEN → ORDERED or VOID. **One live per group** (partial unique index)                     |
| `GroupSettlementLine`  | Frozen lines per member (name, unit price, quantity, total)                                                                                   |
| `GroupShare`           | Per member: due, own-items part, paid, status (NOTHING_DUE/UNPAID/PAID/REFUNDED), payment and refund ledger IDs (unique), timestamps          |
| `GroupEvent`           | Append-only activity: create, join, leave, remove, settings, allocation changes (from/to), checkout, payments, order, reopen, cancel, refunds |
| `BanquetSettings`      | Per outlet: enabled, max guests (1–1000), notice (0–60 days), concurrent events (1–20)                                                        |
| `BanquetBooking`       | Event, times, guests, notes, phone, status, estimate, per-guest, **unique pass token**, decision, version                                     |
| `BanquetBookingItem`   | Price and name snapshot per dish                                                                                                              |
| `BanquetStatusHistory` | Every status change with actor, role and reason                                                                                               |
| `PeerSplit`            | Owner, title, total (≤ ₹1,00,000), INR, dates, method, status, version                                                                        |
| `PeerSplitParticipant` | Unique (split, user), position, inputs, due, paid, status                                                                                     |
| `PeerSplitSettlement`  | Payer, recipient, amount, unique idempotency key, unique debit/credit (and reversal) ledger IDs                                               |

- **New ledger types:** `GROUP_SHARE_PAYMENT` (debit), `PEER_TRANSFER_OUT` (debit) and
  `PEER_TRANSFER_IN` (credit). The type and direction CHECK now covers them.
- **`PaymentMethod.GROUP`:** allowed with `PAID`/`REFUNDED`, and only for immediate orders without
  loyalty points (CHECK).
- **Order lines:** `OrderItem.quantity` may now be up to 200, so a group's combined dish fits on
  one line. Carts are still 1–10.
- **CHECKs** keep every amount non-negative, shares consistent with their status, banquet and
  split values in range, and peer settlements consistent with reversal.

## API

All under `/api/v1`, sign-in and STUDENT role required (staff routes need the outlet assignment).
Errors use the usual `{ error: { code, message, details } }`.

| Route                                                                                             | Purpose                                                 |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /groups` · `POST /groups`                                                                    | My groups · create                                      |
| `POST /groups/join {code}`                                                                        | Join (rate-limited)                                     |
| `GET /groups/:id` · `PATCH /groups/:id`                                                           | Group view (members only) · host settings               |
| `DELETE /groups/:id/members/:memberId`                                                            | Host removes, or a member leaves                        |
| `PUT /groups/:id/items/:menuItemId {quantity}`                                                    | My quantity (0 removes)                                 |
| `PUT /groups/:id/allocation {mode, percents?, amounts?}`                                          | Host formula (member IDs → bps / paise)                 |
| `POST /groups/:id/checkout {expectedTotalPaise}`                                                  | Host locks the tray                                     |
| `POST /groups/:id/shares/mine/pay` (Idempotency-Key)                                              | Pay my share; places the order when it's the last one   |
| `POST /groups/:id/order` · `/reopen` · `/cancel {reason?}`                                        | Host: retry placing, reopen (refunds), cancel (refunds) |
| `GET /banquets/venues` · `POST /banquets/quote`                                                   | Venues and rules · server estimate                      |
| `GET /banquets` · `POST /banquets`                                                                | My bookings · request (`expectedTotalPaise`)            |
| `GET /banquets/:id` · `GET /banquets/:id/pass` · `POST /banquets/:id/cancel`                      | Host only                                               |
| `GET/PUT /staff/outlets/:outletId/banquets/settings`                                              | Rules (PUT: manager)                                    |
| `GET /staff/outlets/:outletId/banquets` · `POST …/:id/confirm` · `/reject {reason}` · `/complete` | Requests; decisions are manager-only                    |
| `GET /staff/outlets/:outletId/banquets/pass/:token`                                               | Verify a pass (MANAGER or POS of that outlet)           |
| `GET /splits` · `POST /splits` · `GET/PATCH /splits/:id`                                          | List · create · view · owner edits details              |
| `POST /splits/:id/settlements {amountPaise}` (Idempotency-Key)                                    | Repay via wallet                                        |
| `POST /splits/:id/cancel {reason?}`                                                               | Owner cancels (reverses repayments)                     |

**Rate limits:**

- The usual per-user money limit (20 a minute) covers group checkout, pay, order, reopen and
  cancel, plus `/splits` and `/banquets` writes.
- Tray edits aren't limited, so tapping + and − stays smooth.

## Screens

| Path                                 | What                                                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/groups`                            | Header, Join code, tabs                                                                                                                                         |
| `/groups/tray/:id`                   | Group card (code and invite link copy), formula, members with items, amounts and status, add food, combined tray, checkout confirmation, pay my share, activity |
| `/groups/join/:code`                 | Invite link                                                                                                                                                     |
| `/groups/banquets/new`               | Plan event                                                                                                                                                      |
| `/groups/banquets/:id/pass`          | Event pass                                                                                                                                                      |
| `/manage/banquets` · `/pos/banquets` | Banquet desk: rules (manager), requests, pass check                                                                                                             |

## Limitations

- **No QR codes.** The app doesn't use QR anywhere (Phase 0 decision): join and pass codes are
  text you can copy or read out.
- **No manual "mark paid".** Shares are settled only by wallet payments, and there's no
  cash-at-counter route for a group share.
- **Group orders** are "order now" only (no scheduled group orders), don't use loyalty points,
  and are owned by the host's account (members follow them on the group page).
- **No reserved bays, deposits or booking payments** for banquets (CampusCart has no such data);
  the estimate is only an estimate.
- **No receipts.** Peer splits can't attach receipt images (there is no file storage); use the
  note.
- **Rate limits** are in-memory per server process, like the existing ones.
