import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { destroyWorld, makeWorld, type World } from '../test/fixtures.ts';
import { displayStatus, Journal, JOURNAL_FILE_NAME, newJournalId, type JournalEntry, type JournalStatus } from './journal.ts';

/** A journal entry with empty step lists; tests set what they look at. */
function entry(id: string, status: JournalStatus = 'running', overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id,
    at: '2026-10-01T10:00:00.000Z',
    mode: 'copy',
    action: 'none',
    status,
    title: `entry ${id}`,
    rootUuid: null,
    source: {},
    target: {},
    relation: null,
    backupDir: null,
    backedUp: [],
    created: [],
    moved: [],
    warnings: [],
    ...overrides,
  };
}

describe('newJournalId', () => {
  it('is a UTC timestamp followed by six hex digits', () => {
    assert.match(newJournalId(), /^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  });

  it('gives a different id on every call', () => {
    assert.notEqual(newJournalId(), newJournalId());
  });
});

describe('displayStatus', () => {
  it('shows a running entry as interrupted', () => {
    assert.equal(displayStatus(entry('a', 'running')), 'interrupted');
  });

  it('shows every other status as it is', () => {
    for (const status of ['done', 'failed', 'restored', 'resolved'] as const) assert.equal(displayStatus(entry('a', status)), status);
  });
});

describe('Journal', () => {
  let world: World;
  let journal: Journal;
  let file: string;
  let dataDir: string;
  let counter = 0;

  before(async () => {
    world = await makeWorld();
  });

  after(async () => {
    await destroyWorld(world);
  });

  /** Each test gets a journal of its own in a fresh data directory. */
  const fresh = (): void => {
    counter += 1;
    dataDir = path.join(world.paths.dataDir, `case-${counter}`);
    journal = new Journal(dataDir);
    file = path.join(dataDir, JOURNAL_FILE_NAME);
  };

  it('lists nothing when the file does not exist', async () => {
    fresh();
    assert.deepEqual(await journal.list(), []);
    assert.equal(await journal.get('missing'), undefined);
  });

  it('appends entries as one JSON line each, in order', async () => {
    fresh();
    await journal.append(entry('one'));
    await journal.append(entry('two', 'done'));
    const lines = (await readFile(file, 'utf8')).split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[2], '');
    assert.deepEqual(
      (await journal.list()).map((listed) => listed.id),
      ['one', 'two'],
    );
    assert.deepEqual(await journal.get('two'), entry('two', 'done'));
    assert.equal(await journal.get('three'), undefined);
  });

  it('skips a torn last line and keeps the entries before it', async () => {
    fresh();
    await journal.append(entry('one'));
    await journal.append(entry('two'));
    // What a write cut short half-way leaves: the start of a JSON object, no newline.
    await appendFile(file, '{"id":"three","at":"2026-10');
    assert.deepEqual(
      (await journal.list()).map((listed) => listed.id),
      ['one', 'two'],
    );
  });

  it('replaces an entry in place on update', async () => {
    fresh();
    await journal.append(entry('one'));
    await journal.append(entry('two'));
    await journal.append(entry('three'));
    await journal.update(entry('two', 'done', { created: ['/x'] }));
    const listed = await journal.list();
    assert.deepEqual(
      listed.map((candidate) => [candidate.id, candidate.status]),
      [
        ['one', 'running'],
        ['two', 'done'],
        ['three', 'running'],
      ],
    );
    assert.deepEqual(listed[1]?.created, ['/x']);
  });

  it('appends an entry with an unknown id on update', async () => {
    fresh();
    await journal.append(entry('one'));
    await journal.update(entry('new'));
    assert.deepEqual(
      (await journal.list()).map((listed) => listed.id),
      ['one', 'new'],
    );
  });

  it('creates the file on the first update', async () => {
    fresh();
    await journal.update(entry('only'));
    assert.deepEqual(
      (await journal.list()).map((listed) => listed.id),
      ['only'],
    );
  });

  it('lists running entries as interrupted, oldest first, without the excepted id', async () => {
    fresh();
    await journal.append(entry('r1', 'running'));
    await journal.append(entry('d', 'done'));
    await journal.append(entry('r2', 'running'));
    await journal.append(entry('f', 'failed'));
    assert.deepEqual(
      (await journal.interrupted()).map((listed) => listed.id),
      ['r1', 'r2'],
    );
    assert.deepEqual(
      (await journal.interrupted('r1')).map((listed) => listed.id),
      ['r2'],
    );
  });

  it('resolves a running entry and keeps its lists', async () => {
    fresh();
    await journal.append(entry('r', 'running', { created: ['/a'], moved: [{ from: '/b', to: '/c' }] }));
    const resolved = await journal.resolve('r');
    assert.equal(resolved.status, 'resolved');
    assert.ok(resolved.resolvedAt && Number.isFinite(Date.parse(resolved.resolvedAt)));
    const stored = await journal.get('r');
    assert.equal(stored?.status, 'resolved');
    assert.equal(stored?.resolvedAt, resolved.resolvedAt);
    assert.deepEqual(stored?.created, ['/a']);
    assert.deepEqual(stored?.moved, [{ from: '/b', to: '/c' }]);
  });

  it('refuses to resolve an entry that is not running and names its status', async () => {
    fresh();
    for (const status of ['done', 'failed', 'restored', 'resolved'] as const) {
      await journal.append(entry(`e-${status}`, status));
      await assert.rejects(journal.resolve(`e-${status}`), new RegExp(`e-${status} is ${status}; only interrupted operations can be resolved`));
      assert.equal((await journal.get(`e-${status}`))?.status, status);
    }
  });

  it('refuses to resolve an id that is not in the journal', async () => {
    fresh();
    await assert.rejects(journal.resolve('nope'), /journal entry nope not found/);
  });
});
