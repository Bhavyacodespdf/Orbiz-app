import type { Request } from 'express';
import { AppError } from './errors.js';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Reads the Idempotency-Key header that every money-moving request must send.
 * The browser generates one key per user intent (one checkout, one recharge),
 * so retries and double-clicks reuse it and the server does the work only once.
 */
export function requireIdempotencyKey(req: Request): string {
  const key = req.get('idempotency-key');
  if (!key || !KEY_PATTERN.test(key)) {
    throw new AppError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'An Idempotency-Key header (8–100 letters, digits, "-" or "_") is required.',
    );
  }
  return key;
}
