import { useId, useState } from 'react';
import { Link } from 'react-router';
import { Star } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { RatingSummary } from '@/services/outlets';
import { STAR_LABELS, formatAverage, ratingSentence, ratingsLabel } from './review-labels';

/** Five stars, filled to the rating (decorative; pair it with text). */
export function StarRow({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} aria-hidden>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={cn(
            'size-4',
            n <= Math.round(value)
              ? 'fill-mustard-500 text-mustard-600'
              : 'fill-transparent text-espresso-200',
          )}
        />
      ))}
    </span>
  );
}

/**
 * "★ 4.5 · 12 ratings" or "Not yet rated", from real reviews. With `to`, it links to the
 * dish's reviews.
 */
export function RatingInline({
  rating,
  to,
  className,
}: {
  rating: RatingSummary;
  to?: string;
  className?: string;
}) {
  const content =
    rating.average === null ? (
      <span className="text-espresso-500">Not yet rated</span>
    ) : (
      <>
        <Star className="size-3.5 fill-mustard-500 text-mustard-600" aria-hidden />
        <span className="font-semibold text-espresso-900 tabular">
          {formatAverage(rating.average)}
        </span>
        <span aria-hidden className="text-espresso-500">
          ·
        </span>
        <span className="text-espresso-500">{ratingsLabel(rating.count)}</span>
      </>
    );
  const classes = cn('inline-flex items-center gap-1 text-sm', className);
  if (!to) {
    return (
      <span className={classes}>
        <span className="sr-only">{ratingSentence(rating)}</span>
        <span aria-hidden className="inline-flex items-center gap-1">
          {content}
        </span>
      </span>
    );
  }
  return (
    <Link
      to={to}
      className={cn(classes, 'rounded-sm underline-offset-2 hover:underline')}
      aria-label={`${ratingSentence(rating)}. See reviews`}
    >
      {content}
    </Link>
  );
}

/** Accessible 1–5 star picker: a radio group, so arrow keys and screen readers just work. */
export function StarInput({
  value,
  onChange,
  error,
}: {
  value: number | null;
  onChange: (stars: number) => void;
  error?: string;
}) {
  const name = useId();
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  return (
    <fieldset aria-describedby={error ? `${name}-error` : undefined}>
      <legend className="text-sm font-semibold text-espresso-900">Your rating</legend>
      <div className="mt-1.5 flex items-center gap-3">
        <div className="flex" onMouseLeave={() => setHover(null)}>
          {STAR_LABELS.map((label, i) => {
            const stars = i + 1;
            return (
              <label
                key={stars}
                className="cursor-pointer rounded-md p-1 has-focus-visible:ring-2 has-focus-visible:ring-chili-500"
                onMouseEnter={() => setHover(stars)}
              >
                <input
                  type="radio"
                  name={name}
                  value={stars}
                  checked={value === stars}
                  onChange={() => onChange(stars)}
                  className="sr-only"
                />
                <span className="sr-only">{`${stars} ${stars === 1 ? 'star' : 'stars'}: ${label}`}</span>
                <Star
                  aria-hidden
                  className={cn(
                    'size-8 transition-colors',
                    stars <= shown
                      ? 'fill-mustard-500 text-mustard-600'
                      : 'fill-transparent text-espresso-400',
                  )}
                />
              </label>
            );
          })}
        </div>
        <span className="text-sm font-semibold text-espresso-700" aria-hidden>
          {shown > 0 ? STAR_LABELS[shown - 1] : 'Tap a star'}
        </span>
      </div>
      {error && (
        <p id={`${name}-error`} className="mt-1 text-sm font-semibold text-chili-700">
          {error}
        </p>
      )}
    </fieldset>
  );
}
