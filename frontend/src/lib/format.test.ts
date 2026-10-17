import { describe, expect, it } from 'vitest';
import { paiseToRupeesInput, parseRupeesToPaise } from './money';
import { timeAgo } from './time';

describe('parseRupeesToPaise', () => {
  it.each([
    ['45', 4500],
    ['45.5', 4550],
    ['45.50', 4550],
    ['0.10', 10],
    [' 120 ', 12000],
    ['0.29', 29],
  ])('%s → %i paise', (input, paise) => {
    expect(parseRupeesToPaise(input)).toBe(paise);
  });

  it.each(['', 'abc', '-5', '4.555', '1e3', '12,000', '.5'])('rejects %j', (input) => {
    expect(parseRupeesToPaise(input)).toBeNull();
  });

  it('round-trips with paiseToRupeesInput', () => {
    for (const paise of [100, 4550, 4505, 99999]) {
      expect(parseRupeesToPaise(paiseToRupeesInput(paise))).toBe(paise);
    }
  });
});

describe('timeAgo', () => {
  const now = new Date('2026-10-16T10:00:00Z').getTime();
  it('describes recent times briefly', () => {
    expect(timeAgo('2026-10-16T09:59:40Z', now)).toBe('just now');
    expect(timeAgo('2026-10-16T09:56:00Z', now)).toBe('4 min ago');
    expect(timeAgo('2026-10-16T07:30:00Z', now)).toBe('2 h ago');
  });
});
