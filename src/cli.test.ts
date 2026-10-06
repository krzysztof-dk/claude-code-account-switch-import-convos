import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
import { AccountStore, type AccountInfo } from './accounts.ts';
import { describeOutcome, findConversation, planTransfers, summaryLine } from './cli.ts';
import { pathExists } from './fsx.ts';
import { assessSync, buildInventory, conversationsOf, type Conversation, type Inventory } from './inventory.ts';
import { LOCK_FILE_NAME } from './lock.ts';
import type { OutcomeAction, TransferOutcome } from './operations.ts';
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

describe('cli: the pieces the commands and the TUI share', () => {
  let world: World;
  let inventory: Inventory;
  let onA: Conversation[];
  let accountB: AccountInfo;
  // Two CLI ids that share their first seven characters, so a short prefix
  // names both, and a record whose id is not "local_" + its CLI id, so a
  // prefix can only reach it through the "local_" rule.
  const twinOne = 'abcdef01-1111-4111-8111-111111111111';
  const twinTwo = 'abcdef02-2222-4222-8222-222222222222';
  const loner = 'fedcba98-3333-4333-8333-333333333333';
  const lonerRecordId = 'local_99887766-4444-4444-8444-444444444444';

  const conversation = (cliId: string): Conversation => {
    const found = onA.find((candidate) => candidate.cliSessionId === cliId);
    assert.ok(found, cliId);
    return found;
  };

  before(async () => {
    world = await makeWorld();
    for (const [cliId, title] of [
      [twinOne, 'twin one'],
      [twinTwo, 'twin two'],
    ] as const) {
      await writeTranscript(world, { cliId, prompts: 1, email: EMAIL_A, title });
      await writeRecord(world, world.a, { cliSessionId: cliId, title });
    }
    await writeTranscript(world, { cliId: loner, prompts: 1, email: EMAIL_A, title: 'loner' });
    await writeRecord(world, world.a, { cliSessionId: loner, sessionId: lonerRecordId, title: 'loner' });
    inventory = await buildInventory(world.paths, { store: await AccountStore.load(world.paths.dataDir) });
    onA = conversationsOf(inventory, world.a);
    const b = inventory.accounts.find((account) => account.accountId === ACCOUNT_B.accountId);
    assert.ok(b);
    accountB = b;
  });
  after(async () => {
    await destroyWorld(world);
  });

  it('finds a conversation by its exact record id or CLI session id, in any case', () => {
    assert.equal(findConversation(onA, `local_${twinOne}`), conversation(twinOne));
    assert.equal(findConversation(onA, twinTwo), conversation(twinTwo));
    assert.equal(findConversation(onA, lonerRecordId), conversation(loner));
    assert.equal(findConversation(onA, `  ${twinOne.toUpperCase()} `), conversation(twinOne));
  });

  it('finds a conversation by a prefix of six characters or more, with or without "local_"', () => {
    assert.equal(findConversation(onA, 'fedcba'), conversation(loner));
    assert.equal(findConversation(onA, 'abcdef01'), conversation(twinOne));
    // "998877" starts no id at all; only "local_998877..." does, the record id.
    assert.equal(findConversation(onA, '998877'), conversation(loner));
    assert.equal(findConversation(onA, 'local_998877'), conversation(loner));
  });

  it('refuses a prefix several conversations share, naming how many', () => {
    assert.throws(() => findConversation(onA, 'abcdef0'), /"abcdef0" is ambiguous \(2 matches\)/);
  });

  it('refuses a prefix shorter than six characters and an id nothing has', () => {
    // Five characters would be a unique prefix of the loner, yet too short to count.
    assert.throws(() => findConversation(onA, 'fedcb'), /no conversation matches "fedcb"/);
    assert.throws(() => findConversation(onA, 'zzzzzzzz'), /no conversation matches "zzzzzzzz"/);
    assert.throws(() => findConversation([], twinOne), /no conversation matches/);
  });

  /** An outcome of the "twin one" conversation on account B, with the fields a test sets. */
  const outcome = (action: OutcomeAction, fields: Partial<Omit<TransferOutcome, 'item' | 'action'>> = {}): TransferOutcome => ({
    item: {
      source: conversation(twinOne),
      target: accountB,
      mode: 'copy',
      assessment: { state: 'new', existing: null, comparison: null, warnings: [] },
      onConflict: 'skip',
    },
    action,
    reason: null,
    journalId: null,
    newSessionId: null,
    newCliSessionId: null,
    host: null,
    warnings: [],
    dryRun: false,
    ...fields,
  });

  it('describes every outcome the way transfer prints it and the TUI shows it', () => {
    // The target is named by its label: account B has neither a name nor an e-mail here.
    const journal = { journalId: '20261006T100000Z-abcdef' };
    assert.equal(
      describeOutcome(outcome('created', { ...journal, newSessionId: 'local_new', newCliSessionId: 'cli-new', host: 'transcript also on build@mini.local' })),
      'created "twin one" on bbbbbbbb... as local_new, transcript also on build@mini.local [journal 20261006T100000Z-abcdef]',
    );
    assert.equal(describeOutcome(outcome('updated', journal)), 'updated "twin one" on bbbbbbbb... [journal 20261006T100000Z-abcdef]');
    assert.equal(
      describeOutcome(outcome('repaired', { ...journal, reason: 'Remote Control switched off' })),
      'repaired "twin one" on bbbbbbbb...: Remote Control switched off [journal 20261006T100000Z-abcdef]',
    );
    assert.equal(describeOutcome(outcome('moved', { ...journal, host: 'transcript stays on build@mini.local' })), 'moved "twin one" to bbbbbbbb..., transcript stays on build@mini.local [journal 20261006T100000Z-abcdef]');
    // An up-to-date copy wrote nothing, so a journal id would mislead and is left out.
    assert.equal(describeOutcome(outcome('up-to-date', journal)), 'up to date "twin one" on bbbbbbbb...');
    assert.equal(describeOutcome(outcome('skipped', { reason: 'the target copy is newer' })), 'skipped "twin one": the target copy is newer');
    assert.equal(describeOutcome(outcome('refused', { ...journal, reason: 'Claude Code is running' })), 'REFUSED "twin one": Claude Code is running [journal 20261006T100000Z-abcdef]');
    assert.equal(describeOutcome(outcome('failed', { ...journal, reason: 'disk full' })), 'FAILED "twin one": disk full [journal 20261006T100000Z-abcdef]');
  });

  it('marks a dry-run outcome and shortens a long title', () => {
    assert.equal(describeOutcome(outcome('created', { dryRun: true })), '[dry-run] created "twin one" on bbbbbbbb...');
    const long = { ...outcome('skipped', { dryRun: true }) };
    long.item = { ...long.item, source: { ...long.item.source, title: 'x'.repeat(80) } };
    assert.equal(describeOutcome(long), `[dry-run] skipped "${'x'.repeat(57)}..."`);
  });

  it('sums up a transfer: six counts always, in order, the rare three only when there are any', () => {
    assert.equal(summaryLine(new Map(), 0), 'summary: 0 created, 0 updated, 0 up to date, 0 skipped, 0 excluded, 0 failed');
    const tally = new Map<OutcomeAction, number>([
      ['failed', 1],
      ['up-to-date', 4],
      ['created', 2],
      ['skipped', 3],
      ['updated', 5],
      ['repaired', 0],
    ]);
    assert.equal(summaryLine(tally, 6), 'summary: 2 created, 5 updated, 4 up to date, 3 skipped, 6 excluded, 1 failed');
    // Added in a fixed order (repaired, moved, refused), whatever order the tally has.
    tally.set('refused', 1).set('moved', 2).set('repaired', 3);
    assert.equal(summaryLine(tally, 0), 'summary: 2 created, 5 updated, 4 up to date, 3 skipped, 0 excluded, 1 failed, 3 repaired, 2 moved, 1 refused');
  });

  it('plans one item per conversation, with its assessment against the target and the policy given', () => {
    const chosen = [conversation(twinTwo), conversation(loner)];
    const items = planTransfers(inventory, accountB, chosen, 'move', 'overwrite');
    assert.equal(items.length, 2);
    const targetConversations = conversationsOf(inventory, accountB);
    for (const [index, item] of items.entries()) {
      assert.equal(item.source, chosen[index]);
      assert.equal(item.target, accountB);
      assert.equal(item.mode, 'move');
      assert.equal(item.onConflict, 'overwrite');
      assert.deepEqual(item.assessment, assessSync(chosen[index]!, targetConversations));
      assert.equal(item.assessment.state, 'new');
    }
    assert.deepEqual(planTransfers(inventory, accountB, [], 'copy', 'skip'), []);
  });
});

