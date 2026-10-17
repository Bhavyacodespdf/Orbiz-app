# Secure pickup verification (QR + numeric code)

An order is handed over only after serving staff verify the student's pickup credential **and**
press **Confirm handover**. The backend guarantees each order is released once, to the holder of
that order's credential.

> This supersedes the Phase 0 choice "pickup code, no QR" (decision Q9). The order number
> (`N-007`) is still shown and called out at the counter, but it is now labelled **Order number**:
> it is sequential and is never accepted as proof of pickup.

## Lifecycle (existing statuses)

| Requested name   | CampusCart status | Who                                   |
| ---------------- | ----------------- | ------------------------------------- |
| ACCEPTED         | `ACCEPTED`        | POS or manager                        |
| PREPARING        | `PREPARING`       | POS or manager                        |
| READY_FOR_PICKUP | `READY`           | POS or manager ("Mark ready")         |
| PICKED_UP        | `COMPLETED`       | **Only** via verify + confirm (below) |

- **No direct handover.** The plain `READY → COMPLETED` transition was removed, and the generic
  transition endpoint answers `409 PICKUP_VERIFICATION_REQUIRED`. Staff no longer see a
  one-click "Hand over" button.
- **Students can't collect their own order.** They can't verify codes (staff-only routes), and
  they can't cancel a READY order.
- **Credentials are issued when the order becomes `READY`** (in the same transaction as the
  status change), not at acceptance. Before that, the student sees "Your pickup code will appear
  here when your order is ready", so no code exists that could be used early.
- **Scheduled orders** follow exactly the same rule. A code appears only when staff mark the
  order READY, never just because the slot time arrived.
- **Revocation:** cancelling or rejecting an order revokes any active credential, and so does
  processing it as a no-show. Refunds, stock and no-show rules are unchanged.
- **Payment:** counter orders still need the payment recorded before the handover. Verification
  shows "Take ₹X first" and **Confirm handover** stays disabled (the existing rule that
  COMPLETED requires PAID).

## Credentials

| Part         | Format                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Numeric code | 6 digits by default (`PICKUP_CODE_DIGITS=8` for 8), uniform from `crypto.randomInt`; trivially guessable patterns (`000000`, `123456`, `987654`…) are never issued |
| QR payload   | `CCPICKUP1.<43-char base64url token>`, a 256-bit token from `crypto.randomBytes`. It holds nothing personal                                                        |

**How they're stored**

- No plain code or token is ever stored or logged.
- **Lookup:** HMAC-SHA256 with a server key (`codeHash`, `tokenHash`). A leaked database can't
  be brute-forced offline over the small numeric space without the key.
- **Display:** an AES-256-GCM sealed copy, bound to the order ID as authenticated data, so the
  owner can see the same code again on reload or another device.
- Both keys are derived from `SESSION_SECRET` with HKDF, so there's no new secret to manage.
  Rotating `SESSION_SECRET` invalidates outstanding codes; students tap **Get a new code**.

**Uniqueness**

- At most one ACTIVE credential per order, and an active code is unique per outlet. Both are
  partial unique indexes.
- Issuance is collision-safe: an advisory lock per outlet serialises it, and a new code is drawn
  until no active credential at that outlet has it.

**Expiry:** 12 hours after issue by default (`PICKUP_CODE_TTL_MINUTES`).

- An expired code is refused. The student's screen says it expired and offers **Get a new code**,
  which revokes the old one; at most 10 codes per order.
- Codes for collected or ended orders can never be re-issued.

**The student's screen** shows: order number, outlet, "Ready for pickup", the QR (drawn in the
browser from the payload), the code (`480 213`), the instruction, a validity time, and a warning
not to share it.

- After handover it shows **ORDER COLLECTED** and the handover time, and no code.
- `GET /orders/:id/pickup` is owner-only and `Cache-Control: no-store`.
- The code never appears in order lists, staff order views, socket events, toasts, URLs or audit
  entries.

