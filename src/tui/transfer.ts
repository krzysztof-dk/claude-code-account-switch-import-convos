// The transfer screen: pick a source (an account or the unlisted transcripts),
// a target account, the conversations (all of them, all but some, or some),
// the mode, decide conflicts one by one, review a dry-run plan and apply it.
// Planning looks at the SSH hosts of the conversations that run on one (read
// only, see ssh-host.ts), so it can take a few seconds per host conversation.
import * as p from '@clack/prompts';
import { accountKey, accountLabel, type AccountInfo } from '../accounts.ts';
import { describeOutcome } from '../cli.ts';
import { describeComparison, describeFlags, describeOrigin, describeState, formatSize, formatWhen, shortenPath, truncate } from '../format.ts';
import { assessSync, conversationsOf, type Conversation, type SyncAssessment } from '../inventory.ts';
import { executeTransfer, type ConflictPolicy, type TransferItem, type TransferMode, type TransferOutcome } from '../operations.ts';
import type { TuiContext } from './context.ts';
import { settleInterruptedInTui } from './interrupted.ts';

const UNLISTED = 'none';

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

/**
 * The "Transfer conversations" screen, start to finish: source, target,
 * scope, the picker, the mode, a decision per conflicting conversation, the
 * dry-run plan (which looks at the SSH hosts, read only), the guard, the
 * interrupted-operation check, the confirmation, the real run and a
 * rescan. Returns early, with nothing written, whenever the person cancels
 * a prompt, the guard refuses, or the TUI runs as a dry run.
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
  const assessed = conversations.map((conversation) => ({ conversation, assessment: assessSync(conversation, targetConversations) }));
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

  const items: TransferItem[] = [];
  for (const { conversation, assessment } of selected) {
    let onConflict: ConflictPolicy = 'skip';
    if (assessment.state === 'target-ahead' || assessment.state === 'diverged') {
      for (const warning of assessment.warnings) p.log.warn(warning);
      const answer = await p.select({
        message: `"${truncate(conversation.title, 60)}": ${describeState(assessment.state)} (${describeComparison(assessment)}). What to do?`,
        options: [
          { value: 'skip', label: 'Skip', hint: 'leave the target copy as it is' },
          { value: 'overwrite', label: 'Overwrite the target copy', hint: 'replace it with the source; the previous copy goes into backups' },
        ],
      });
      if (p.isCancel(answer)) return;
      onConflict = answer;
    }
    items.push({ source: conversation, target, mode, assessment, onConflict });
  }

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
  const spinner = p.spinner();
  spinner.start('Transferring');
  const outcomes: TransferOutcome[] = [];
  for (const item of items) {
    spinner.message(`Transferring "${truncate(item.source.title, 40)}"`);
    outcomes.push(await executeTransfer(live, item));
  }
  const failed = outcomes.filter((outcome) => outcome.action === 'failed' || outcome.action === 'refused').length;
  spinner.stop(failed === 0 ? 'Done' : `Done with ${failed} failure(s) or refusal(s)`);
  p.note(outcomeLines(outcomes), 'Result');
  p.log.info('Start the Claude app to see the result; it reads session records at start-up. Use "Restore from journal" to undo.');
  await context.reload();
}
