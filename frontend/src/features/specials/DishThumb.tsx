import { UtensilsCrossed } from 'lucide-react';
import { cn } from '@/lib/cn';

/** A dish photo, or a neutral placeholder when the outlet hasn't added one. */
export function DishThumb({
  imageUrl,
  className,
}: {
  imageUrl: string | null;
  className?: string;
}) {
  return imageUrl ? (
    <img
      src={imageUrl}
      alt=""
      loading="lazy"
      className={cn('shrink-0 rounded-(--radius-control) object-cover', className)}
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-(--radius-control) bg-cream-200 text-espresso-400',
        className,
      )}
    >
      <UtensilsCrossed className="size-1/3" />
    </span>
  );
}
