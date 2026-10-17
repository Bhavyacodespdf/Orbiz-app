# Scheduled orders

Students can **order now** (unchanged) or **schedule** an order for a pickup slot later. A scheduled
order costs a fixed **₹10 per order**, never per item. The server decides every slot, fee and
total; the browser only shows them.

## What was there before

- **No opening hours.** Outlets had only the manual **Open / Paused / Closed** switch, so this
  feature adds per-outlet **pickup hours** that the manager sets. No hours were invented: until a
  manager sets them, an outlet offers no slots.
- **Payment at placement.** Orders are paid when placed, in one transaction (a wallet debit), or
  created unpaid for the counter. Scheduled orders use exactly the same flow; the fee is simply
  part of the total.

## Pricing

```
food subtotal (live menu prices)
− loyalty-points discount (1 point = ₹1, food only)
+ scheduled-order fee        ₹10 if SCHEDULED, ₹0 if IMMEDIATE
= total  →  the amount debited from the wallet / collected at the counter
```

- **Server-side only.** The fee comes from `feeFor()` in
  `backend/src/modules/scheduling/scheduling.rules.ts`. The checkout body cannot contain a fee
  (strict schema), and `expectedTotalPaise` must equal the server's total or the order is refused
  with `PRICE_CHANGED`.
- **Database CHECKs:**
  - `SCHEDULED` ⇔ `scheduledFor` is set
  - fee = 1000 for `SCHEDULED`, 0 for `IMMEDIATE`
  - `total = subtotal − pointsDiscount + scheduledFee`
- **Charged once.** Retrying with the same idempotency key returns the original order, with no
  second order, debit or fee. Rescheduling never charges again.
- **Existing orders:** all became `IMMEDIATE` with a ₹0 fee in the migration; nothing about them
  changed.

## Slots and rules

**Manager settings** (**Kitchen → Outlet → Scheduled orders**):

- Pickup hours per weekday, in IST. Tick a day and set opening and closing times; use 00:00 to
  close at midnight.
- **Minimum notice:** default 30 minutes.
- **Slot length:** default 15 minutes.
- **How many days ahead:** default 2.
- **Optional orders per slot:** default no limit.

The defaults are only starting values for these settings, not opening hours.

**A slot is offered and accepted only if:**

- the outlet is active and not **Paused** ("no new orders")
- the pickup hours cover it, and it starts on a slot boundary (opening time + n × slot length)
- it is at least the minimum notice after now (so never in the past) and within the days-ahead
  window
- it isn't full, if a capacity is set

A per-slot database advisory lock means orders arriving together can't overfill a slot.

**Closed right now** is fine for scheduling (the hours decide), so a student can order ahead
before the outlet opens. "Order now" still needs the outlet to be **Open**, as before.

**Timezone.** Everything follows CampusCart's calendar policy, India Standard Time (no daylight
saving). Hours, dates and labels are IST, and timestamps are stored as instants. A scheduled
order's pickup number belongs to its **collection day**.

**Errors** (`409`):

| Code                     | Meaning                               |
| ------------------------ | ------------------------------------- |
| `SCHEDULING_UNAVAILABLE` | No hours set, or the outlet is paused |
| `SLOT_IN_PAST`           | The slot has already started          |
| `SLOT_TOO_SOON`          | Less than the minimum notice          |
| `SLOT_TOO_FAR`           | Beyond the days-ahead window          |
| `INVALID_SLOT`           | Not one of the outlet's slots         |
| `SLOT_FULL`              | The slot has reached its capacity     |

A time without a timezone offset is `400`.

## Lifecycle

- **Normal order flow.** Scheduled orders follow the normal statuses and staff permissions. Nothing
  happens automatically when the slot arrives, apart from the [no-show policy](no-show-policy.md)
  10 minutes after it.
- **Accept early, prepare on time.** Staff can **accept** a scheduled order straight away, but it
  can't move to **Preparing** until the slot is within the outlet's minimum notice
  (`409 TOO_EARLY_TO_PREPARE`, with the time it can start). That stops kitchens starting too
  early.
- **Staff queues** (Manager board, POS) run in the order food is due: a scheduled order counts
  from its slot.
  - Cards show **Scheduled · Fri, 17 Oct, 1:30 pm · in 2 h** (red once past due).
  - Filters: **All / Order now / Scheduled / Upcoming / Past due**.
  - The order dialog shows the pickup time and the ₹10 fee.
- **Students** see "Order scheduled", the pickup time, and the fee line on the order and in their
  order list.

