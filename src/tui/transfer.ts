// The transfer screen: pick a source (an account or the unlisted transcripts),
// a target account, the conversations (all of them, all but some, or some),
// the mode, decide conflicts one by one, review a dry-run plan and apply it.
// Planning looks at the SSH hosts of the conversations that run on one (read
// only, see ssh-host.ts), so it can take a few seconds per host conversation.
//
// Two questions stop at one conversation, both asked through ./decide.ts so
// an answer can reach the rest of the batch: the conflict question before
// the plan, for a conversation whose target copy is newer or diverged, and
// the failure question during the run, after a conversation failed or was
// refused while others are still to come. Besides the answer for that one
// conversation, both offer the same answer for every conversation left and
// calling the transfer off, each confirmed after a note on what exactly
// happens. Calling the transfer off before the plan discards the choices
// made (nothing is written before "Apply N operations?"); during the run it
// undoes what the run did so far (batch.ts). Asked for by the operator on
// 2026-10-06, when a sync of 632 conversations stopped at its first
// "target is newer" question.
import * as p from '@clack/prompts';
import { accountKey, accountLabel, type AccountInfo } from '../accounts.ts';
import { describeBatchUndo, journalIdsOf, undoBatch, type BatchUndoResult } from '../batch.ts';
import { describeOutcome } from '../cli.ts';
import { describeComparison, describeFlags, describeOrigin, describeState, formatSize, formatWhen, shortenPath, truncate } from '../format.ts';
import { assessSync, conversationsOf, type Conversation, type SyncAssessment } from '../inventory.ts';
import {
  executeTransfer,
  type ConflictPolicy,
  type OperationContext,
  type OutcomeAction,
  type TransferItem,
  type TransferMode,
  type TransferOutcome,
} from '../operations.ts';
import type { TuiContext } from './context.ts';
import { decide, indented, tally, type Answer } from './decide.ts';
import { settleInterruptedInTui } from './interrupted.ts';

const UNLISTED = 'none';

/** The outcomes that changed files on the target: after them the app has something new to show. */
const WRITE_ACTIONS = new Set<OutcomeAction>(['created', 'updated', 'repaired', 'moved']);

function accountOption(account: AccountInfo): { value: string; label: string; hint: string } {
  const bits = [account.email ?? 'e-mail unknown', `${account.sessionCount} session${account.sessionCount === 1 ? '' : 's'}`];
  if (account.orgName) bits.push(account.orgName);
  if (account.loggedIn) bits.push('logged in');
  return { value: accountKey(account.accountId, account.orgId), label: accountLabel(account), hint: bits.join(' | ') };
}

function conversationHint(conversation: Conversation, assessment: SyncAssessment, accounts: readonly AccountInfo[]): string {
  const bits = [
    describeState(assessment.state),
    describeOrigin(conversation, accounts),
    shortenPath(conversation.cwd, 28),
    formatWhen(conversation.lastActivityAt),
    formatSize(conversation.sizeBytes),
  ];
  const flags = describeFlags(conversation);
  if (flags) bits.push(flags);
  return bits.join(' | ');
}

function outcomeLines(outcomes: readonly TransferOutcome[]): string {
  return outcomes
    .flatMap((outcome) => [describeOutcome(outcome), ...outcome.warnings.map((warning) => `  warning: ${warning}`)])
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

/** Whether the transfer asks about a conversation before the plan: its target copy is newer than the source, or diverged from it. */
export function isConflict(entry: Assessed): boolean {
  return entry.assessment.state === 'target-ahead' || entry.assessment.state === 'diverged';
}

/** '"title" (target is newer: target has 1 extra line)': one conflicting conversation as the notes list it. */
export function describeConflict(entry: Assessed): string {
  return `"${truncate(entry.conversation.title, 60)}" (${describeState(entry.assessment.state)}: ${describeComparison(entry.assessment)})`;
}

/**
 * The answers to the conflict question: skip or overwrite for the one
 * conversation asked about; the same for every conflict left (this one and
 * the ones after it), offered when more than one is left; and calling the
 * transfer off. The last three are confirmed after a note that lists the
 * conversations involved, or says that nothing has been written.
 */
export type ConflictAnswer = 'skip' | 'overwrite' | 'skip-all' | 'overwrite-all' | 'cancel';

/**
 * Builds the answers for the conflict question about `remaining[0]`, with
 * the other conflicts still to be asked about after it and the answers
 * already given (they stay as given; the notes say so).
 */
export function conflictAnswers(remaining: readonly Assessed[], decided: readonly ConflictPolicy[]): Answer<ConflictAnswer>[] {
  const count = remaining.length;
  const listed = indented(remaining.map(describeConflict));
  const earlier = decided.length > 0 ? `\nThe ${plural(decided.length, 'answer')} given before (${tally(decided)}) stay as given.` : '';
  const answers: Answer<ConflictAnswer>[] = [
    { value: 'skip', label: 'Skip this conversation', hint: 'leave the target copy as it is; the result lists it as skipped' },
    { value: 'overwrite', label: 'Overwrite the target copy', hint: 'replace it with the source; the previous copy goes into backups' },
  ];
  if (count > 1) {
    const rest = `this one and the ${count - 1} after it; asks to confirm first`;
    answers.push(
      {
        value: 'skip-all',
        label: `Skip all ${count} remaining conflicts`,
        hint: rest,
        confirm: {
          title: 'Skip all',
          note: `Skipped: the target copy of each stays as it is, and the result lists it as skipped.\n${listed}${earlier}`,
          question: `Skip all ${count} remaining conflicts?`,
        },
      },
      {
        value: 'overwrite-all',
        label: `Overwrite all ${count} remaining conflicts`,
        hint: rest,
        confirm: {
          title: 'Overwrite all',
          note:
            'Overwritten: each target copy is replaced by the source. The previous copy goes into backups, ' +
            `as a journal entry of its own that "Restore from journal" undoes.\n${listed}${earlier}`,
          question: `Overwrite the target copies of all ${count} remaining conflicts?`,
        },
      },
    );
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
          ? `Undone, newest first; each undo is a journal entry of its own:\n${indented(undoLines)}\nNot attempted: the ${leftText} left.\n` +
            'Claude Code must still be closed: an undo it refuses, and the ones after it, stay listed in "Restore from journal".'
          : `Nothing to undo: no operation of this transfer wrote anything.\nNot attempted: the ${leftText} left.`,
        question: undoable ? `Undo ${plural(undoLines.length, 'operation')} and stop the transfer?` : 'Stop the transfer?',
      },
    },
  ];
}

