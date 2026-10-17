import type { RatingSummary } from '@/services/outlets';
import type { Feedback, FeedbackAspect, FeedbackLevel } from '@/services/reviews';

export const ASPECT_LABELS: Record<FeedbackAspect, string> = {
  taste: 'Taste',
  portion: 'Portion size',
  freshness: 'Freshness',
  value: 'Value for money',
};

/** Wording per aspect, so "Portion size: Generous" reads naturally. */
export const LEVEL_LABELS: Record<FeedbackAspect, Record<FeedbackLevel, string>> = {
  taste: { POOR: 'Poor', OKAY: 'Okay', GREAT: 'Great' },
  portion: { POOR: 'Too small', OKAY: 'Just right', GREAT: 'Generous' },
  freshness: { POOR: 'Stale', OKAY: 'Okay', GREAT: 'Fresh' },
  value: { POOR: 'Poor', OKAY: 'Fair', GREAT: 'Great' },
};

/** "Taste: Great · Portion size: Just right" for the aspects the reviewer filled in. */
export function feedbackParts(feedback: Feedback): string[] {
  return (Object.keys(ASPECT_LABELS) as FeedbackAspect[])
    .filter((a) => feedback[a] !== null)
    .map((a) => `${ASPECT_LABELS[a]}: ${LEVEL_LABELS[a][feedback[a]!]}`);
}

/** The server's limit for review text. */
export const BODY_MAX = 1000;

export const itemPath = (outletSlug: string, itemId: string) =>
  `/outlets/${outletSlug}/items/${itemId}`;

export const STAR_LABELS = ['Very poor', 'Poor', 'Average', 'Good', 'Excellent'] as const;

export const ratingsLabel = (count: number) => `${count} ${count === 1 ? 'rating' : 'ratings'}`;

/** "4.5" — one decimal always, so 4 reads as 4.0 next to 4.5. */
export const formatAverage = (average: number) => average.toFixed(1);

/** The spoken form of a summary, e.g. "Rated 4.5 out of 5 from 12 ratings". */
export function ratingSentence(rating: RatingSummary) {
  return rating.average === null
    ? 'Not yet rated'
    : `Rated ${formatAverage(rating.average)} out of 5 from ${ratingsLabel(rating.count)}`;
}

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { dateStyle: 'medium' });
