import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  ACCOUNT_B,
  EMAIL_A,
  FAKE_SSH,
  destroyWorld,
  hostHome,
  hostProjectDir,
  makeWorld,
  readTree,
  sshRecordFields,
  writeHostTranscript,
  writeRecord,
  writeSshTranscript,
  writeTranscript,
  type World,
} from '../test/fixtures.ts';
import { pathExists } from './fsx.ts';
import { packageRoot } from './paths.ts';

const execFileAsync = promisify(execFile);

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the real CLI in a child process against one test world; stdin is a
 * pipe, so there is no terminal. SSH hosts are the world's fake host, reached
 * through test/fake-ssh.sh instead of ssh.
 */
function runnerFor(world: () => World): (...args: string[]) => Promise<Run> {
  return async (...args) => {
    const cli = path.join(packageRoot(), 'src', 'cli.ts');
    const paths = world().paths;
    const common = ['--user-data', paths.userData, '--claude-dir', paths.claudeDir, '--data', paths.dataDir];
    const env = { ...process.env, CLAUDE_CONFIG_DIR: '', CCAS_SSH: FAKE_SSH, CCAS_TEST_HOST_HOME: hostHome(world()) };
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args, ...common], { cwd: packageRoot(), env });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    }
  };
}

const localRecords = async (dir: string): Promise<string[]> => (await readdir(dir)).filter((name) => name.startsWith('local_'));

describe('cli (end to end)', () => {
  let world: World;
  let cliId: string;
  const run = runnerFor(() => world);

  before(async () => {
    world = await makeWorld();
    const t = await writeTranscript(world, { prompts: 2, email: EMAIL_A, title: 'E2E' });
    cliId = t.cliId;
    await writeRecord(world, world.a, { cliSessionId: t.cliId, title: 'E2E record' });
  });
  after(async () => {
    await destroyWorld(world);
  });

  it('prints usage errors with a non-zero exit code', async () => {
    assert.equal((await run('transfer')).code, 1);
    assert.equal((await run('bogus')).code, 1);
    assert.match((await run('--bogus')).stderr, /Usage/);
    const help = await run('--help');
    assert.equal(help.code, 0);
    assert.match(help.stdout, /ccas transfer/);
    assert.match((await run('--version')).stdout, /^\d+\.\d+\.\d+/);
  });

  it('lists accounts and conversations as text and JSON', async () => {
    const accounts = await run('accounts', '--json');
    assert.equal(accounts.code, 0);
    const parsed = JSON.parse(accounts.stdout) as { email: string | null; loggedIn: boolean }[];
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]?.email, EMAIL_A);
    assert.equal(parsed[0]?.loggedIn, true);
    const text = await run('accounts');
    assert.match(text.stdout, /logged in/);
    const list = await run('list', '--from', EMAIL_A, '--to', ACCOUNT_B.accountId.slice(0, 8), '--json');
    assert.equal(list.code, 0);
    const conversations = JSON.parse(list.stdout) as { title: string; state: string; cliSessionId: string }[];
    assert.equal(conversations[0]?.title, 'E2E record');
    assert.equal(conversations[0]?.state, 'new');
    assert.equal(conversations[0]?.cliSessionId, cliId);
    assert.match((await run('list', '--from', 'none')).stdout, /0 conversations on no account/);
  });

  it('transfers with a dry run first, then for real, and restores from the journal', async () => {
    const dry = await run('transfer', '--from', EMAIL_A, '--to', 'bbbbbbbb', '--mode', 'copy', '--session', cliId.slice(0, 8), '--dry-run');
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /\[dry-run\] created "E2E record"/);
    assert.deepEqual((await readdir(world.b.dir)).filter((name) => name.startsWith('local_')), []);

    const real = await run('transfer', '--from', EMAIL_A, '--to', 'bbbbbbbb', '--mode', 'copy', '--session', cliId);
    assert.equal(real.code, 0, real.stderr);
    assert.match(real.stdout, /created "E2E record" on bbbbbbbb\.\.\. as local_/);
    assert.match(real.stdout, /Start the Claude app/);
    assert.equal((await readdir(world.b.dir)).filter((name) => name.startsWith('local_')).length, 1);

    const again = await run('transfer', '--from', EMAIL_A, '--to', 'bbbbbbbb', '--mode', 'copy', '--session', cliId);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /up to date/);

    const journal = await run('journal', '--json');
    const entries = JSON.parse(journal.stdout) as { id: string; status: string; action: string }[];
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.action, 'created');
    assert.match((await run('journal')).stdout, /created\s+done/);

    const restore = await run('restore', entries[0]!.id);
    assert.equal(restore.code, 0, restore.stderr);
    assert.match(restore.stdout, /removed/);
    assert.equal((await readdir(world.b.dir)).filter((name) => name.startsWith('local_')).length, 0);
    assert.equal((await run('restore', entries[0]!.id)).code, 1);
  });
});

