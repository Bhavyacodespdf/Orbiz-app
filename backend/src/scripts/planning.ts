/**
 * Weekly stock planning: explicit, operator-run workflows.
 *
 *   npm run planning -w backend -- status
 *   npm run planning -w backend -- run-jobs            # one pass: demand, forecasts, outcomes
 *   npm run planning -w backend -- train               # train + evaluate; never activates
 *   npm run planning -w backend -- train --activate    # activate only if it passes validation
 *   npm run planning -w backend -- activate --version <v>
 *   npm run planning -w backend -- deactivate          # back to the baseline
 *
 * Training never runs on its own, and a learned policy is used only once it is ACTIVE.
 */
import { parseArgs } from 'node:util';
import { prisma } from '../lib/prisma.js';
import { runPlanningJobs } from '../modules/planning/planning.jobs.js';
import { setActivePolicy, trainPolicy } from '../modules/planning/train.js';
import { POLICY_NAME } from '../modules/planning/planning.rules.js';

function usage(message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    'Usage: planning <status|run-jobs|train [--activate]|activate --version <v>|deactivate>',
  );
  process.exit(1);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { activate: { type: 'boolean' }, version: { type: 'string' } },
  });
  const command = positionals[0];
  if (command === 'run-jobs') {
    console.log(JSON.stringify(await runPlanningJobs(prisma), null, 2));
  } else if (command === 'train') {
    const { policy, activated } = await trainPolicy(prisma, { activate: values.activate === true });
    console.log(
      JSON.stringify(
        {
          version: policy.version,
          status: policy.status,
          activated,
          evaluation: policy.evaluation,
          notes: policy.notes,
        },
        null,
        2,
      ),
    );
  } else if (command === 'activate') {
    if (!values.version) usage('--version is required');
    const p = await setActivePolicy(prisma, values.version);
    console.log(`Active policy: ${p?.name} ${p?.version}`);
  } else if (command === 'deactivate') {
    await setActivePolicy(prisma, null);
    console.log('No learned policy is active; plans use the baseline.');
  } else if (command === 'status') {
    const [decisions, policies, runs] = await Promise.all([
      prisma.planningDecision.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.policyVersion.findMany({
        where: { name: POLICY_NAME },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { version: true, status: true, createdAt: true },
      }),
      prisma.forecastRun.count(),
    ]);
    console.log(
      JSON.stringify(
        {
          forecastRuns: runs,
          decisions: Object.fromEntries(decisions.map((d) => [d.status, d._count._all])),
          policies,
        },
        null,
        2,
      ),
    );
  } else {
    usage(command ? `Unknown command "${command}"` : undefined);
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
