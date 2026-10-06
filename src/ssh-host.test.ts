import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { FAKE_SSH, destroyWorld, localHostRunner, makeWorld, readTree, replaceInBytes, type World } from '../test/fixtures.ts';
import { pathExists } from './fsx.ts';
import {
  HostStepError,
  copyOnHost,
  copyScript,
  describeHost,
  hostCopyPaths,
  hostTargetOf,
  probeHost,
  probeScript,
  shQuote,
  sshArguments,
  sshRunner,
  tombstoneOnHost,
  tombstoneScript,
  undoOnHost,
  undoScript,
  type HostCopyRequest,
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
  /** A copy request for an original without per-session directories (the ids are filled in per test). */
  let plain: Pick<HostCopyRequest, 'dir' | 'claudeDir' | 'dirs' | 'existingDirs'>;

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
    plain = { dir, claudeDir: path.join(home, '.claude'), dirs: [], existingDirs: [] };
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
    assert.deepEqual(missing, {
      dir: null,
      sourceSidecar: false,
      target: null,
      targetSidecar: null,
      targetLive: [],
      claudeDir: path.join(home, '.claude'),
      sourceDirs: [],
      targetDirs: [],
    });
  });

  it('copies the original next to it with the id rewritten, ends its Remote Control link, and refuses to overwrite', async () => {
    const id = randomUUID();
    const copy = randomUUID();
    const { bytes } = await writeOriginal(id);
    const sideBefore = await readTree(path.join(dir, id));
    const result = await copyOnHost(run, TARGET, { ...plain, sourceCliSessionId: id, targetCliSessionId: copy });
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
      () => copyOnHost(run, TARGET, { ...plain, sourceCliSessionId: id, targetCliSessionId: copy }),
      (error: unknown) => error instanceof HostStepError && error.kind === 'conflict' && /exists already/.test(error.message),
    );
    assert.deepEqual((await readdir(dir)).sort(), namesBefore, 'a refused copy leaves nothing behind');
  });

  it('replaces a copy keeping the old one aside, and undoes that exactly', async () => {
    const id = randomUUID();
    const copy = randomUUID();
    await writeOriginal(id);
    await copyOnHost(run, TARGET, { ...plain, sourceCliSessionId: id, targetCliSessionId: copy });
    const transcript = path.join(dir, `${copy}.jsonl`);
    await writeFile(transcript, 'the copy as it was before the update\n');
    const oldSide = await readTree(path.join(dir, copy));
    const result = await copyOnHost(run, TARGET, { ...plain, sourceCliSessionId: id, targetCliSessionId: copy, replaceTag: 'J1' });
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
  });

  it('copies the per-session directories first, keeps old ones aside on an update, and sets them aside on undo', async () => {
    // file-history/<id> and uploads/<id> live under the host's CLI directory,
    // not next to the transcript; the probe reports them, the copy script
    // puts them in place before the side folder and the transcript.
    const id = randomUUID();
    const copy = randomUUID();
    await writeOriginal(id);
    const claudeDir = path.join(home, '.claude');
    const fileHistory = (cli: string): string => path.join(claudeDir, 'file-history', cli);
    const uploads = (cli: string): string => path.join(claudeDir, 'uploads', cli);
    await mkdir(fileHistory(id), { recursive: true });
    await writeFile(path.join(fileHistory(id), 'abc@v1'), 'snapshot');
    await mkdir(uploads(id), { recursive: true });
    await writeFile(path.join(uploads(id), 'a.png'), Buffer.from([1, 2, 3]));

    const probe = await probeHost(run, TARGET, { sourceCliSessionId: id, targetCliSessionId: copy });
    assert.equal(probe.claudeDir, claudeDir);
    assert.deepEqual(probe.sourceDirs, ['file-history', 'uploads']);
    assert.deepEqual(probe.targetDirs, []);
    const request: HostCopyRequest = { dir, claudeDir, sourceCliSessionId: id, targetCliSessionId: copy, dirs: probe.sourceDirs, existingDirs: probe.targetDirs };
    const paths = hostCopyPaths(request, true);
    assert.deepEqual(paths.dirs, [fileHistory(copy), uploads(copy)]);
    assert.deepEqual(paths.existingDirs, []);
    const result = await copyOnHost(run, TARGET, request);
    // Announced in the order they went into place: the directories, the side folder, the transcript.
    assert.deepEqual(result.created, [fileHistory(copy), uploads(copy), path.join(dir, copy), path.join(dir, `${copy}.jsonl`)]);
    assert.equal(await readFile(path.join(fileHistory(copy), 'abc@v1'), 'utf8'), 'snapshot');
    assert.ok((await readFile(path.join(uploads(copy), 'a.png'))).equals(Buffer.from([1, 2, 3])));
    assert.equal(await readFile(path.join(fileHistory(id), 'abc@v1'), 'utf8'), 'snapshot', 'the original is untouched');

    // With the transcript and side folder gone, the directories alone make a fresh copy a conflict.
    await rm(path.join(dir, `${copy}.jsonl`));
    await rm(path.join(dir, copy), { recursive: true });
    await assert.rejects(
      () => copyOnHost(run, TARGET, request),
      (error: unknown) => error instanceof HostStepError && error.kind === 'conflict' && /file-history/.test(error.message),
    );

    // An update keeps the old directories aside under its tag and writes fresh ones.
    await writeFile(path.join(fileHistory(copy), 'abc@v1'), 'older');
    const again = await probeHost(run, TARGET, { sourceCliSessionId: id, targetCliSessionId: copy });
    assert.deepEqual(again.targetDirs, ['file-history', 'uploads']);
    const update = await copyOnHost(run, TARGET, { ...request, existingDirs: again.targetDirs, replaceTag: 'J2' });
    assert.deepEqual(update.moved, [fileHistory(copy), uploads(copy)]);
    assert.equal(await readFile(path.join(`${fileHistory(copy)}.ccas-backup-J2`, 'abc@v1'), 'utf8'), 'older');
    assert.equal(await readFile(path.join(fileHistory(copy), 'abc@v1'), 'utf8'), 'snapshot');

    // Undo sets the fresh directories aside and brings the kept ones back.
    const undone = await undoOnHost(run, TARGET, {
      created: update.created,
      moved: update.moved.map((from) => ({ from, to: `${from}.ccas-backup-J2` })),
      tag: 'R2',
    });
    assert.deepEqual(undone.warnings, []);
    assert.equal(await readFile(path.join(fileHistory(copy), 'abc@v1'), 'utf8'), 'older');
    assert.ok(await pathExists(`${uploads(copy)}.ccas-removed-R2`), 'the fresh directory is set aside, not deleted');
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
    await assert.rejects(() => copyOnHost(run, TARGET, { ...plain, sourceCliSessionId: id, targetCliSessionId: '../x' }), /refusing/);
    await assert.rejects(() => copyOnHost(run, TARGET, { ...plain, sourceCliSessionId: id, targetCliSessionId: randomUUID(), replaceTag: 'a b' }), /refusing/);
    // A per-session directory name comes from the probe's output; only the three the CLI keeps are ever used in a script.
    await assert.rejects(() => copyOnHost(run, TARGET, { ...plain, sourceCliSessionId: id, targetCliSessionId: randomUUID(), dirs: ['../projects'] }), /refusing/);
  });

  it('refuses a host or key path that could be an ssh option, before ssh runs', async () => {
    // The values come from the record's sshConfig, a file; "--" before the
    // host protects against options, the check protects against everything
    // else that is not a destination (spaces, control characters).
    assert.throws(() => sshArguments({ host: '-oProxyCommand=evil' }), /refusing/);
    assert.throws(() => sshArguments({ host: 'mini local' }), /refusing/);
    assert.throws(() => sshArguments({ host: 'mini\nlocal' }), /refusing/);
    assert.throws(() => sshArguments({ host: 'mini', identityFile: '-F/etc/ssh_config' }), /refusing/);
    for (const host of ['mini', 'build@mini.local', '[::1]', 'user@[fe80::1%en0]', 'ssh://build@mini.local:2222', 'mini-2.local', '10.0.0.5']) {
      assert.ok(sshArguments({ host }).includes(host), host);
    }
    await assert.rejects(
      () => probeHost(sshRunner(FAKE_SSH), { host: '-oProxyCommand=evil' }, { sourceCliSessionId: randomUUID(), targetCliSessionId: randomUUID() }),
      (error: unknown) => error instanceof HostStepError && error.kind === 'failed' && /refusing/.test(error.message),
    );
  });

  it('trusts a path the host reports only when it is absolute and clean, and a directory name only when the CLI keeps it', async () => {
    const request = { sourceCliSessionId: randomUUID(), targetCliSessionId: randomUUID() };
    const relative: HostRunner = async () => ({ code: 0, stdout: 'CCAS_CLAUDE_DIR:relative/dir\nCCAS_OK\n', stderr: '' });
    await assert.rejects(() => probeHost(relative, TARGET, request), /unusable Claude directory/);
    const control: HostRunner = async () => ({ code: 0, stdout: 'CCAS_CLAUDE_DIR:/home/x/.claude\nCCAS_DIR:/home/x/.claude/projects/p\rx\nCCAS_OK\n', stderr: '' });
    await assert.rejects(() => probeHost(control, TARGET, request), /unusable folder/);
    const foreign: HostRunner = async () => ({ code: 0, stdout: 'CCAS_CLAUDE_DIR:/home/x/.claude\nCCAS_SOURCE_DIR:../projects\nCCAS_SOURCE_DIR:uploads\nCCAS_OK\n', stderr: '' });
    assert.deepEqual((await probeHost(foreign, TARGET, request)).sourceDirs, ['uploads']);
  });
});

