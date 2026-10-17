import type { Database } from '../../lib/prisma.js';
import { recordAudit } from '../../lib/audit.js';
import { dayOf } from './dates.js';
import {
  ACTIONS,
  POLICY_NAME,
  REWARD_WEIGHTS,
  TRAINING_RULES,
  type ActionName,
} from './planning.rules.js';
import { replayReward, stateBucket, type Candidate, type DecisionState } from './policy.js';

/*
 * Offline training — run explicitly (`npm run planning -w backend -- train`), never automatically.
 *
 * Data: FINALIZED decisions whose week had NO stockout. In those weeks observed demand is true
 * demand, so we can replay each candidate action (opening stock + its quantity) against what
 * actually happened. Censored weeks, uncounted items and unfinished weeks are excluded: we never
 * treat an unobserved outcome as zero.
 *
 * Method: a contextual bandit with a tabular policy. For each state bucket with enough training
 * examples, pick the action with the best mean replayed reward; otherwise keep the baseline
 * (MEDIUM). The newest decisions form a time-based holdout the policy never saw; it is VALIDATED
 * only if it beats the baseline there by the configured margin without lowering service level.
 * Even then it is used only after explicit activation.
 */

export interface TrainingExample {
  id: string;
  periodStart: string;
  bucket: string;
  opening: number;
  demand: number;
  candidates: Candidate[];
}

export interface PolicyEvaluation {
  decisions: number;
  meanReward: number;
  serviceLevel: number | null;
}

export function evaluatePolicy(
  examples: TrainingExample[],
  pick: (e: TrainingExample) => ActionName,
): PolicyEvaluation {
  let reward = 0;
  let fulfilled = 0;
  let demand = 0;
  for (const e of examples) {
    const qty = e.candidates.find((c) => c.action === pick(e))?.quantity ?? 0;
    const r = replayReward(e.opening, qty, e.demand);
    reward += r.reward;
    fulfilled += r.fulfilled;
    demand += e.demand;
  }
  return {
    decisions: examples.length,
    meanReward: examples.length ? Math.round((reward / examples.length) * 1000) / 1000 : 0,
    serviceLevel: demand > 0 ? Math.round((fulfilled / demand) * 1000) / 1000 : null,
  };
}

/**
 * Time-based split: the newest decisions (by week) are held out, so the policy is always judged
 * on weeks that come after everything it learned from. A week is never split across both sets.
 */
export function splitByTime(examples: TrainingExample[]) {
  const sorted = [...examples].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const target = Math.max(
    TRAINING_RULES.minHoldoutDecisions,
    Math.ceil(sorted.length * TRAINING_RULES.holdoutFraction),
  );
  let cut = Math.max(0, sorted.length - target);
  while (cut > 0 && sorted[cut - 1]!.periodStart === sorted[cut]?.periodStart) cut -= 1;
  return { train: sorted.slice(0, cut), holdout: sorted.slice(cut) };
}

/** Pure: learns the bucket → action table from training examples. */
export function learnTable(train: TrainingExample[]): Record<string, ActionName> {
  const byBucket = new Map<string, TrainingExample[]>();
  for (const e of train) byBucket.set(e.bucket, [...(byBucket.get(e.bucket) ?? []), e]);
  const table: Record<string, ActionName> = {};
  for (const [bucket, examples] of byBucket) {
    if (examples.length < TRAINING_RULES.minBucketSamples) continue;
    let best: ActionName = 'MEDIUM';
    let bestReward = evaluatePolicy(examples, () => 'MEDIUM').meanReward;
    for (const action of ACTIONS) {
      const r = evaluatePolicy(examples, () => action).meanReward;
      if (r > bestReward) {
        best = action;
        bestReward = r;
      }
    }
    table[bucket] = best;
  }
  return table;
}

export async function loadExamples(
  db: Database,
): Promise<{ examples: TrainingExample[]; excluded: Record<string, number> }> {
  const rows = await db.planningDecision.findMany({
    where: { status: { in: ['FINALIZED', 'EXCLUDED'] } },
    orderBy: [{ periodStart: 'asc' }, { id: 'asc' }],
  });
  const excluded: Record<string, number> = {};
  const examples: TrainingExample[] = [];
  const skip = (why: string) => (excluded[why] = (excluded[why] ?? 0) + 1);
  for (const r of rows) {
    const state = r.state as unknown as DecisionState;
    if (r.status === 'EXCLUDED') skip(r.excludeReason ?? 'EXCLUDED');
    else if (r.censored) skip('STOCKOUT_WEEK');
    else if (r.demandUnits === null || state.projectedOpening === null) skip('INCOMPLETE');
    else
      examples.push({
        id: r.id,
        periodStart: dayOf(r.periodStart),
        bucket: stateBucket(state),
        opening: state.projectedOpening,
        demand: r.demandUnits,
        candidates: r.candidateActions as unknown as Candidate[],
      });
  }
  return { examples, excluded };
}

