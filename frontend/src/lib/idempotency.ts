/**
 * A fresh key for one user intent (one checkout, one recharge). Retrying the
 * same intent reuses the key, so the server does the work at most once.
 */
export function newIdempotencyKey(): string {
  return `cc-${crypto.randomUUID()}`;
}
