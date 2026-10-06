// Asking what to do with operations that were cut short (see ../interrupted.ts).
// Used by the TUI and, when a terminal is attached, by the transfer and restore
// commands, so the question looks the same everywhere. It is asked through
// ./decide.ts: besides Undo and Leave for the one entry in front of the
// person, the same answer for every entry left, and Exit, each confirmed
// after a note on what exactly happens (the operator's request of
// 2026-10-06 for every question that stops at one item of a batch). Exit
// has no "undo what was undone": a finished restore is final
// (operations.ts, restoreEntry), so the note says what stays undone.
import * as p from '@clack/prompts';
import { describeInterrupted, interruptedHelp } from '../interrupted.ts';
import { truncate } from '../format.ts';
import type { JournalEntry } from '../journal.ts';
import { restoreEntry, type OperationContext } from '../operations.ts';
import type { TuiContext } from './context.ts';
import { decide, indented, type Answer } from './decide.ts';

/** What the person decided about the interrupted operations, for the caller to continue, rescan or stop. */
export interface InterruptedAnswer {
  /** exit: the person chose to stop, or undoing failed. */
  choice: 'continue' | 'exit';
  /** True when an undo changed files, so plans made before are stale. */
  changedFiles: boolean;
}

/**
 * The answers about one interrupted entry: undo it, leave it as it is, the
 * same for every entry left (offered when more than one is left), and Exit.
 */
export type InterruptedChoice = 'undo' | 'leave' | 'undo-all' | 'leave-all' | 'exit';

/** "<id>: copy "title"": an entry already dealt with, as the Exit note lists it. */
function nameOf(entry: JournalEntry): string {
  return `${entry.id}: ${entry.mode} "${truncate(entry.title, 50)}"`;
}

/**
 * Builds the answers for the question about `remaining[0]`, with the entries
 * still to be asked about after it, and what was decided so far: `undone`
 * (restored, which stays so) and `left` (marked resolved). The Exit note
 * recaps both and names what stays interrupted, since those are asked about
 * again before the next write.
 */
export function interruptedAnswers(remaining: readonly JournalEntry[], undone: readonly JournalEntry[], left: readonly JournalEntry[]): Answer<InterruptedChoice>[] {
  const count = remaining.length;
  const listed = indented(remaining.map(describeInterrupted));
  const answers: Answer<InterruptedChoice>[] = [
    { value: 'undo', label: 'Undo', hint: 'put back what it changed (restore), then continue' },
    { value: 'leave', label: 'Leave', hint: 'keep its files as they are and mark it resolved; it can still be restored later' },
  ];
  if (count > 1) {
    const rest = `this one and the ${count - 1} after it; asks to confirm first`;
    answers.push(
      {
        value: 'undo-all',
        label: `Undo all ${count} remaining`,
        hint: rest,
        confirm: {
          title: 'Undo all',
          note:
            'Each is restored in turn: created files go into the backup, moves are reversed, overwritten files come back ' +
            `from the backup, host changes are undone on the host. Then the tool carries on.\n${listed}`,
          question: `Undo all ${count} remaining?`,
        },
      },
      {
        value: 'leave-all',
        label: `Leave all ${count} remaining`,
        hint: rest,
        confirm: {
          title: 'Leave all',
          note: `Each is marked resolved and its files stay as they are; "Restore from journal" (ccas restore <id>) can still undo it later.\n${listed}`,
          question: `Leave all ${count} as they are?`,
        },
      },
    );
  }
  const recap = [
    undone.length > 0 ? `Undone so far (stays undone; a finished restore is final):\n${indented(undone.map(nameOf))}` : 'Undone so far: nothing.',
    ...(left.length > 0 ? [`Left as they are so far (resolved):\n${indented(left.map(nameOf))}`] : []),
    `Still interrupted, asked about again before the next write:\n${listed}`,
    'Nothing else changes now.',
  ];
  answers.push({
    value: 'exit',
    label: 'Exit',
    hint: 'change nothing more now; asks to confirm first',
    confirm: { title: 'Exit', note: recap.join('\n'), question: 'Exit now?' },
  });
  return answers;
}

/**
 * Asks about each entry in turn (interruptedAnswers): undo it, leave its
 * files as they are, the same for all that are left, or stop. Ctrl+C or
 * Escape at the question counts as Exit. An undo that fails ends the
 * questions with Exit as well, with the error shown.
 */
export async function askAboutInterrupted(context: OperationContext, entries: readonly JournalEntry[]): Promise<InterruptedAnswer> {
  let changedFiles = false;
  const undone: JournalEntry[] = [];
  const left: JournalEntry[] = [];
  let forAll: 'undo' | 'leave' | null = null;
  for (const [index, entry] of entries.entries()) {
    let choice: 'undo' | 'leave';
    if (forAll !== null) {
      choice = forAll;
    } else {
      p.log.warn(`An earlier operation was interrupted and may have left files half-written:\n${describeInterrupted(entry)}`);
      const answer = await decide('What should happen to it?', interruptedAnswers(entries.slice(index), undone, left));
      if (answer === null || answer === 'exit') return { choice: 'exit', changedFiles };
      choice = answer === 'undo' || answer === 'undo-all' ? 'undo' : 'leave';
      if (answer === 'undo-all' || answer === 'leave-all') forAll = choice;
    }
    if (choice === 'leave') {
      await context.journal.resolve(entry.id);
      p.log.info(`${entry.id} is resolved; its files stay as they are.`);
      left.push(entry);
      continue;
    }
    try {
      const result = await restoreEntry({ ...context, dryRun: false }, entry.id);
      changedFiles = true;
      undone.push(entry);
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
