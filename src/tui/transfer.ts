// The transfer screen: pick a source (an account or the unlisted transcripts),
// a target account, the conversations (all of them, all but some, or some),
// answer one question per conversation the target already holds, review a
// dry-run plan and apply it. Planning looks at the SSH hosts of the
// conversations that run on one (read only, see ssh-host.ts), so it can take
// a few seconds per host conversation. The tool copies only: the "Operation"
// choice (Copy or Move) went on 2026-10-07 with the move path (operations.ts).
//
// Two questions stop at one conversation, both asked through ./decide.ts so
// an answer can reach the rest of the batch:
//   - the pair question before the plan, for every conversation whose linked
//     copy the target already holds. It says whether the two are the same or
//     different and which one is longer (pairKindOf, describePair), and the
//     answers depend on that kind: skip, keep or copy for an identical pair,
//     copy or skip where the source is longer, skip or overwrite where the
//     target is longer or the two diverged. Until 2026-10-07 only the last
//     two kinds were asked about; identical pairs were silently "up to date"
//     (each SSH one costing a host probe for the repair of old copies) and
//     a copy that was behind was updated without a question. The operator
//     asked to see every pair and to answer once or for all of its kind.
//   - the failure question during the run, after a conversation failed or
//     was refused while others are still to come.
// Besides the answer for that one conversation, both offer the same answer
// for every conversation left (of the same kind, for the pair question) and
// calling the transfer off, each confirmed after a note on what exactly
// happens. Calling the transfer off before the plan discards the choices
// made (nothing is written before "Apply N operations?"); during the run it
// undoes what the run did so far (batch.ts). Asked for by the operator on
// 2026-10-06, when a sync of 632 conversations stopped at its first
// "target is newer" question.
//
// Every spinner message, question and result line carries the position of
// the conversation in the run ("3/31", "[3/31]"), so a long run says how far
// it got (cli.ts, Position; asked for by the operator on 2026-10-07).
import * as p from '@clack/prompts';
import { accountKey, accountLabel, type AccountInfo } from '../accounts.ts';
import { describeBatchUndo, journalIdsOf, undoBatch, type BatchUndoResult } from '../batch.ts';
import { describeOutcome, positionPrefix, type Position } from '../cli.ts';
import { describeComparison, describeFlags, describeOrigin, describeState, formatSize, formatWhen, shortenPath, truncate } from '../format.ts';
import { assessSync, conversationsOf, type Conversation, type SyncAssessment } from '../inventory.ts';
import { executeTransfer, type ExistingPolicy, type OperationContext, type OutcomeAction, type TransferItem, type TransferOutcome } from '../operations.ts';
import type { TuiContext } from './context.ts';
import { decide, indented, tally, type Answer } from './decide.ts';
import { settleInterruptedInTui } from './interrupted.ts';

const UNLISTED = 'none';

/** The outcomes that changed files on the target: after them the app has something new to show. */
const WRITE_ACTIONS = new Set<OutcomeAction>(['created', 'updated', 'repaired']);

function accountOption(account: AccountInfo): { value: string; label: string; hint: string } {
  const bits = [account.email ?? 'e-mail unknown', `${account.sessionCount} session${account.sessionCount === 1 ? '' : 's'}`];
  if (account.orgName) bits.push(account.orgName);
  if (account.loggedIn) bits.push('logged in');
  return { value: accountKey(account.accountId, account.orgId), label: accountLabel(account), hint: bits.join(' | ') };
}

/**
 * The hint column of the picker: the state against the target with the
 * comparison behind it when there is one ("update available (target lacks
 * 3 lines)"), so the list already shows which pairs are the same and which
 * side is longer; then the origin, the project, the date and the size.
 */
function conversationHint(conversation: Conversation, assessment: SyncAssessment, accounts: readonly AccountInfo[]): string {
  const comparison = describeComparison(assessment);
  const bits = [
    comparison ? `${describeState(assessment.state)} (${comparison})` : describeState(assessment.state),
    describeOrigin(conversation, accounts),
    shortenPath(conversation.cwd, 28),
    formatWhen(conversation.lastActivityAt),
    formatSize(conversation.sizeBytes),
  ];
  const flags = describeFlags(conversation);
  if (flags) bits.push(flags);
  return bits.join(' | ');
}

