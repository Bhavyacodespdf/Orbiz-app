import { Link } from 'react-router';
import { MapPin } from 'lucide-react';
import { StatusSign } from '@/components/ui/StatusSign';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import type { Outlet } from '@/services/outlets';

const tiles = [
  'bg-chili-500 text-cream-100',
  'bg-mustard-500 text-espresso-900',
  'bg-espresso-900 text-mustard-300',
  'bg-chili-100 text-chili-700',
];

/** Picks a stable tile colour from the outlet name, so cards differ without stock photos. */
function tileFor(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return tiles[hash % tiles.length]!;
}

export function OutletCard({ outlet }: { outlet: Outlet }) {
  const initials = outlet.name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');

  return (
    <Link
      to={`/outlets/${outlet.slug}`}
      className={cn(
        'group flex flex-col overflow-hidden rounded-(--radius-panel) border border-espresso-100 bg-cream-50 shadow-lift transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_30px_-16px_rgb(43_30_26/0.35)]',
      )}
    >
      <div
        className={cn(
          'relative flex h-28 items-end justify-between p-4',
          outlet.imageUrl ? 'bg-espresso-900' : tileFor(outlet.name),
        )}
      >
        {outlet.imageUrl ? (
          <img src={outlet.imageUrl} alt="" className="absolute inset-0 size-full object-cover" />
        ) : (
          <span
            aria-hidden
            className="font-display text-5xl leading-none font-extrabold opacity-90"
          >
            {initials}
          </span>
        )}
        <StatusSign status={outlet.status} className="relative bg-cream-50" />
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-xl font-bold group-hover:text-chili-600">{outlet.name}</h2>
          {outlet.isSample && <Badge tone="mustard">Sample data</Badge>}
        </div>
        {outlet.location && (
          <p className="flex items-center gap-1.5 text-sm text-espresso-500">
            <MapPin className="size-4 shrink-0" aria-hidden />
            {outlet.location}
          </p>
        )}
        {outlet.description && (
          <p className="line-clamp-2 text-sm text-espresso-700">{outlet.description}</p>
        )}
      </div>
    </Link>
  );
}