## Staff: Verify pickup

**Verify pickup** is a button on the POS queue header, on the Manager order board, on every
READY ticket, and in the order dialog. It opens a dialog with two ways in:

- **Enter code:** numeric input (spaces allowed), 6/8-digit and digits-only validation, loading
  and error states.
- **Scan QR:** the camera is requested only after **Start camera**. Frames are decoded in the
  browser (`jsqr`) and the camera is released as soon as a code is read. There are clear messages
  for blocked or missing cameras, with manual entry as the fallback. Decoding only reads the
  text; the server decides.

After a successful check, the dialog shows the minimum needed to identify the order: order
number, student's display name, outlet, items and quantities, scheduled time, and any payment
due. Then **Confirm handover** / **Cancel**.

## Server rules

### `POST /staff/outlets/:outletId/pickup/verify`

Assigned MANAGER or POS only.

- **Body:** `{ method: 'CODE', code }` or `{ method: 'QR', payload }`.
- Looks up an ACTIVE credential at **this outlet** (codes), or the token's credential (QR).
- **Errors:**

| Situation                                                      | Response                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Unknown, malformed or mistyped code; **another outlet's** code | `404 PICKUP_NO_MATCH`, the same message either way, plus `attemptsLeft`      |
| QR already redeemed                                            | `409 PICKUP_ALREADY_COLLECTED`, naming the order and time (same outlet only) |
| Revoked or replaced                                            | `409 PICKUP_CODE_INVALID`                                                    |
| Expired                                                        | `409 PICKUP_CODE_EXPIRED`                                                    |
| Order not READY                                                | `409 PICKUP_NOT_READY`                                                       |

- **On success:** a **challenge token** (256-bit, stored only as SHA-256) valid for **2 minutes**,
  bound to the credential, order, outlet and **this staff member**, plus the order details.
  Nothing changes on the order.

### `POST /staff/outlets/:outletId/pickup/confirm`

`{ challengeToken }`. One PostgreSQL transaction:

1. Lock the challenge row (`FOR UPDATE`). It must belong to this staff member and outlet and not
   be expired. If it was already confirmed, return the same result (idempotent retry, no second
   audit entry).
