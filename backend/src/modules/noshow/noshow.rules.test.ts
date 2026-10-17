import { describe, expect, it } from 'vitest';
import { allocateDiscount, paidPerLine, pickupDeadline, splitRefund } from './noshow.rules.js';

describe('no-show rules', () => {
  it('sets the deadline 10 minutes after the slot', () => {
    expect(pickupDeadline(new Date('2026-10-17T07:30:00.000Z')).toISOString()).toBe(
      '2026-10-17T07:40:00.000Z',
    );
  });

  it.each([
    [10_000, 9_000, 1_000],
    [3_500, 3_150, 350],
    [2_599, 2_339, 260], // 2339.1 → rounded down; fee takes the remainder
    [1, 0, 1],
    [0, 0, 0],
  ])('splits %i paise into a %i refund and %i fee that add up exactly', (paid, refund, fee) => {
    expect(splitRefund(paid)).toEqual({ refundPaise: refund, feePaise: fee });
  });

  it('spreads a discount across lines in whole paise that add up exactly', () => {
    expect(allocateDiscount([3_500, 4_000], 2_000)).toEqual([933, 1_067]);
    expect(allocateDiscount([100, 100, 100], 100)).toEqual([34, 33, 33]);
    expect(allocateDiscount([5_000], 0)).toEqual([0]);
    for (const [lines, discount] of [
      [[1_234, 5_678, 999], 777],
      [[50, 50], 99],
    ] as const) {
      expect(allocateDiscount([...lines], discount).reduce((a, b) => a + b, 0)).toBe(discount);
    }
  });

  it('counts only money actually paid: nothing for an unpaid counter order', () => {
    const lines = [{ lineTotalPaise: 3_500 }, { lineTotalPaise: 4_000 }];
    expect(paidPerLine(lines, { pointsDiscountPaise: 2_000, paid: true })).toEqual([2_567, 2_933]);
    expect(paidPerLine(lines, { pointsDiscountPaise: 0, paid: false })).toEqual([0, 0]);
  });
});
