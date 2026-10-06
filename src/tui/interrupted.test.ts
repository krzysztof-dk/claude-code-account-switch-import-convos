// The answers of the question about interrupted operations, as pure data;
// the question itself runs through the real process in index.test.ts.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { JournalEntry } from '../journal.ts';
import { interruptedAnswers } from './interrupted.ts';

/** An entry a process that died half-way leaves: still running, one file created. */
function entry(id: string, title = 'cut short'): JournalEntry {
  return {
    id,
    at: '2026-10-06T09:00:00.000Z',
    mode: 'copy',
    action: 'created',
    status: 'running',
    title,
    rootUuid: null,
    source: {},
    target: {},
    relation: 'new',
    backupDir: null,
    backedUp: [],
    created: ['/x/a'],
    moved: [],
    warnings: [],
  };
}

const DESCRIBED = (id: string): string => `${id}: copy "cut short", started 2026-10-06T09:00:00.000Z, 1 created, 0 moved, 0 backed up so far`;

describe('tui: the answers about an interrupted operation', () => {
  it('offers Undo, Leave and Exit for the last entry, and the two "all" answers before that', () => {
    const last = interruptedAnswers([entry('one')], [], []);
    assert.deepEqual(
      last.map((answer) => answer.value),
      ['undo', 'leave', 'exit'],
    );
    assert.equal(last[0]?.confirm, undefined, 'the answer for this one entry is taken at once');
    assert.equal(last[1]?.confirm, undefined);

    const both = interruptedAnswers([entry('one'), entry('two')], [], []);
    assert.deepEqual(
      both.map((answer) => answer.value),
      ['undo', 'leave', 'undo-all', 'leave-all', 'exit'],
    );
    assert.equal(both[2]?.label, 'Undo all 2 remaining');
    assert.equal(both[2]?.hint, 'this one and the 1 after it; asks to confirm first');
    assert.equal(both[2]?.confirm?.question, 'Undo all 2 remaining?');
    assert.ok(both[2]?.confirm?.note.startsWith('Each is restored in turn'), both[2]?.confirm?.note);
    assert.ok(both[2]?.confirm?.note.endsWith(`\n  ${DESCRIBED('one')}\n  ${DESCRIBED('two')}`), both[2]?.confirm?.note);
    assert.equal(both[3]?.label, 'Leave all 2 remaining');
    assert.equal(both[3]?.confirm?.question, 'Leave all 2 as they are?');
    assert.ok(both[3]?.confirm?.note.startsWith('Each is marked resolved and its files stay as they are'), both[3]?.confirm?.note);
  });

  it('the Exit note recaps what was undone and left so far, and what stays interrupted', () => {
    const fresh = interruptedAnswers([entry('one')], [], []);
    assert.equal(fresh[2]?.label, 'Exit');
    assert.equal(fresh[2]?.hint, 'change nothing more now; asks to confirm first');
    assert.equal(fresh[2]?.confirm?.question, 'Exit now?');
    assert.equal(
      fresh[2]?.confirm?.note,
      `Undone so far: nothing.\nStill interrupted, asked about again before the next write:\n  ${DESCRIBED('one')}\nNothing else changes now.`,
    );

    const later = interruptedAnswers([entry('three')], [entry('one', 'first')], [entry('two', 'second')]);
    assert.equal(
      later[2]?.confirm?.note,
      'Undone so far (stays undone; a finished restore is final):\n  one: copy "first"\n' +
        'Left as they are so far (resolved):\n  two: copy "second"\n' +
        `Still interrupted, asked about again before the next write:\n  ${DESCRIBED('three')}\nNothing else changes now.`,
    );
  });
});
