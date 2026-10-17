import { useState } from 'react';
import { CalendarPlus, Clock, Sparkles, Trophy, Vote } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { useToast } from '@/components/feedback/toast-context';
import { describeError } from '@/lib/errors';
import { cn } from '@/lib/cn';
import { useStaffMenu, type StaffOutlet } from '@/services/staff';
import {
  useCreatePoll,
  useDeletePoll,
  useManagerPolls,
  usePollAction,
  useUpdatePoll,
  type ManagerPoll,
  type PollAction,
} from '@/services/polls';
import { StaffGate } from '@/features/staff/StaffGate';
import { OutletPicker } from '@/features/staff/OutletPicker';
import { DishThumb } from '@/features/specials/DishThumb';
import { formatDay, formatWhen, outcomeSummary, votesLabel } from '@/features/specials/poll-format';
import { PollEditorDialog } from './PollEditorDialog';

function statusBadge(poll: ManagerPoll): { label: string; tone: BadgeTone } {
  switch (poll.phase) {
    case 'DRAFT':
      return { label: 'Draft', tone: 'neutral' };
    case 'UPCOMING':
      return { label: 'Scheduled', tone: 'dark' };
    case 'VOTING':
      return { label: 'Voting open', tone: 'success' };
    case 'CLOSED':
      return poll.tiedOptionIds
        ? { label: 'Tie — needs your choice', tone: 'chili' }
        : { label: 'Voting closed', tone: 'neutral' };
    case 'FINALIZED':
      return { label: 'Finalized', tone: 'mustard' };
  }
}

type ConfirmKind = 'open' | 'close' | 'delete' | 'finalize' | 'settle';

type Confirm = { kind: ConfirmKind; poll: ManagerPoll; tieBreakOptionId?: string } | null;

const CONFIRM_TEXT = {
  open: {
    title: 'Open voting?',
    body: 'Students will be able to vote during the scheduled window. Once open, the dishes and times can’t be changed.',
    label: 'Open voting',
  },
  close: {
    title: 'Close voting now?',
    body: 'No more votes will be accepted. The result is then worked out from the votes cast so far.',
    label: 'Close voting',
  },
  delete: {
    title: 'Delete this draft?',
    body: 'The draft poll will be removed. Students never saw it.',
    label: 'Delete draft',
  },
  settle: {
    title: 'Work out the result?',
    body: 'The winner is calculated from the votes cast. If nobody voted, there is no special for this day.',
    label: 'Finalize result',
  },
  finalize: {
    title: 'Make this dish the special?',
    body: 'This resolves the tie. Students will see that the outlet manager chose between the tied dishes. It can’t be changed afterwards.',
    label: 'Confirm special',
  },
} as const;

