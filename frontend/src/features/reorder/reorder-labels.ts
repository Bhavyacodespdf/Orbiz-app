import type { LineStatus, ReorderLine } from '@/services/reorder';

/** Why a dish can't be added, in plain words. */
export const UNAVAILABLE_TEXT: Record<Exclude<LineStatus, 'AVAILABLE' | 'LIMITED'>, string> = {
  SOLD_OUT: 'Sold out right now',
  NO_LONGER_ON_MENU: 'No longer on the menu',
  OUTLET_UNAVAILABLE: 'The outlet isn’t taking orders right now',
};

/** "Only 2 left — adding 2 of 3" / "Up to 10 per dish — adding 10 of 12". */
export function limitedText(line: ReorderLine): string {
  const reason =
    line.limitReason === 'QUANTITY_LIMIT'
      ? 'Up to 10 per dish'
      : `Only ${line.addableQuantity} left`;
  return `${reason} — adding ${line.addableQuantity} of ${line.requestedQuantity}`;
}

/** "All available", "1 dish unavailable", "Outlet closed". */
export function availabilitySummary(lines: ReorderLine[], acceptingOrders: boolean): string {
  if (!acceptingOrders) return 'Outlet not taking orders right now';
  const missing = lines.filter((l) => l.addableQuantity === 0).length;
  const limited = lines.filter((l) => l.status === 'LIMITED').length;
  if (missing === 0 && limited === 0) return 'Available now';
  if (missing === lines.length) return 'Not available right now';
  return [
    missing > 0 && `${missing} ${missing === 1 ? 'dish' : 'dishes'} unavailable`,
    limited > 0 && `${limited} with limited stock`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export const formatOrderDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
