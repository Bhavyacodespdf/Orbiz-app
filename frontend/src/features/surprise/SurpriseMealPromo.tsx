import { Link } from 'react-router';
import { ChevronRight, Gift } from 'lucide-react';

/** Home page entry point to the Surprise Meal budget solver. */
export function SurpriseMealPromo() {
  return (
    <Link
      to="/surprise"
      className="mb-8 flex items-center gap-4 rounded-(--radius-panel) border border-plum-100 bg-plum-50 p-4 transition-shadow hover:shadow-lift"
    >
      <span className="grid size-12 shrink-0 place-items-center rounded-(--radius-control) bg-plum-600 text-white">
        <Gift className="size-6" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-bold text-plum-700">AI Surprise Meal</span>
        <span className="block text-sm text-espresso-700">
          Set a budget and a mood, and get a combo that fits — guaranteed.
        </span>
      </span>
      <ChevronRight className="size-5 shrink-0 text-plum-700" aria-hidden />
    </Link>
  );
}
