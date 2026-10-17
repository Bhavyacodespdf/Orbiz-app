# Order capacity: 10 orders per outlet every rolling 3 minutes

Each outlet takes on at most **10 orders in any rolling 3-minute window**. The backend enforces
it; the browser only shows the result.

## When an order counts

CampusCart takes an order on at **checkout**. One database transaction validates the cart, prices
it on the server, creates the order, takes stock, spends points, debits the wallet (or creates
an unpaid counter order) and empties the cart. That is the outlet's acceptance event, so that is
where the limit applies.

Staff **Accept** later is a kitchen step for an order the student has already paid for. Limiting
it would leave paid orders stuck, and would mean refunding them, instead of simply not taking
the order.

| Case                                                                             | Counted?                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Order placed now (wallet or counter)                                             | Once, at checkout                                            |
| Scheduled order                                                                  | Once, at checkout (not when its slot or pickup time arrives) |
| Retry with the same `Idempotency-Key`                                            | No: the original order is returned                           |
| Refused checkout (validation, price change, no funds, out of stock, outlet full) | No: the transaction rolls back                               |
| Status changes, reschedules, the no-show worker                                  | No: nothing writes to the capacity record again              |
| Order later rejected or cancelled                                                | Stays counted: the outlet already took it on                 |

**Items don't matter.** An order with 1 item and one with 20 count the same.

**Counts are per outlet.** Outlet A being full never affects outlet B.

## How it's enforced

`claimOrderCapacity` is in `backend/src/modules/capacity/capacity.service.ts` and is called
inside the checkout transaction.

1. `pg_advisory_xact_lock(hashtext('order-capacity:<outletId>'))`. This serialises checkouts for
   that outlet only. The lock lives in PostgreSQL, so it covers every API instance. It is released
   automatically at commit or rollback.
2. Count the outlet's `OutletOrderAcceptance` rows where
   `acceptedAt > clock_timestamp() − 3 minutes`. This uses the database clock, read after the lock
   (UTC).
3. If there are 10, refuse with `429`. Otherwise insert one row for the order, primary key
   `orderId`, so an order can never be counted twice.

The row is part of the checkout transaction. If anything later in checkout fails, it is rolled
back together with the order, stock, points and payment. A plain count without the lock would let
simultaneous checkouts all see 9 and all succeed; the lock prevents that. No Redis or other
infrastructure is needed.

**Window edge.** An order accepted at `t` stops counting at exactly `t + 3 min`.

## When the outlet is full

`429 ORDER_CAPACITY_FULL`, with a `Retry-After` header (seconds):

```json
{
  "error": {
    "code": "ORDER_CAPACITY_FULL",
    "message": "This outlet has reached its order capacity and is temporarily not accepting new orders. Please try again shortly.",
    "details": { "retryAt": "2026-10-17T09:42:10.123Z", "retryAfterSeconds": 74 }
  }
}
```

- `retryAt` is when the oldest of the last 10 orders leaves the window.
- **Nothing is created or charged.** No order, no wallet debit, no stock or points taken, and the
  cart is unchanged.
- Payment happens inside the same transaction, so there is never a payment to refund.
- **The checkout page:**
  - shows the message with "You can try again from <time>"
  - disables the place-order button until then, so there are no repeated submissions
  - keeps the same idempotency key, so the eventual retry still can't create two orders

## Scheduled orders

A scheduled order uses one unit of capacity when it is placed, like any other order. This rolling
limit is separate from the optional **orders per slot** limit for pickup slots
([scheduled-orders.md](scheduled-orders.md)). Both must allow the order, and neither counts toward
the other.

## Data

Migration `20261017200000_outlet_order_capacity` adds `OutletOrderAcceptance`:

| Column       | Notes                                                     |
| ------------ | --------------------------------------------------------- |
| `orderId`    | Primary key, references `Order`                           |
| `outletId`   | The order's actual outlet; references `Outlet`            |
| `acceptedAt` | UTC database time, taken after the outlet's capacity lock |

There is an index on `(outletId, acceptedAt)`. Orders placed in the 3 minutes before the migration
were backfilled from `placedAt`; older orders are outside every window anyway.

## Configuration

`ORDER_CAPACITY_PER_WINDOW` defaults to **10**. In production it **must** be 10 (the server
refuses to start otherwise). Only test setups change it: the browser end-to-end suite sets it high,
because it places many orders at one outlet within minutes. The window (3 minutes) is fixed in
`capacity.rules.ts`.

## Limitations

- An order rejected or cancelled within the window still uses capacity.
- A student who is refused must place the order again themselves after the retry time. There is
  no queue or automatic deferral.
- Under heavy load, checkouts for the same outlet wait for one another briefly (the lock is held
  until each checkout commits). Other outlets are unaffected.