2. Lock the order row, then the credential row (the same lock order as the no-show worker, so
   they can't deadlock). The credential must still be ACTIVE (otherwise `409
PICKUP_ALREADY_COLLECTED`).
3. The order must be at this outlet, `READY` and paid.
4. Conditional update `READY → COMPLETED` (version check), plus a status-history row (actor role
   POS or MANAGER).
5. Credential → `REDEEMED` (who and when); challenge → confirmed.
6. Insert an `OrderHandover` (unique per order, credential and verification) and the audit entry
   `PICKUP_HANDOVER_CONFIRMED`.

Two staff confirming the same order at once: exactly one succeeds, and the other gets
`409 PICKUP_ALREADY_COLLECTED`. Nothing in pickup verification deducts stock, charges anyone or
creates an order.

### Failed-attempt protection

Codes have only 10⁶ (or 10⁸) values, so guessing is throttled on the server.

- Every attempt is stored in `PickupVerificationAttempt` (outcome only, never the code).
- **5** failures by one staff member at an outlet within **5 minutes** start a cooldown for that
  person (`429 PICKUP_VERIFY_LOCKED` with `retryAfterSeconds`, audited). Colleagues can still
  serve students.
- **25** failures at an outlet in 5 minutes lock verification for the whole outlet.
- Only failures count; successful checks don't.

Wrong guesses can't be tied to a particular credential (a wrong code matches nothing), so the
limits apply per staff member and outlet. With 6 digits and a handful of ready orders per outlet,
5 tries per 5 minutes gives an attacker about a 0.003% chance per window per active order.

## Notifications and real time

- **Mark ready** sends the owner `order.ready` over the existing Socket.IO connection, with only
  the order number and outlet name. The student app shows a toast ("Order N-007 is ready…") and
  the order page switches to the QR and code.
- The handover emits the usual `order.updated`, so the student's page changes to **Order
  collected** and the staff queues refresh.
- No pickup code is ever sent in an event.

## Audit

Every entry goes to the existing admin-only audit log, with no codes or tokens in metadata:

| Action                       | When                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `PICKUP_CREDENTIAL_ISSUED`   | Order marked ready (actor = staff)                                                        |
| `PICKUP_CREDENTIAL_REISSUED` | Student refresh, or a code issued for an order that was already READY before this release |
| `PICKUP_CREDENTIAL_REVOKED`  | Cancelled, rejected or no-show                                                            |
| `PICKUP_VERIFIED`            | Code accepted (verification ID, method)                                                   |
| `PICKUP_HANDOVER_CONFIRMED`  | Handover (handover, verification and credential IDs, method, outlet, actor role)          |
| `PICKUP_VERIFY_LOCKED`       | Cooldown triggered                                                                        |

`OrderHandover` rows can't be updated or deleted: a database trigger rejects it.

## Database (migration `20261018020000_pickup_verification`)

The migration only adds tables, indexes, CHECKs and a trigger:

- **`PickupCredential`:** order, outlet, `codeHash`, `tokenHash` (unique), `sealed`, status
  (`ACTIVE | REDEEMED | EXPIRED | REVOKED`), expiry, redemption (who and when), revocation (when
  and why).
- **`PickupVerification`:** challenge hash (unique), credential, order, outlet, staff, method,
  expiry, confirmation time.
- **`OrderHandover`:** immutable; unique `orderId`, `credentialId` and `verificationId`.
- **`PickupVerificationAttempt`:** outlet, staff, method, outcome, optional credential.

**Orders that were READY when this is deployed** have no credential. The first time the student
opens the order, one is issued (audited as `REISSUED`, reason `BACKFILL`).

Apply it with:

```bash
npm run db:migrate:deploy -w backend
```

```bash
npm run db:migrate:test -w backend
```

## Configuration (optional)

```
PICKUP_CODE_DIGITS=6          # 6 or 8
PICKUP_CODE_TTL_MINUTES=720   # 10–2880
```

## Tests

- **Backend:** `backend/src/modules/pickup/pickup.test.ts` (18 tests) and 2 tests in
  `noshow.test.ts`.
  - Code generation and weak patterns; sealing bound to the order; keyed hashing.
  - Issuance at READY with no plain secrets stored; collision-safe concurrent issuance.
  - Owner-only viewing; numeric and QR verification without release, then explicit confirm.
  - The generic transition refused; wrong, malformed, expired and revoked codes.
  - Another outlet's code treated as unknown; unassigned staff, students and signed-out users
    refused; a challenge bound to its staff member and outlet, and expiring.
  - Not-ready, cancelled and unpaid orders; two staff racing (one handover); idempotent retry.
  - Immutable handover rows; lockout and cooldown; backfill for orders that were already READY;
    students can't self-collect.
  - Scheduled orders get a code only at READY; no-show revokes the code.
- **Shared test helper:** `transition(..., 'COMPLETED')` performs the real verify + confirm, so
  every existing order test now exercises verification.
- **Frontend:** `frontend/src/features/pickup/Pickup.test.tsx` (8 tests).
  - Student: not-ready, active (QR, code, instructions, validity, warning), expired refresh,
    collected.
  - Staff: input validation, verify then confirm, tries left, unpaid blocks confirm, camera
    requested only on Start and the blocked-camera fallback.
- **End to end:** `frontend/e2e/pickup.spec.ts`, with axe on the code screen and the verify
  dialog. The journey, reviews and reorder specs now hand over through verification too.

## Known limitations

- **No staff override.** If a student can't show a code (phone dead), there is no manager
  override in this release. They can log in on another device to see it.
- **Camera scanning** wasn't exercised by automated tests (headless browsers have no camera). The
  decode path only produces text that goes through the same server verification as typed codes.
