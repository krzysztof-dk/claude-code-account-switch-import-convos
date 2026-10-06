import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { destroyWorld, hostHome, hostProjectDir, localHostRunner, makeWorld, type World } from '../test/fixtures.ts';
import { mirrorPath, pathExists } from './fsx.ts';
import { Journal, type JournalEntry } from './journal.ts';
import { OperationLog, type OperationFields } from './operation-log.ts';
import type { HostRunner, HostTarget } from './ssh-host.ts';

/** What the disk looked like at the moment the operation log asked the journal to write. */
interface UpdateSnapshot {
  /** The entry as it was handed to update. */
  entry: JournalEntry;
  /** Whether the watched path existed then, null when nothing was watched. */
  watchedExists: boolean | null;
  /** The entry as a separate reader found it on disk once update returned. */
  onDisk: JournalEntry | undefined;
}

/**
 * A journal that notes, at every update, whether a watched path still exists
 * and what a fresh reader of the file sees once the update returns. A step is
 * write-ahead when the journal names it on disk while its path is still
 * where it was before the step.
 */
class RecordingJournal extends Journal {
  private readonly dataDir: string;
  watched: string | null = null;
  readonly snapshots: UpdateSnapshot[] = [];

  constructor(dataDir: string) {
    super(dataDir);
    this.dataDir = dataDir;
  }

  override async update(entry: JournalEntry): Promise<void> {
    const watchedExists = this.watched === null ? null : await pathExists(this.watched);
    await super.update(entry);
    const onDisk = await new Journal(this.dataDir).get(entry.id);
    this.snapshots.push({ entry: structuredClone(entry), watchedExists, onDisk });
  }
}

const FIELDS: OperationFields = {
  mode: 'copy',
  action: 'none',
  title: 'Operation log test',
  rootUuid: null,
  source: {},
  target: {},
  relation: null,
};

const HOST: HostTarget = { host: 'build@mini.local', port: 2222 };

