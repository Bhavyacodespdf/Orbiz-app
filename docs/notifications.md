# Notifications

Persistent, event-driven notifications for students and staff. The **inbox** (database) is the
source of truth. Socket.IO only tells open tabs to refresh it, so nothing is lost while someone is
offline, refreshes the page or reconnects.

## How a notification is created and delivered

The system follows the transactional outbox pattern:

1. Business code (a status change, checkout, handover, no-show…) calls `notify()` **inside its own
   database transaction**. If the transaction rolls back, the notification never existed.
2. After commit, `deliverSoon()` runs the dispatcher. Every 30 seconds the operations worker runs
   it again as a safety net.
3. **Dispatcher:** it claims undelivered rows with `FOR UPDATE SKIP LOCKED` and a 30-second lease,
   emits `notification.created` (ID and type only) to the user's private room, and marks the row
   `DELIVERED`. Several API instances can run it at once. A crash mid-delivery is retried after
   the lease expires.
4. **Retries:** live-delivery failures back off at 15 s, 30 s, 60 s and so on (capped at 10 min).
   After 5 attempts the row is marked `FAILED` and stays in the inbox. The related outlet's
   managers get an hourly alert.

`(userId, dedupeKey)` is unique, so a repeated or concurrent event creates exactly one logical
notification. Keys name the event, for example `order:<id>:READY`, `order:<id>:ALMOST_READY`,
`order:<id>:ETA:1`, or `outlet:<id>:CAPACITY_FULL:<window>`. A socket emit can't be guaranteed to
arrive exactly once, but the notification itself is created once and is always in the inbox.

## Events

| Who           | Type                                 | When                                                                        |
| ------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| Student       | `ORDER_PLACED`                       | Checkout or group-order placement committed                                 |
|               | `ORDER_ACCEPTED`                     | Accepted by staff or by auto-accept                                         |
|               | `ORDER_PREPARING`                    | Preparation started                                                         |
|               | `ORDER_ETA_CHANGED`                  | The estimated ready time moved ≥ 5 min (at most twice per order)            |
|               | `ORDER_ALMOST_READY`                 | A preparing order is estimated ≤ 2 min from ready (worker; approximate)     |
|               | `ORDER_READY`                        | The **actual** READY transition                                             |
|               | `ORDER_COLLECTED` + `REVIEW_PROMPT`  | Pickup handover confirmed                                                   |
|               | `ORDER_REJECTED` / `ORDER_CANCELLED` | With the reason and any wallet refund; group members get their share refund |
|               | `ORDER_NO_SHOW`                      | The existing no-show worker processed the order (with refund)               |
|               | `SCHEDULED_PICKUP_SOON`              | 10 min before a scheduled slot (from the slot, not the estimate)            |
|               | `PICKUP_DEADLINE_SOON`               | A ready scheduled order is ≤ 5 min from its no-show deadline                |
| POS + manager | `STAFF_MANUAL_REVIEW`                | Auto-accept handed an order back to staff, with the reason                  |
|               | `STAFF_ORDER_DELAYED`                | A preparing order is ≥ 5 min past its estimate (once per order)             |
|               | `STAFF_CAPACITY_FULL`                | Checkout refused by the 10-orders-per-3-minutes limit (once per window)     |
| Manager       | `MANAGER_QUEUE_DELAYS`               | ≥ 3 delayed orders at once (hourly at most)                                 |
|               | `MANAGER_AUTO_ACCEPT_FAILURES`       | ≥ 3 auto-accept fallbacks in 15 min (hourly at most)                        |
|               | `MANAGER_DELIVERY_FAILURES`          | A notification couldn't be delivered live after 5 attempts (hourly)         |

**Exclusions:**

- **Manual mode, new orders:** staff get no inbox notification for every new order. The live queue
  and its on-screen alert already show them. Inbox items for staff are reserved for orders that
  need a decision or attention.
- **Content:** notifications never contain a pickup code, QR token, payment detail or another
  student's data. They name the order number (`N-007`) and outlet, and link to `/orders/<id>`.

## API (`/api/v1/me/notifications`, any signed-in user, own inbox only)

| Request                                      | Result                                                                |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `GET ?filter=all\|unread&limit=1–50&cursor=` | `{ notifications, unread, nextCursor }`, newest first (keyset paging) |
| `GET /unread-count`                          | `{ unread }`                                                          |
| `POST /:id/read`                             | Marks one read (404 for someone else's)                               |
| `POST /read-all`                             | Marks all read                                                        |

## UI

There's a bell with an unread badge in the student header and in the Kitchen, POS and Admin top
bars. It opens the inbox:

- All / Unread filters, Mark all as read, and Load older;
- clicking an item marks it read and opens its link;
- loading, empty and error-with-retry states;
- the badge's label is "Notifications, N unread".

The list refreshes on `notification.created`, and on reconnect everything is re-read.

## Web Push

**Web Push isn't enabled in this release.** It would need a service worker, VAPID keys in the
backend config, a subscription table, and user preferences with quiet hours. The in-app inbox and
live delivery don't depend on it.

To add it later:

- add a `PUSH` channel to `Notification`, plus a `PushSubscription` model;
- send pushes from the same dispatcher;
- never include secrets in push payloads.