describe('ssh host: the scripts as text', () => {
  // The scripts are plain functions of their request, so their shape can be
  // checked without a host: the prelude every script relies on, quoting of
  // every value that comes from a record, a probe or a journal, and the order
  // of the steps where the order is the safety property.
  const ID = '11111111-1111-4111-8111-111111111111';
  const COPY = '22222222-2222-4222-8222-222222222222';
  const QUOTED_DIR = "/Users/build/.claude/projects/-Users-build-it's a dir";
  const scripts = (): Record<string, string> => ({
    probe: probeScript({ sourceCliSessionId: ID, targetCliSessionId: COPY, hint: `${QUOTED_DIR}/${ID}.jsonl` }),
    copy: copyScript({ dir: QUOTED_DIR, claudeDir: "/Users/build/o'clock/.claude", sourceCliSessionId: ID, targetCliSessionId: COPY, dirs: [], existingDirs: [] }),
    tombstone: tombstoneScript(`${QUOTED_DIR}/${ID}.jsonl`),
    undo: undoScript({ created: [`${QUOTED_DIR}/${COPY}.jsonl`], moved: [{ from: `${QUOTED_DIR}/x`, to: `${QUOTED_DIR}/x.ccas-backup-J1` }], tag: 'R1' }),
  });

  it('starts every script with the prelude: unset variables stop it, files are private, bytes are bytes', () => {
    for (const [name, script] of Object.entries(scripts())) {
      assert.deepEqual(script.split('\n').slice(0, 3), ['set -u', 'umask 077', 'LC_ALL=C'], name);
    }
  });

  it('quotes every value in single quotes, a single quote inside as \'\\\'\'', () => {
    const quotedDir = `'/Users/build/.claude/projects/-Users-build-it'\\''s a dir`;
    const { probe, copy, tombstone, undo } = scripts();
    assert.ok(probe!.includes(`OLD='${ID}'`) && probe!.includes(`NEW='${COPY}'`), probe);
    assert.ok(probe!.includes(`HINT=${quotedDir}/${ID}.jsonl'`), probe);
    assert.ok(copy!.includes(`D=${quotedDir}'`), copy);
    assert.ok(copy!.includes(`K='/Users/build/o'\\''clock/.claude'`), copy);
    assert.ok(copy!.includes(`TAG=''`), 'no tag is an empty quoted value');
    assert.ok(tombstone!.includes(`F=${quotedDir}/${ID}.jsonl'`), tombstone);
    assert.ok(undo!.includes(`X=${quotedDir}/${COPY}.jsonl'`), undo);
    assert.ok(undo!.includes(`TO=${quotedDir}/x.ccas-backup-J1'`) && undo!.includes(`TAG='R1'`), undo);
    // No raw value outside quotes: the quote-bearing directory never appears bare.
    for (const script of [probe!, copy!, tombstone!, undo!]) assert.ok(!script.includes("it's a dir"), script);
  });

  it('puts the per-session directories into place before the side folder, and the transcript last', () => {
    const script = copyScript({ dir: '/h/p', claudeDir: '/h/.claude', sourceCliSessionId: ID, targetCliSessionId: COPY, dirs: ['file-history', 'uploads'], existingDirs: [] });
    assert.ok(script.includes('TD0="$K/file-history/$NEW"') && script.includes('TD1="$K/uploads/$NEW"'), script);
    const announced = [...script.matchAll(/echo "CCAS_CREATED:(\$\w+)"/g)].map((match) => match[1]);
    assert.deepEqual(announced, ['$TD0', '$TD1', '$SN', '$F']);
  });

  it('undoes created paths newest first, then moves the kept ones back newest first', () => {
    const script = undoScript({
      created: ['/h/first', '/h/second', '/h/third'],
      moved: [
        { from: '/h/a', to: '/h/a.ccas-backup-J' },
        { from: '/h/b', to: '/h/b.ccas-backup-J' },
      ],
      tag: 'R7',
    });
    const created = [...script.matchAll(/^X='([^']*)'$/gm)].map((match) => match[1]);
    assert.deepEqual(created, ['/h/third', '/h/second', '/h/first']);
    const movedBack = [...script.matchAll(/^FROM='([^']*)'$/gm)].map((match) => match[1]);
    assert.deepEqual(movedBack, ['/h/b', '/h/a']);
    assert.ok(script.lastIndexOf("X='/h/first'") < script.indexOf("FROM='/h/b'"), 'every created path goes before any move back');
  });
});