describe('OperationLog', () => {
  let world: World;
  let counter = 0;

  before(async () => {
    world = await makeWorld();
  });

  after(async () => {
    await destroyWorld(world);
  });

  /**
   * A started operation in a data directory of its own, plus a scratch
   * directory for the files it works on.
   */
  const setup = async (host?: HostRunner): Promise<{ log: OperationLog; journal: RecordingJournal; files: string; backupsDir: string }> => {
    counter += 1;
    const dataDir = path.join(world.paths.dataDir, `case-${counter}`);
    const files = path.join(world.root, 'files', `case-${counter}`);
    await mkdir(files, { recursive: true });
    const journal = new RecordingJournal(dataDir);
    const backupsDir = path.join(dataDir, 'backups');
    const log = new OperationLog({ journal, backupsDir, at: Date.UTC(2026, 9, 1, 10, 0, 0), host }, FIELDS);
    await log.start();
    return { log, journal, files, backupsDir };
  };

  describe('start', () => {
    it('appends a running entry with empty step lists', async () => {
      const { log, journal } = await setup();
      assert.equal(log.entry.at, '2026-10-01T10:00:00.000Z');
      const stored = await journal.get(log.entry.id);
      assert.equal(stored?.status, 'running');
      assert.equal(stored?.title, 'Operation log test');
      assert.equal(stored?.backupDir, null);
      assert.deepEqual([stored?.backedUp, stored?.created, stored?.moved, stored?.warnings], [[], [], [], []]);
    });
  });

  describe('write-ahead order', () => {
    it('journals moveAway on disk while the path is still at its source', async () => {
      const { log, journal, files, backupsDir } = await setup();
      const target = path.join(files, 'record.json');
      await writeFile(target, 'record');
      journal.watched = target;
      await log.moveAway(target);
      assert.equal(journal.snapshots.length, 1);
      const [snapshot] = journal.snapshots;
      assert.equal(snapshot?.watchedExists, true);
      assert.deepEqual(snapshot?.onDisk?.moved, [{ from: target, to: mirrorPath(path.join(backupsDir, log.entry.id), target) }]);
    });

    it('journals move on disk while the path is still at its source', async () => {
      const { log, journal, files } = await setup();
      const from = path.join(files, 'a.jsonl');
      const to = path.join(files, 'elsewhere', 'a.jsonl');
      await writeFile(from, 'line\n');
      journal.watched = from;
      await log.move(from, to);
      const [snapshot] = journal.snapshots;
      assert.equal(snapshot?.watchedExists, true);
      assert.deepEqual(snapshot?.onDisk?.moved, [{ from, to }]);
      assert.equal(await pathExists(from), false);
      assert.equal(await readFile(to, 'utf8'), 'line\n');
    });

    it('journals a created path on disk before the caller creates it', async () => {
      const { log, journal, files } = await setup();
      const created = path.join(files, 'new.jsonl');
      journal.watched = created;
      await log.created(created);
      const [snapshot] = journal.snapshots;
      assert.equal(snapshot?.watchedExists, false);
      assert.deepEqual(snapshot?.onDisk?.created, [created]);
    });

    it('journals every host step on disk before it returns', async () => {
      const { log, journal } = await setup();
      await log.remoteCreated(HOST, '/h/new.jsonl');
      await log.remoteMoved(HOST, '/h/old.jsonl', '/h/old.jsonl.ccas-backup-x');
      await log.remoteTombstoned(HOST, '/h/orig.jsonl');
      assert.deepEqual(
        journal.snapshots.map((snapshot) => [snapshot.onDisk?.remote?.created.length, snapshot.onDisk?.remote?.moved.length, snapshot.onDisk?.remote?.tombstoned.length]),
        [
          [1, 0, 0],
          [1, 1, 0],
          [1, 1, 1],
        ],
      );
    });
  });

  describe('backup', () => {
    it('records a backup only once the copy exists in the mirror', async () => {
      const { log, journal, files, backupsDir } = await setup();
      const original = path.join(files, 'record.json');
      await writeFile(original, 'before');
      const mirror = mirrorPath(path.join(backupsDir, log.entry.id), original);
      journal.watched = mirror;
      await log.backup(original);
      const [snapshot] = journal.snapshots;
      assert.equal(snapshot?.watchedExists, true);
      assert.deepEqual(snapshot?.onDisk?.backedUp, [original]);
      assert.equal(log.entry.backupDir, path.join(backupsDir, log.entry.id));
      assert.equal(snapshot?.onDisk?.backupDir, log.entry.backupDir);
      assert.equal(await readFile(mirror, 'utf8'), 'before');
      assert.equal(await readFile(original, 'utf8'), 'before');
    });

    it('copies a directory with everything in it', async () => {
      const { log, files, backupsDir } = await setup();
      const dir = path.join(files, 'sidecar');
      await mkdir(path.join(dir, 'subagents'), { recursive: true });
      await writeFile(path.join(dir, 'subagents', 'agent-1.jsonl'), 'agent\n');
      await log.backup(dir);
      assert.equal(await readFile(path.join(mirrorPath(path.join(backupsDir, log.entry.id), dir), 'subagents', 'agent-1.jsonl'), 'utf8'), 'agent\n');
    });

    it('records nothing for a path that does not exist', async () => {
      const { log, journal, files } = await setup();
      await log.backup(path.join(files, 'missing.json'));
      assert.equal(journal.snapshots.length, 0);
      assert.deepEqual(log.entry.backedUp, []);
      assert.equal(log.entry.backupDir, null);
    });
  });

  describe('moveAway', () => {
    it('moves the path into the mirror and records the move', async () => {
      const { log, files, backupsDir } = await setup();
      const target = path.join(files, 'record.json');
      await writeFile(target, 'record');
      await log.moveAway(target);
      const mirror = mirrorPath(path.join(backupsDir, log.entry.id), target);
      assert.equal(await pathExists(target), false);
      assert.equal(await readFile(mirror, 'utf8'), 'record');
      assert.deepEqual(log.entry.moved, [{ from: target, to: mirror }]);
      assert.equal(log.entry.backupDir, path.join(backupsDir, log.entry.id));
    });

    it('does nothing for a path that does not exist', async () => {
      const { log, journal, files } = await setup();
      await log.moveAway(path.join(files, 'missing.json'));
      assert.equal(journal.snapshots.length, 0);
      assert.deepEqual(log.entry.moved, []);
    });
  });

  describe('created', () => {
    it('only records the path', async () => {
      const { log, files } = await setup();
      const created = path.join(files, 'new.jsonl');
      await log.created(created);
      assert.deepEqual(log.entry.created, [created]);
      assert.equal(await pathExists(created), false);
    });
  });

  describe('host steps', () => {
    it('start the host part on first use and accumulate', async () => {
      const { log } = await setup();
      assert.equal(log.entry.remote, undefined);
      await log.remoteCreated(HOST, '/h/new.jsonl');
      await log.remoteCreated(HOST, '/h/new');
      await log.remoteMoved(HOST, '/h/old.jsonl', '/h/old.jsonl.ccas-backup-x');
      await log.remoteTombstoned(HOST, '/h/orig.jsonl');
      await log.remoteTombstoned(HOST, '/h/other.jsonl');
      assert.deepEqual(log.entry.remote, {
        host: HOST,
        created: ['/h/new.jsonl', '/h/new'],
        moved: [{ from: '/h/old.jsonl', to: '/h/old.jsonl.ccas-backup-x' }],
        tombstoned: ['/h/orig.jsonl', '/h/other.jsonl'],
      });
    });

    it('can start with a move or a tombstone', async () => {
      const moved = await setup();
      await moved.log.remoteMoved(HOST, '/h/a', '/h/b');
      assert.deepEqual(moved.log.entry.remote, { host: HOST, created: [], moved: [{ from: '/h/a', to: '/h/b' }], tombstoned: [] });
      const tombstoned = await setup();
      await tombstoned.log.remoteTombstoned(HOST, '/h/c.jsonl');
      assert.deepEqual(tombstoned.log.entry.remote, { host: HOST, created: [], moved: [], tombstoned: ['/h/c.jsonl'] });
    });
  });

  describe('warn', () => {
    it('adds the warning to the entry and writes it with the next step', async () => {
      const { log, journal, files } = await setup();
      log.warn('first');
      log.warn('second');
      assert.deepEqual(log.entry.warnings, ['first', 'second']);
      assert.deepEqual((await journal.get(log.entry.id))?.warnings, []);
      await log.created(path.join(files, 'x'));
      assert.deepEqual((await journal.get(log.entry.id))?.warnings, ['first', 'second']);
    });
  });

  describe('finish', () => {
    it('marks the entry done with the action', async () => {
      const { log, journal } = await setup();
      await log.finish('created');
      const stored = await journal.get(log.entry.id);
      assert.equal(stored?.status, 'done');
      assert.equal(stored?.action, 'created');
    });
  });

  describe('fail', () => {
    it('marks the entry failed with the message of an Error', async () => {
      const { log, journal } = await setup();
      await log.fail(new Error('disk full'));
      const stored = await journal.get(log.entry.id);
      assert.equal(stored?.status, 'failed');
      assert.equal(stored?.error, 'disk full');
    });

    it('marks the entry failed with a string as it is', async () => {
      const { log, journal } = await setup();
      await log.fail('guard closed');
      const stored = await journal.get(log.entry.id);
      assert.equal(stored?.status, 'failed');
      assert.equal(stored?.error, 'guard closed');
    });
  });

  describe('rollback', () => {
    it('sets created paths aside under rolled-back and tolerates ones never created', async () => {
      const { log, files, backupsDir } = await setup();
      const file = path.join(files, 'new.jsonl');
      const dir = path.join(files, 'new-sidecar');
      const never = path.join(files, 'never.jsonl');
      await log.created(file);
      await writeFile(file, 'copy\n');
      await log.created(dir);
      await mkdir(path.join(dir, 'tool-results'), { recursive: true });
      await writeFile(path.join(dir, 'tool-results', 'r.txt'), 'result');
      await log.created(never);
      await log.rollback();
      const rolledBack = path.join(backupsDir, log.entry.id, 'rolled-back');
      assert.equal(await pathExists(file), false);
      assert.equal(await pathExists(dir), false);
      assert.equal(await readFile(mirrorPath(rolledBack, file), 'utf8'), 'copy\n');
      assert.equal(await readFile(path.join(mirrorPath(rolledBack, dir), 'tool-results', 'r.txt'), 'utf8'), 'result');
      assert.equal(await pathExists(mirrorPath(rolledBack, never)), false);
      assert.deepEqual(log.entry.created, []);
    });

    it('reverses moves, the newest first', async () => {
      const { log, files } = await setup();
      const first = path.join(files, 'first.json');
      const middle = path.join(files, 'middle.json');
      const last = path.join(files, 'last.json');
      await writeFile(first, 'content');
      // Two chained moves only come back in the right place when undone newest first.
      await log.move(first, middle);
      await log.move(middle, last);
      const away = path.join(files, 'away.json');
      await writeFile(away, 'away');
      await log.moveAway(away);
      await log.rollback();
      assert.equal(await readFile(first, 'utf8'), 'content');
      assert.equal(await pathExists(middle), false);
      assert.equal(await pathExists(last), false);
      assert.equal(await readFile(away, 'utf8'), 'away');
      assert.deepEqual(log.entry.moved, []);
    });

    it('copies backed-up files back over the changed originals', async () => {
      const { log, files } = await setup();
      const original = path.join(files, 'record.json');
      await writeFile(original, 'before');
      await log.backup(original);
      await writeFile(original, 'after');
      await log.rollback();
      assert.equal(await readFile(original, 'utf8'), 'before');
    });

    it('leaves a move whose both ends exist and warns about it', async () => {
      const { log, files } = await setup();
      const from = path.join(files, 'a.json');
      const to = path.join(files, 'b.json');
      await writeFile(from, 'a');
      await log.move(from, to);
      // What a move across volumes cut short between the copy and the delete leaves.
      await writeFile(from, 'a again');
      await log.rollback();
      assert.equal(await readFile(from, 'utf8'), 'a again');
      assert.equal(await readFile(to, 'utf8'), 'a');
      assert.deepEqual(log.entry.warnings, [`both ${from} and ${to} exist; left as they are`]);
    });

    it('undoes host steps through the host runner', async () => {
      const { log } = await setup(localHostRunner(hostHome(world)));
      const dir = hostProjectDir(world);
      await mkdir(dir, { recursive: true });
      const created = path.join(dir, `created-${log.entry.id}.jsonl`);
      const replaced = path.join(dir, `replaced-${log.entry.id}.jsonl`);
      const keptAside = `${replaced}.ccas-backup-${log.entry.id}`;
      await log.remoteCreated(HOST, created);
      await writeFile(created, 'copy on host\n');
      await log.remoteMoved(HOST, replaced, keptAside);
      await writeFile(keptAside, 'original on host\n');
      await log.remoteTombstoned(HOST, path.join(dir, 'tombstoned.jsonl'));
      await log.rollback();
      assert.equal(await pathExists(created), false);
      assert.equal(await readFile(`${created}.ccas-removed-${log.entry.id}`, 'utf8'), 'copy on host\n');
      assert.equal(await readFile(replaced, 'utf8'), 'original on host\n');
      assert.equal(await pathExists(keptAside), false);
      assert.deepEqual(log.entry.remote?.created, []);
      assert.deepEqual(log.entry.remote?.moved, []);
      assert.deepEqual(log.entry.remote?.tombstoned, [path.join(dir, 'tombstoned.jsonl')]);
      assert.deepEqual(log.entry.warnings, []);
    });

    it('warns with the host paths when no host runner was given', async () => {
      const { log } = await setup();
      await log.remoteCreated(HOST, '/h/new.jsonl');
      await log.remoteMoved(HOST, '/h/old.jsonl', '/h/old.jsonl.ccas-backup-x');
      await log.rollback();
      assert.equal(log.entry.warnings.length, 1);
      const warning = log.entry.warnings[0] ?? '';
      assert.match(warning, /^host changes not undone \(no way to reach the host was given\)/);
      assert.match(warning, /set aside \/h\/new\.jsonl and move back \/h\/old\.jsonl\.ccas-backup-x to \/h\/old\.jsonl$/);
      // The steps stay listed, so a later restore can still undo them.
      assert.deepEqual(log.entry.remote?.created, ['/h/new.jsonl']);
      assert.deepEqual(log.entry.remote?.moved, [{ from: '/h/old.jsonl', to: '/h/old.jsonl.ccas-backup-x' }]);
    });

    it('leaves the host alone when it has only tombstones', async () => {
      const { log } = await setup();
      await log.remoteTombstoned(HOST, '/h/orig.jsonl');
      await log.rollback();
      assert.deepEqual(log.entry.warnings, []);
    });
  });
});
