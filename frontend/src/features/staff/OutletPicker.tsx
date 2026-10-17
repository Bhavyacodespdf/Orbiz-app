import { SelectField } from '@/components/ui/SelectField';
import type { StaffOutlet } from '@/services/staff';

export function OutletPicker({
  outlets,
  selectedId,
  onSelect,
}: {
  outlets: StaffOutlet[];
  selectedId: string;
  onSelect: (outletId: string) => void;
}) {
  if (outlets.length < 2) return null;
  return (
    <SelectField
      label="Outlet"
      hideLabel
      value={selectedId}
      onChange={(event) => onSelect(event.target.value)}
      className="w-full sm:w-64"
    >
      {outlets.map(({ outlet }) => (
        <option key={outlet.id} value={outlet.id}>
          {outlet.name}
        </option>
      ))}
    </SelectField>
  );
}