function SpecialsManager({
  current,
  outlets,
  select,
}: {
  current: StaffOutlet;
  outlets: StaffOutlet[];
  select: (id: string) => void;
}) {
  const outletId = current.outlet.id;
  const toast = useToast();
  const polls = useManagerPolls(outletId);
  const menu = useStaffMenu(outletId);
  const create = useCreatePoll(outletId);
  const update = useUpdatePoll(outletId);
  const remove = useDeletePoll(outletId);
  const action = usePollAction(outletId);

  const [editor, setEditor] = useState<{ poll: ManagerPoll | null } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const saving = create.isPending || update.isPending;

  const failed = (title: string) => (error: unknown) =>
    toast.show({ tone: 'error', title, description: describeError(error) });

  function openEditor(poll: ManagerPoll | null) {
    create.reset();
    update.reset();
    setEditor({ poll });
  }

  function runConfirmed() {
    if (!confirm) return;
    const { kind, poll } = confirm;
    const done = () => setConfirm(null);
    if (kind === 'delete') {
      remove.mutate(poll.id, {
        onSuccess: () => {
          done();
          toast.show({ tone: 'success', title: 'Draft deleted' });
        },
        onError: failed('Couldn’t delete the draft'),
      });
      return;
    }
    const request: PollAction =
      kind === 'finalize' || kind === 'settle'
        ? { action: 'finalize', tieBreakOptionId: confirm.tieBreakOptionId }
        : { action: kind };
    action.mutate(
      { pollId: poll.id, ...request },
      {
        onSuccess: (updated) => {
          done();
          toast.show({
            tone: 'success',
            title:
              kind === 'open'
                ? 'Voting is open'
                : kind === 'close'
                  ? updated.result
                    ? 'Voting closed and the result is in'
                    : 'Voting closed'
                  : updated.result?.outcome === 'NO_VOTES'
                    ? 'Finalized: no votes, so no special'
                    : 'Today’s Special confirmed',
          });
        },
        onError: (error) => {
          done();
          failed('That didn’t work')(error);
        },
      },
    );
  }

  const text = confirm ? CONFIRM_TEXT[confirm.kind] : null;

  return (
    <>
      <PageHeader
        eyebrow="Kitchen"
        title="Today’s Special"
        description="Students vote between dishes you choose. The dish with the most votes becomes the special for that day."
        actions={
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <OutletPicker outlets={outlets} selectedId={outletId} onSelect={select} />
            <Button
              icon={<CalendarPlus className="size-4" aria-hidden />}
              onClick={() => openEditor(null)}
            >
              New poll
            </Button>
          </div>
        }
      />

      {polls.isPending ? (
        <div className="flex flex-col gap-4" aria-busy>
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : polls.error ? (
        <ErrorState
          title="Couldn’t load polls"
          error={polls.error}
          onRetry={() => void polls.refetch()}
          retrying={polls.isFetching}
        />
      ) : polls.data.polls.length === 0 ? (
        <EmptyState
          icon={<Vote aria-hidden />}
          title="No polls yet"
          description="Create a poll to let students choose a Today’s Special. Without a poll, the outlet simply has no special that day."
          action={<Button onClick={() => openEditor(null)}>Create a poll</Button>}
        />
      ) : (
        <ul className="flex flex-col gap-4" aria-label="Polls">
          {polls.data.polls.map((poll) => (
            <PollCard
              key={poll.id}
              poll={poll}
              onEdit={() => openEditor(poll)}
              onConfirm={(kind, tieBreakOptionId) => setConfirm({ kind, poll, tieBreakOptionId })}
            />
          ))}
          {polls.data.nextBefore && (
            <li className="text-sm text-espresso-500">Showing the 30 most recent polls.</li>
          )}
        </ul>
      )}

      <PollEditorDialog
        open={editor !== null}
        poll={editor?.poll ?? null}
        menu={menu.data}
        saving={saving}
        error={create.error ?? update.error}
        onClose={() => setEditor(null)}
        onSave={(input) => {
          const onSuccess = () => {
            setEditor(null);
            toast.show({
              tone: 'success',
              title: editor?.poll ? 'Draft saved' : 'Draft poll created',
              description: 'Check the dishes, then open voting when you’re ready.',
            });
          };
          if (editor?.poll) update.mutate({ pollId: editor.poll.id, input }, { onSuccess });
          else create.mutate(input, { onSuccess });
        }}
      />

      <ConfirmDialog
        open={confirm !== null}
        title={text?.title ?? ''}
        description={text?.body ?? ''}
        confirmLabel={text?.label ?? ''}
        destructive={confirm?.kind === 'delete' || confirm?.kind === 'close'}
        loading={action.isPending || remove.isPending}
        onConfirm={runConfirmed}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}

function PollCard({
  poll,
  onEdit,
  onConfirm,
}: {
  poll: ManagerPoll;
  onEdit: () => void;
  onConfirm: (kind: ConfirmKind, tieBreakOptionId?: string) => void;
}) {
  const badge = statusBadge(poll);
  const now = Date.parse(poll.serverNow);
  const [tieChoice, setTieChoice] = useState<string | null>(null);
  const tied = poll.tiedOptionIds ?? [];
  const winnerId = poll.result?.winnerOptionId ?? null;
  const headingId = `poll-${poll.id}`;

  return (
    <li>
      <Panel className="p-4 sm:p-5" role="region" aria-labelledby={headingId}>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id={headingId} className="text-lg font-bold">
              Special for {formatDay(poll.day)}
            </h2>
            <p className="flex items-center gap-1.5 text-sm text-espresso-500">
              <Clock className="size-4" aria-hidden />
              Voting {formatWhen(poll.opensAt, now)} – {formatWhen(poll.closesAt, now)} IST
              {poll.showLiveResults && ' · live counts shown to students'}
            </p>
          </div>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>

        {poll.result && (
          <p
            className={cn(
              'mb-3 flex items-center gap-2 rounded-(--radius-control) px-3 py-2 text-sm',
              poll.result.outcome === 'NO_VOTES'
                ? 'bg-espresso-50 text-espresso-700'
                : 'bg-mustard-50 text-mustard-800',
            )}
          >
            {poll.result.outcome === 'NO_VOTES' ? (
              'Nobody voted, so there is no special for this day.'
            ) : (
              <>
                <Sparkles className="size-4 shrink-0" aria-hidden />
                <span>
                  <strong>{poll.options.find((o) => o.id === winnerId)?.dish.name}</strong> is the
                  special.{' '}
                  {outcomeSummary(
                    poll.result.outcome,
                    poll.result.winnerVotes ?? 0,
                    poll.result.totalVotes,
                    poll.result.winnerPercentage ?? 0,
                  )}
                  .
                </span>
              </>
            )}
          </p>
        )}

        {tied.length > 0 && (
          <p
            role="status"
            className="mb-3 rounded-(--radius-control) bg-chili-50 px-3 py-2 text-sm text-chili-700"
          >
            {tied.length} dishes tied for the most votes. Choose which one becomes the special.
            Students will be told the outlet manager chose between the tied dishes.
          </p>
        )}

        <ul className="flex flex-col gap-2" aria-label="Dishes and votes">
          {poll.options.map((option) => {
            const isTied = tied.includes(option.id);
            return (
              <li
                key={option.id}
                className={cn(
                  'flex items-center gap-3 rounded-(--radius-control) border px-3 py-2',
                  option.id === winnerId
                    ? 'border-mustard-300 bg-mustard-50'
                    : 'border-espresso-100',
                )}
              >
                {isTied && (
                  <input
                    type="radio"
                    name={`tie-${poll.id}`}
                    aria-label={`Choose ${option.dish.name}`}
                    className="accent-chili-500"
                    checked={tieChoice === option.id}
                    onChange={() => setTieChoice(option.id)}
                  />
                )}
                <DishThumb imageUrl={option.dish.imageUrl} className="size-10" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-semibold">
                    <span className="truncate">{option.dish.name}</span>
                    {option.id === winnerId && (
                      <Trophy className="size-4 shrink-0 text-mustard-600" aria-label="Winner" />
                    )}
                  </p>
                  <div
                    className="mt-1 h-1.5 overflow-hidden rounded-full bg-espresso-100"
                    aria-hidden
                  >
                    <div
                      className="h-full rounded-full bg-espresso-400"
                      style={{ width: `${option.percentage}%` }}
                    />
                  </div>
                  {!option.counted && (
                    <p className="text-xs text-espresso-500">
                      Withdrawn from the menu — its votes can’t win.
                    </p>
                  )}
                  {option.counted && !option.votable && poll.phase !== 'FINALIZED' && (
                    <p className="text-xs text-espresso-500">
                      Sold out — students can’t vote for it now.
                    </p>
                  )}
                </div>
                <span className="tabular shrink-0 text-right text-sm">
                  <span className="block font-semibold">{votesLabel(option.votes)}</span>
                  <span className="text-espresso-500">{option.percentage}%</span>
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-sm text-espresso-500">{votesLabel(poll.votesCast)} cast.</p>

        <div className="mt-4 flex flex-wrap gap-2">
          {poll.status === 'DRAFT' && (
            <>
              <Button onClick={() => onConfirm('open')}>Open voting</Button>
              <Button variant="secondary" onClick={onEdit}>
                Edit
              </Button>
              <Button variant="ghost" onClick={() => onConfirm('delete')}>
                Delete draft
              </Button>
            </>
          )}
          {poll.status === 'OPEN' && (
            <Button variant="danger" onClick={() => onConfirm('close')}>
              Close voting now
            </Button>
          )}
          {poll.status === 'CLOSED' && tied.length > 0 && (
            <Button
              disabled={!tieChoice}
              onClick={() => onConfirm('finalize', tieChoice ?? undefined)}
            >
              Make chosen dish the special
            </Button>
          )}
          {poll.status === 'CLOSED' && tied.length === 0 && (
            <Button onClick={() => onConfirm('settle')}>Finalize result</Button>
          )}
        </div>
      </Panel>
    </li>
  );
}

export function ManagerSpecialsPage() {
  return (
    <StaffGate role="MANAGER">
      {(ctx) => <SpecialsManager key={ctx.current.outlet.id} {...ctx} />}
    </StaffGate>
  );
}
