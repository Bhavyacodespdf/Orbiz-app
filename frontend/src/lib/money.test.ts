import { describe, expect, it } from 'vitest';
import { formatINR } from './money';

describe('formatINR', () => {
  it('formats whole rupees without decimals', () => {
    expect(formatINR(12000)).toBe('₹120');
    expect(formatINR(0)).toBe('₹0');
  });

  it('shows two decimals when there are paise', () => {
    expect(formatINR(12050)).toBe('₹120.50');
    expect(formatINR(5)).toBe('₹0.05');
  });

  it('uses Indian digit grouping', () => {
    expect(formatINR(12345600)).toBe('₹1,23,456');
  });

  it('rejects non-integer paise so float money bugs surface early', () => {
    expect(() => formatINR(10.5)).toThrow(TypeError);
  });
});
