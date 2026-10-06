// Bookkeeping for one write operation: its journal entry and the backup
// directory every replaced or removed path is mirrored into.
//
// Write-ahead: each step that changes the disk (created, move, moveAway) is
// written to the journal, and flushed to the disk (journal.ts), before it
// happens. A process that dies half-way (killed, crashed, power cut) thus
// leaves an entry that still says "running" and lists every path the
// operation may have touched; `restore <id>` undoes exactly that and
// tolerates the steps that never happened. A backup is the one step recorded
// after the fact: restore copies a listed backup over the original, so a
// half-written backup must never be listed. Recording it late is safe,
// because the original is changed only after its backup completed.
//
// Steps on the SSH host of a conversation (ssh-host.ts) are recorded the
// same way, before the remote script runs, in the entry's `remote` part.
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { mirrorPath, moveTree, pathExists } from './fsx.ts';
import { newJournalId, type Journal, type JournalEntry, type RemoteSteps } from './journal.ts';
import { HostStepError, undoOnHost, type HostRunner, type HostTarget } from './ssh-host.ts';

/**
 * The parts of a journal entry the caller decides when an operation starts:
 * mode, the action expected so far, title, root uuid, both ends and the
 * relation found, and for a restore the id of the entry it undoes.
 * OperationLog fills in the rest (id, start time, status, step lists).
 */
export type OperationFields = Pick<JournalEntry, 'mode' | 'action' | 'title' | 'rootUuid' | 'source' | 'target' | 'relation'> & {
  restores?: string;
};

/**
 * Where an OperationLog writes and what it may use: the journal, the backups
 * root, the start time, and the host runner for undoing host steps in a
 * rollback.
 */
export interface OperationLogOptions {
  journal: Journal;
  /** <dataDir>/backups; this operation's mirror goes into <backupsDir>/<journal id>. */
  backupsDir: string;
  /** Epoch milliseconds the operation started. */
  at: number;
  /** Reaches the SSH host when a rollback has host steps to undo. */
  host?: HostRunner | undefined;
}

/**
 * The bookkeeping of one write operation (operations.ts): it opens the
 * journal entry, records each step before it happens (a backup once it is
 * complete), keeps the backup mirror under <backupsDir>/<journal id>,
 * closes the entry, and can roll back what it did so far.
 */
export class OperationLog {
  readonly entry: JournalEntry;
  private readonly backupDir: string;
  private readonly journal: Journal;
  private readonly host: HostRunner | undefined;

  constructor(options: OperationLogOptions, fields: OperationFields) {
    const id = newJournalId();
    this.journal = options.journal;
    this.host = options.host;
    this.backupDir = path.join(options.backupsDir, id);
    this.entry = {
      id,
      at: new Date(options.at).toISOString(),
      status: 'running',
      backupDir: null,
      backedUp: [],
      created: [],
      moved: [],
      warnings: [],
      ...fields,
    };
  }

  async start(): Promise<void> {
    await this.journal.append(this.entry);
  }

  /** Copies a file or directory into the backup mirror before it gets overwritten; journaled once the copy is complete. */
  async backup(absolutePath: string): Promise<void> {
    if (!(await pathExists(absolutePath))) return;
    await cp(absolutePath, mirrorPath(this.backupDir, absolutePath), { recursive: true, force: true });
    this.entry.backedUp.push(absolutePath);
    this.entry.backupDir = this.backupDir;
    await this.journal.update(this.entry);
  }

  /** Removes a file or directory by moving it into the backup mirror (journaled first). */
  async moveAway(absolutePath: string): Promise<void> {
    if (!(await pathExists(absolutePath))) return;
    const destination = mirrorPath(this.backupDir, absolutePath);
    this.entry.moved.push({ from: absolutePath, to: destination });
    this.entry.backupDir = this.backupDir;
    await this.journal.update(this.entry);
    await moveTree(absolutePath, destination);
  }

