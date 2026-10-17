import { useCallback, useEffect } from 'react';
import { useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CircleCheck, Clock, Trophy, Vote } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { Price } from '@/components/ui/Price';
import { DietaryMark } from '@/components/ui/DietaryMark';
import { Skeleton } from '@/components/feedback/Skeleton';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { cn } from '@/lib/cn';
import { useCurrentUser } from '@/services/auth';
import {
  outletPollKey,
  specialsKey,
  useOutletPoll,
  useVote,
  type StudentPoll,
  type StudentPollOption,
} from '@/services/polls';
import { DishThumb } from './DishThumb';
import { formatRemaining, formatWhen, specialDayLabel, votesLabel } from './poll-format';
import { useServerClock } from './useServerClock';

/**
 * The outlet's Today's Special vote. Everything shown — phase, counts, winner — comes
 * from the server; the vote button only asks the server to record a choice.
 */
export function PollPanel({ slug }: { slug: string }) {
  const location = useLocation();
  const user = useCurrentUser();
  const signedIn = Boolean(user.data);
  const poll = useOutletPoll(slug, signedIn);

  if (user.isPending) return null;

  if (!signedIn) {
    return (
      <Panel className="mb-6 flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center">
        <Vote className="size-6 shrink-0 text-mustard-600" aria-hidden />
        <p className="flex-1 text-espresso-700">
          Students pick each outlet’s Today’s Special by vote. Sign in to see whether a vote is open
          here.
        </p>
        <ButtonLink
          to={`/login?returnTo=${encodeURIComponent(location.pathname)}`}
          variant="secondary"
          size="sm"
        >
          Sign in to vote
        </ButtonLink>
      </Panel>
    );
  }

  if (poll.isPending) return <Skeleton className="mb-6 h-48 w-full rounded-(--radius-panel)" />;

  if (poll.error) {
    return (
      <ErrorState
        className="mb-6"
        title="Couldn’t load the Today’s Special vote"
        error={poll.error}
        onRetry={() => void poll.refetch()}
        retrying={poll.isFetching}
      />
    );
  }

  if (!poll.data) {
    return (
      <p className="mb-6 flex items-center gap-2 text-sm text-espresso-500">
        <Vote className="size-4" aria-hidden />
        No Today’s Special vote is running at this outlet right now.
      </p>
    );
  }

  return <PollBody slug={slug} poll={poll.data} />;
}

function PollBody({ slug, poll }: { slug: string; poll: StudentPoll }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const vote = useVote(slug);
  const now = useServerClock(poll.serverNow);

  // When the window opens or closes, re-read: the server decides what happens next.
  const boundary = poll.phase === 'UPCOMING' ? poll.opensAt : poll.closesAt;
  const live = poll.phase === 'UPCOMING' || poll.phase === 'VOTING';
  const crossed = live && now >= Date.parse(boundary);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: outletPollKey(slug) });
    void queryClient.invalidateQueries({ queryKey: specialsKey });
  }, [queryClient, slug]);
  useEffect(() => {
    if (crossed) refresh();
  }, [crossed, refresh]);

  const voting = poll.phase === 'VOTING' && !crossed;
  const mine = poll.options.find((o) => o.id === poll.myOptionId);
  const winnerId = poll.result?.winnerOptionId ?? null;

  function castVote(option: StudentPollOption) {
    vote.mutate(
      { pollId: poll.id, optionId: option.id },
      {
        onSuccess: () =>
          toast.show({
            tone: 'success',
            title: 'Vote saved',
            description: `You voted for ${option.dish.name}.`,
          }),
        onError: (error) =>
          toast.show({
            tone: 'error',
            title: 'Your vote wasn’t saved',
            description: describeError(error),
          }),
      },
    );
  }

  return (
    <Panel className="mb-6 p-4 sm:p-5" role="region" aria-labelledby="poll-heading">
      <div className="mb-4 flex flex-col gap-1">
        <p className="text-xs font-bold tracking-[0.14em] text-mustard-700 uppercase">
          Student vote
        </p>
        <h2 id="poll-heading" className="text-xl font-extrabold">
          {poll.phase === 'FINALIZED'
            ? `Results: ${specialDayLabel(poll.day, now)} special`
            : `Vote for ${specialDayLabel(poll.day, now)} special`}
        </h2>
        <PhaseLine poll={poll} now={now} voting={voting} />
      </div>

      {mine && (
        <p
          role="status"
          className="mb-4 flex items-start gap-2 rounded-(--radius-control) bg-success-50 px-3 py-2 text-sm text-success-600"
        >
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            Your vote: <strong>{mine.dish.name}</strong>.
            {voting && ' You can change it until voting closes.'}
          </span>
        </p>
      )}

      {poll.result?.outcome === 'NO_VOTES' && (
        <p role="status" className="mb-4 text-sm text-espresso-700">
          Nobody voted, so this poll has no winner and there’s no special from it.
        </p>
      )}

      <ul className="grid gap-3 sm:grid-cols-2" aria-label="Dishes in this vote">
        {poll.options.map((option) => (
          <OptionCard
            key={option.id}
            option={option}
            isMine={option.id === poll.myOptionId}
            isWinner={option.id === winnerId}
            voting={voting}
            busy={vote.isPending}
            loading={vote.isPending && vote.variables?.optionId === option.id}
            onVote={() => castVote(option)}
          />
        ))}
      </ul>

      {poll.resultsVisible && poll.votesCast !== null && (
        <p className="mt-3 text-sm text-espresso-500">{votesLabel(poll.votesCast)} cast so far.</p>
      )}
      {voting && !poll.resultsVisible && (
        <p className="mt-3 text-sm text-espresso-500">
          Vote counts are revealed when voting closes.
        </p>
      )}
    </Panel>
  );
}