/** The result lines of the Plan and Result boxes, each with its position out of `total` (the whole run, also when it stopped early). */
function outcomeLines(outcomes: readonly TransferOutcome[], total: number): string {
  return outcomes
    .flatMap((outcome, index) => [describeOutcome(outcome, { index: index + 1, total }), ...outcome.warnings.map((warning) => `  warning: ${warning}`)])
    .join('\n');
}

/** "3 conversations", "1 operation": a count with its noun. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * How the conversations of a transfer are chosen (asked on the operator's
 * request of 2026-09-28, so acting on a whole list takes one choice instead
 * of selecting every entry):
 *   all      every conversation of the source, nothing to pick
 *   all-but  every conversation except the ones picked (like --all --exclude)
 *   pick     only the ones picked (like --session)
 * The picker types to filter, so it cannot offer a "select all" key of its
 * own: every letter goes into the filter.
 */
export type SelectionScope = 'all' | 'all-but' | 'pick';

/** The entries a scope and the indexes picked in the list stand for, in list order. */
export function applySelection<T>(entries: readonly T[], scope: SelectionScope, picked: readonly number[]): T[] {
  if (scope === 'all') return [...entries];
  const chosen = new Set(picked);
  return entries.filter((_, index) => (scope === 'pick' ? chosen.has(index) : !chosen.has(index)));
}

