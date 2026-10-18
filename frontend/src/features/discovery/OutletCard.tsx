import { Link } from 'react-router';
import { ArrowUpRight, MapPin } from 'lucide-react';
import { StatusSign } from '@/components/ui/StatusSign';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import type { Outlet } from '@/services/outlets';

/** Four tile recipes: a gradient plus a drawn pattern, so cards differ without photography. */
const tiles = [
  { wash: 'from-chili-500 via-chili-600 to-chili-700', ink: 'text-cream-100', pattern: 'arcs' },
  {
    wash: 'from-mustard-500 via-mustard-600 to-mustard-700',
    ink: 'text-espresso-900',
    pattern: 'dots',
  },
  {
    wash: 'from-espresso-700 via-espresso-800 to-espresso-900',
    ink: 'text-mustard-300',
    pattern: 'grid',
  },
  { wash: 'from-plum-600 via-plum-600 to-plum-700', ink: 'text-cream-100', pattern: 'rays' },
] as const;

/**
 * Stable per-name recipe, offset by position so neighbours never share one: similar names
 * ("Cafe1", "Cafe10") hash close together and would otherwise come out identical.
 */
function tileFor(name: string, index: number) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return tiles[(hash + index) % tiles.length]!;
}

/** The drawn layer of a tile. Decorative only, so it is hidden from assistive tech. */
function Pattern({ kind }: { kind: (typeof tiles)[number]['pattern'] }) {
  const id = `p-${kind}`;
  return (
    <svg aria-hidden className="absolute inset-0 size-full opacity-[0.18]" role="presentation">
      <defs>
        {kind === 'dots' && (
          <pattern id={id} width="22" height="22" patternUnits="userSpaceOnUse">
            <circle cx="3" cy="3" r="2.2" fill="currentColor" />
          </pattern>
        )}
        {kind === 'grid' && (
          <pattern id={id} width="26" height="26" patternUnits="userSpaceOnUse">
            <path d="M26 0H0v26" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </pattern>
        )}
        {kind === 'arcs' && (
          <pattern id={id} width="34" height="34" patternUnits="userSpaceOnUse">
            <path d="M0 34a17 17 0 0 1 34 0" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </pattern>
        )}
        {kind === 'rays' && (
          <pattern
            id={id}
            width="18"
            height="18"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(35)"
          >
            <line x1="0" y1="0" x2="0" y2="18" stroke="currentColor" strokeWidth="2" />
          </pattern>
        )}
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

export function OutletCard({ outlet, index = 0 }: { outlet: Outlet; index?: number }) {
  /*
   * The first word's capitals and digits: "Cafe1" → C1, "Cafe10" → C10, "NE Cafe" → NE.
   * Taking one letter per word instead would spell real words on some names
   * ("Night Owl" → NO) and would not tell Cafe1 and Cafe10 apart.
   */
  const firstWord = outlet.name.trim().split(/\s+/)[0] ?? '';
  const monogram = (
    firstWord.match(/[A-Z0-9]/g)?.join('') || firstWord.charAt(0).toUpperCase()
  ).slice(0, 3);
  const tile = tileFor(outlet.name, index);

  return (
    <Link
      to={`/outlets/${outlet.slug}`}
      style={{ animationDelay: `${Math.min(index, 6) * 45}ms` }}
      className={cn(
        'group animate-rise relative flex h-full w-full flex-col overflow-hidden rounded-[1.25rem]',
        'border border-line bg-surface-raised shadow-lift',
        'transition-[transform,box-shadow,border-color] duration-300 ease-out',
        'hover:-translate-y-1.5 hover:border-espresso-200 hover:shadow-float',
        'focus-visible:-translate-y-1.5 focus-visible:shadow-float',
      )}
    >
      <div className="relative h-40 overflow-hidden">
        <div
          className={cn(
            'absolute inset-0 bg-gradient-to-br transition-transform duration-[600ms] ease-out group-hover:scale-[1.06]',
            tile.wash,
            tile.ink,
          )}
        >
          {outlet.imageUrl ? (
            <img src={outlet.imageUrl} alt="" className="size-full object-cover" />
          ) : (
            <>
              <Pattern kind={tile.pattern} />
              <span
                aria-hidden
                className="absolute -right-3 -bottom-8 font-display text-[7.5rem] leading-none font-black opacity-[0.22] select-none"
              >
                {monogram}
              </span>
            </>
          )}
          <span
            aria-hidden
            className="grain-layer absolute inset-0 opacity-[0.07] mix-blend-overlay"
          />
        </div>

        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/30 via-black/10 to-transparent"
        />
        <StatusSign
          status={outlet.status}
          className="glass absolute top-3 right-3 border-transparent"
        />
        {outlet.isSample && (
          <Badge tone="mustard" className="absolute top-3 left-3 shadow-sm">
            Sample data
          </Badge>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-5">
        <h2 className="font-display text-[1.6rem] leading-[1.1] font-extrabold tracking-[-0.02em] text-balance transition-colors group-hover:text-chili-600">
          {outlet.name}
        </h2>
        {outlet.location && (
          <p className="flex items-center gap-1.5 text-sm text-ink-muted">
            <MapPin className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{outlet.location}</span>
          </p>
        )}
        {outlet.description && (
          <p className="line-clamp-2 text-sm leading-relaxed text-espresso-700">
            {outlet.description}
          </p>
        )}
        <span
          aria-hidden
          className="mt-auto flex items-center justify-end border-t border-line pt-3 text-chili-600"
        >
          <span className="grid size-8 place-items-center rounded-full bg-chili-50 transition-colors duration-300 group-hover:bg-chili-500 group-hover:text-white">
            <ArrowUpRight className="size-4 transition-transform duration-300 ease-out group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          </span>
        </span>
      </div>
    </Link>
  );
}
