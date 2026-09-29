import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applySelection } from './transfer.ts';

describe('tui: choosing conversations', () => {
  const entries = ['a', 'b', 'c', 'd'];

  it('takes every conversation without picking any', () => {
    assert.deepEqual(applySelection(entries, 'all', []), ['a', 'b', 'c', 'd']);
    assert.deepEqual(applySelection(entries, 'all', [1]), ['a', 'b', 'c', 'd'], 'picks do not matter for all');
  });

  it('takes all but the picked ones, in list order', () => {
    assert.deepEqual(applySelection(entries, 'all-but', [3, 1]), ['a', 'c']);
    assert.deepEqual(applySelection(entries, 'all-but', []), ['a', 'b', 'c', 'd'], 'leaving out nothing is all');
  });

  it('takes only the picked ones, in list order', () => {
    assert.deepEqual(applySelection(entries, 'pick', [2, 0]), ['a', 'c']);
    assert.deepEqual(applySelection(entries, 'pick', []), []);
  });
});
