import { describe, expect, it } from 'vitest';
import {
  RECHARGE_MIN_PAISE,
  bonusPointsFor,
  maxRedeemablePoints,
  pointsToPaise,
  rechargeMinPaise,
} from './loyalty.rules.js';

describe('loyalty rules', () => {
  it.each([
    [50_000, 10],
    [100_000, 25],
    [130_000, 30],
    [150_000, 40],
  ])('a ₹%i paise recharge earns exactly %i points', (amount, points) => {
    expect(bonusPointsFor(amount)).toBe(points);
  });

  it.each([9_900, 10_000, 49_900, 50_100, 99_900, 100_100, 120_000, 140_000, 160_000, 200_000])(
    'invents nothing for %i paise (no rounding, no nearest slab)',
    (amount) => {
      expect(bonusPointsFor(amount)).toBe(0);
    },
  );

  it('keeps ₹99 as a floor that configuration can raise but never lower', () => {
    expect(RECHARGE_MIN_PAISE).toBe(9_900);
    expect(rechargeMinPaise(1_000)).toBe(9_900);
    expect(rechargeMinPaise(20_000)).toBe(20_000);
  });

  it('values one point at exactly ₹1', () => {
    expect(pointsToPaise(1)).toBe(100);
    expect(pointsToPaise(20)).toBe(2_000);
  });

  it('never redeems more than the points held or the order minus ₹1', () => {
    expect(maxRedeemablePoints(6_000, 100)).toBe(59); // ₹60 order → at most ₹59 off
    expect(maxRedeemablePoints(6_000, 20)).toBe(20); // limited by points held
    expect(maxRedeemablePoints(3_550, 100)).toBe(34); // ₹35.50 → ₹34 off leaves ₹1.50
    expect(maxRedeemablePoints(100, 100)).toBe(0); // ₹1 order: nothing to discount
    expect(maxRedeemablePoints(0, 100)).toBe(0);
  });
});