describe('ssh host: the tombstone and undo scripts on awkward paths', () => {
  let world: World;
  let run: HostRunner;
  /** A folder with spaces and single quotes in its name. */
  let dir: string;

  before(async () => {
    world = await makeWorld();
    const home = path.join(world.root, 'host');
    dir = path.join(home, '.claude', 'projects', "it's got 'quotes' and spaces");
    await mkdir(dir, { recursive: true });
    run = localHostRunner(home);
  });
  after(async () => {
    await destroyWorld(world);
  });

  it('appends the tombstone to a transcript whose path has spaces and quotes', async () => {
    const id = randomUUID();
    const transcript = path.join(dir, `${id} copy's.jsonl`);
    const live = `${JSON.stringify({ type: 'bridge-session', sessionId: id, bridgeSessionId: 'cse_x', lastSequenceNum: 2 })}\n`;
    await writeFile(transcript, live);
    const result = await run(TARGET, tombstoneScript(transcript));
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(`CCAS_TOMBSTONE:${id}`) && result.stdout.includes('CCAS_OK'), result.stdout);
    assert.equal(await readFile(transcript, 'utf8'), `${live}${bridgeTombstone(id)}\n`);
  });

  it('sets created paths aside and moves kept ones back on paths with spaces and quotes', async () => {
    const created = path.join(dir, "new 'one'.jsonl");
    await writeFile(created, 'created by the operation');
    // A temporary file a cut-short copy left next to it goes aside too.
    await writeFile(`${created}.ccas-tmp.4242`, 'half');
    const original = path.join(dir, "old 'one'");
    const kept = `${original}.ccas-backup-J1`;
    await writeFile(kept, 'the original');
    const result = await run(TARGET, undoScript({ created: [created], moved: [{ from: original, to: kept }], tag: 'R1' }));
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes('CCAS_OK') && !result.stdout.includes('CCAS_WARN'), result.stdout);
    assert.equal(await readFile(`${created}.ccas-removed-R1`, 'utf8'), 'created by the operation');
    assert.equal(await readFile(`${created}.ccas-tmp.4242.ccas-removed-R1`, 'utf8'), 'half');
    assert.equal(await pathExists(created), false);
    assert.equal(await readFile(original, 'utf8'), 'the original');
    assert.equal(await pathExists(kept), false);
  });
});
