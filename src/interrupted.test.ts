import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeHostSteps, describeInterrupted, interruptedHelp } from './interrupted.ts';
import type { JournalEntry, RemoteSteps } from './journal.ts';

function entry(id: string, overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id,
    at: '2026-10-01T10:00:00.000Z',
    mode: 'copy',
    action: 'none',
    status: 'running',
    title: 'Fix the login bug',
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

function remote(overrides: Partial<RemoteSteps> = {}): RemoteSteps {
  return { host: { host: 'build@mini.local' }, created: [], moved: [], tombstoned: [], ...overrides };
}

describe('describeHostSteps', () => {
  it('is empty without host steps', () => {
    assert.equal(describeHostSteps(entry('a')), '');
  });

  it('is empty when the host part lists no steps', () => {
    assert.equal(describeHostSteps(entry('a', { remote: remote() })), '');
  });

  it('counts created, moved and tombstoned paths and names the host', () => {
    const steps = remote({
      created: ['/h/new.jsonl', '/h/new'],
      moved: [{ from: '/h/old.jsonl', to: '/h/old.jsonl.ccas-backup-x' }],
      tombstoned: ['/h/orig.jsonl'],
    });
    assert.equal(describeHostSteps(entry('a', { remote: steps })), ', 4 on build@mini.local');
  });

  it('shows the port of the host when it has one', () => {
    const steps = remote({ host: { host: 'build@mini.local', port: 2222 }, tombstoned: ['/h/orig.jsonl'] });
    assert.equal(describeHostSteps(entry('a', { remote: steps })), ', 1 on build@mini.local:2222');
  });
});

describe('describeInterrupted', () => {
  it('names the id, the mode, the start and the counts', () => {
    const text = describeInterrupted(
      entry('20261001T100000Z-abc123', {
        mode: 'move',
        created: ['/a'],
        moved: [
          { from: '/b', to: '/c' },
          { from: '/d', to: '/e' },
        ],
        backedUp: ['/f', '/g', '/h'],
      }),
    );
    assert.equal(text, '20261001T100000Z-abc123: move "Fix the login bug", started 2026-10-01T10:00:00.000Z, 1 created, 2 moved, 3 backed up so far');
  });

  it('truncates a long title to 50 characters', () => {
    const title = `${'word '.repeat(20)}end`;
    const text = describeInterrupted(entry('x', { title }));
    const quoted = /"([^"]*)"/.exec(text)?.[1] ?? '';
    assert.equal(quoted.length, 50);
    assert.ok(quoted.endsWith('...'));
  });

  it('adds the host steps before "so far"', () => {
    const text = describeInterrupted(entry('x', { remote: remote({ created: ['/h/new.jsonl'] }) }));
    assert.ok(text.endsWith('0 backed up, 1 on build@mini.local so far'), text);
  });
});

describe('interruptedHelp', () => {
  it('uses the singular for one operation', () => {
    const text = interruptedHelp([entry('one')]);
    const lines = text.split('\n');
    assert.equal(lines[0], '1 operation was interrupted and may have left files half-written:');
    assert.equal(lines.length, 3);
    assert.ok(lines[1]?.startsWith('  one: copy'));
  });

  it('uses the plural and lists every operation', () => {
    const text = interruptedHelp([entry('one'), entry('two')]);
    const lines = text.split('\n');
    assert.equal(lines[0], '2 operations were interrupted and may have left files half-written:');
    assert.ok(lines[1]?.startsWith('  one: '));
    assert.ok(lines[2]?.startsWith('  two: '));
  });

  it('names both commands', () => {
    const last = interruptedHelp([entry('one')]).split('\n').at(-1) ?? '';
    assert.match(last, /"ccas restore <id>"/);
    assert.match(last, /"ccas resolve <id>"/);
  });
});