/** Trains, evaluates on the time-based holdout, and records the result as a PolicyVersion. */
export async function trainPolicy(db: Database, opts: { activate?: boolean; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const { examples, excluded } = await loadExamples(db);
  const { train, holdout } = splitByTime(examples);
  const version = `${dayOf(now)}.${now.getTime()}`;
  const base = {
    name: POLICY_NAME,
    version,
    algorithm: 'tabular-contextual-bandit/historical-replay',
    rewardConfig: { weights: REWARD_WEIGHTS, units: 'menu-item units (no cost data exists)' },
    dataset: {
      train: train.map((e) => e.id),
      holdout: holdout.map((e) => e.id),
      excluded,
      trainPeriod: train.length ? [train[0]!.periodStart, train.at(-1)!.periodStart] : null,
      holdoutPeriod: holdout.length ? [holdout[0]!.periodStart, holdout.at(-1)!.periodStart] : null,
    },
  };

  if (
    train.length < TRAINING_RULES.minTrainDecisions ||
    holdout.length < TRAINING_RULES.minHoldoutDecisions
  ) {
    const policy = await db.policyVersion.create({
      data: {
        ...base,
        status: 'REJECTED',
        artifact: { table: {} },
        evaluation: {
          verdict: 'INSUFFICIENT_DATA',
          usableDecisions: examples.length,
          required: TRAINING_RULES.minTrainDecisions + TRAINING_RULES.minHoldoutDecisions,
        },
        notes: 'Not enough finalized, stockout-free decisions yet. The baseline stays in use.',
      },
    });
    return { policy, activated: false };
  }

  const table = learnTable(train);
  const learned = (e: TrainingExample) => table[e.bucket] ?? 'MEDIUM';
  const baseline = () => 'MEDIUM' as const;
  const evaluation = {
    holdout: {
      learned: evaluatePolicy(holdout, learned),
      baseline: evaluatePolicy(holdout, baseline),
    },
    train: { learned: evaluatePolicy(train, learned), baseline: evaluatePolicy(train, baseline) },
  };
  const b = evaluation.holdout.baseline;
  const l = evaluation.holdout.learned;
  const rewardOk =
    l.meanReward >= b.meanReward + Math.abs(b.meanReward) * TRAINING_RULES.minRewardImprovement &&
    l.meanReward > b.meanReward;
  const serviceOk =
    b.serviceLevel === null ||
    l.serviceLevel === null ||
    l.serviceLevel >= b.serviceLevel - TRAINING_RULES.maxServiceLevelDrop;
  const validated = rewardOk && serviceOk;

  const policy = await db.$transaction(async (tx) => {
    const activate = validated && opts.activate === true;
    if (activate) {
      await tx.policyVersion.updateMany({
        where: { name: POLICY_NAME, status: 'ACTIVE' },
        data: { status: 'RETIRED' },
      });
    }
    const created = await tx.policyVersion.create({
      data: {
        ...base,
        status: activate ? 'ACTIVE' : validated ? 'VALIDATED' : 'REJECTED',
        artifact: { table, defaultAction: 'MEDIUM' },
        evaluation: JSON.parse(
          JSON.stringify({
            ...evaluation,
            verdict: validated
              ? 'BEATS_BASELINE'
              : rewardOk
                ? 'SERVICE_LEVEL_DROPPED'
                : 'NOT_BETTER_THAN_BASELINE',
            rules: TRAINING_RULES,
          }),
        ),
        activatedAt: activate ? now : null,
      },
    });
    await recordAudit(tx, {
      actor: { type: 'CLI' },
      action: 'PLANNING_POLICY_TRAINED',
      entityType: 'PolicyVersion',
      entityId: created.id,
      metadata: { version, status: created.status },
    });
    return created;
  });
  return { policy, activated: policy.status === 'ACTIVE' };
}

/** Explicitly switches the learned policy on (only a VALIDATED one) or back to the baseline. */
export async function setActivePolicy(db: Database, version: string | null) {
  return db.$transaction(async (tx) => {
    if (version === null) {
      await tx.policyVersion.updateMany({
        where: { name: POLICY_NAME, status: 'ACTIVE' },
        data: { status: 'RETIRED' },
      });
      return null;
    }
    const target = await tx.policyVersion.findUnique({
      where: { name_version: { name: POLICY_NAME, version } },
    });
    if (!target) throw new Error(`No policy version ${version}`);
    if (target.status !== 'VALIDATED' && target.status !== 'RETIRED') {
      throw new Error(
        `Policy ${version} is ${target.status}; only a validated policy can be activated.`,
      );
    }
    if (
      target.status === 'RETIRED' &&
      (target.evaluation as { verdict?: string }).verdict !== 'BEATS_BASELINE'
    ) {
      throw new Error(`Policy ${version} never passed validation.`);
    }
    await tx.policyVersion.updateMany({
      where: { name: POLICY_NAME, status: 'ACTIVE' },
      data: { status: 'RETIRED' },
    });
    return tx.policyVersion.update({
      where: { id: target.id },
      data: { status: 'ACTIVE', activatedAt: new Date() },
    });
  });
}
