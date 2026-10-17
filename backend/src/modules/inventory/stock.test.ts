import { describe, expect, it } from 'vitest';
import { hasStockFor, soldOutReason, stockStatus } from './stock.js';

const item = (overrides: Partial<Parameters<typeof stockStatus>[0]> = {}) => ({
  isAvailable: true,
  trackInventory: true,
  stockQuantity: 10,
  lowStockThreshold: 5,
  ...overrides,
});

describe('stock status rules', () => {
  it('is AVAILABLE above the threshold', () => {
    expect(stockStatus(item({ stockQuantity: 6 }))).toBe('AVAILABLE');
  });
  it('is LOW_STOCK at or below the threshold while units remain', () => {
    expect(stockStatus(item({ stockQuantity: 5 }))).toBe('LOW_STOCK');
    expect(stockStatus(item({ stockQuantity: 3 }))).toBe('LOW_STOCK');
    expect(stockStatus(item({ stockQuantity: 1 }))).toBe('LOW_STOCK');
  });
  it('is SOLD_OUT at zero', () => {
    expect(stockStatus(item({ stockQuantity: 0 }))).toBe('SOLD_OUT');
    expect(soldOutReason(item({ stockQuantity: 0 }))).toBe('OUT_OF_STOCK');
  });
  it('is SOLD_OUT whenever staff marked it so, whatever the quantity', () => {
    expect(stockStatus(item({ isAvailable: false, stockQuantity: 50 }))).toBe('SOLD_OUT');
    expect(soldOutReason(item({ isAvailable: false, stockQuantity: 50 }))).toBe('MARKED_SOLD_OUT');
  });
  it('treats untracked items as available unless marked sold out', () => {
    expect(stockStatus(item({ trackInventory: false, stockQuantity: null }))).toBe('AVAILABLE');
    expect(hasStockFor(item({ trackInventory: false, stockQuantity: null }), 9)).toBe(true);
    expect(
      stockStatus(item({ trackInventory: false, stockQuantity: null, isAvailable: false })),
    ).toBe('SOLD_OUT');
  });
  it('checks there are enough units for a quantity', () => {
    expect(hasStockFor(item({ stockQuantity: 3 }), 3)).toBe(true);
    expect(hasStockFor(item({ stockQuantity: 3 }), 4)).toBe(false);
  });
  it('with a threshold of 0, a tracked item is never LOW_STOCK', () => {
    expect(stockStatus(item({ stockQuantity: 1, lowStockThreshold: 0 }))).toBe('AVAILABLE');
  });
});
