import { z } from 'zod';

/**
 * Where to send the user after sign-in. Only same-site relative paths are
 * accepted so the sign-in flow can't be abused as an open redirect.
 */
export const returnToSchema = z
  .string()
  .max(300)
  .regex(/^\/(?![/\\])[^\s]*$/)
  .catch('/');

export function safeReturnTo(value: unknown): string {
  return returnToSchema.parse(typeof value === 'string' ? value : '/');
}

export const devLoginSchema = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(60).optional(),
});
