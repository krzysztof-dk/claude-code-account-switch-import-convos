// One ccas process at a time per data directory.
//
// The journal, the lineage file and the summary cache are rewritten whole
// (journal.ts, lineage.ts, summary-cache.ts), and an operation's steps are
// journaled one after another, so two processes writing into one data
// directory at the same time would interleave their entries and lose each
// other's updates. The README used to say that two processes were not
// supported and left it at that; since 2026-10-05 (review) a lock file
// enforces it for everything that writes: the TUI, transfer, restore and
// resolve. Dry runs and the read-only commands run without it: they only
// write the summary cache and accounts.json, each replaced atomically, so
// the worst case is one of them keeping an older cache.
//
// The lock is <dataDir>/lock, created exclusively (O_EXCL) and holding the
// pid and start time of its owner. Release happens in a finally block,
// which a SIGKILL or a power cut skips, so a lock whose pid is dead is a
// leftover and is taken over, with a note for the person; a lock whose pid
// is alive refuses with a message naming it. EPERM on the liveness check
// counts as alive, as in app-guard.ts: not knowing is not permission. Two
// processes finding the same dead lock race for it; the loser's exclusive
// create fails and it reads the winner's live pid on its second attempt.
//
// The lock is also removed when the process exits without reaching the
// finally block: the prompt library ends the process with process.exit(0)
// on Ctrl+C while a spinner runs (found by the TUI tests of 2026-10-06,
// @clack/core, block()). An "exit" listener removes the file
// synchronously, since nothing asynchronous runs after that event; the
// journal entry of an operation cut short that way stays "running" and the
// next run asks about it, as after any interruption.
import { readFileSync, rmSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { processAlive } from './app-guard.ts';

/** Name of the lock file inside the data directory; the README names it for the person who has to remove a leftover by hand. */
export const LOCK_FILE_NAME = 'lock';

/** What the lock file holds about its owner. */
export interface LockInfo {
  pid: number;
  /** ISO time the owner took the lock. */
  startedAt: string;
}

/** Thrown by acquireLock when another live ccas process holds the lock. */
export class LockHeldError extends Error {
  readonly file: string;
  readonly holder: LockInfo;

  constructor(file: string, holder: LockInfo) {
    super(`another ccas is running (PID ${holder.pid}, since ${holder.startedAt}); wait for it to finish, or remove ${file} if that process is gone`);
    this.name = 'LockHeldError';
    this.file = file;
    this.holder = holder;
  }
}

/** A held lock: where it is, whose leftover it replaced (if any), and how to let it go. */
export interface Lock {
  file: string;
  /** The dead process whose lock was taken over, for a note to the person; null when the lock was free. */
  takenOverFrom: LockInfo | null;
  /** Removes the lock when this process still owns it; a lock taken over by someone else meanwhile is left alone. */
  release(): Promise<void>;
}

/** The lock a file's text describes, or null when the text is torn or not a lock. */
function parseLock(text: string): LockInfo | null {
  try {
    const parsed = JSON.parse(text) as { pid?: unknown; startedAt?: unknown } | null;
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return { pid: parsed.pid, startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : 'an unknown time' };
  } catch {
    return null;
  }
}

/** The content of a lock file, or null when it is missing, torn or not a lock. */
async function readLock(file: string): Promise<LockInfo | null> {
  try {
    return parseLock(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Removes the lock file when this process still owns it, synchronously, so
 * it can run from an "exit" listener; a lock another process took over
 * meanwhile is left alone. Errors are swallowed: at exit there is nobody
 * to tell, and a lock left behind is taken over by the next run anyway.
 */
function releaseSync(file: string): void {
  try {
    if (parseLock(readFileSync(file, 'utf8'))?.pid === process.pid) rmSync(file, { force: true });
  } catch {
    // Gone or unreadable: nothing to release.
  }
}

/**
 * Takes the lock of a data directory for this process. Throws LockHeldError
 * when a live process holds it; takes over the lock of a dead one (and says
 * so in the result). `isAlive` is replaced in tests.
 */
export async function acquireLock(dataDir: string, isAlive: (pid: number) => boolean = processAlive): Promise<Lock> {
  const file = path.join(dataDir, LOCK_FILE_NAME);
  const own: LockInfo = { pid: process.pid, startedAt: new Date().toISOString() };
  await mkdir(dataDir, { recursive: true });
  let takenOverFrom: LockInfo | null = null;
  // Two attempts: the second one only after a dead lock was removed, and it
  // fails for good when another process took the lock in between.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(own), 'utf8');
      } finally {
        await handle.close();
      }
      // Belt and braces for an exit that skips the finally block (see the header).
      const atExit = (): void => releaseSync(file);
      process.once('exit', atExit);
      return {
        file,
        takenOverFrom,
        async release() {
          process.off('exit', atExit);
          const current = await readLock(file);
          if (current?.pid === process.pid) await rm(file, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = await readLock(file);
      if (holder && isAlive(holder.pid)) throw new LockHeldError(file, holder);
      // Dead, torn or not a lock at all: a leftover, taken over.
      takenOverFrom = holder;
      await rm(file, { force: true });
    }
  }
  const holder = (await readLock(file)) ?? { pid: 0, startedAt: 'an unknown time' };
  throw new LockHeldError(file, holder);
}