/** "3 new, 28 up to date": how many conversations are in which state, for the scope question. */
function stateCounts(assessments: readonly SyncAssessment[]): string {
  const counts = new Map<string, number>();
  for (const assessment of assessments) {
    const label = describeState(assessment.state);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${count} ${label}`).join(', ');
}

/** A chosen conversation with its state against the target, as the screen carries it from the picker to the plan. */
export interface Assessed {
  conversation: Conversation;
  assessment: SyncAssessment;
}

/**
 * The four kinds of pair the transfer asks about, from the state assessSync
 * (inventory.ts) gives a conversation whose linked copy the target holds:
 *   same           the two transcripts are identical (state up-to-date)
 *   source-longer  the copy is behind the source, or has no transcript (update-available)
 *   target-longer  the copy went further than the source (target-ahead)
 *   diverged       both went on after the copy was made (diverged)
 * The "all" answers reach only the pairs of the same kind, so skipping every
 * identical pair leaves the ones where the source is longer still asked
 * about. The other states (new, no-transcript, unrelated, ambiguous) are not
 * asked about: there is nothing to compare, or the copy is never touched.
 */
export type PairKind = 'same' | 'source-longer' | 'target-longer' | 'diverged';

/** The kind of pair a selected conversation makes with its copy on the target, or null when the transfer does not ask about it. */
export function pairKindOf(entry: Assessed): PairKind | null {
  switch (entry.assessment.state) {
    case 'up-to-date':
      return 'same';
    case 'update-available':
      return 'source-longer';
    case 'target-ahead':
      return 'target-longer';
    case 'diverged':
      return 'diverged';
    default:
      return null;
  }
}

/** "12 lines", "1 line": a count of transcript lines (the lines with a uuid, which the comparison counts). */
function lines(count: number): string {
  return `${count} line${count === 1 ? '' : 's'}`;
}

/**
 * What the pair question says after the title: whether the two are the same
 * or different, and which one is longer, with the length of each side in
 * lines (the shared start plus what each side added, the numbers behind
 * describeComparison in format.ts). A copy without a transcript has no
 * comparison; its source's own line count is shown then.
 */
export function describePair(entry: Assessed): string {
  const comparison = entry.assessment.comparison;
  const kind = pairKindOf(entry);
  if (!comparison) {
    const sourceLines = entry.conversation.summary?.uuidChain.length ?? 0;
    return kind === 'source-longer' ? `differs: the target copy has no transcript (source ${lines(sourceLines)})` : describeState(entry.assessment.state);
  }
  const source = comparison.commonPrefix + comparison.sourceExtra;
  const target = comparison.commonPrefix + comparison.targetExtra;
  switch (kind) {
    case 'same':
      return `is the same on both accounts (${lines(source)} each)`;
    case 'source-longer':
      return `differs: the source is longer (source ${lines(source)}, target ${target})`;
    case 'target-longer':
      return `differs: the target is longer (source ${lines(source)}, target ${target})`;
    case 'diverged': {
      const longer = source > target ? 'the source is longer' : source < target ? 'the target is longer' : 'both the same length';
      return `differs: both went on after ${lines(comparison.commonPrefix)} shared (source ${lines(source)}, target ${target}; ${longer})`;
    }
    default:
      return describeState(entry.assessment.state);
  }
}

/** '[7/31] "title" is the same on both accounts (12 lines each). What to do?': the pair question with its position in the run. */
export function pairQuestion(at: Position, entry: Assessed): string {
  return `${positionPrefix(at)}"${truncate(entry.conversation.title, 60)}" ${describePair(entry)}. What to do?`;
}

/** '"title" differs: the source is longer (source 20 lines, target 12)': one pair as the notes list it. */
export function describeListedPair(entry: Assessed): string {
  return `"${truncate(entry.conversation.title, 60)}" ${describePair(entry)}`;
}

/**
 * The answers to the pair question. The single ones: skip (leave the copy
 * as it is, listed as skipped), keep (an identical pair only: up to date as
 * before, repairing an old copy) and overwrite (copy: the target copy is
 * brought up to date, or replaced by the source). Then the same for every
 * pair of the same kind left (this one and the ones after it), offered when
 * more than one is left; and calling the transfer off. The "all" answers and
 * cancel are confirmed after a note that lists the pairs involved, or says
 * that nothing has been written.
 */
export type PairAnswer = 'skip' | 'keep' | 'overwrite' | 'skip-all' | 'keep-all' | 'overwrite-all' | 'cancel';

/** A single answer of the pair question, as given and recapped in the notes. */
export type PairDecision = 'skip' | 'keep' | 'overwrite';

/** The policy executeTransfer gets for each single answer (operations.ts, ExistingPolicy). */
export const POLICY_OF: Readonly<Record<PairDecision, ExistingPolicy>> = { skip: 'skip', keep: 'sync', overwrite: 'overwrite' };

/** How many items a note lists before it says how many more there are. */
export const NOTE_LIST_LIMIT = 10;

/**
 * The lines of a note that lists items: the first NOTE_LIST_LIMIT, then one
 * line with the count of the rest. The conflict note and the undo note of
 * the failure question used to list every item in full; found while
 * extending the question to identical pairs on 2026-10-07, where a sync of
 * hundreds of conversations would have drawn a note box hundreds of lines
 * tall for "Skip all" (and for an undo after hundreds of copies).
 */
export function listed(items: readonly string[]): string {
  if (items.length <= NOTE_LIST_LIMIT) return indented(items);
  return indented([...items.slice(0, NOTE_LIST_LIMIT), `... and ${items.length - NOTE_LIST_LIMIT} more`]);
}

/** One single answer of the pair question with the words of its "all" counterpart. */
interface SingleAnswer {
  value: PairDecision;
  label: string;
  hint: string;
  all: { label: string; title: string; note: string; question: string };
}

/** The journal sentence every overwriting "all" note ends with. */
const UNDOABLE = 'The previous copy goes into backups, as a journal entry of its own that "Restore from journal" undoes.';

/**
 * The single answers of each kind, in the order they are offered: first the
 * one the operator asked for on 2026-10-07 (skip for an identical pair, copy
 * where the source is longer), so Enter alone takes it; for a newer or
 * diverged copy skip comes first, as before, since overwriting loses what
 * the target added.
 */
function singleAnswers(kind: PairKind, count: number): SingleAnswer[] {
  const skipAll = (where: string, note: string): SingleAnswer['all'] => ({
    label: `Skip all ${count} remaining ${where}`,
    title: 'Skip all',
    note,
    question: `Skip all ${count} remaining ${where}?`,
  });
  switch (kind) {
    case 'same':
      return [
        {
          value: 'skip',
          label: 'Skip this conversation',
          hint: 'nothing is done and the SSH host is not asked; the result lists it as skipped',
          all: skipAll('identical conversations', 'Skipped: nothing is done to any of them, and the result lists each as skipped.'),
        },
        {
          value: 'keep',
          label: 'Keep it as it is (up to date)',
          hint: 'as before: nothing is copied; a copy made before 2026-09-28 is repaired, which looks at the SSH host',
          all: {
            label: `Keep all ${count} remaining identical conversations`,
            title: 'Keep all',
            note:
              'Kept: nothing is copied and each copy is left as it is; one made before 2026-09-28 is repaired (Remote Control off, ' +
              'its transcript on the SSH host), as a journal entry of its own.',
            question: `Keep all ${count} remaining identical conversations?`,
          },
        },
        {
          value: 'overwrite',
          label: 'Copy anyway: overwrite the target copy',
          hint: 'the transcript is the same; the record is refreshed (title, archive state); the previous copy goes into backups',
          all: {
            label: `Copy all ${count} remaining identical conversations anyway`,
            title: 'Copy all anyway',
            note: `Overwritten: each target copy is written again from its source (the same transcript, the record refreshed). ${UNDOABLE}`,
            question: `Overwrite the target copies of all ${count} remaining identical conversations?`,
          },
        },
      ];
    case 'source-longer':
      return [
        {
          value: 'overwrite',
          label: 'Copy: bring the target copy up to date',
          hint: 'the target gets the lines it lacks; the previous copy goes into backups',
          all: {
            label: `Copy all ${count} remaining where the source is longer`,
            title: 'Copy all',
            note: `Updated: each target copy is brought up to date with its source. ${UNDOABLE}`,
            // Short enough not to wrap at 80 columns: clack wraps a confirm's
            // message, and a wrapped question is hard to read (and to match).
            question: `Copy all ${count} remaining where the source is longer?`,
          },
        },
        {
          value: 'skip',
          label: 'Skip this conversation',
          hint: 'the target copy stays behind; the result lists it as skipped',
          all: skipAll('where the source is longer', 'Skipped: each target copy stays behind its source, and the result lists it as skipped.'),
        },
      ];
    case 'target-longer':
      return [
        {
          value: 'skip',
          label: 'Skip this conversation',
          hint: 'leave the target copy as it is (it has more); the result lists it as skipped',
          all: skipAll('where the target is longer', 'Skipped: the target copy of each stays as it is, and the result lists it as skipped.'),
        },
        {
          value: 'overwrite',
          label: 'Overwrite the target copy',
          hint: 'replace it with the shorter source; the previous copy goes into backups',
          all: {
            label: `Overwrite all ${count} remaining where the target is longer`,
            title: 'Overwrite all',
            note: `Overwritten: each target copy is replaced by its shorter source. ${UNDOABLE}`,
            question: `Overwrite the target copies of all ${count} remaining where the target is longer?`,
          },
        },
      ];
    default:
      return [
        {
          value: 'skip',
          label: 'Skip this conversation',
          hint: 'leave the target copy as it is; the result lists it as skipped',
          all: skipAll('diverged conversations', 'Skipped: the target copy of each stays as it is, and the result lists it as skipped.'),
        },
        {
          value: 'overwrite',
          label: 'Overwrite the target copy',
          hint: 'replace it with the source; what the target added since they diverged goes into backups',
          all: {
            label: `Overwrite all ${count} remaining diverged conversations`,
            title: 'Overwrite all',
            note: `Overwritten: each target copy is replaced by its source. ${UNDOABLE}`,
            question: `Overwrite the target copies of all ${count} remaining diverged conversations?`,
          },
        },
      ];
  }
}

/**
 * Builds the answers for the pair question about `remaining[0]`, with the
 * other pairs of the same kind still to be asked about after it, and the
 * single answers already given to earlier pair questions of any kind (they
 * stay as given; the notes say so).
 */
export function pairAnswers(kind: PairKind, remaining: readonly Assessed[], decided: readonly PairDecision[]): Answer<PairAnswer>[] {
  const count = remaining.length;
  const list = listed(remaining.map(describeListedPair));
  const earlier = decided.length > 0 ? `\nThe ${plural(decided.length, 'answer')} given before (${tally(decided)}) stay as given.` : '';
  const singles = singleAnswers(kind, count);
  const answers: Answer<PairAnswer>[] = singles.map(({ value, label, hint }) => ({ value, label, hint }));
  if (count > 1) {
    const rest = `this one and the ${count - 1} after it; asks to confirm first`;
    for (const single of singles) {
      answers.push({
        value: `${single.value}-all`,
        label: single.all.label,
        hint: rest,
        confirm: { title: single.all.title, note: `${single.all.note}\n${list}${earlier}`, question: single.all.question },
      });
    }
  }
  const discarded = decided.length > 0 ? ` and the ${plural(decided.length, 'answer')} given so far (${tally(decided)})` : '';
  answers.push({
    value: 'cancel',
    label: 'Cancel the transfer',
    hint: 'nothing has been written; back to the menu after confirming',
    confirm: {
      title: 'Cancel the transfer',
      note:
        'Nothing has been written: these questions come before the plan, and files change only after ' +
        `"Apply ... operations?" is answered Yes.\nDiscarded: the choice of source, target and conversations${discarded}. Back to the menu.`,
      question: 'Cancel the transfer?',
    },
  });
  return answers;
}

/**
 * The answers to the failure question, asked during the run after a
 * conversation failed or was refused while others are still to come: go on
 * with the next one, go on without asking again (later failures only show
 * in the result), stop here keeping what was done, or call the transfer off
 * and undo what it did so far.
 */
export type FailureAnswer = 'skip' | 'continue' | 'stop' | 'cancel';

/** Whether an outcome stops the run to ask: the operation failed, or the guard refused it (Claude Code appeared). */
export function isFailure(outcome: TransferOutcome): boolean {
  return outcome.action === 'failed' || outcome.action === 'refused';
}

/**
 * Builds the answers for the failure question about `outcome`, the last of
 * `done` (the outcomes of the run so far), with `left` conversations still
 * to come and `undoLines` (describeBatchUndo) naming what calling the
 * transfer off would undo, newest first; with nothing to undo the last
 * answer only stops. After a refusal the hints say that Claude Code has to
 * be quit first, since the guard is asked again before every conversation.
 */
export function failureAnswers(outcome: TransferOutcome, done: readonly TransferOutcome[], left: number, undoLines: readonly string[]): Answer<FailureAnswer>[] {
  const written = done.filter((candidate) => WRITE_ACTIONS.has(candidate.action)).length;
  const leftText = plural(left, 'conversation');
  const afterRefusal = outcome.action === 'refused' ? '; the guard is asked again before each one, so quit Claude Code first' : '';
  const undoable = undoLines.length > 0;
  return [
    { value: 'skip', label: 'Skip it and continue', hint: `go on with the ${leftText} left${afterRefusal}` },
    {
      value: 'continue',
      label: 'Continue without asking again',
      hint: `later failures or refusals no longer stop the run${afterRefusal}; asks to confirm first`,
      confirm: {
        title: 'Continue without asking',
        note:
          `The ${leftText} left are transferred one after another. A failure or a refusal no longer stops the run: ` +
          'it is reported in the Result box, and the conversations after it are still attempted. What was done so far stays.',
        question: 'Continue without asking again?',
      },
    },
    { value: 'stop', label: 'Stop here', hint: `keep the ${plural(written, 'operation')} done; the ${leftText} left are not attempted` },
    {
      value: 'cancel',
      label: undoable ? 'Cancel the transfer and undo what it did' : 'Cancel the transfer',
      hint: undoable ? `undo the ${plural(undoLines.length, 'operation')} done, newest first; asks to confirm first` : 'nothing has been written; asks to confirm first',
      confirm: {
        title: 'Cancel the transfer',
        note: undoable
          ? `Undone, newest first; each undo is a journal entry of its own:\n${listed(undoLines)}\nNot attempted: the ${leftText} left.\n` +
            'Claude Code must still be closed: an undo it refuses, and the ones after it, stay listed in "Restore from journal".'
          : `Nothing to undo: no operation of this transfer wrote anything.\nNot attempted: the ${leftText} left.`,
        question: undoable ? `Undo ${plural(undoLines.length, 'operation')} and stop the transfer?` : 'Stop the transfer?',
      },
    },
  ];
}

/**
 * Asks the pair question about every selected conversation whose copy the
 * target holds, in list order, and gives each item its policy
 * (ExistingPolicy). An "all" answer settles every later pair of the same
 * kind without a question. Returns null when the person called the transfer
 * off (confirmed) or cancelled the question (Ctrl+C or Escape): nothing has
 * been written at this point, so there is nothing to undo.
 */
async function decidePairs(selected: readonly Assessed[], target: AccountInfo): Promise<TransferItem[] | null> {
  const items: TransferItem[] = [];
  const decided: PairDecision[] = [];
  const forAll = new Map<PairKind, ExistingPolicy>();
  for (const [index, entry] of selected.entries()) {
    const kind = pairKindOf(entry);
    const settled = kind === null ? undefined : forAll.get(kind);
    let onExisting: ExistingPolicy = 'sync';
    if (kind !== null && settled !== undefined) {
      onExisting = settled;
    } else if (kind !== null) {
      // The warnings of the pairs answered for all at once are not lost:
      // every outcome carries its assessment's warnings into the plan.
      for (const warning of entry.assessment.warnings) p.log.warn(warning);
      const remaining = selected.slice(index).filter((candidate) => pairKindOf(candidate) === kind);
      const answer = await decide(pairQuestion({ index: index + 1, total: selected.length }, entry), pairAnswers(kind, remaining, decided));
      if (answer === null) return null;
      if (answer === 'cancel') {
        p.log.info('Transfer cancelled: nothing was changed.');
        return null;
      }
      const single: PairDecision = answer === 'skip-all' ? 'skip' : answer === 'keep-all' ? 'keep' : answer === 'overwrite-all' ? 'overwrite' : answer;
      onExisting = POLICY_OF[single];
      if (answer !== single) forAll.set(kind, onExisting);
      decided.push(single);
    }
    items.push({ source: entry.conversation, target, assessment: entry.assessment, onExisting });
  }
  return items;
}

/** How the run ended: the outcomes so far, how many conversations were not attempted, and the undo when the transfer was called off. */
interface RunResult {
  outcomes: TransferOutcome[];
  notAttempted: number;
  undo: BatchUndoResult | null;
}

/**
 * Undoes what the run did so far (batch.ts) under a spinner and reports it:
 * one line per entry undone or not, the warnings of the restores, and the
 * guard's refusal with the entries it left for "Restore from journal".
 */
async function undoRun(live: OperationContext, outcomes: readonly TransferOutcome[]): Promise<BatchUndoResult> {
  const spinner = p.spinner();
  spinner.start('Undoing');
  const result = await undoBatch(live, journalIdsOf(outcomes));
  spinner.stop(result.refused ? 'Undo stopped' : 'Undone');
  const lines = [
    ...result.undone.map(
      (restore) =>
        `undone ${restore.entry.action} "${truncate(restore.entry.title, 50)}" [${restore.entry.id}]: ${plural(restore.steps.length, 'step')}, restore ${restore.restoreJournalId ?? '-'}`,
    ),
    ...result.failed.map((failure) => `NOT undone ${failure.id}: ${failure.error}`),
  ];
  p.note(lines.join('\n') || 'nothing to undo', 'Undone');
  for (const restore of result.undone) for (const warning of restore.warnings) p.log.warn(warning);
  if (result.refused) p.log.error(`${result.refused} Not undone: ${result.notTried.join(', ')}; "Restore from journal" lists them.`);
  return result;
}

/**
 * Runs the items one after another under a spinner that counts them. A
 * failure or a refusal with conversations still to come stops the spinner,
 * shows the result line and asks the failure question (failureAnswers).
 * Ctrl+C or Escape at that question counts as "Stop here", the answer that
 * writes and undoes nothing more. The last conversation failing asks
 * nothing: the run is over, and "Restore from journal" undoes any of its
 * operations.
 */
async function runItems(context: TuiContext, live: OperationContext, items: readonly TransferItem[]): Promise<RunResult> {
  const outcomes: TransferOutcome[] = [];
  let ask = true;
  let spinner = p.spinner();
  spinner.start('Transferring');
  for (const [index, item] of items.entries()) {
    const at: Position = { index: index + 1, total: items.length };
    const title = truncate(item.source.title, 40);
    spinner.message(`Transferring ${at.index}/${at.total} "${title}"`);
    const outcome = await executeTransfer(live, item);
    outcomes.push(outcome);
    const left = items.length - index - 1;
    if (!ask || !isFailure(outcome) || left === 0) continue;
    spinner.stop(`Stopped at ${at.index}/${at.total} "${title}"`);
    p.log.error(describeOutcome(outcome, at));
    for (const warning of outcome.warnings) p.log.warn(warning);
    const undoLines = await describeBatchUndo(context.journal, outcomes);
    const answer = await decide(
      `${positionPrefix(at)}"${truncate(item.source.title, 60)}" ${outcome.action === 'refused' ? 'was refused' : 'failed'}. What now?`,
      failureAnswers(outcome, outcomes, left, undoLines),
    );
    if (answer === 'skip' || answer === 'continue') {
      if (answer === 'continue') ask = false;
      spinner = p.spinner();
      spinner.start('Transferring');
      continue;
    }
    if (answer === 'cancel') return { outcomes, notAttempted: left, undo: await undoRun(live, outcomes) };
    p.log.info(`Stopped; the ${plural(left, 'conversation')} left ${left === 1 ? 'was' : 'were'} not attempted.`);
    return { outcomes, notAttempted: left, undo: null };
  }
  const failed = outcomes.filter(isFailure).length;
  spinner.stop(failed === 0 ? `Done, ${plural(items.length, 'conversation')}` : `Done, ${plural(items.length, 'conversation')}, ${failed} failure(s) or refusal(s)`);
  return { outcomes, notAttempted: 0, undo: null };
}

/**
 * The "Transfer conversations" screen, start to finish: source, target,
 * scope, the picker, the pair question for every conversation the target
 * holds, the dry-run plan (which looks at the SSH hosts, read only), the
 * guard, the interrupted-operation check, the confirmation, the real run
 * (which stops to ask after a failure, see runItems) and a rescan. Returns
 * early, with nothing written, whenever the person cancels a prompt or the
 * transfer before the plan, the guard refuses, or the TUI runs as a dry run.
 */
export async function transferFlow(context: TuiContext): Promise<void> {
  const inventory = context.inventory;
  if (inventory.accounts.length === 0) {
    p.log.warn(`No account directories under ${context.paths.sessionsRoot}.`);
    return;
  }

  const sourceChoice = await p.select({
    message: 'Source',
    options: [
      ...inventory.accounts.map(accountOption),
      {
        value: UNLISTED,
        label: 'No account: unlisted transcripts',
        hint: `${inventory.unlisted.length} transcript(s) no record points at (claude.ai, terminal, unpersisted desktop)`,
      },
    ],
  });
  if (p.isCancel(sourceChoice)) return;
  const source = sourceChoice === UNLISTED ? null : inventory.accounts.find((account) => accountKey(account.accountId, account.orgId) === sourceChoice) ?? null;

  const targetOptions = inventory.accounts.filter((account) => accountKey(account.accountId, account.orgId) !== sourceChoice).map(accountOption);
  if (targetOptions.length === 0) {
    p.log.warn('A second account is needed as the target.');
    return;
  }
  const targetChoice = await p.select({ message: 'Target account', options: targetOptions });
  if (p.isCancel(targetChoice)) return;
  const target = inventory.accounts.find((account) => accountKey(account.accountId, account.orgId) === targetChoice);
  if (!target) return;

  const conversations = conversationsOf(inventory, source);
  const targetConversations = conversationsOf(inventory, target);
  if (conversations.length === 0) {
    p.log.info('Nothing to transfer from this source.');
    return;
  }
  const assessed: Assessed[] = conversations.map((conversation) => ({ conversation, assessment: assessSync(conversation, targetConversations) }));
  const scope = await p.select<SelectionScope>({
    message: `Which conversations to transfer to ${accountLabel(target)}?`,
    options: [
      { value: 'all', label: `All ${assessed.length} conversation${assessed.length === 1 ? '' : 's'}`, hint: stateCounts(assessed.map((entry) => entry.assessment)) },
      { value: 'all-but', label: 'All except the ones I pick', hint: 'pick the conversations to leave out' },
      { value: 'pick', label: 'Pick them one by one', hint: 'type to filter, space selects' },
    ],
  });
  if (p.isCancel(scope)) return;
  let pickedIndexes: number[] = [];
  if (scope !== 'all') {
    const options = assessed.map(({ conversation, assessment }, index) => ({
      value: String(index),
      label: truncate(conversation.title, 70),
      hint: conversationHint(conversation, assessment, inventory.accounts),
    }));
    const picked = await p.autocompleteMultiselect({
      message:
        scope === 'pick'
          ? `Conversations to transfer to ${accountLabel(target)} (type to filter, space selects)`
          : `Conversations to leave out (type to filter, space selects; Enter with none selected leaves out nothing)`,
      options,
      placeholder: 'title, project, state...',
      maxItems: 12,
      required: scope === 'pick',
      filter: (search, option) => {
        const needle = search.toLowerCase();
        return (option.label ?? '').toLowerCase().includes(needle) || (option.hint ?? '').toLowerCase().includes(needle);
      },
    });
    if (p.isCancel(picked)) return;
    pickedIndexes = picked.map(Number);
  }
  const selected = applySelection(assessed, scope, pickedIndexes);
  if (selected.length === 0) {
    p.log.info('Nothing left to transfer.');
    return;
  }
  if (source === null) p.log.info('Unlisted transcripts are imported as copies; the originals stay untouched.');

  const items = await decidePairs(selected, target);
  if (items === null) return;

  const dryRun = { paths: context.paths, journal: context.journal, lineage: context.lineage, dryRun: true };
  const plan: TransferOutcome[] = [];
  const planning = p.spinner();
  planning.start('Planning');
  for (const [index, item] of items.entries()) {
    planning.message(`Planning ${index + 1}/${items.length} "${truncate(item.source.title, 40)}"`);
    plan.push(await executeTransfer(dryRun, item));
  }
  planning.stop(`Planned ${plural(items.length, 'conversation')}`);
  p.note(outcomeLines(plan, items.length), 'Plan');

  if (context.dryRun) {
    p.log.info('Dry run: nothing was changed. Start without --dry-run to apply.');
    return;
  }
  // Asked now, right before writing, and asked again inside every operation.
  const gate = await context.guard();
  if (!gate.allowed) {
    p.log.error(gate.reason ?? 'writes are not allowed');
    p.log.info('The plan above is what will happen once the app is closed. Nothing was changed.');
    return;
  }
  if (gate.reason) p.log.warn(gate.reason);
  // Nothing is written while an earlier operation is still unresolved; undoing
  // one changes files, which makes the plan above stale.
  const settled = await settleInterruptedInTui(context);
  if (settled === 'exit') return;
  if (settled === 'changed') {
    p.log.info('Files changed while undoing; pick the conversations again.');
    return;
  }
  const confirmed = await p.confirm({ message: `Apply ${items.length} operation${items.length === 1 ? '' : 's'}?`, initialValue: false });
  if (p.isCancel(confirmed) || !confirmed) {
    p.log.info('Nothing changed.');
    return;
  }

  const live = { ...dryRun, dryRun: false };
  const run = await runItems(context, live, items);
  p.note(outcomeLines(run.outcomes, items.length), 'Result');
  if (run.notAttempted > 0) {
    p.log.info(`${plural(run.notAttempted, 'conversation')} not attempted; transferring the same conversations again continues where this run stopped (the ones done report up to date).`);
  }
  const wrote = run.outcomes.some((outcome) => WRITE_ACTIONS.has(outcome.action));
  if (run.undo && run.undo.undone.length === 0 && run.undo.failed.length === 0 && run.undo.refused === null) {
    p.log.info('Transfer cancelled: nothing was written.');
  } else if (run.undo && run.undo.failed.length === 0 && run.undo.refused === null) {
    p.log.info('Transfer cancelled: everything it did was undone.');
  } else if (wrote) {
    p.log.info('Start the Claude app to see the result; it reads session records at start-up. Use "Restore from journal" to undo.');
  }
  await context.reload();
}
