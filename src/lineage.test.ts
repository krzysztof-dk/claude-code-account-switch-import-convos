import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ACCOUNT_A, ACCOUNT_B, destroyWorld, makeWorld, readJson, type World } from '../test/fixtures.ts';
import { LINEAGE_FILE_NAME, LineageStore, type LineageLink } from './lineage.ts';

function link(rootUuid: string, journalId: string, overrides: Partial<LineageLink> = {}): LineageLink {
  return {
    rootUuid,
    at: Date.UTC(2026, 9, 1, 10, 0, 0),
    journalId,
    mode: 'copy',
    action: 'created',
    sourceLineCount: 10,
    source: { ...ACCOUNT_A, sessionId: `local_${journalId}-source`, cliSessionId: `${journalId}-source-cli` },
    target: { ...ACCOUNT_B, sessionId: `local_${journalId}-target`, cliSessionId: `${journalId}-target-cli` },
    ...overrides,
  };
}

describe('LineageStore', () => {
  let world: World;
  let counter = 0;

  before(async () => {
    world = await makeWorld();
  });

  after(async () => {
    await destroyWorld(world);
  });

  /** A fresh data directory per test, so no test sees another one's file. */
  const freshDir = async (): Promise<string> => {
    counter += 1;
    const dir = path.join(world.paths.dataDir, `case-${counter}`);
    await mkdir(dir, { recursive: true });
    return dir;
  };

  it('starts empty when the file does not exist', async () => {
    const store = await LineageStore.load(await freshDir());
    assert.deepEqual(store.all(), []);
    assert.deepEqual(store.byRoot('anything'), []);
  });

  it('refuses a file that is not valid JSON, naming the file and what to do', async () => {
    const dir = await freshDir();
    const file = path.join(dir, LINEAGE_FILE_NAME);
    await writeFile(file, '{"version":1,"links":[');
    await assert.rejects(LineageStore.load(dir), (error: Error) => {
      assert.ok(error.message.startsWith(`${file} is not valid JSON`), error.message);
      assert.match(error.message, /fix it or restore it from a backup/);
      return true;
    });
  });

  it('refuses a file without a links list', async () => {
    const dir = await freshDir();
    const file = path.join(dir, LINEAGE_FILE_NAME);
    for (const text of ['{"version":1}', '{"version":1,"links":{}}', 'null', '[]']) {
      await writeFile(file, text);
      await assert.rejects(LineageStore.load(dir), (error: Error) => {
        assert.ok(error.message.startsWith(`${file} has no "links" list`), `${text}: ${error.message}`);
        assert.match(error.message, /fix it or restore it from a backup/);
        return true;
      });
    }
  });

  it('writes version 1 and the links, which a fresh load sees', async () => {
    const dir = await freshDir();
    const store = await LineageStore.load(dir);
    const first = link('root-1', 'j1');
    await store.add(first);
    assert.deepEqual(await readJson(path.join(dir, LINEAGE_FILE_NAME)), { version: 1, links: [first] });
    const reloaded = await LineageStore.load(dir);
    assert.deepEqual(reloaded.all(), [first]);
  });

  it('keeps earlier links when one is added after a reload', async () => {
    const dir = await freshDir();
    await (await LineageStore.load(dir)).add(link('root-1', 'j1'));
    const reloaded = await LineageStore.load(dir);
    await reloaded.add(link('root-2', 'j2'));
    assert.deepEqual(
      (await LineageStore.load(dir)).all().map((stored) => stored.journalId),
      ['j1', 'j2'],
    );
  });

  it('finds links by root uuid', async () => {
    const store = await LineageStore.load(await freshDir());
    await store.add(link('root-1', 'j1'));
    await store.add(link('root-2', 'j2'));
    await store.add(link('root-1', 'j3', { action: 'updated' }));
    assert.deepEqual(
      store.byRoot('root-1').map((found) => found.journalId),
      ['j1', 'j3'],
    );
    assert.deepEqual(store.byRoot('root-9'), []);
  });

  it('returns every link in insertion order', async () => {
    const dir = await freshDir();
    const store = await LineageStore.load(dir);
    const links = [link('root-b', 'j1'), link('root-a', 'j2'), link('root-b', 'j3', { mode: 'import', source: { cliSessionId: 'unlisted-cli' } })];
    for (const added of links) await store.add(added);
    assert.deepEqual(store.all(), links);
    assert.deepEqual((await LineageStore.load(dir)).all(), links);
  });
});
