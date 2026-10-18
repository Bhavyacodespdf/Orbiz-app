import { Link } from 'react-router';
import { ArrowRight, Gift } from 'lucide-react';

/**
 * Home page entry point to the Surprise Meal budget solver. It sits in the hero's second
 * column, so it is built as a tall tile rather than a banner.
 */
export function SurpriseMealPromo() {
  return (
    <Link
      to="/surprise"
      className="group relative flex flex-col gap-4 overflow-hidden rounded-[1.25rem] bg-gradient-to-br from-plum-600 to-plum-700 p-6 shadow-float transition-[transform,box-shadow] duration-300 ease-out hover:-translate-y-1"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -top-16 -right-10 size-44 rounded-full bg-mustard-300/25 blur-2xl transition-opacity duration-500 group-hover:opacity-90"
      />
      <span className="relative grid size-12 place-items-center rounded-xl bg-white/15 text-white ring-1 ring-white/25 transition-transform duration-300 ease-out group-hover:-rotate-6">
        <Gift className="size-6" aria-hidden />
      </span>
      <span className="relative">
        <span className="block font-display text-xl leading-tight font-extrabold tracking-tight text-white">
          AI Surprise Meal
        </span>
        <span className="mt-1.5 block text-sm leading-relaxed text-white/75">
          Set a budget and a mood, and get a combo that fits — guaranteed.
        </span>
      </span>
      <span
        aria-hidden
        className="relative mt-auto inline-flex size-9 items-center justify-center rounded-full bg-white text-plum-700 transition-transform duration-300 ease-out group-hover:translate-x-1"
      >
        <ArrowRight className="size-4" />
      </span>
    </Link>
  );
}
