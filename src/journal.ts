// Journal of every write the tool performed, one JSON line per operation.
//
// The journal is what makes operations reversible: each entry lists the files
// that were backed up (mirrored under a backup directory), the files that were
// created and the files that were moved, and for a conversation that runs on
// an SSH host what was created and kept aside there (RemoteSteps), so
// `restore <id>` can undo the operation without guessing. An entry is
// appended when an operation starts (status "running") and rewritten in place
// at every step, before the step happens (operation-log.ts), and every write
// is flushed to the disk. An
// operation cut short (killed, crashed, power cut) therefore leaves an entry
// that still says "running" and lists everything it may have changed. Nothing
// else leaves "running" behind, since the tool runs one operation at a time,
// so such an entry found by a later run is an interrupted operation: the
// person undoes it (restore) or keeps its files as they are (resolve).
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { appendFileDurable, writeFileAtomic } from './fsx.ts';
import type { HostTarget } from './ssh-host.ts';

/**
 * running: in progress, or interrupted when seen by a later run
 * done / failed: finished, successfully or not
 * restored: undone by a restore
 * resolved: interrupted, and the person chose to keep its files as they are
 */
export type JournalStatus = 'running' | 'done' | 'failed' | 'restored' | 'resolved';

export interface JournalEndpoint {
  accountId?: string | undefined;
  orgId?: string | undefined;
  sessionId?: string | undefined;
  cliSessionId?: string | undefined;
}

/**
 * What an operation changed on the SSH host of a conversation (ssh-host.ts),
 * recorded before each change like the local steps. Paths are the host's.
 */
export interface RemoteSteps {
  host: HostTarget;
  /** Paths created on the host; undone by setting them aside. */
  created: string[];
  /** Replaced paths and where they were kept on the host; undone by moving them back. */
  moved: { from: string; to: string }[];
  /**
   * Transcripts on the host that got Remote Control tombstones appended in
   * place (a moved conversation, or a copy the host already had). Restore
   * leaves those lines: they only keep Remote Control off.
   */
  tombstoned: string[];
}

export interface JournalEntry {
  id: string;
  /** ISO time the operation started. */
  at: string;
  mode: 'copy' | 'move' | 'import' | 'restore';
  /**
   * What the operation did to the target: created, updated, moved, repaired
   * (an up-to-date copy got what copies made before 2026-09-28 lack: Remote
   * Control off, its transcript on the SSH host), or nothing.
   */
  action: 'created' | 'updated' | 'moved' | 'repaired' | 'none';
  status: JournalStatus;
  title: string;
  rootUuid: string | null;
  source: JournalEndpoint;
  target: JournalEndpoint;
  relation: string | null;
  /** Directory under which every backed-up path is mirrored, or null when nothing was backed up. */
  backupDir: string | null;
  /** Absolute paths whose previous content lives under backupDir. */
  backedUp: string[];
  /** Absolute paths (files or directories) that did not exist before. */
  created: string[];
  /** Renames performed, in order. */
  moved: { from: string; to: string }[];
  /** Changes on the SSH host of the conversation, when there were any. */
  remote?: RemoteSteps | undefined;
  warnings: string[];
  error?: string | undefined;
  /** Id of the entry this restore undid. */
  restores?: string | undefined;
  /** ISO time an interrupted entry was marked as resolved. */
  resolvedAt?: string | undefined;
}

export const JOURNAL_FILE_NAME = 'journal.jsonl';

export function newJournalId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

/** Status as shown to the person: an entry still running when listed was interrupted. */
export function displayStatus(entry: JournalEntry): string {
  return entry.status === 'running' ? 'interrupted' : entry.status;
}

export class Journal {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, JOURNAL_FILE_NAME);
  }

  async list(): Promise<JournalEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: JournalEntry[] = [];
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch {
        // A torn last line from an interrupted write is skipped, not fatal.
      }
    }
    return entries;
  }

  async get(id: string): Promise<JournalEntry | undefined> {
    return (await this.list()).find((entry) => entry.id === id);
  }

  /** Entries left "running" by an earlier run, oldest first, optionally without one id. */
  async interrupted(except?: string): Promise<JournalEntry[]> {
    return (await this.list()).filter((entry) => entry.status === 'running' && entry.id !== except);
  }

  async append(entry: JournalEntry): Promise<void> {
    await appendFileDurable(this.file, `${JSON.stringify(entry)}\n`);
  }

  /** Replaces the entry with the same id; the file is small, so it is rewritten whole. */
  async update(entry: JournalEntry): Promise<void> {
    const entries = await this.list();
    const index = entries.findIndex((candidate) => candidate.id === entry.id);
    if (index === -1) entries.push(entry);
    else entries[index] = entry;
    await writeFileAtomic(this.file, entries.map((candidate) => JSON.stringify(candidate)).join('\n') + '\n', { sync: true });
  }

  /**
   * Marks an interrupted entry as resolved: its files stay as they are. The
   * lists stay too, so `restore <id>` can still undo it later.
   */
  async resolve(id: string): Promise<JournalEntry> {
    const entry = await this.get(id);
    if (!entry) throw new Error(`journal entry ${id} not found`);
    if (entry.status !== 'running') throw new Error(`${id} is ${displayStatus(entry)}; only interrupted operations can be resolved`);
    entry.status = 'resolved';
    entry.resolvedAt = new Date().toISOString();
    await this.update(entry);
    return entry;
  }
}
