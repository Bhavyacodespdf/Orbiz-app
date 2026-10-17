import { randomBytes } from 'node:crypto';
import type { Database, DbClient } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { recordAudit, type AuditActor } from '../../lib/audit.js';
import { env } from '../../config/env.js';
import type {
  PickupAttemptOutcome,
  PickupMethod,
  StaffRole,
} from '../../generated/prisma/enums.js';
import { orderInclude, toOrder } from '../orders/orders.serializer.js';
import { notify } from '../notifications/notifications.service.js';
import { collectedNotices } from '../notifications/order-notices.js';
import {
  hashChallenge,
  hashCode,
  hashToken,
  newNumericCode,
  newToken,
  qrPayload,
  seal,
  tokenFromQr,
  unseal,
} from './pickup.crypto.js';

/*
 * Secure pickup verification (docs/pickup-verification.md).
 *
 *   order → READY ─ issue credential (QR token + numeric code)
 *   staff scans / types it ─ verify ─ short-lived challenge + the matched order (nothing released)
 *   staff presses "Confirm handover" ─ confirm: one transaction re-checks everything, then
 *     READY → COMPLETED, credential REDEEMED, immutable OrderHandover, audit
 *   cancel / reject / no-show ─ credential REVOKED
 *
 * Statuses: READY is "ready for pickup" and COMPLETED is "picked up" in this codebase.
 */

const MINUTE_MS = 60_000;
/** A verified code must be confirmed within this time, by the same staff member. */
export const CHALLENGE_TTL_MS = 2 * MINUTE_MS;
/** Failed attempts allowed in the window before a cooldown. */
export const STAFF_FAILURE_LIMIT = 5;
export const OUTLET_FAILURE_LIMIT = 25;
export const FAILURE_WINDOW_MS = 5 * MINUTE_MS;
/** A student can get a fresh code this many times per order (e.g. after it expired). */
export const MAX_CREDENTIALS_PER_ORDER = 10;
const FAILURES: PickupAttemptOutcome[] = ['NO_MATCH', 'EXPIRED', 'ALREADY_COLLECTED'];

const clockTime = (d: Date) =>
  d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

/**
 * Issues a new credential for an order (revoking any active one). Collision-safe: an advisory
 * lock per outlet serialises issuance, and a new code is drawn until no active credential at the
 * outlet has it (the partial unique index is the backstop). Call inside a transaction.
 */
export async function issueCredential(
  tx: DbClient,
  input: {
    orderId: string;
    outletId: string;
    actor: AuditActor;
    reason: 'READY' | 'REFRESH' | 'BACKFILL';
  },
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pickup-code:${input.outletId}`}))`;
  await revokeCredentials(
    tx,
    input.orderId,
    input.reason === 'REFRESH' ? 'REPLACED' : 'REISSUED',
    input.actor,
    false,
  );
  let code = newNumericCode(env.PICKUP_CODE_DIGITS);
  while (
    await tx.pickupCredential.findFirst({
      where: { outletId: input.outletId, codeHash: hashCode(code), status: 'ACTIVE' },
      select: { id: true },
    })
  ) {
    code = newNumericCode(env.PICKUP_CODE_DIGITS);
  }
  const token = newToken();
  const now = new Date();
  const credential = await tx.pickupCredential.create({
    data: {
      orderId: input.orderId,
      outletId: input.outletId,
      codeHash: hashCode(code),
      tokenHash: hashToken(token),
      sealed: seal({ code, token }, input.orderId),
      createdAt: now,
      expiresAt: new Date(now.getTime() + env.PICKUP_CODE_TTL_MINUTES * MINUTE_MS),
    },
  });
  await recordAudit(tx, {
    actor: input.actor,
    action: input.reason === 'READY' ? 'PICKUP_CREDENTIAL_ISSUED' : 'PICKUP_CREDENTIAL_REISSUED',
    entityType: 'Order',
    entityId: input.orderId,
    metadata: {
      credentialId: credential.id,
      outletId: input.outletId,
      reason: input.reason,
      expiresAt: credential.expiresAt.toISOString(),
    },
  });
  return credential;
}

