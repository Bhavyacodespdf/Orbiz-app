import type { Dietary } from '@/services/outlets';
import { cn } from '@/lib/cn';

const marks: Record<Dietary, { label: string; color: string; shape: 'dot' | 'triangle' }> = {
  VEG: { label: 'Vegetarian', color: '#2F7A4B', shape: 'dot' },
  EGG: { label: 'Contains egg', color: '#C7851C', shape: 'dot' },
  NON_VEG: { label: 'Non-vegetarian', color: '#87281B', shape: 'triangle' },
};

/** The familiar Indian food-label square: green dot (veg), brown triangle (non-veg). */
export function DietaryMark({
  dietary,
  className,
  decorative = false,
}: {
  dietary: Dietary;
  className?: string;
  /** Hide from assistive tech when nearby text already says it (e.g. a "Veg only" button). */
  decorative?: boolean;
}) {
  const mark = marks[dietary];
  return (
    <span
      {...(decorative
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': mark.label, title: mark.label })}
      className={cn(
        'inline-grid size-4 shrink-0 place-items-center rounded-[3px] border-[1.5px]',
        className,
      )}
      style={{ borderColor: mark.color }}
    >
      {mark.shape === 'dot' ? (
        <span className="size-2 rounded-full" style={{ backgroundColor: mark.color }} />
      ) : (
        <span
          className="size-0 border-x-[4.5px] border-b-[8px] border-x-transparent"
          style={{ borderBottomColor: mark.color }}
        />
      )}
    </span>
  );
}
