// Asking what to do with operations that were cut short (see ../interrupted.ts).
// Used by the TUI and, when a terminal is attached, by the transfer and restore
// commands, so the question looks the same everywhere.
import * as p from '@clack/prompts';
import { describeInterrupted, interruptedHelp } from '../interrupted.ts';
import type { JournalEntry } from '../journal.ts';
import { restoreEntry, type OperationContext } from '../operations.ts';
import type { TuiContext } from './context.ts';

/** What the person decided about the interrupted operations, for the caller to continue, rescan or stop. */
export interface InterruptedAnswer {
  /** exit: the person chose to stop, or undoing failed. */
  choice: 'continue' | 'exit';
  /** True when an undo changed files, so plans made before are stale. */
  changedFiles: boolean;
}

/** Asks about each entry in turn: undo it, leave its files as they are, or stop. */
export async function askAboutInterrupted(context: OperationContext, entries: readonly JournalEntry[]): Promise<InterruptedAnswer> {
  let changedFiles = false;
  for (const entry of entries) {
    p.log.warn(`An earlier operation was interrupted and may have left files half-written:\n${describeInterrupted(entry)}`);
    const answer = await p.select({
      message: 'What should happen to it?',
      options: [
        { value: 'undo', label: 'Undo', hint: 'put back what it changed (restore), then continue' },
        { value: 'leave', label: 'Leave', hint: 'keep its files as they are and mark it resolved; it can still be restored later' },
        { value: 'exit', label: 'Exit', hint: 'change nothing now' },
      ],
    });
    if (p.isCancel(answer) || answer === 'exit') return { choice: 'exit', changedFiles };
    if (answer === 'leave') {
      await context.journal.resolve(entry.id);
      p.log.info(`${entry.id} is resolved; its files stay as they are.`);
      continue;
    }
    try {
      const result = await restoreEntry({ ...context, dryRun: false }, entry.id);
      changedFiles = true;
      p.note(result.steps.length > 0 ? result.steps.join('\n') : 'nothing to do', `Undone: ${entry.id}`);
      for (const warning of result.warnings) p.log.warn(warning);
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : String(error));
      return { choice: 'exit', changedFiles };
    }
  }
  return { choice: 'continue', changedFiles };
}

/**
 * The TUI's check before anything writes: asks about interrupted operations
 * when writing is possible now, and only warns when the guard is closed
 * (Claude running), since undoing would be refused anyway. Rescans after an
 * undo. Returns what the caller should do next.
 */
export async function settleInterruptedInTui(context: TuiContext): Promise<'clear' | 'changed' | 'exit'> {
  const entries = await context.journal.interrupted();
  if (entries.length === 0) return 'clear';
  if (context.dryRun) {
    p.log.warn(interruptedHelp(entries));
    return 'clear';
  }
  const gate = await context.guard();
  if (!gate.allowed) {
    p.log.warn(`${interruptedHelp(entries)}\nNothing can be undone right now: ${gate.reason ?? 'writes are not allowed'}`);
    return 'clear';
  }
  const answer = await askAboutInterrupted({ paths: context.paths, journal: context.journal, lineage: context.lineage, dryRun: false }, entries);
  if (answer.changedFiles) await context.reload();
  if (answer.choice === 'exit') return 'exit';
  return answer.changedFiles ? 'changed' : 'clear';
}