/**
 * Asks about every conflicting conversation in turn and gives each item its
 * conflict policy. Returns null when the person called the transfer off
 * (confirmed) or cancelled the question (Ctrl+C or Escape): nothing has
 * been written at this point, so there is nothing to undo.
 */
async function decideConflicts(selected: readonly Assessed[], target: AccountInfo, mode: TransferMode): Promise<TransferItem[] | null> {
  const items: TransferItem[] = [];
  const conflicts = selected.filter(isConflict);
  const decided: ConflictPolicy[] = [];
  let forAll: ConflictPolicy | null = null;
  for (const entry of selected) {
    let onConflict: ConflictPolicy = 'skip';
    if (isConflict(entry) && forAll !== null) {
      onConflict = forAll;
    } else if (isConflict(entry)) {
      // The warnings of the conflicts answered for all at once are not lost:
      // every outcome carries its assessment's warnings into the plan.
      for (const warning of entry.assessment.warnings) p.log.warn(warning);
      const remaining = conflicts.slice(conflicts.indexOf(entry));
      const answer = await decide(
        `"${truncate(entry.conversation.title, 60)}": ${describeState(entry.assessment.state)} (${describeComparison(entry.assessment)}). What to do?`,
        conflictAnswers(remaining, decided),
      );
      if (answer === null) return null;
      if (answer === 'cancel') {
        p.log.info('Transfer cancelled: nothing was changed.');
        return null;
      }
      onConflict = answer === 'skip' || answer === 'skip-all' ? 'skip' : 'overwrite';
      if (answer === 'skip-all' || answer === 'overwrite-all') forAll = onConflict;
      decided.push(onConflict);
    }
    items.push({ source: entry.conversation, target, mode, assessment: entry.assessment, onConflict });
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
 * Runs the items one after another under a spinner. A failure or a refusal
 * with conversations still to come stops the spinner, shows the result line
 * and asks the failure question (failureAnswers). Ctrl+C or Escape at that
 * question counts as "Stop here", the answer that writes and undoes nothing
 * more. The last conversation failing asks nothing: the run is over, and
 * "Restore from journal" undoes any of its operations.
 */
async function runItems(context: TuiContext, live: OperationContext, items: readonly TransferItem[]): Promise<RunResult> {
  const outcomes: TransferOutcome[] = [];
  let ask = true;
  let spinner = p.spinner();
  spinner.start('Transferring');
  for (const [index, item] of items.entries()) {
    spinner.message(`Transferring "${truncate(item.source.title, 40)}"`);
    const outcome = await executeTransfer(live, item);
    outcomes.push(outcome);
    const left = items.length - index - 1;
    if (!ask || !isFailure(outcome) || left === 0) continue;
    spinner.stop(`Stopped at "${truncate(item.source.title, 40)}"`);
    p.log.error(describeOutcome(outcome));
    for (const warning of outcome.warnings) p.log.warn(warning);
    const undoLines = await describeBatchUndo(context.journal, outcomes);
    const answer = await decide(
      `"${truncate(item.source.title, 60)}" ${outcome.action === 'refused' ? 'was refused' : 'failed'}. What now?`,
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
  spinner.stop(failed === 0 ? 'Done' : `Done with ${failed} failure(s) or refusal(s)`);
  return { outcomes, notAttempted: 0, undo: null };
}

/**
 * The "Transfer conversations" screen, start to finish: source, target,
 * scope, the picker, the mode, a decision per conflicting conversation, the
 * dry-run plan (which looks at the SSH hosts, read only), the guard, the
 * interrupted-operation check, the confirmation, the real run (which stops
 * to ask after a failure, see runItems) and a rescan. Returns early, with
 * nothing written, whenever the person cancels a prompt or the transfer
 * before the plan, the guard refuses, or the TUI runs as a dry run.
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

  let mode: TransferMode = 'copy';
  if (source === null) {
    p.log.info('Unlisted transcripts are imported as copies; the originals stay untouched.');
  } else {
    const modeChoice = await p.select({
      message: 'Operation',
      options: [
        { value: 'copy', label: 'Copy (sync)', hint: 'the target gets its own copy; copying again later updates it' },
        { value: 'move', label: 'Move', hint: 'like copy, then the source side is removed (into backups)' },
      ],
    });
    if (p.isCancel(modeChoice)) return;
    mode = modeChoice;
  }

  const items = await decideConflicts(selected, target, mode);
  if (items === null) return;

  const dryRun = { paths: context.paths, journal: context.journal, lineage: context.lineage, dryRun: true };
  const plan: TransferOutcome[] = [];
  const planning = p.spinner();
  planning.start('Planning');
  for (const item of items) {
    planning.message(`Planning "${truncate(item.source.title, 40)}"`);
    plan.push(await executeTransfer(dryRun, item));
  }
  planning.stop('Planned');
  p.note(outcomeLines(plan), 'Plan');

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
  p.note(outcomeLines(run.outcomes), 'Result');
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
