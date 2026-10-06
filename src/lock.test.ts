import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LOCK_FILE_NAME, LockHeldError, acquireLock } from './lock.ts';

/** A pid no process on macOS can have (pids stop at 99998). */
const DEAD_PID = 4194303;

describe('lock', () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ccas-lock-'));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('takes a free lock for this process, refuses a second taker while it lives, and releases it', async () => {
    const dir = path.join(root, 'free');
    const lock = await acquireLock(dir);
    assert.equal(lock.file, path.join(dir, LOCK_FILE_NAME));
    assert.equal(lock.takenOverFrom, null);
    const written = JSON.parse(await readFile(lock.file, 'utf8')) as { pid: number; startedAt: string };
    assert.equal(written.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(written.startedAt)));
    assert.equal((await stat(lock.file)).mode & 0o777, 0o600, 'the lock file is private');
    await assert.rejects(
      () => acquireLock(dir),
      (error: unknown) => error instanceof LockHeldError && error.holder.pid === process.pid && new RegExp(`PID ${process.pid}`).test(error.message),
    );
    await lock.release();
    await assert.rejects(() => stat(lock.file), /ENOENT/);
    // Free again: the next taker gets it without a note.
    const again = await acquireLock(dir);
    assert.equal(again.takenOverFrom, null);
    await again.release();
  });

  it('takes over the lock of a process that is gone, and says whose it was', async () => {
    const dir = path.join(root, 'dead');
    const file = path.join(dir, LOCK_FILE_NAME);
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify({ pid: DEAD_PID, startedAt: '2026-10-05T10:00:00.000Z' }), { mode: 0o600 });
    const lock = await acquireLock(dir);
    assert.deepEqual(lock.takenOverFrom, { pid: DEAD_PID, startedAt: '2026-10-05T10:00:00.000Z' });
    assert.equal((JSON.parse(await readFile(file, 'utf8')) as { pid: number }).pid, process.pid);
    await lock.release();
  });

  it('treats a torn or foreign lock file as a leftover', async () => {
    const dir = path.join(root, 'torn');
    const file = path.join(dir, LOCK_FILE_NAME);
    await mkdir(dir, { recursive: true });
    await writeFile(file, '{"pid": 12', { mode: 0o600 });
    const lock = await acquireLock(dir);
    assert.equal(lock.takenOverFrom, null, 'nothing readable to report');
    assert.equal((JSON.parse(await readFile(file, 'utf8')) as { pid: number }).pid, process.pid);
    await lock.release();
  });

  it('keeps refusing while the holder is alive according to the liveness check', async () => {
    const dir = path.join(root, 'alive');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, LOCK_FILE_NAME), JSON.stringify({ pid: DEAD_PID, startedAt: 'x' }), { mode: 0o600 });
    // With every pid reported alive (as the sandbox does, EPERM), the leftover counts as held.
    await assert.rejects(() => acquireLock(dir, () => true), (error: unknown) => error instanceof LockHeldError && error.holder.pid === DEAD_PID);
    // With the pid reported dead it is taken over.
    const lock = await acquireLock(dir, () => false);
    assert.equal(lock.takenOverFrom?.pid, DEAD_PID);
    await lock.release();
  });

  it('release leaves a lock that another process took over meanwhile', async () => {
    const dir = path.join(root, 'stolen');
    const lock = await acquireLock(dir);
    await writeFile(lock.file, JSON.stringify({ pid: process.pid + 1, startedAt: 'later' }));
    await lock.release();
    assert.equal((JSON.parse(await readFile(lock.file, 'utf8')) as { pid: number }).pid, process.pid + 1, 'not ours any more, so left alone');
  });
});