  /** Moves a file or directory (journaled first). */
  async move(from: string, to: string): Promise<void> {
    this.entry.moved.push({ from, to });
    await this.journal.update(this.entry);
    await moveTree(from, to);
  }

  /** Announces a path the operation is about to create (journaled before the caller creates it). */
  async created(absolutePath: string): Promise<void> {
    this.entry.created.push(absolutePath);
    await this.journal.update(this.entry);
  }

  /** The entry's record of host steps, started on first use; one operation works on one host. */
  private remote(target: HostTarget): RemoteSteps {
    this.entry.remote ??= { host: target, created: [], moved: [], tombstoned: [] };
    return this.entry.remote;
  }

  /** Announces a path about to be created on the host (journaled before the remote script runs). */
  async remoteCreated(target: HostTarget, hostPath: string): Promise<void> {
    this.remote(target).created.push(hostPath);
    await this.journal.update(this.entry);
  }

  /** Announces a path on the host about to be kept aside at `to` (journaled first). */
  async remoteMoved(target: HostTarget, from: string, to: string): Promise<void> {
    this.remote(target).moved.push({ from, to });
    await this.journal.update(this.entry);
  }

  /** Announces a host transcript about to get Remote Control tombstones (journaled first; not undone). */
  async remoteTombstoned(target: HostTarget, hostPath: string): Promise<void> {
    this.remote(target).tombstoned.push(hostPath);
    await this.journal.update(this.entry);
  }

  /** Adds a warning; it reaches the journal with the next step or when the entry is closed. */
  warn(message: string): void {
    this.entry.warnings.push(message);
  }

  async finish(action: JournalEntry['action']): Promise<void> {
    this.entry.action = action;
    this.entry.status = 'done';
    await this.journal.update(this.entry);
  }

  async fail(error: unknown): Promise<void> {
    this.entry.status = 'failed';
    this.entry.error = error instanceof Error ? error.message : String(error);
    await this.journal.update(this.entry);
  }

  /**
   * Undoes everything this operation did so far, newest step first: files it
   * created go into the backup mirror (never deleted), moves are reversed,
   * overwritten files come back from the backup, and host steps are undone
   * on the host (ssh-host.ts, undoOnHost). Used when the guard closes in the
   * middle of an operation or a host step fails. A move whose two ends both
   * exist (cut short across volumes) is left alone with a warning, as
   * restore does; so is a host that cannot be reached, with the paths to
   * look at.
   */
  async rollback(): Promise<void> {
    const remote = this.entry.remote;
    if (remote && (remote.created.length > 0 || remote.moved.length > 0)) {
      try {
        if (!this.host) throw new HostStepError(remote.host, 'unreachable', 'no way to reach the host was given');
        const undone = await undoOnHost(this.host, remote.host, { created: remote.created, moved: remote.moved, tag: this.entry.id });
        for (const warning of undone.warnings) this.warn(warning);
        remote.created = [];
        remote.moved = [];
      } catch (error) {
        this.warn(`host changes not undone (${error instanceof Error ? error.message : String(error)}); on the host, set aside ${remote.created.join(', ') || 'nothing'} and move back ${remote.moved.map((move) => `${move.to} to ${move.from}`).join(', ') || 'nothing'}`);
      }
    }
    for (const created of [...this.entry.created].reverse()) {
      if (await pathExists(created)) await moveTree(created, mirrorPath(path.join(this.backupDir, 'rolled-back'), created));
    }
    for (const move of [...this.entry.moved].reverse()) {
      const [atDestination, atSource] = await Promise.all([pathExists(move.to), pathExists(move.from)]);
      if (atDestination && atSource) {
        this.warn(`both ${move.from} and ${move.to} exist; left as they are`);
        continue;
      }
      if (atDestination) await moveTree(move.to, move.from);
    }
    for (const backed of this.entry.backedUp) {
      const mirror = mirrorPath(this.backupDir, backed);
      if (await pathExists(mirror)) await cp(mirror, backed, { recursive: true, force: true });
    }
    this.entry.created = [];
    this.entry.moved = [];
  }
}