/** Revokes the order's active credential (cancelled, rejected, no-show, or replaced). */
export async function revokeCredentials(
  tx: DbClient,
  orderId: string,
  reason: string,
  actor: AuditActor,
  audit = true,
) {
  const active = await tx.pickupCredential.findMany({
    where: { orderId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (active.length === 0) return 0;
  await tx.pickupCredential.updateMany({
    where: { orderId, status: 'ACTIVE' },
    data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: reason },
  });
  if (audit) {
    await recordAudit(tx, {
      actor,
      action: 'PICKUP_CREDENTIAL_REVOKED',
      entityType: 'Order',
      entityId: orderId,
      metadata: { credentialIds: active.map((a) => a.id), reason },
    });
  }
  return active.length;
}

// ─── Student view ────────────────────────────────────────────────────────────

export type PickupState = 'NOT_READY' | 'ACTIVE' | 'EXPIRED' | 'COLLECTED' | 'ENDED';

/**
 * The pickup section of the student's own order: the live code only while the order is READY
 * and the credential is active. Collected and ended orders never show a usable code again.
 */
export async function studentPickup(db: Database, userId: string, orderId: string) {
  const order = await db.order.findFirst({
    where: { id: orderId, userId },
    include: { handover: true },
  });
  if (!order) throw notFound('Order not found');

  if (order.status === 'COMPLETED') {
    return {
      state: 'COLLECTED' as PickupState,
      collectedAt: (order.handover?.handedOverAt ?? order.updatedAt).toISOString(),
    };
  }
  if (order.status !== 'READY') {
    return {
      state: (['REJECTED', 'CANCELLED', 'NO_SHOW'].includes(order.status)
        ? 'ENDED'
        : 'NOT_READY') as PickupState,
    };
  }

  let credential = await db.pickupCredential.findFirst({ where: { orderId, status: 'ACTIVE' } });
  if (credential && credential.expiresAt <= new Date()) {
    await db.pickupCredential.updateMany({
      where: { id: credential.id, status: 'ACTIVE' },
      data: { status: 'EXPIRED' },
    });
    credential = null;
  }
  if (!credential) {
    const ever = await db.pickupCredential.count({ where: { orderId } });
    if (ever > 0) return { state: 'EXPIRED' as PickupState, canRefresh: true };
    // A READY order from before pickup verification existed: issue its first credential now.
    credential = await db.$transaction((tx) =>
      issueCredential(tx, {
        orderId,
        outletId: order.outletId,
        actor: { type: 'SYSTEM' },
        reason: 'BACKFILL',
      }),
    );
  }
  const { code, token } = unseal(credential.sealed, orderId);
  return {
    state: 'ACTIVE' as PickupState,
    code,
    qrPayload: qrPayload(token),
    expiresAt: credential.expiresAt.toISOString(),
    /** Counter orders must be paid before the handover can be confirmed. */
    paymentDuePaise: order.paymentStatus === 'PENDING_COUNTER' ? order.totalPaise : 0,
  };
}

/** A fresh code for the student's own READY order (old one revoked). */
export async function refreshPickup(db: Database, userId: string, orderId: string) {
  const order = await db.order.findFirst({ where: { id: orderId, userId } });
  if (!order) throw notFound('Order not found');
  if (order.status !== 'READY') {
    throw new AppError(
      409,
      'PICKUP_NOT_AVAILABLE',
      order.status === 'COMPLETED'
        ? 'This order has already been collected.'
        : 'A pickup code is only available while your order is ready.',
    );
  }
  if ((await db.pickupCredential.count({ where: { orderId } })) >= MAX_CREDENTIALS_PER_ORDER) {
    throw new AppError(
      429,
      'TOO_MANY_CODES',
      'Too many new codes for this order. Show your order number at the counter.',
    );
  }
  await db.$transaction((tx) =>
    issueCredential(tx, {
      orderId,
      outletId: order.outletId,
      actor: { type: 'USER', userId },
      reason: 'REFRESH',
    }),
  );
  return studentPickup(db, userId, orderId);
}

// ─── Staff verification ──────────────────────────────────────────────────────

/** Lockout: too many failures by this staff member (or at this outlet) in the window. */
async function lockoutFor(db: Database, outletId: string, staffUserId: string) {
  const since = new Date(Date.now() - FAILURE_WINDOW_MS);
  const [mine, outlet] = await Promise.all([
    db.pickupVerificationAttempt.findMany({
      where: { outletId, staffUserId, outcome: { in: FAILURES }, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: STAFF_FAILURE_LIMIT,
      select: { createdAt: true },
    }),
    db.pickupVerificationAttempt.findMany({
      where: { outletId, outcome: { in: FAILURES }, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: OUTLET_FAILURE_LIMIT,
      select: { createdAt: true },
    }),
  ]);
  const until = (rows: { createdAt: Date }[]) =>
    rows[rows.length - 1]!.createdAt.getTime() + FAILURE_WINDOW_MS;
  if (mine.length >= STAFF_FAILURE_LIMIT) return { until: until(mine), failuresLeft: 0 };
  if (outlet.length >= OUTLET_FAILURE_LIMIT) return { until: until(outlet), failuresLeft: 0 };
  return { until: null, failuresLeft: STAFF_FAILURE_LIMIT - mine.length };
}

async function recordAttempt(
  db: DbClient,
  data: {
    outletId: string;
    staffUserId: string;
    method: PickupMethod;
    outcome: PickupAttemptOutcome;
    credentialId?: string;
  },
) {
  await db.pickupVerificationAttempt.create({ data });
}

export interface VerifyInput {
  outletId: string;
  staffUserId: string;
  method: PickupMethod;
  /** The typed numeric code or the scanned QR payload. Never logged. */
  secret: string;
}

/**
 * Checks a code at this outlet. On success returns the matched order (minimum details) and a
 * challenge token for the explicit confirmation. Nothing is released here.
 */
export async function verifyPickup(db: Database, input: VerifyInput) {
  const base = { outletId: input.outletId, staffUserId: input.staffUserId, method: input.method };
  const lock = await lockoutFor(db, input.outletId, input.staffUserId);
  if (lock.until) {
    await recordAttempt(db, { ...base, outcome: 'LOCKED' });
    const retryAfterSeconds = Math.max(1, Math.ceil((lock.until - Date.now()) / 1000));
    await recordAudit(db, {
      actor: { type: 'USER', userId: input.staffUserId },
      action: 'PICKUP_VERIFY_LOCKED',
      entityType: 'Outlet',
      entityId: input.outletId,
      metadata: { method: input.method, retryAfterSeconds },
    });
    throw new AppError(
      429,
      'PICKUP_VERIFY_LOCKED',
      `Too many codes that didn’t match. Wait ${Math.ceil(retryAfterSeconds / 60)} min, then try again — or ask the student to show their QR code.`,
      { retryAfterSeconds },
    );
  }

  const fail = async (
    outcome: PickupAttemptOutcome,
    status: number,
    code: string,
    message: string,
    credentialId?: string,
  ): Promise<never> => {
    await recordAttempt(db, { ...base, outcome, credentialId });
    throw new AppError(status, code, message, { attemptsLeft: Math.max(0, lock.failuresLeft - 1) });
  };
  const noMatch = () =>
    fail(
      'NO_MATCH',
      404,
      'PICKUP_NO_MATCH',
      'No ready order at this outlet matches that code. Check it with the student.',
    );

  let credential;
  if (input.method === 'CODE') {
    const pattern = new RegExp(`^\\d{${env.PICKUP_CODE_DIGITS}}$`);
    if (!pattern.test(input.secret)) return noMatch();
    credential = await db.pickupCredential.findFirst({
      where: { outletId: input.outletId, codeHash: hashCode(input.secret), status: 'ACTIVE' },
      include: { handover: true },
    });
  } else {
    const token = tokenFromQr(input.secret);
    if (!token) return noMatch();
    credential = await db.pickupCredential.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { handover: true },
    });
  }
  // Another outlet's code is reported exactly like an unknown one.
  if (!credential || credential.outletId !== input.outletId) return noMatch();

  const order = await db.order.findUniqueOrThrow({
    where: { id: credential.orderId },
    include: { items: { orderBy: { name: 'asc' } }, user: { select: { displayName: true } } },
  });
  if (credential.status === 'REDEEMED') {
    return fail(
      'ALREADY_COLLECTED',
      409,
      'PICKUP_ALREADY_COLLECTED',
      `Already collected: order ${order.pickupCode} was handed over at ${clockTime(credential.redeemedAt!)}.`,
      credential.id,
    );
  }
  if (credential.status === 'REVOKED' || credential.status === 'EXPIRED') {
    return fail(
      'EXPIRED',
      409,
      'PICKUP_CODE_INVALID',
      'This code is no longer valid. Ask the student to show the current code in their app.',
      credential.id,
    );
  }
  if (credential.expiresAt <= new Date()) {
    await db.pickupCredential.updateMany({
      where: { id: credential.id, status: 'ACTIVE' },
      data: { status: 'EXPIRED' },
    });
    return fail(
      'EXPIRED',
      409,
      'PICKUP_CODE_EXPIRED',
      'This code has expired. Ask the student to refresh it in the app.',
      credential.id,
    );
  }
  if (order.status !== 'READY') {
    return fail(
      'EXPIRED',
      409,
      'PICKUP_NOT_READY',
      `Order ${order.pickupCode} isn’t ready for pickup.`,
      credential.id,
    );
  }

  const challenge = randomBytes(32).toString('base64url');
  const verification = await db.$transaction(async (tx) => {
    const v = await tx.pickupVerification.create({
      data: {
        credentialId: credential.id,
        orderId: order.id,
        outletId: input.outletId,
        staffUserId: input.staffUserId,
        method: input.method,
        challengeHash: hashChallenge(challenge),
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });
    await recordAttempt(tx, { ...base, outcome: 'VERIFIED', credentialId: credential.id });
    await recordAudit(tx, {
      actor: { type: 'USER', userId: input.staffUserId },
      action: 'PICKUP_VERIFIED',
      entityType: 'Order',
      entityId: order.id,
      metadata: {
        verificationId: v.id,
        credentialId: credential.id,
        method: input.method,
        outletId: input.outletId,
      },
    });
    return v;
  });

  const paymentDuePaise = order.paymentStatus === 'PENDING_COUNTER' ? order.totalPaise : 0;
  return {
    challengeToken: challenge,
    expiresAt: verification.expiresAt.toISOString(),
    order: {
      id: order.id,
      pickupCode: order.pickupCode,
      status: order.status,
      timing: order.timing,
      scheduledFor: order.scheduledFor?.toISOString() ?? null,
      customer: { displayName: order.user.displayName },
      items: order.items.map((i) => ({
        menuItemId: i.menuItemId,
        name: i.name,
        quantity: i.quantity,
      })),
      paymentMethod: order.paymentMethod,
      paymentDuePaise,
    },
    /** Counter orders need the payment recorded first (existing rule: COMPLETED requires PAID). */
    canConfirm: paymentDuePaise === 0,
  };
}

/**
 * The explicit handover. One transaction, with the challenge and credential rows locked:
 * re-validates the challenge (same staff, same outlet, not expired), the credential (still
 * active) and the order (still READY and paid), then marks the order COMPLETED, redeems the
 * credential, writes the immutable OrderHandover and the audit entry. Retrying the same
 * challenge returns the same result without a second handover or audit entry.
 */
export async function confirmHandover(
  db: Database,
  input: { outletId: string; staffUserId: string; staffRoles: StaffRole[]; challengeToken: string },
) {
  const invalid = () =>
    new AppError(
      404,
      'PICKUP_CHALLENGE_INVALID',
      'That verification isn’t valid. Scan or enter the code again.',
    );

  const result = await db.$transaction(async (tx) => {
    const [v] = await tx.$queryRaw<
      {
        id: string;
        credentialId: string;
        orderId: string;
        outletId: string;
        staffUserId: string;
        method: PickupMethod;
        expiresAt: Date;
        confirmedAt: Date | null;
      }[]
    >`SELECT "id", "credentialId", "orderId", "outletId", "staffUserId", "method", "expiresAt", "confirmedAt"
      FROM "PickupVerification" WHERE "challengeHash" = ${hashChallenge(input.challengeToken)}
      FOR UPDATE`;
    if (!v || v.staffUserId !== input.staffUserId || v.outletId !== input.outletId) throw invalid();
    if (v.confirmedAt) {
      // The same confirmation retried (double tap, lost response): already done, once.
      return { orderId: v.orderId, alreadyConfirmed: true };
    }
    if (v.expiresAt.getTime() <= Date.now()) {
      throw new AppError(
        409,
        'PICKUP_CHALLENGE_EXPIRED',
        'This check took too long. Scan or enter the code again.',
      );
    }

    // Lock order before credential — the same order the no-show worker and transitions use
    // (order row, then its credential), so concurrent handover and no-show can't deadlock.
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${v.orderId}::uuid FOR UPDATE`;
    const [credential] = await tx.$queryRaw<{ id: string; status: string; orderId: string }[]>`
      SELECT "id", "status", "orderId" FROM "PickupCredential" WHERE "id" = ${v.credentialId}::uuid FOR UPDATE`;
    if (!credential || credential.orderId !== v.orderId) throw invalid();
    if (credential.status === 'REDEEMED') {
      throw new AppError(
        409,
        'PICKUP_ALREADY_COLLECTED',
        'This order has already been handed over.',
      );
    }
    if (credential.status !== 'ACTIVE') {
      throw new AppError(
        409,
        'PICKUP_CODE_INVALID',
        'This code is no longer valid. Ask the student to show the current code in their app.',
      );
    }

    const order = await tx.order.findFirst({ where: { id: v.orderId, outletId: input.outletId } });
    if (!order) throw invalid();
    if (order.status !== 'READY') {
      throw new AppError(
        409,
        'PICKUP_NOT_READY',
        `Order ${order.pickupCode} isn’t ready for pickup.`,
      );
    }
    if (order.paymentStatus !== 'PAID') {
      throw new AppError(
        409,
        'PAYMENT_REQUIRED',
        'Record the counter payment before handing this order over.',
      );
    }

    const { count } = await tx.order.updateMany({
      where: { id: order.id, status: 'READY', version: order.version },
      data: { status: 'COMPLETED', version: { increment: 1 } },
    });
    if (count === 0) {
      throw new AppError(
        409,
        'ORDER_CHANGED',
        'This order was just updated by someone else. Refresh and try again.',
      );
    }
    const actorRole: StaffRole = input.staffRoles.includes('POS') ? 'POS' : 'MANAGER';
    const now = new Date();
    await tx.orderStatusHistory.create({
      data: {
        orderId: order.id,
        fromStatus: 'READY',
        toStatus: 'COMPLETED',
        actorUserId: input.staffUserId,
        actorRole,
        reason: `Handed over after ${v.method === 'QR' ? 'QR' : 'pickup code'} verification`,
      },
    });
    await tx.pickupCredential.update({
      where: { id: credential.id },
      data: { status: 'REDEEMED', redeemedAt: now, redeemedById: input.staffUserId },
    });
    await tx.pickupVerification.update({ where: { id: v.id }, data: { confirmedAt: now } });
    const handover = await tx.orderHandover.create({
      data: {
        orderId: order.id,
        credentialId: credential.id,
        verificationId: v.id,
        outletId: input.outletId,
        staffUserId: input.staffUserId,
        method: v.method,
        handedOverAt: now,
      },
    });
    const outletName = (
      await tx.outlet.findUniqueOrThrow({ where: { id: order.outletId }, select: { name: true } })
    ).name;
    await notify(
      tx,
      collectedNotices(
        { id: order.id, userId: order.userId, pickupCode: order.pickupCode, outletName },
        now,
      ),
    );
    await recordAudit(tx, {
      actor: { type: 'USER', userId: input.staffUserId },
      action: 'PICKUP_HANDOVER_CONFIRMED',
      entityType: 'Order',
      entityId: order.id,
      metadata: {
        handoverId: handover.id,
        verificationId: v.id,
        credentialId: credential.id,
        method: v.method,
        outletId: input.outletId,
        actorRole,
      },
    });
    return { orderId: order.id, alreadyConfirmed: false };
  });

  const order = await db.order.findUniqueOrThrow({
    where: { id: result.orderId },
    include: {
      ...orderInclude,
      handover: { include: { staffUser: { select: { displayName: true } } } },
    },
  });
  return {
    order: toOrder(order),
    ownerId: order.userId,
    alreadyConfirmed: result.alreadyConfirmed,
    handover: order.handover && {
      handedOverAt: order.handover.handedOverAt.toISOString(),
      handedOverBy: order.handover.staffUser.displayName,
      method: order.handover.method,
    },
  };
}
