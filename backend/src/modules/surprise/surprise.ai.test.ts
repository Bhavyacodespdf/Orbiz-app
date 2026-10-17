import { describe, expect, it } from 'vitest';
import { askAdvisor, validateAdvice, type ComboAdvisor } from './surprise.ai.js';
import type { Candidate } from './surprise.engine.js';

const c = (id: string, pricePaise: number, extra: Partial<Candidate> = {}): Candidate => ({
  id,
  name: id,
  description: '',
  pricePaise,
  dietary: 'VEG',
  imageUrl: null,
  categoryId: 'cat',
  categoryName: 'Snacks',
  outletId: 'o1',
  outletName: 'Canteen',
  outletSlug: 'canteen',
  ...extra,
});
const candidates = [c('a', 5_000), c('b', 4_000), c('x', 3_000, { outletId: 'o2' })];
const context = { candidates, budgetPaise: 10_000, diet: 'ANY' as const, outletId: null };

describe('validating AI suggestions', () => {
  it('accepts candidate IDs and takes prices from the database records, not the AI', () => {
    const result = validateAdvice(
      { itemIds: ['a', 'b'], explanation: 'Great <b>value</b>!', prices: { a: 1 }, totalPaise: 2 },
      context,
    );
    expect(result).toMatchObject({ ok: true, explanation: 'Great b value /b !' });
    if (result.ok) expect(result.items.map((i) => i.pricePaise)).toEqual([5_000, 4_000]);
  });

  it.each([
    [{ itemIds: ['a', 'invented-id'] }, 'item not among the eligible candidates'],
    [{ itemIds: ['a', 'x'] }, 'items from more than one outlet'],
    [{ itemIds: ['a', 'a'] }, 'repeated item'],
    [{ itemIds: [] }, 'malformed response'],
    ['Try the a and b combo!', 'malformed response'],
    [undefined, 'malformed response'],
  ])('rejects %j', (raw, reason) => {
    expect(validateAdvice(raw, context)).toEqual({ ok: false, reason });
  });

  it('rejects combos over budget, outside the chosen outlet or breaking the diet', () => {
    expect(validateAdvice({ itemIds: ['a', 'b'] }, { ...context, budgetPaise: 8_000 })).toEqual({
      ok: false,
      reason: 'over budget',
    });
    expect(validateAdvice({ itemIds: ['x'] }, { ...context, outletId: 'o1' })).toEqual({
      ok: false,
      reason: 'item from another outlet',
    });
    expect(validateAdvice({ itemIds: ['a'] }, { ...context, diet: 'NON_VEG' })).toEqual({
      ok: false,
      reason: 'dietary rule broken',
    });
  });

  it('gives up on a slow provider and never throws for a failing one', async () => {
    const slow: ComboAdvisor = { name: 'slow', suggest: () => new Promise(() => {}) };
    const broken: ComboAdvisor = {
      name: 'broken',
      suggest: async () => {
        throw new Error('boom');
      },
    };
    const start = Date.now();
    expect(
      await askAdvisor(slow, { budgetPaise: 1, mood: 'FEAST', diet: 'ANY', candidates: [] }, 50),
    ).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(
      await askAdvisor(broken, { budgetPaise: 1, mood: 'FEAST', diet: 'ANY', candidates: [] }),
    ).toBeUndefined();
  });
});
