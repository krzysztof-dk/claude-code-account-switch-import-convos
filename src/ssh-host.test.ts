import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { FAKE_SSH, destroyWorld, localHostRunner, makeWorld, readTree, replaceInBytes, type World } from '../test/fixtures.ts';
import {
  HostStepError,
  copyOnHost,
  describeHost,
  hostTargetOf,
  probeHost,
  shQuote,
  sshArguments,
  sshRunner,
  tombstoneOnHost,
  undoOnHost,
  type HostRunner,
  type HostTarget,
} from './ssh-host.ts';
import { appendBridgeTombstones, bridgeTombstone } from './transcripts.ts';

const TARGET: HostTarget = { host: 'build@mini.local' };

describe('ssh host', () => {
  let world: World;
  let home: string;
  let run: HostRunner;
  /** A project folder with a space and a single quote in its name, to prove every path is quoted. */
  let dir: string;

  /** Writes an original on the fake host: a transcript with a live Remote Control link and a side folder. */
  const writeOriginal = async (id: string): Promise<{ transcript: string; bytes: Buffer }> => {
    const lines = [
      { type: 'user', sessionId: id, uuid: randomUUID(), message: { role: 'user', content: 'zażółć 🙂' } },
      { type: 'bridge-session', sessionId: id, bridgeSessionId: 'cse_source', lastSequenceNum: 7 },
    ];
    const bytes = Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    const transcript = path.join(dir, `${id}.jsonl`);
    await writeFile(transcript, bytes, { mode: 0o600 });
    await mkdir(path.join(dir, id, 'subagents', 'nested'), { recursive: true });
    await writeFile(path.join(dir, id, 'subagents', 'nested', `agent-${id.slice(0, 8)}.jsonl`), `{"sessionId":"${id}"}\n`);
    await writeFile(path.join(dir, id, `${id}.json`), `{"sessionId":"${id}"}`);
    await writeFile(path.join(dir, id, 'notes.txt'), `plain text naming ${id}\n`);
    return { transcript, bytes };
  };

  before(async () => {
    world = await makeWorld();
    home = path.join(world.root, 'host');
    dir = path.join(home, '.claude', 'projects', "-Users-build-it's a dir");
    await mkdir(dir, { recursive: true });
    run = localHostRunner(home);
  });
  after(async () => {
    await destroyWorld(world);
  });

  it('reads the host from the record the way the app keeps it', () => {
    assert.equal(hostTargetOf({ sessionId: 'local_a', createdAt: 1, lastActivityAt: 2 }), null);
    assert.equal(hostTargetOf({ sessionId: 'local_a', createdAt: 1, lastActivityAt: 2, sshConfig: { sshHost: '  ' } }), null);
    const target = hostTargetOf({ sessionId: 'local_a', createdAt: 1, lastActivityAt: 2, sshConfig: { sshHost: 'mini', sshPort: 2222, sshIdentityFile: '/k/id', extra: 1 } });
    assert.deepEqual(target, { host: 'mini', port: 2222, identityFile: '/k/id' });
    assert.equal(describeHost(target!), 'mini:2222');
    assert.deepEqual(sshArguments(target!).slice(-7), ['-p', '2222', '-i', '/k/id', '--', 'mini', 'sh -s']);
    assert.ok(sshArguments(TARGET).includes('BatchMode=yes'));
    assert.equal(shQuote("it's"), `'it'\\''s'`);
  });

  it('finds the original by its id, trusting the hinted path only when it names that id', async () => {
    const id = randomUUID();
    const other = randomUUID();
    const { transcript } = await writeOriginal(id);
    const decoy = path.join(home, '.claude', 'projects', 'decoy');
    await mkdir(decoy, { recursive: true });
    await writeFile(path.join(decoy, `${other}.jsonl`), '{}\n');
    for (const hint of [transcript, path.join(decoy, `${other}.jsonl`), '/nowhere/x.jsonl', null]) {
      const probe = await probeHost(run, TARGET, { sourceCliSessionId: id, targetCliSessionId: other, hint });
      assert.equal(probe.dir, dir, String(hint));
      assert.equal(probe.sourceSidecar, true);
    }
    const missing = await probeHost(run, TARGET, { sourceCliSessionId: randomUUID(), targetCliSessionId: randomUUID() });
    assert.deepEqual(missing, { dir: null, sourceSidecar: false, target: null, targetSidecar: null, targetLive: [] });
  });

  it('copies the original next to it with the id rewritten, ends its Remote Control link, and refuses to overwrite', async () => {
    const id = randomUUID();
    const copy = randomUUID();
    const { bytes } = await writeOriginal(id);
    const sideBefore = await readTree(path.join(dir, id));
    const result = await copyOnHost(run, TARGET, { dir, sourceCliSessionId: id, targetCliSessionId: copy });
    assert.deepEqual(result, { created: [path.join(dir, copy), path.join(dir, `${copy}.jsonl`)], moved: [], tombstoned: [copy] });
    const copied = await readFile(path.join(dir, `${copy}.jsonl`));
    assert.ok(copied.equals(Buffer.concat([replaceInBytes(bytes, id, copy), Buffer.from(`${bridgeTombstone(copy)}\n`)])));
    const side = await readTree(path.join(dir, copy));
    assert.deepEqual([...side.keys()].sort(), [...sideBefore.keys()].map((name) => name.split(id).join(copy)).sort());
    for (const [name, file] of side) {
      const original = sideBefore.get(name.split(copy).join(id))!;
      const expected = /\.jsonl?$/.test(name) ? replaceInBytes(original.bytes, id, copy) : original.bytes;
      assert.ok(file.bytes.equals(expected), name);
    }

    const probe = await probeHost(run, TARGET, { sourceCliSessionId: id, targetCliSessionId: copy });
    assert.equal(probe.target, path.join(dir, `${copy}.jsonl`));
    assert.equal(probe.targetSidecar, path.join(dir, copy));
    assert.deepEqual(probe.targetLive, [], 'the copy links up with nothing');

    const namesBefore = (await readdir(dir)).sort();
    await assert.rejects(
      () => copyOnHost(run, TARGET, { dir, sourceCliSessionId: id, targetCliSessionId: copy }),
      (error: unknown) => error instanceof HostStepError && error.kind === 'conflict' && /exists already/.test(error.message),
    );
    assert.deepEqual((await readdir(dir)).sort(), namesBefore, 'a refused copy leaves nothing behind');
  });

  it('replaces a copy keeping the old one aside, and undoes that exactly', async () => {
    const id = randomUUID();
    const copy = randomUUID();
    await writeOriginal(id);
    await copyOnHost(run, TARGET, { dir, sourceCliSessionId: id, targetCliSessionId: copy });
    const transcript = path.join(dir, `${copy}.jsonl`);
    await writeFile(transcript, 'the copy as it was before the update\n');
    const oldSide = await readTree(path.join(dir, copy));
    const result = await copyOnHost(run, TARGET, { dir, sourceCliSessionId: id, targetCliSessionId: copy, replaceTag: 'J1' });
    assert.deepEqual(result.moved, [transcript, path.join(dir, copy)]);
    assert.equal(await readFile(`${transcript}.ccas-backup-J1`, 'utf8'), 'the copy as it was before the update\n');

    const undone = await undoOnHost(run, TARGET, {
      created: [path.join(dir, copy), transcript],
      moved: [
        { from: transcript, to: `${transcript}.ccas-backup-J1` },
        { from: path.join(dir, copy), to: `${path.join(dir, copy)}.ccas-backup-J1` },
      ],
      tag: 'R1',
    });
    assert.deepEqual(undone.warnings, []);
    assert.equal(await readFile(transcript, 'utf8'), 'the copy as it was before the update\n');
    assert.deepEqual(await readTree(path.join(dir, copy)), oldSide);
    assert.ok((await readdir(dir)).includes(`${copy}.jsonl.ccas-removed-R1`), 'the newer copy is set aside, not deleted');
    // Steps an interrupted operation announced but never took are skipped.
    const never = path.join(dir, `${randomUUID()}.jsonl`);
    const skipped = await undoOnHost(run, TARGET, { created: [never], moved: [{ from: never, to: `${never}.ccas-backup-J2` }], tag: 'R2' });
    assert.deepEqual(skipped, { steps: [], warnings: [] });
  });

  it('ends links in place like the app does, the same way this tool does locally, and only once', async () => {
    const id = randomUUID();
    const { transcript, bytes } = await writeOriginal(id);
    const local = path.join(world.root, 'local-twin.jsonl');
    await writeFile(local, bytes);
    assert.deepEqual(await tombstoneOnHost(run, TARGET, transcript), [id]);
    await appendBridgeTombstones(local);
    assert.ok((await readFile(transcript)).equals(await readFile(local)), 'the awk on the host and the code here agree');
    assert.deepEqual(await tombstoneOnHost(run, TARGET, transcript), []);
    assert.ok((await readFile(transcript)).equals(await readFile(local)));
    await assert.rejects(
      () => tombstoneOnHost(run, TARGET, path.join(dir, 'gone.jsonl')),
      (error: unknown) => error instanceof HostStepError && error.kind === 'missing',
    );
  });

  it('runs through the ssh program with the script on standard input, and explains a host it cannot reach', async () => {
    process.env['CCAS_TEST_HOST_HOME'] = home;
    try {
      const id = randomUUID();
      await writeOriginal(id);
      const probe = await probeHost(sshRunner(FAKE_SSH), { host: 'build@mini.local', port: 2222, identityFile: '/k/id' }, { sourceCliSessionId: id, targetCliSessionId: randomUUID() });
      assert.equal(probe.dir, dir);
      await assert.rejects(
        () => probeHost(sshRunner(FAKE_SSH), { host: 'unreachable.invalid' }, { sourceCliSessionId: id, targetCliSessionId: id }),
        (error: unknown) =>
          error instanceof HostStepError &&
          error.kind === 'unreachable' &&
          /could not reach unreachable\.invalid over ssh \(ssh: connect to host .* Connection refused\); "ssh unreachable\.invalid true" must work/.test(error.message),
      );
    } finally {
      delete process.env['CCAS_TEST_HOST_HOME'];
    }
    await assert.rejects(
      () => probeHost(sshRunner(path.join(world.root, 'no-such-ssh')), TARGET, { sourceCliSessionId: randomUUID(), targetCliSessionId: randomUUID() }),
      (error: unknown) => error instanceof HostStepError && error.kind === 'unreachable' && /could not start/.test(error.message),
    );
  });

  it('refuses ids and tags that are not plain names', async () => {
    const id = randomUUID();
    await assert.rejects(() => copyOnHost(run, TARGET, { dir, sourceCliSessionId: id, targetCliSessionId: '../x' }), /refusing/);
    await assert.rejects(() => copyOnHost(run, TARGET, { dir, sourceCliSessionId: id, targetCliSessionId: randomUUID(), replaceTag: 'a b' }), /refusing/);
  });
});
