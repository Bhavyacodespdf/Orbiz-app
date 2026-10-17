/**
 * Money is always handled as integer paise (₹1 = 100 paise) and only
 * converted to rupees for display. Amounts always come from the server.
 */
const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatINR(paise: number): string {
  if (!Number.isInteger(paise)) {
    throw new TypeError(`Money must be an integer number of paise, got ${paise}`);
  }
  // Show paise only when there are some: ₹120 but ₹120.50
  const rupees = paise / 100;
  return paise % 100 === 0
    ? inr.format(rupees).replace(/\.00$/, '')
    : new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        minimumFractionDigits: 2,
      }).format(rupees);
}

/**
 * Parses what a person typed as rupees ("45", "45.5", "45.50") into integer
 * paise using string arithmetic, so 0.1 + 0.2 style float errors can't occur.
 * Returns null for anything else (negative, more than 2 decimals, text).
 */
export function parseRupeesToPaise(input: string): number | null {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  const rupees = Number(match[1]);
  const paise = Number((match[2] ?? '').padEnd(2, '0'));
  return rupees * 100 + paise;
}

/** 4550 → "45.50", 4500 → "45" — for pre-filling price inputs. */
export function paiseToRupeesInput(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  return rest === 0 ? String(rupees) : `${rupees}.${String(rest).padStart(2, '0')}`;
}
