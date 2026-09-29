import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareChains, consistencyWarnings } from './compare.ts';

describe('compareChains', () => {
  const chain = ['a', 'b', 'c', 'd'];

  it('identical chains', () => {
    assert.deepEqual(compareChains(chain, [...chain]), { relation: 'identical', commonPrefix: 4, sourceExtra: 0, targetExtra: 0 });
  });

  it('target behind: the source continued the conversation', () => {
    assert.deepEqual(compareChains(chain, ['a', 'b']), { relation: 'target-behind', commonPrefix: 2, sourceExtra: 2, targetExtra: 0 });
  });

  it('target ahead: the target continued it', () => {
    assert.deepEqual(compareChains(['a', 'b'], chain), { relation: 'target-ahead', commonPrefix: 2, sourceExtra: 0, targetExtra: 2 });
  });

  it('diverged: both continued from a shared point', () => {
    assert.deepEqual(compareChains(['a', 'b', 'x'], ['a', 'b', 'y', 'z']), { relation: 'diverged', commonPrefix: 2, sourceExtra: 1, targetExtra: 2 });
  });

  it('unrelated: nothing in common', () => {
    assert.equal(compareChains(['a', 'b'], ['x', 'y']).relation, 'unrelated');
  });

  it('empty chains', () => {
    assert.equal(compareChains([], []).relation, 'identical');
    assert.equal(compareChains(['a'], []).relation, 'target-behind');
    assert.equal(compareChains([], ['a']).relation, 'target-ahead');
  });
});

describe('consistencyWarnings', () => {
  it('is silent when facts agree or are unknown', () => {
    assert.deepEqual(consistencyWarnings({ record: { cwd: '/p', createdAt: 5 } }, { record: { cwd: '/p', createdAt: 5 } }), []);
    assert.deepEqual(consistencyWarnings({}, {}), []);
  });

  it('names every disagreement', () => {
    const warnings = consistencyWarnings(
      { record: { cwd: '/p', createdAt: 0 }, summary: { cwd: '/p', firstTimestamp: '2026-01-01T00:00:00Z', rootUuid: 'r1' } },
      { record: { cwd: '/q', createdAt: 5000 }, summary: { cwd: '/q', firstTimestamp: '2026-01-02T00:00:00Z', rootUuid: 'r2' } },
    );
    assert.equal(warnings.length, 4);
    assert.match(warnings[0] ?? '', /working directory/);
    assert.match(warnings[1] ?? '', /creation time/);
    assert.match(warnings[2] ?? '', /first transcript line/);
    assert.match(warnings[3] ?? '', /first message uuid/);
  });
});
