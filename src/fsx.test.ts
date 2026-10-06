import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  appendFileDurable,
  ensurePrivateDir,
  isDirectory,
  listSubdirectories,
  mirrorPath,
  moveTree,
  pathExists,
  syncDirectory,
  tempPathFor,
  tempSiblings,
  writeFileAtomic,
} from './fsx.ts';
import { packageRoot } from './paths.ts';

describe('fsx', () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ccas-fsx-'));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('tells a file, a directory and nothing apart', async () => {
    const file = path.join(root, 'exists.txt');
    await writeFile(file, 'x');
    assert.equal(await pathExists(file), true);
    assert.equal(await pathExists(root), true);
    assert.equal(await pathExists(path.join(root, 'nope')), false);
    assert.equal(await isDirectory(root), true);
    assert.equal(await isDirectory(file), false);
    assert.equal(await isDirectory(path.join(root, 'nope')), false);
  });

  it('names temporary files after the target, the pid and the time, never ending in .json.tmp', () => {
    const target = path.join(root, 'local_abc.json');
    const tmp = tempPathFor(target);
    assert.ok(tmp.startsWith(`${target}.`));
    assert.match(path.basename(tmp), /^local_abc\.json\.\d+\.\d+\.tmp$/);
    assert.ok(path.basename(tmp).includes(`.${process.pid}.`));
    // The desktop app promotes files named local_<uuid>.json.tmp to records
    // when they are younger than 30 days (records.ts header, "uD" in
    // Claude.app 2.19675.0). This tool's temporary names must never qualify,
    // or a write cut short would come back as a record.
    assert.ok(!tmp.endsWith('.json.tmp'));
  });

  it('finds the temporary files of one target and nothing else', async () => {
    const dir = path.join(root, 'siblings');
    await mkdir(dir);
    const target = path.join(dir, 'journal.jsonl');
    await writeFile(path.join(dir, 'journal.jsonl.100.2.tmp'), '');
    await writeFile(path.join(dir, 'journal.jsonl.99.1.tmp'), '');
    await writeFile(path.join(dir, 'journal.jsonl.notes.tmp'), '');
    await writeFile(path.join(dir, 'journal.jsonl'), '');
    await writeFile(path.join(dir, 'journal.jsonl2.1.2.tmp'), '');
    assert.deepEqual(await tempSiblings(target), [path.join(dir, 'journal.jsonl.100.2.tmp'), path.join(dir, 'journal.jsonl.99.1.tmp')]);
    assert.deepEqual(await tempSiblings(path.join(root, 'missing', 'x')), []);
  });

  it('writes atomically with the requested mode and leaves no temporary file behind, also when the rename fails', async () => {
    const dir = path.join(root, 'atomic');
    const file = path.join(dir, 'state.json');
    await writeFileAtomic(file, '{"a":1}\n', { mode: 0o600, sync: true, syncDir: true });
    assert.equal(await readFile(file, 'utf8'), '{"a":1}\n');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dir), ['state.json'], 'no temporary file left');
    // Replacing keeps the old content until the rename, and the new one after.
    await writeFileAtomic(file, '{"a":2}\n');
    assert.equal(await readFile(file, 'utf8'), '{"a":2}\n');
    // A target that is a directory makes the rename fail; the temporary file goes away with the error.
    const blocked = path.join(dir, 'taken');
    await mkdir(blocked);
    await assert.rejects(() => writeFileAtomic(blocked, 'x'));
    assert.deepEqual((await readdir(dir)).sort(), ['state.json', 'taken']);
  });

  it('flushes a directory without touching its entries', async () => {
    const dir = path.join(root, 'flushed');
    await mkdir(dir);
    await writeFile(path.join(dir, 'a'), 'a');
    await syncDirectory(dir);
    assert.deepEqual(await readdir(dir), ['a']);
  });

  it('appends durably and keeps a torn last line from swallowing the next entry', async () => {
    const file = path.join(root, 'append', 'journal.jsonl');
    await appendFileDurable(file, '{"id":1}\n', { mode: 0o600, syncDir: true });
    assert.equal(await readFile(file, 'utf8'), '{"id":1}\n', 'no leading newline in a new file');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await appendFileDurable(file, '{"id":2}\n');
    assert.equal(await readFile(file, 'utf8'), '{"id":1}\n{"id":2}\n');
    // A line torn by a crash: the next entry starts on its own line, so a
    // reader skips the torn one and keeps the new one.
    await writeFile(file, '{"id":1}\n{"id":2}\n{"id":3', { flag: 'w' });
    await appendFileDurable(file, '{"id":4}\n');
    assert.equal(await readFile(file, 'utf8'), '{"id":1}\n{"id":2}\n{"id":3\n{"id":4}\n');
  });

  it('creates the tool data directories private and fixes the bits of existing ones', async () => {
    const fresh = path.join(root, 'data', 'backups');
    await ensurePrivateDir(fresh);
    assert.equal((await stat(fresh)).mode & 0o777, 0o700);
    const open = path.join(root, 'open');
    await mkdir(open, { mode: 0o755 });
    await ensurePrivateDir(open);
    assert.equal((await stat(open)).mode & 0o777, 0o700);
  });

  it('moves files and trees within a volume, creating the destination parent', async () => {
    const dir = path.join(root, 'move');
    await mkdir(path.join(dir, 'tree', 'inner'), { recursive: true });
    await writeFile(path.join(dir, 'tree', 'inner', 'f.txt'), 'f');
    await writeFile(path.join(dir, 'one.txt'), 'one');
    await moveTree(path.join(dir, 'one.txt'), path.join(dir, 'new', 'place', 'one.txt'));
    assert.equal(await readFile(path.join(dir, 'new', 'place', 'one.txt'), 'utf8'), 'one');
    await moveTree(path.join(dir, 'tree'), path.join(dir, 'moved-tree'));
    assert.equal(await readFile(path.join(dir, 'moved-tree', 'inner', 'f.txt'), 'utf8'), 'f');
    assert.equal(await pathExists(path.join(dir, 'tree')), false);
    await assert.rejects(() => moveTree(path.join(dir, 'nope'), path.join(dir, 'x')), /ENOENT/);
  });

  it('moves a tree across volumes by copying and removing', async (t) => {
    // The temporary directory and this repository usually sit on different
    // volumes on the development machine; where they do not, the EXDEV
    // path cannot be exercised and the check is skipped with the reason.
    const here = path.join(packageRoot(), 'data', `fsx-test-${process.pid}`);
    if ((await stat(root)).dev === (await stat(packageRoot())).dev) return t.skip('tmpdir and the package sit on one volume');
    try {
      await mkdir(path.join(root, 'xdev', 'inner'), { recursive: true });
      await writeFile(path.join(root, 'xdev', 'inner', 'f.txt'), 'across');
      await moveTree(path.join(root, 'xdev'), path.join(here, 'xdev'));
      assert.equal(await readFile(path.join(here, 'xdev', 'inner', 'f.txt'), 'utf8'), 'across');
      assert.equal(await pathExists(path.join(root, 'xdev')), false);
    } finally {
      await rm(here, { recursive: true, force: true });
    }
  });

  it('mirrors absolute paths below a root', () => {
    assert.equal(mirrorPath('/backups/1', '/Users/me/.claude/projects/x.jsonl'), '/backups/1/Users/me/.claude/projects/x.jsonl');
    assert.equal(mirrorPath('/backups/1', '/'), '/backups/1');
  });

  it('lists immediate subdirectories, sorted, and nothing for a missing directory', async () => {
    const dir = path.join(root, 'subs');
    await mkdir(path.join(dir, 'b'), { recursive: true });
    await mkdir(path.join(dir, 'a'));
    await writeFile(path.join(dir, 'c.txt'), '');
    assert.deepEqual(await listSubdirectories(dir), ['a', 'b']);
    assert.deepEqual(await listSubdirectories(path.join(root, 'none')), []);
    await assert.rejects(() => listSubdirectories(path.join(dir, 'c.txt')), /ENOTDIR/);
  });
});