describe('cli: --all, --exclude and interrupted operations', () => {
  let world: World;
  /** Record ids of the three conversations on account A; the first is the one left out. */
  let ids: string[];
  const run = runnerFor(() => world);
  const transferAll = (...extra: string[]): Promise<Run> => run('transfer', '--from', EMAIL_A, '--to', 'bbbbbbbb', '--mode', 'copy', '--all', ...extra);

  before(async () => {
    world = await makeWorld();
    ids = [];
    for (const title of ['kept apart', 'plain']) {
      const t = await writeTranscript(world, { prompts: 1, email: EMAIL_A, title });
      ids.push((await writeRecord(world, world.a, { cliSessionId: t.cliId, title })).record.sessionId);
    }
    const ssh = await writeSshTranscript(world, { prompts: 1, agents: 1, straddle64k: true });
    ids.push((await writeRecord(world, world.a, { cliSessionId: ssh.cliId, title: 'over ssh', ...sshRecordFields(ssh.cliId) })).record.sessionId);
    await writeHostTranscript(world, ssh);
  });
  after(async () => {
    await destroyWorld(world);
  });

  it('refuses flag combinations that do not make sense, with exit code 1', async () => {
    const base = ['transfer', '--from', EMAIL_A, '--to', 'bbbbbbbb', '--mode', 'copy'];
    for (const extra of [[], ['--all', '--session', ids[1]!], ['--exclude', ids[0]!]]) {
      const result = await run(...base, ...extra);
      assert.equal(result.code, 1, extra.join(' '));
    }
  });

  it('stops on a mistyped --exclude before writing anything', async () => {
    const projectsBefore = await readTree(world.paths.projectsRoot);
    const result = await transferAll('--exclude', ids[0]!, '--exclude', 'local_zzzzzzzz');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no conversation matches "local_zzzzzzzz"/);
    assert.deepEqual(await localRecords(world.b.dir), []);
    assert.equal(await pathExists(path.join(world.paths.dataDir, 'journal.jsonl')), false);
    assert.deepEqual(await readTree(world.paths.projectsRoot), projectsBefore);
  });

  it('plans --all --exclude as a dry run: excluded lines first, the summary last', async () => {
    // The same conversation named twice (full id and prefix) is excluded once.
    const result = await transferAll('--exclude', ids[0]!, '--exclude', ids[0]!.slice('local_'.length, 'local_'.length + 8), '--dry-run');
    assert.equal(result.code, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.match(lines[0] ?? '', /^\[dry-run\] excluded "kept apart" \(local_/);
    assert.equal(lines.filter((line) => line.includes('excluded "')).length, 1);
    assert.equal(lines.at(-1), '[dry-run] summary: 2 created, 0 updated, 0 up to date, 0 skipped, 1 excluded, 0 failed');
    assert.deepEqual(await localRecords(world.b.dir), []);
  });

  it('copies for real, then finds everything up to date', async () => {
    const hostBefore = (await readdir(hostProjectDir(world))).length;
    const real = await transferAll('--exclude', ids[0]!);
    assert.equal(real.code, 0, real.stderr);
    assert.equal(real.stdout.trim().split('\n').at(-1), 'summary: 2 created, 0 updated, 0 up to date, 0 skipped, 1 excluded, 0 failed');
    assert.match(real.stdout, /created "over ssh" on bbbbbbbb\.\.\. as local_\S+, transcript also on build@mini\.local/);
    assert.equal((await localRecords(world.b.dir)).length, 2);
    // The SSH copy got its transcript and side folder on the (fake) host, next to the original.
    assert.equal((await readdir(hostProjectDir(world))).length, hostBefore + 2);
    const again = await transferAll('--exclude', ids[0]!);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.stdout.trim().split('\n').at(-1), 'summary: 0 created, 0 updated, 2 up to date, 0 skipped, 1 excluded, 0 failed');
  });

  it('refuses to write while an operation is interrupted, until it is resolved or restored', async () => {
    const journalFile = path.join(world.paths.dataDir, 'journal.jsonl');
    const leftover = path.join(world.root, 'half-written.txt');
    await writeFile(leftover, 'half-written');
    // What a process that died half-way leaves: an entry still running.
    const cutShort = {
      id: '20260928T120000Z-aaaaaa',
      at: '2026-09-28T12:00:00.000Z',
      mode: 'copy',
      action: 'created',
      status: 'running',
      title: 'cut short',
      rootUuid: null,
      source: {},
      target: {},
      relation: 'new',
      backupDir: null,
      backedUp: [],
      created: [leftover],
      moved: [],
      warnings: [],
    };
    await appendFile(journalFile, `${JSON.stringify(cutShort)}\n`);

    const refused = await transferAll('--exclude', ids[0]!);
    assert.equal(refused.code, 4);
    assert.match(refused.stderr, new RegExp(cutShort.id));
    assert.match(refused.stderr, /ccas restore <id>/);
    assert.match(refused.stderr, /ccas resolve <id>/);
    const listing = await run('journal');
    assert.equal(listing.code, 0);
    assert.match(listing.stdout, /interrupted/);
    assert.match(listing.stderr, /warning: 1 operation was interrupted/);

    const resolved = await run('resolve', cutShort.id);
    assert.equal(resolved.code, 0, resolved.stderr);
    assert.equal((await run('resolve', cutShort.id)).code, 1, 'only an interrupted entry can be resolved');
    assert.ok(await pathExists(leftover), 'resolve keeps the files as they are');
    assert.equal((await transferAll('--exclude', ids[0]!)).code, 0);

    const second = { ...cutShort, id: '20260928T120100Z-bbbbbb' };
    await appendFile(journalFile, `${JSON.stringify(second)}\n`);
    assert.equal((await transferAll('--exclude', ids[0]!)).code, 4);
    const restored = await run('restore', second.id);
    assert.equal(restored.code, 0, restored.stderr);
    assert.equal(await pathExists(leftover), false, 'restore moved it into the backup');
    assert.equal((await transferAll('--exclude', ids[0]!)).code, 0);
  });
});
