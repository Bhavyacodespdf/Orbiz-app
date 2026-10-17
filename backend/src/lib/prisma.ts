import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client.js';
import { env } from '../config/env.js';

/**
 * One shared database client for the whole process. Prisma keeps a
 * connection pool internally, so creating many clients would waste connections.
 */
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

export type Database = typeof prisma;

/** Either the main client or a client inside `db.$transaction(async (tx) => …)`. */
export type DbClient = Database | Prisma.TransactionClient;

/** True when a write failed because it would break a unique constraint. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