function PhaseLine({ poll, now, voting }: { poll: StudentPoll; now: number; voting: boolean }) {
  let text: string;
  if (poll.phase === 'UPCOMING' && now < Date.parse(poll.opensAt)) {
    text = `Voting opens ${formatWhen(poll.opensAt, now)}.`;
  } else if (voting) {
    const remaining = Date.parse(poll.closesAt) - now;
    text = `Voting closes in ${formatRemaining(remaining)} (${formatWhen(poll.closesAt, now)}).`;
  } else if (poll.phase === 'FINALIZED') {
    text =
      poll.result?.outcome === 'TIE_RESOLVED_BY_MANAGER'
        ? 'Voting has closed. The top dishes tied, so the outlet manager chose between them.'
        : 'Voting has closed.';
  } else {
    text = 'Voting has closed. Waiting for the outlet to confirm the result.';
  }
  return (
    <p className="flex items-center gap-1.5 text-sm text-espresso-700">
      <Clock className="size-4 shrink-0" aria-hidden />
      {text}
    </p>
  );
}

function OptionCard({
  option,
  isMine,
  isWinner,
  voting,
  busy,
  loading,
  onVote,
}: {
  option: StudentPollOption;
  isMine: boolean;
  isWinner: boolean;
  voting: boolean;
  busy: boolean;
  loading: boolean;
  onVote: () => void;
}) {
  const { dish } = option;
  return (
    <li
      className={cn(
        'flex flex-col gap-3 rounded-(--radius-control) border p-3',
        isWinner
          ? 'border-mustard-300 bg-mustard-50'
          : isMine
            ? 'border-success-600/40 bg-success-50/60'
            : 'border-espresso-100 bg-cream-100',
      )}
    >
      <div className="flex gap-3">
        <DishThumb imageUrl={dish.imageUrl} className="size-16" />
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-1.5 font-sans text-base font-semibold">
            {dish.dietary && <DietaryMark dietary={dish.dietary} />}
            <span className="truncate">{dish.name}</span>
          </h3>
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-espresso-500">
            <Price paise={dish.pricePaise} className="text-espresso-900" />
            <span>{dish.category.name}</span>
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {isWinner && (
              <Badge tone="mustard" icon={<Trophy className="size-3.5" aria-hidden />}>
                Today’s Special
              </Badge>
            )}
            {!option.votable && <Badge tone="neutral">Not available</Badge>}
          </div>
        </div>
      </div>

      {option.votes !== null && option.percentage !== null && (
        <div>
          <div className="mb-1 flex justify-between text-sm">
            <span className="font-semibold text-espresso-900">{votesLabel(option.votes)}</span>
            <span className="tabular text-espresso-700">{option.percentage}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-espresso-100" aria-hidden>
            <div
              className={cn('h-full rounded-full', isWinner ? 'bg-mustard-500' : 'bg-espresso-400')}
              style={{ width: `${option.percentage}%` }}
            />
          </div>
        </div>
      )}

      {voting &&
        (isMine ? (
          <p className="flex h-9 items-center justify-center gap-1.5 rounded-(--radius-control) border border-success-600/40 bg-cream-50 text-sm font-semibold text-success-600">
            <Check className="size-4" aria-hidden />
            Your vote
          </p>
        ) : (
          <Button
            size="sm"
            aria-label={`Vote for ${dish.name}`}
            onClick={onVote}
            disabled={busy || !option.votable}
            loading={loading}
          >
            {option.votable ? 'Vote' : 'Unavailable'}
          </Button>
        ))}
    </li>
  );
}
