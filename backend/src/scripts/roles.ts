/**
 * Server-side role administration, for whoever operates the server.
 *
 *   npm run roles -w backend -- grant  --email you@example.com --role ADMIN
 *   npm run roles -w backend -- revoke --email you@example.com --role POS --reason "Left the canteen"
 *
 * Shortcut for provisioning the first administrator:
 *   npm run admin:grant -w backend -- --email you@example.com
 *
 * The person must have signed in to CampusCart at least once. Every change is
 * written to the audit log with actor type CLI.
 */
import { parseArgs } from 'node:util';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { grantRole, revokeRole, type GrantableRole } from '../modules/users/roles.service.js';

const ROLES: GrantableRole[] = ['MANAGER', 'POS', 'ADMIN'];

function usage(message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    'Usage:\n' +
      '  roles grant  --email <email> --role <MANAGER|POS|ADMIN>\n' +
      '  roles revoke --email <email> --role <MANAGER|POS|ADMIN> --reason "<why>"',
  );
  process.exit(1);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      email: { type: 'string' },
      role: { type: 'string' },
      reason: { type: 'string' },
    },
  });

  const [command] = positionals;
  const role = values.role?.toUpperCase() as GrantableRole | undefined;
  if (command !== 'grant' && command !== 'revoke') usage('Command must be "grant" or "revoke".');
  if (!values.email) usage('--email is required.');
  if (!role || !ROLES.includes(role)) usage(`--role must be one of ${ROLES.join(', ')}.`);

  const actor = { type: 'CLI' as const };
  const result =
    command === 'grant'
      ? await grantRole(prisma, { email: values.email, role, actor, lists: env })
      : await revokeRole(prisma, {
          email: values.email,
          role,
          actor,
          reason: values.reason ?? usage('--reason is required when revoking.'),
        });

  if (!result.changed) {
    console.log(
      command === 'grant'
        ? `${values.email} already has ${role}. Nothing changed.`
        : `${values.email} does not have an active ${role} role. Nothing changed.`,
    );
  } else if (command === 'grant') {
    console.log(`Granted ${role} to ${values.email}. Recorded in the audit log.`);
  } else {
    console.log(
      `Revoked ${role} from ${values.email}; ended ${result.sessionsEnded ?? 0} session(s). Recorded in the audit log.`,
    );
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof AppError ? `Error: ${err.message}` : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
