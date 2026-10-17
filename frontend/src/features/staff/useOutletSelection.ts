import { useSearchParams } from 'react-router';
import { useStaffOutlets, type StaffRole } from '@/services/staff';

const STORAGE_KEY = 'campuscart.staff.outlet';

function remembered(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Which assigned outlet a staff screen is showing. Kept in the URL (?outlet=)
 * so it survives refresh, and remembered per browser for convenience.
 */
export function useOutletSelection(role: StaffRole) {
  const outlets = useStaffOutlets();
  const [params, setParams] = useSearchParams();
  const mine = (outlets.data ?? []).filter((o) => o.roles.includes(role));
  const wanted = params.get('outlet') ?? remembered();
  const selected = mine.find((o) => o.outlet.id === wanted) ?? mine[0];

  function select(outletId: string) {
    try {
      localStorage.setItem(STORAGE_KEY, outletId);
    } catch {
      // Storage unavailable (private mode): the URL still carries the choice.
    }
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('outlet', outletId);
        return next;
      },
      { replace: true },
    );
  }

  return { query: outlets, outlets: mine, selected, select };
}
