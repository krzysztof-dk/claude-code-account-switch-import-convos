// Undoing the operations of one run as a whole.
//
// A transfer runs its conversations one after another, and each of them is a
// journal entry of its own (operations.ts): "Restore from journal" undoes one
// entry at a time. When the transfer screen stops at a conversation that
// failed or was refused and the person answers "cancel the transfer and undo
// what it did" (tui/transfer.ts, asked for by the operator on 2026-10-06),
// the operations done so far in that run are undone here, newest first, each
// through restoreEntry, so every undo is a journal entry of its own and the
// journal reads exactly as if the person had restored them by hand in that
// order. Newest first because a later operation may build on an earlier one
// (a move onto a copy the same run made).
//
// What counts as the run: the outcomes executeTransfer returned so far. The
// ones with a journal id opened an entry; an entry whose operation was rolled
// back inside executeTransfer (the guard closed, a host step failed) is
// "failed" with its created and moved lists empty and its backups still
// listed, so undoing it only copies those backups back, which is harmless.
// Outcomes without a journal id (skipped, up to date, a failure before the
// first write) have nothing to undo.
import { GuardRefusal } from './app-guard.ts';
import { truncate } from './format.ts';
import { describeHostSteps } from './interrupted.ts';
import type { Journal, JournalEntry } from './journal.ts';
import { restoreEntry, type OperationContext, type RestoreResult, type TransferOutcome } from './operations.ts';

/** The journal ids of the outcomes that opened an entry, newest first: the order the undo takes. */
export function journalIdsOf(outcomes: readonly TransferOutcome[]): string[] {
  return outcomes
    .map((outcome) => outcome.journalId)
    .filter((id): id is string => id !== null)
    .reverse();
}

/** "updated "title" [id]: 2 moved, 1 backed up": one entry as the confirmation note lists it, or what is known when the entry is not in the journal. */
export function describeUndoOf(entry: JournalEntry | undefined, id: string): string {
  if (!entry) return `${id}: not in the journal`;
  const counts = `${entry.created.length} created, ${entry.moved.length} moved, ${entry.backedUp.length} backed up${describeHostSteps(entry)}`;
  const status = entry.status === 'done' ? '' : ` (${entry.status})`;
  return `${entry.action} "${truncate(entry.title, 50)}" [${entry.id}]${status}: ${counts}`;
}

/**
 * One line per entry the undo would touch, newest first, for the note shown
 * before the person confirms: the action, the title, the journal id and how
 * many paths come back. Empty when the run wrote nothing.
 */
export async function describeBatchUndo(journal: Journal, outcomes: readonly TransferOutcome[]): Promise<string[]> {
  const ids = journalIdsOf(outcomes);
  if (ids.length === 0) return [];
  const entries = new Map((await journal.list()).map((entry) => [entry.id, entry]));
  return ids.map((id) => describeUndoOf(entries.get(id), id));
}

/**
 * How undoBatch ended: the restores that went through (in undo order), the
 * entries whose restore threw, the guard's reason when it closed, and the
 * ids after that point, which were not tried.
 */
export interface BatchUndoResult {
  undone: RestoreResult[];
  failed: { id: string; error: string }[];
  /** The guard's reason when Claude Code appeared before or during an undo; null when it stayed closed. */
  refused: string | null;
  /** Ids not tried because the guard closed; they stay listed in "Restore from journal". */
  notTried: string[];
}

/**
 * Undoes the entries named, in the order given (journalIdsOf gives newest
 * first), each through restoreEntry. An undo that throws for its own reasons
 * (already restored, a missing entry) is reported and the others still run,
 * since each operation stands on its own; the guard closing (Claude Code
 * started meanwhile) stops the rest, because every later undo would be
 * refused too, and names them so the person can restore them once it is
 * closed again.
 */
export async function undoBatch(context: OperationContext, ids: readonly string[]): Promise<BatchUndoResult> {
  const result: BatchUndoResult = { undone: [], failed: [], refused: null, notTried: [] };
  for (const [index, id] of ids.entries()) {
    try {
      result.undone.push(await restoreEntry({ ...context, dryRun: false }, id));
    } catch (error) {
      if (error instanceof GuardRefusal) {
        result.refused = error.message;
        result.notTried = ids.slice(index);
        return result;
      }
      result.failed.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
