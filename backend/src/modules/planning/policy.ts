import type { Database } from '../../lib/prisma.js';
import type { PlanAction } from '../../generated/prisma/enums.js';
import {
  ACTION_MULTIPLIERS,
  ACTIONS,
  BASELINE_POLICY,
  POLICY_NAME,
  REWARD_WEIGHTS,
  type ActionName,
} from './planning.rules.js';

/*
 * The decision policy. The BASELINE always recommends the full need (MEDIUM). A learned policy
 * is a table from a coarse state bucket to an action, trained offline on finalized experience
 * (see train.ts) and used only when it is ACTIVE — i.e. it beat the baseline on a time-based
 * holdout AND someone explicitly activated it. Otherwise the baseline is used.
 */

export interface DecisionState {
  confidence: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  tracked: boolean;
  forecastWeek: number;
  sigmaWeek: number | null;
  safetyStock: number;
  currentStock: number | null;
  projectedOpening: number | null;
  baselineNeed: number;
  stockoutRate: number;
  wastedLast28: number;
  last7Demand: number;
  last28Demand: number;
  fulfillmentType: 'PACKAGED' | 'HANDMADE' | null;
}

export interface Candidate {
  action: ActionName;
  quantity: number;
}

/** Item-specific action quantities: multiples of the baseline need, within the stock limit. */
export function candidatesFor(need: number, room: number): Candidate[] {
  return ACTIONS.map((action) => ({
    action,
    quantity: Math.max(0, Math.min(room, Math.round(ACTION_MULTIPLIERS[action] * need))),
  }));
}

/** Demand variability: coefficient of variation of the weekly forecast. */
export function stateBucket(s: Pick<DecisionState, 'confidence' | 'forecastWeek' | 'sigmaWeek'>) {
  const cv = s.sigmaWeek === null || s.forecastWeek <= 0 ? null : s.sigmaWeek / s.forecastWeek;
  const variability =
    cv === null ? 'UNKNOWN' : cv < 0.3 ? 'STEADY' : cv < 0.7 ? 'VARIABLE' : 'ERRATIC';
  return `${s.confidence}|${variability}`;
}

export interface LoadedPolicy {
  name: string;
  version: string;
  table: Record<string, ActionName> | null;
}

/** The active learned policy, or the baseline when none is active (or its artifact is bad). */
export async function activePolicy(db: Database): Promise<LoadedPolicy> {
  const active = await db.policyVersion.findFirst({
    where: { name: POLICY_NAME, status: 'ACTIVE' },
  });
  const table = (active?.artifact as { table?: Record<string, string> } | null)?.table;
  const valid = table && Object.values(table).every((a) => (ACTIONS as string[]).includes(a));
  if (!active || !valid) return { ...BASELINE_POLICY, table: null };
  return { name: active.name, version: active.version, table: table as Record<string, ActionName> };
}

/** Chooses an action. No need → NONE, whatever the policy says. */
export function chooseAction(policy: LoadedPolicy, state: DecisionState): PlanAction {
  if (state.baselineNeed <= 0) return 'NONE';
  return policy.table?.[stateBucket(state)] ?? 'MEDIUM';
}

export interface RewardInput {
  fulfilled: number;
  estimatedLost: number;
  wasted: number;
  leftover: number | null;
}

export function rewardOf(r: RewardInput) {
  const components = {
    fulfilled: r.fulfilled * REWARD_WEIGHTS.fulfilled,
    lost: -r.estimatedLost * REWARD_WEIGHTS.lost,
    wasted: -r.wasted * REWARD_WEIGHTS.wasted,
    leftover: -(r.leftover ?? 0) * REWARD_WEIGHTS.leftover,
    leftoverKnown: r.leftover !== null,
    weights: REWARD_WEIGHTS,
  };
  const reward = components.fulfilled + components.lost + components.wasted + components.leftover;
  return { reward: Math.round(reward * 100) / 100, components };
}

/**
 * Historical replay: what an action's quantity would have achieved against the demand that
 * actually happened (only valid for weeks without stockouts, where observed demand is true
 * demand; censored weeks are excluded from training and evaluation).
 */
export function replayReward(opening: number, quantity: number, demand: number) {
  const available = opening + quantity;
  const fulfilled = Math.min(demand, available);
  return {
    fulfilled,
    reward: rewardOf({
      fulfilled,
      estimatedLost: Math.max(0, demand - available),
      wasted: 0,
      leftover: Math.max(0, available - demand),
    }).reward,
  };
}