describe('cli: help, version and the data directory lock', () => {
  let world: World;
  let cliId: string;
  const run = runnerFor(() => world);
  const lockFile = (): string => path.join(world.paths.dataDir, LOCK_FILE_NAME);
  const transfer = (...extra: string[]): Promise<Run> => run('transfer', '--from', EMAIL_A, '--to', 'bbbbbbbb', '--mode', 'copy', '--session', cliId, ...extra);

  before(async () => {
    world = await makeWorld();
    const t = await writeTranscript(world, { prompts: 1, email: EMAIL_A, title: 'locked' });
    cliId = t.cliId;
    await writeRecord(world, world.a, { cliSessionId: t.cliId, title: 'locked' });
  });
  after(async () => {
    await destroyWorld(world);
  });

  it('prints the usage on --help and the package version on --version, both with exit code 0', async () => {
    const help = await run('--help');
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^ccas - move or copy/);
    assert.match(help.stdout, /Usage:/);
    assert.match(help.stdout, /Exit codes:/);
    assert.equal(help.stderr, '');
    const pkg = JSON.parse(await readFile(path.join(packageRoot(), 'package.json'), 'utf8')) as { version: string };
    const version = await run('--version');
    assert.equal(version.code, 0);
    assert.equal(version.stdout, `${pkg.version}\n`);
  });

  it('ends an unknown command with exit code 1, naming it, and the usage', async () => {
    const result = await run('frobnicate');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown command "frobnicate"/);
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.stdout, '');
  });

  it('refuses to transfer while another live ccas holds the lock, and leaves its lock alone', async () => {
    // The lock names this test process, which is alive: exactly what a
    // second ccas sees while the first one runs.
    const held = JSON.stringify({ pid: process.pid, startedAt: '2026-10-06T10:00:00.000Z' });
    await writeFile(lockFile(), held);
    try {
      const refused = await transfer();
      assert.equal(refused.code, 1);
      assert.match(refused.stderr, new RegExp(`another ccas is running \\(PID ${process.pid}, since 2026-10-06T10:00:00.000Z\\)`));
      assert.deepEqual(await localRecords(world.b.dir), [], 'nothing was written');
      assert.equal(await readFile(lockFile(), 'utf8'), held, 'the holder keeps its lock');

      // A dry run writes nothing that needs the lock, so it runs next to the holder.
      const dry = await transfer('--dry-run');
      assert.equal(dry.code, 0, dry.stderr);
      assert.match(dry.stdout, /\[dry-run\] created "locked"/);
      assert.equal(await readFile(lockFile(), 'utf8'), held);
    } finally {
      await rm(lockFile(), { force: true });
    }
  });

  it('takes over the lock of a ccas that is gone, with a warning, and releases it at the end', async () => {
    // 4194303 is above the largest pid macOS and Linux hand out, so no process has it.
    await writeFile(lockFile(), JSON.stringify({ pid: 4194303, startedAt: '2026-10-01T08:00:00.000Z' }));
    const result = await transfer();
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /warning: took over the lock of ccas PID 4194303 \(since 2026-10-01T08:00:00.000Z\), which is no longer running/);
    assert.match(result.stdout, /created "locked" on bbbbbbbb\.\.\. as local_/);
    assert.equal((await localRecords(world.b.dir)).length, 1);
    assert.equal(await pathExists(lockFile()), false, 'released when the command ended');
  });
});