**Stock** is taken when the order is placed, in the same transaction (the existing inventory rule),
which reserves it for the slot. It's never taken twice and is given back once if the order is
rejected or cancelled. Staff who find an item unavailable at fulfilment use the existing reject
flow, which refunds the student and restores the stock.

## Changing and cancelling

- **Reschedule** (`POST /orders/:id/reschedule { scheduledFor }`): the student's own scheduled
  order can move to another valid slot while it is still **Placed** and its current slot is at
  least the minimum notice away. There's no extra fee. Choosing the same slot changes nothing, and
  it's version-checked so it can't race with staff. Otherwise:
  - `409 TOO_LATE_TO_RESCHEDULE` for an order that is no longer eligible
  - `409 NOT_SCHEDULED` for an order placed for now
- **Cancel / reject:** the existing rules apply unchanged. Students cancel while **Placed**; staff
  reject or cancel before **Ready**. Repeats are refused by the existing version-checked transition.
- **The ₹10 fee is kept on cancellation** (business decision, 2026-10-17). When a wallet-paid
  scheduled order is rejected by the outlet or cancelled, the refund is the **total minus ₹10**:
  the food is refunded in full, the fee is not.
  - The refund is made exactly once, and its wallet entry says "₹10 scheduled-order fee not
    refunded".
  - Students see the exact refund before they confirm a cancellation ("₹40 will be returned… The
    ₹10 scheduled-order fee isn’t refunded"), and staff see it before rejecting. Orders carry
    `refundPaise` for this.
  - Orders placed for now are refunded in full, as before.
  - Unpaid counter orders become **Void**, so nothing was ever charged.
  - The rule is `REFUND_SCHEDULED_FEE_ON_CANCEL = false` in `scheduling.rules.ts`. Setting it to
    `true` would refund the fee too.

## Order capacity

Scheduled orders count once, when placed, toward the outlet's limit of 10 orders per rolling 3
minutes ([order-capacity.md](order-capacity.md)). That limit is separate from **orders per slot**
above.

## Not collected in time

A ready scheduled order not collected within 10 minutes of its slot is settled automatically
(packaged items 90% refunded and restocked, handmade items not refunded, the ₹10 fee kept). See
[no-show-policy.md](no-show-policy.md).

## API

| Method & path                      | Who          | Notes                                                                                                                                              |
| ---------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /outlets/:slug/slots`         | Anyone       | `{ timezone, feePaise, leadMinutes, slotMinutes, days: [{ date, hours, slots: [{ startsAt, label, available }] }] }`. Empty `days` = no scheduling |
| `POST /orders`                     | Student      | Adds optional `scheduledFor` (ISO instant with offset). Omit it to order now                                                                       |
| `POST /orders/:orderId/reschedule` | Student      | `{ scheduledFor }`                                                                                                                                 |
| `GET /staff/outlets/:id/orders`    | Manager, POS | Adds `?timing=IMMEDIATE\|SCHEDULED` and `?due=upcoming\|past_due`                                                                                  |
| `GET /staff/outlets/:id/schedule`  | Manager, POS | Pickup hours and settings                                                                                                                          |
| `PUT /staff/outlets/:id/schedule`  | Manager      | `{ leadMinutes, slotMinutes, daysAhead, slotCapacity \| null, hours: [{ weekday 0–6, opensMinute, closesMinute }] }`. Audited                      |

- **Orders and summaries** add `timing`, `scheduledFor` and `scheduledFeePaise`.
- **The cart** adds `canSchedule`: the cart could be placed for a later slot even while the outlet
  is closed right now.

## Notifications

The existing live updates are reused:

- **New scheduled orders** reach the outlet's staff instantly (`order.created`).
- **Status and time changes** (including reschedules and rejections) reach the student and staff
  (`order.updated`).
- **The order page shows the confirmation in-app.**

There are no email or push notifications in CampusCart. Reminders before the pickup time would be a
future addition.

## Manual test

1. As a manager, open **Kitchen → Outlet → Scheduled orders**, tick some days with hours that
   include the next few hours, and save.
2. As a student, add items, open checkout and choose **Schedule for later**. Pick a day and time:
   the ticket shows **Scheduled-order fee ₹10** and the new total, plus the pickup time. Pay.
3. The order page says **Order scheduled** with the pickup time. Choose **Change time** and pick
   another slot: no new charge.
4. On the Manager board or POS queue the card shows **Scheduled ·** with the time. Filter by
   **Scheduled**. Accept it. **Start preparing** is refused until the slot is close.
5. Set **Orders per slot** to 1 and try to book the same slot twice: the second is refused.
6. **Pause** the outlet: scheduling is no longer offered.
