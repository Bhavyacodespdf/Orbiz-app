import { useId, useState, type FormEvent } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { cn } from '@/lib/cn';
import { ApiError } from '@/services/http';
import {
  FEEDBACK_ASPECTS,
  useSaveReview,
  type FeedbackAspect,
  type FeedbackLevel,
  type OwnReview,
} from '@/services/reviews';
import { StarInput } from './Stars';
import { ASPECT_LABELS, BODY_MAX, LEVEL_LABELS } from './review-labels';

type Feedback = Record<FeedbackAspect, FeedbackLevel | null>;

function AspectPicker({
  aspect,
  value,
  onChange,
}: {
  aspect: FeedbackAspect;
  value: FeedbackLevel | null;
  onChange: (level: FeedbackLevel | null) => void;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-wrap items-center justify-between gap-2">
      <legend className="float-left text-sm font-semibold text-espresso-900">
        {ASPECT_LABELS[aspect]}
      </legend>
      <div className="flex gap-1.5">
        {(['POOR', 'OKAY', 'GREAT'] as const).map((level) => (
          <label
            key={level}
            className={cn(
              'cursor-pointer rounded-full border px-3 py-1 text-sm font-semibold transition-colors has-focus-visible:ring-2 has-focus-visible:ring-chili-500',
              value === level
                ? 'border-espresso-900 bg-espresso-900 text-cream-100'
                : 'border-espresso-200 bg-cream-50 text-espresso-700 hover:border-espresso-400',
            )}
          >
            <input
              type="radio"
              name={name}
              value={level}
              checked={value === level}
              // A second click on the chosen option clears it (feedback is optional).
              onClick={() => value === level && onChange(null)}
              onChange={() => onChange(level)}
              className="sr-only"
            />
            {LEVEL_LABELS[aspect][level]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Write or edit a review. The server checks eligibility; this only collects the review. */
export function ReviewFormDialog({
  open,
  onClose,
  itemId,
  itemName,
  existing,
}: {
  open: boolean;
  onClose: () => void;
  itemId: string;
  itemName: string;
  existing: OwnReview | null;
}) {
  const formId = useId();
  const bodyId = useId();
  const toast = useToast();
  const save = useSaveReview(itemId);
  const [rating, setRating] = useState<number | null>(existing?.rating ?? null);
  const [body, setBody] = useState(existing?.body ?? '');
  const [feedback, setFeedback] = useState<Feedback>(
    existing?.feedback ?? { taste: null, portion: null, freshness: null, value: null },
  );
  const [ratingError, setRatingError] = useState<string>();
  const [formError, setFormError] = useState<string>();

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(undefined);
    if (!rating) {
      setRatingError('Choose 1 to 5 stars.');
      return;
    }
    if (body.length > BODY_MAX) {
      setFormError(`Keep your review under ${BODY_MAX} characters.`);
      return;
    }
    save.mutate(
      {
        reviewId: existing?.id ?? null,
        input: { rating, body: body.trim() === '' ? null : body.trim(), ...feedback },
      },
      {
        onSuccess: () => {
          toast.show({
            tone: 'success',
            title: existing ? 'Review updated' : 'Thanks for your review',
          });
          onClose();
        },
        onError: (error) =>
          setFormError(
            error instanceof ApiError && error.code === 'VALIDATION_ERROR'
              ? 'Please check your rating and review.'
              : describeError(error),
          ),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={existing ? 'Edit your review' : 'Rate this dish'}
      description={itemName}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={save.isPending}>
            {existing ? 'Save changes' : 'Submit review'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <StarInput
          value={rating}
          onChange={(stars) => {
            setRating(stars);
            setRatingError(undefined);
          }}
          error={ratingError}
        />

        <div className="flex flex-col gap-3">
          <p className="text-sm font-semibold text-espresso-900">
            How was it? <span className="font-normal text-espresso-500">(optional)</span>
          </p>
          {FEEDBACK_ASPECTS.map((aspect) => (
            <AspectPicker
              key={aspect}
              aspect={aspect}
              value={feedback[aspect]}
              onChange={(level) => setFeedback((f) => ({ ...f, [aspect]: level }))}
            />
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={bodyId} className="text-sm font-semibold text-espresso-900">
            Your review <span className="font-normal text-espresso-500">(optional)</span>
          </label>
          <textarea
            id={bodyId}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            maxLength={BODY_MAX}
            aria-describedby={`${bodyId}-count`}
            placeholder="What did you like? What could be better?"
            className="rounded-(--radius-control) border border-espresso-200 bg-cream-50 px-3 py-2 text-espresso-900 placeholder:text-espresso-500 focus:border-chili-500 focus:ring-2 focus:ring-chili-100 focus:outline-none"
          />
          <p id={`${bodyId}-count`} className="text-right text-xs text-espresso-500">
            {body.length}/{BODY_MAX}
          </p>
        </div>

        {formError && (
          <p
            role="alert"
            className="rounded-(--radius-control) bg-chili-50 p-3 text-sm text-chili-700"
          >
            {formError}
          </p>
        )}
      </form>
    </Dialog>
  );
}
