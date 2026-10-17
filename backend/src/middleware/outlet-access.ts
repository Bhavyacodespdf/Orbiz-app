import type { RequestHandler } from 'express';
import type { Database } from '../lib/prisma.js';
import { forbidden, notFound, unauthenticated } from '../lib/errors.js';
import type { StaffRole } from '../generated/prisma/enums.js';
import { uuidParam } from '../modules/outlets/outlets.schema.js';

/**
 * Allows the request only when the signed-in user BOTH currently holds one of
 * the given roles AND is assigned to the outlet in :outletId with that role.
 * A revoked role makes old assignments inert immediately.
 */
export function requireOutletRole(db: Database, ...roles: StaffRole[]): RequestHandler {
  return async (req, _res, next) => {
    if (!req.auth) return next(unauthenticated());
    const outletId = uuidParam.safeParse(req.params.outletId);
    if (!outletId.success) return next(notFound('Outlet not found'));

    const activeRoles = roles.filter((role) => req.auth!.user.roles.includes(role));
    if (activeRoles.length === 0) return next(forbidden());

    const assignment = await db.staffAssignment.findFirst({
      where: {
        userId: req.auth.user.id,
        outletId: outletId.data,
        role: { in: activeRoles },
        outlet: { isActive: true },
      },
      select: { id: true },
    });
    next(assignment ? undefined : forbidden('You are not assigned to this outlet.'));
  };
}
