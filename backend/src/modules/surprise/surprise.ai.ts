import { z } from 'zod';
import { comboFitsDiet, type Candidate } from './surprise.engine.js';
import { MAX_COMBO_ITEMS, type Diet, type Mood } from './surprise.rules.js';

/*
 * Optional AI step. CampusCart ships WITHOUT an AI provider: the deterministic solver
 * always works on its own. A provider can be plugged in later by implementing
 * ComboAdvisor (server-side only, key read from the environment, never sent to the
 * browser) and returning it from advisorFor().
 *
 * Whatever a provider returns is treated as untrusted text: only item IDs are read,
 * every ID must be one of the candidates WE sent (already filtered for availability,
 * outlet and diet from the database), and names, prices, totals or nutrition it may
 * mention are ignored. Anything invalid, slow or malformed falls back to the solver.
 */

export interface AdvisorRequest {
  budgetPaise: number;
  mood: Mood;
  diet: Diet;
  /** Only what the model needs: no student identity, no order history details. */
  candidates: { id: string; name: string; category: string; pricePaise: number; outlet: string }[];
}

export interface ComboAdvisor {
  readonly name: string;
  /** Returns the provider's raw (untrusted) output. Must honour the abort signal. */
  suggest(request: AdvisorRequest, signal: AbortSignal): Promise<unknown>;
}

/** No provider is configured in this release. */
export function advisorFor(): ComboAdvisor | null {
  return null;
}

export const ADVISOR_TIMEOUT_MS = 2_500;

const adviceSchema = z.object({
  itemIds: z.array(z.string()).min(1).max(MAX_COMBO_ITEMS),
  explanation: z.string().max(2_000).optional(),
});

/** Strips anything that isn't ordinary text and caps the length. */
function cleanText(text: string | undefined): string | null {
  if (!text) return null;
  const printable = [...text]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 32 || code === 127 || ch === '<' || ch === '>' ? ' ' : ch;
    })
    .join('');
  const cleaned = printable.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 280) : null;
}

export type AdviceResult =
  { ok: true; items: Candidate[]; explanation: string | null } | { ok: false; reason: string };

/**
 * Checks a provider's raw output against the candidates and rules. Prices come from the
 * candidate records (the database), never from the provider.
 */
export function validateAdvice(
  raw: unknown,
  context: { candidates: Candidate[]; budgetPaise: number; diet: Diet; outletId: string | null },
): AdviceResult {
  const parsed = adviceSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'malformed response' };
  const ids = parsed.data.itemIds;
  if (new Set(ids).size !== ids.length) return { ok: false, reason: 'repeated item' };

  const byId = new Map(context.candidates.map((c) => [c.id, c]));
  const items: Candidate[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) return { ok: false, reason: 'item not among the eligible candidates' };
    items.push(item);
  }
  const outlets = new Set(items.map((i) => i.outletId));
  if (outlets.size !== 1) return { ok: false, reason: 'items from more than one outlet' };
  if (context.outletId && !outlets.has(context.outletId)) {
    return { ok: false, reason: 'item from another outlet' };
  }
  if (!comboFitsDiet(context.diet, items)) return { ok: false, reason: 'dietary rule broken' };
  const totalPaise = items.reduce((s, i) => s + i.pricePaise, 0);
  if (totalPaise > context.budgetPaise) return { ok: false, reason: 'over budget' };
  return { ok: true, items, explanation: cleanText(parsed.data.explanation) };
}

/** Asks the provider, giving up after the timeout. Never throws. */
export async function askAdvisor(
  advisor: ComboAdvisor,
  request: AdvisorRequest,
  timeoutMs = ADVISOR_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      advisor.suggest(request, controller.signal),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
