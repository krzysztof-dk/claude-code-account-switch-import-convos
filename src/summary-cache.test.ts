import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { destroyWorld, makeWorld, readJson, type World } from '../test/fixtures.ts';
import { SUMMARY_CACHE_FILE_NAME, SummaryCache } from './summary-cache.ts';
import type { TranscriptSummary } from './transcripts.ts';

function summary(rootUuid: string): TranscriptSummary {
  return {
    rootUuid,
    uuidChain: [rootUuid, `${rootUuid}-2`],
    lineCount: 3,
    unparsableLines: 0,
    messageCount: 2,
    promptCount: 1,
    firstTimestamp: '2026-09-01T10:00:00.000Z',
    lastTimestamp: '2026-09-01T10:00:01.000Z',
    cwd: '/Volumes/Store/Dev/alpha',
    version: '2.1.275',
    entrypoints: ['claude-desktop'],
    bridge: null,
    emails: [],
    emailSightings: [],
    customTitle: null,
    firstUserText: 'prompt 1',
    lastModel: 'claude-opus-5',
    sessionIds: ['cli-id'],
  };
}

const TRANSCRIPT = '/claude/projects/-alpha/cli-id.jsonl';

describe('SummaryCache', () => {
  let world: World;
  let counter = 0;

  before(async () => {
    world = await makeWorld();
  });

  after(async () => {
    await destroyWorld(world);
  });

  const freshDir = async (): Promise<string> => {
    counter += 1;
    const dir = path.join(world.paths.dataDir, `case-${counter}`);
    await mkdir(dir, { recursive: true });
    return dir;
  };

  /** Writes a cache with one entry and returns its directory and the parsed file. */
  const savedCache = async (): Promise<{ dir: string; data: { version: unknown; entries: Record<string, unknown> } }> => {
    const dir = await freshDir();
    const cache = await SummaryCache.load(dir);
    cache.set(TRANSCRIPT, 100, 5000, summary('r1'));
    await cache.save();
    return { dir, data: await readJson(path.join(dir, SUMMARY_CACHE_FILE_NAME)) };
  };

  it('is empty when the file does not exist', async () => {
    const cache = await SummaryCache.load(await freshDir());
    assert.equal(cache.get(TRANSCRIPT, 100, 5000), undefined);
  });

  it('is empty when the file is corrupt, and a save replaces it', async () => {
    const dir = await freshDir();
    const file = path.join(dir, SUMMARY_CACHE_FILE_NAME);
    await writeFile(file, '{"version":3,"entries":{');
    const cache = await SummaryCache.load(dir);
    assert.equal(cache.get(TRANSCRIPT, 100, 5000), undefined);
    cache.set(TRANSCRIPT, 100, 5000, summary('r1'));
    await cache.save();
    assert.deepEqual((await SummaryCache.load(dir)).get(TRANSCRIPT, 100, 5000), summary('r1'));
  });

  it('is empty when the file has an older version', async () => {
    const { dir, data } = await savedCache();
    assert.equal(typeof data.version, 'number');
    await writeFile(path.join(dir, SUMMARY_CACHE_FILE_NAME), JSON.stringify({ ...data, version: (data.version as number) - 1 }));
    assert.equal((await SummaryCache.load(dir)).get(TRANSCRIPT, 100, 5000), undefined);
  });

  it('returns a summary only when both size and modification time match', async () => {
    const cache = await SummaryCache.load(await freshDir());
    cache.set(TRANSCRIPT, 100, 5000, summary('r1'));
    assert.deepEqual(cache.get(TRANSCRIPT, 100, 5000), summary('r1'));
    assert.equal(cache.get(TRANSCRIPT, 101, 5000), undefined);
    assert.equal(cache.get(TRANSCRIPT, 100, 5001), undefined);
    assert.equal(cache.get('/claude/projects/-alpha/other.jsonl', 100, 5000), undefined);
  });

  it('replaces the entry of a path on set', async () => {
    const cache = await SummaryCache.load(await freshDir());
    cache.set(TRANSCRIPT, 100, 5000, summary('r1'));
    cache.set(TRANSCRIPT, 200, 6000, summary('r2'));
    assert.equal(cache.get(TRANSCRIPT, 100, 5000), undefined);
    assert.deepEqual(cache.get(TRANSCRIPT, 200, 6000), summary('r2'));
  });

  it('writes nothing on save before anything was set', async () => {
    const dir = await freshDir();
    await (await SummaryCache.load(dir)).save();
    await assert.rejects(stat(path.join(dir, SUMMARY_CACHE_FILE_NAME)), { code: 'ENOENT' });
  });

  it('writes once after a set and leaves the file alone on the next save', async () => {
    const dir = await freshDir();
    const file = path.join(dir, SUMMARY_CACHE_FILE_NAME);
    const cache = await SummaryCache.load(dir);
    cache.set(TRANSCRIPT, 100, 5000, summary('r1'));
    await cache.save();
    const first = await stat(file);
    await cache.save();
    const second = await stat(file);
    // A rewrite renames a new file over the old one, so the inode would change too.
    assert.equal(second.mtimeMs, first.mtimeMs);
    assert.equal(second.ino, first.ino);
  });

  it('writes again after a later set', async () => {
    const dir = await freshDir();
    const cache = await SummaryCache.load(dir);
    cache.set(TRANSCRIPT, 100, 5000, summary('r1'));
    await cache.save();
    cache.set('/claude/projects/-alpha/second.jsonl', 7, 8, summary('r2'));
    await cache.save();
    assert.deepEqual((await SummaryCache.load(dir)).get('/claude/projects/-alpha/second.jsonl', 7, 8), summary('r2'));
  });

  it('writes the version and the entries keyed by path', async () => {
    const { dir, data } = await savedCache();
    assert.equal(typeof data.version, 'number');
    assert.deepEqual(data.entries, { [TRANSCRIPT]: { sizeBytes: 100, mtimeMs: 5000, summary: summary('r1') } });
    assert.deepEqual((await SummaryCache.load(dir)).get(TRANSCRIPT, 100, 5000), summary('r1'));
  });
});
