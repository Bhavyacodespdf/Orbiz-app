import type { Prisma } from '../generated/prisma/client.js';
import type { AuditActorType } from '../generated/prisma/enums.js';
import type { DbClient } from './prisma.js';

export interface AuditActor {
  type: AuditActorType;
  userId?: string | null;
}

export interface AuditEntry {
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId: string;
  /** Context for investigators. Never put secrets, tokens or credentials here. */
  metadata?: Prisma.InputJsonValue;
}

/** Records a sensitive action. Call it inside the same transaction as the change. */
export async function recordAudit(db: DbClient, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      actorType: entry.actor.type,
      actorUserId: entry.actor.userId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: entry.metadata,
    },
  });
}
