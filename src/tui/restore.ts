// The restore screen: pick a finished operation from the journal, see what
// undoing it would touch, confirm, undo. Interrupted operations are not listed
// here; they are dealt with before anything writes (see ./interrupted.ts).
import * as p from '@clack/prompts';
import { truncate } from '../format.ts';
import { describeHostSteps } from '../interrupted.ts';
import { restoreEntry } from '../operations.ts';
import type { TuiContext } from './context.ts';
import { settleInterruptedInTui } from './interrupted.ts';

/** done, failed half-way, or interrupted and left as it was: all can still be undone. */
const RESTORABLE = new Set(['done', 'failed', 'resolved']);

/**
 * The "Restore from journal" screen: lists the operations that can still
 * be undone (newest first), shows the dry-run plan of the chosen one, asks
 * for confirmation, undoes it and rescans. Interrupted operations are not
 * offered here (settleInterruptedInTui deals with them first), and a dry
 * run TUI stops after the plan.
 */
export async function restoreFlow(context: TuiContext): Promise<void> {
  const entries = (await context.journal.list()).filter((entry) => RESTORABLE.has(entry.status) && entry.mode !== 'restore').reverse();
  if (entries.length === 0) {
    p.log.info('No operation to undo.');
    return;
  }
  const choice = await p.select({
    message: 'Operation to undo',
    maxItems: 12,
    options: [
      ...entries.map((entry) => ({
        value: entry.id,
        label: `${entry.at.slice(0, 16).replace('T', ' ')}  ${entry.mode} ${entry.action}${entry.status === 'done' ? '' : ` (${entry.status})`}  "${truncate(entry.title, 40)}"`,
        hint: `${entry.created.length} created, ${entry.moved.length} moved, ${entry.backedUp.length} backed up${describeHostSteps(entry)}`,
      })),
      { value: 'back', label: 'Back' },
    ],
  });
  if (p.isCancel(choice) || choice === 'back') return;

  const base = { paths: context.paths, journal: context.journal, lineage: context.lineage };
  const preview = await restoreEntry({ ...base, dryRun: true }, choice);
  p.note(preview.steps.length > 0 ? preview.steps.join('\n') : 'nothing to do', 'Restore plan');
  if (context.dryRun) {
    p.log.info('Dry run: nothing was changed.');
    return;
  }
  const gate = await context.guard();
  if (!gate.allowed) {
    p.log.error(gate.reason ?? 'writes are not allowed');
    return;
  }
  if (gate.reason) p.log.warn(gate.reason);
  const settled = await settleInterruptedInTui(context);
  if (settled === 'exit') return;
  if (settled === 'changed') {
    p.log.info('Files changed while undoing; choose the operation again.');
    return;
  }
  const confirmed = await p.confirm({ message: 'Undo this operation?', initialValue: false });
  if (p.isCancel(confirmed) || !confirmed) return;
  try {
    const result = await restoreEntry({ ...base, dryRun: false }, choice);
    p.note(result.steps.join('\n') || 'nothing to do', 'Restored');
    for (const warning of result.warnings) p.log.warn(warning);
    if (result.restoreJournalId) p.log.info(`Journal ${result.restoreJournalId}`);
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
  }
  await context.reload();
}
