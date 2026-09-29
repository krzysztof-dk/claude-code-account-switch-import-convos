// Operations cut short: journal entries still "running" when the tool starts.
//
// Every step of an operation is journaled before it happens (operation-log.ts),
// so an entry a dead process left "running" (killed, crashed, power cut) lists
// everything the operation may have changed, possibly half-written. Before
// anything else writes, the person decides what happens to it:
//   - undo: `restore <id>`, which puts back what the operation changed
//   - leave: `resolve <id>`, which keeps the files as they are (the entry can
//     still be restored later)
//   - stop: change nothing now
// With a terminal attached the tool asks (tui/interrupted.ts); without one it
// refuses with exit code 4 and prints the two commands. Commands that only
// read print a warning and carry on.
import { truncate } from './format.ts';
import type { JournalEntry } from './journal.ts';
import { describeHost } from './ssh-host.ts';

/** How many paths the entry changed on the SSH host, as a list suffix; empty when none. */
export function describeHostSteps(entry: JournalEntry): string {
  const remote = entry.remote;
  if (!remote) return '';
  const count = remote.created.length + remote.moved.length + remote.tombstoned.length;
  return count > 0 ? `, ${count} on ${describeHost(remote.host)}` : '';
}

/** One line naming the entry: id, what it was doing, when it started and how far it got. */
export function describeInterrupted(entry: JournalEntry): string {
  return (
    `${entry.id}: ${entry.mode} "${truncate(entry.title, 50)}", started ${entry.at}, ` +
    `${entry.created.length} created, ${entry.moved.length} moved, ${entry.backedUp.length} backed up${describeHostSteps(entry)} so far`
  );
}

/** The explanation printed when there is no terminal to ask in, or next to read-only output. */
export function interruptedHelp(entries: readonly JournalEntry[]): string {
  const lines = [`${entries.length} operation${entries.length === 1 ? ' was' : 's were'} interrupted and may have left files half-written:`];
  for (const entry of entries) lines.push(`  ${describeInterrupted(entry)}`);
  lines.push('Undo one with "ccas restore <id>", or keep its files as they are with "ccas resolve <id>".');
  return lines.join('\n');
}
