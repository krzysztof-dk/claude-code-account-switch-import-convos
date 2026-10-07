// The TUI driven through a pipe, end to end: the real CLI process with no
// command, a test world for its directories, and key presses written to its
// standard input.
//
// Why a pipe works: clack (@clack/prompts) turns standard input into
// keypress events with readline.emitKeypressEvents and switches raw mode on
// only for a terminal, so bytes on a pipe arrive as key presses just as they
// would from a keyboard. picocolors prints no colours without a terminal, but
// clack still writes cursor movements, which are stripped before matching.
//
// One rule makes it reliable: send keys only once the prompt they are meant
// for has printed its message. A prompt subscribes to key presses before its
// first render, and keys sent earlier would land elsewhere: dropped between
// two prompts, or read by a spinner, which ends the whole process on Ctrl+C.
// Every step therefore waits for a text that only the next prompt prints,
// searching the output past the previous match, so the same message printed
// again by a later prompt (the main menu after a flow) is told apart from
// the earlier one.
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  EMAIL_A,
  FAKE_SSH,
  appendRounds,
  destroyWorld,
  encodeCwd,
  hostHome,
  makeWorld,
  readJson,
  readLines,
  sshRecordFields,
  writeRecord,
  writeSshTranscript,
  writeTranscript,
  type World,
} from '../../test/fixtures.ts';
import { pathExists } from '../fsx.ts';
import { LOCK_FILE_NAME } from '../lock.ts';
import { packageRoot } from '../paths.ts';

const execFileAsync = promisify(execFile);

/** Keys as a terminal sends them. */
const KEY = {
  enter: '\r',
  down: '\x1b[B',
  up: '\x1b[A',
  ctrlC: '\x03',
} as const;

/** How long one step may take before the test fails with the output so far. */
const STEP_TIMEOUT_MS = 8000;

/** Control sequences clack writes for cursor movement and erasing (CSI ..., ESC <char>, and the cursor save and restore ESC 7 and ESC 8). */
const CONTROL_SEQUENCE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_78]/g;

function plain(text: string): string {
  return text.replace(CONTROL_SEQUENCE, '');
}

/** The environment and global options of the CLI process, as src/cli.test.ts runs it. */
function cliInvocation(world: World, ...args: string[]): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const paths = world.paths;
  return {
    file: process.execPath,
    args: [path.join(packageRoot(), 'src', 'cli.ts'), ...args, '--user-data', paths.userData, '--claude-dir', paths.claudeDir, '--data', paths.dataDir],
    env: { ...process.env, CLAUDE_CONFIG_DIR: '', CCAS_SSH: FAKE_SSH, CCAS_TEST_HOST_HOME: hostHome(world) },
  };
}

/** A running TUI: what it printed so far, a way to type, and its exit. */
class Tui {
  readonly child: ChildProcessWithoutNullStreams;
  private stdout = '';
  private stderr = '';
  /** Where in the plain output the next wait starts searching. */
  private mark = 0;
  readonly exited: Promise<number | null>;

  constructor(world: World, ...args: string[]) {
    const invocation = cliInvocation(world, ...args);
    this.child = spawn(invocation.file, invocation.args, { cwd: packageRoot(), env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => (this.stdout += chunk));
    this.child.stderr.on('data', (chunk: string) => (this.stderr += chunk));
    this.exited = new Promise((resolve) => this.child.on('exit', (code) => resolve(code)));
  }

  /** Everything printed so far, without control sequences. */
  output(): string {
    return plain(this.stdout);
  }

  /**
   * The output as one line of words: clack draws notes as boxes 80 columns
   * wide (a pipe has no width of its own) and wraps their lines at word
   * boundaries, so a result line such as 'created "x" on y as local_<id>'
   * is split over two box rows. Box borders go, rows are joined with spaces.
   */
  flat(): string {
    return this.output()
      .split('\n')
      .map((row) => row.replace(/^[│|]\s?/u, '').replace(/\s*[│|]\s*$/u, '').trim())
      .join(' ')
      .replace(/\s+/g, ' ');
  }

  /** What was printed since the last match. */
  recent(): string {
    return this.output().slice(this.mark);
  }

  /** Waits until `text` appears past the previous match; fails with the output when it does not. */
  async waitFor(text: string, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.output().indexOf(text, this.mark);
      if (index !== -1) {
        this.mark = index + text.length;
        return;
      }
      if (this.child.exitCode !== null || this.child.signalCode !== null || Date.now() > deadline) {
        const why = this.child.exitCode !== null ? `the TUI exited with ${this.child.exitCode}` : 'timed out';
        assert.fail(`${why} waiting for ${JSON.stringify(text)}; printed since the last step:\n${this.recent()}\nstderr:\n${this.stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Waits for a prompt's text, then types. */
  async answer(prompt: string, keys: string): Promise<void> {
    await this.waitFor(prompt);
    this.child.stdin.write(keys);
  }

  /** Waits for the process to end and gives its exit code. */
  async exitCode(timeoutMs = STEP_TIMEOUT_MS): Promise<number | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), timeoutMs)));
    const result = await Promise.race([this.exited, timeout]);
    clearTimeout(timer);
    if (result === 'timeout') assert.fail(`the TUI did not exit; printed since the last step:\n${this.recent()}\nstderr:\n${this.stderr}`);
    return result;
  }

  /**
   * Closes standard input and gives the exit code. The TUI prints its last
   * words and returns, but a process whose standard input is an open pipe
   * stays alive after that (the paused pipe is still an active handle), so
   * the pipe is closed the way a script feeding the TUI would close it.
   */
  async finish(): Promise<number | null> {
    this.child.stdin.end();
    return this.exitCode();
  }

  /** Ends the process if it still runs, and waits for it. */
  async stop(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.destroy();
      this.child.kill('SIGKILL');
    }
    await this.exited;
  }

  /**
   * Picks Quit (the last entry of the main menu) and expects the goodbye and
   * exit code 0 with standard input still open: the process used to stay
   * alive until the pipe was closed (found by these tests on 2026-10-06,
   * fixed in cli.ts, detachStdin). `menuShown` says the caller already
   * waited for this menu.
   */
  async quit(menuShown = false): Promise<void> {
    if (!menuShown) await this.waitFor('What next?');
    this.child.stdin.write(KEY.up + KEY.enter);
    await this.waitFor('Bye.');
    assert.equal(await this.exitCode(), 0, this.stderr);
  }
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one CLI command to its end, next to a TUI, against the same world. */
async function runCli(world: World, ...args: string[]): Promise<Run> {
  const invocation = cliInvocation(world, ...args);
  try {
    const { stdout, stderr } = await execFileAsync(invocation.file, invocation.args, { cwd: packageRoot(), env: invocation.env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

/** A journal entry as a process that died half-way leaves it: still running, with one created file. */
function cutShortEntry(id: string, created: string): Record<string, unknown> {
  return {
    id,
    at: '2026-10-06T09:00:00.000Z',
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
    created: [created],
    moved: [],
    warnings: [],
  };
}

const localRecords = async (dir: string): Promise<string[]> => (await readdir(dir)).filter((name) => name.startsWith('local_'));

describe('tui through a pipe', { concurrency: false }, () => {
  let world: World;
  let tui: Tui | undefined;
  const open = (...args: string[]): Tui => (tui = new Tui(world, ...args));

  before(async () => {
    world = await makeWorld();
    for (const title of ['first chat', 'second chat']) {
      const t = await writeTranscript(world, { prompts: 1, email: EMAIL_A, title });
      await writeRecord(world, world.a, { cliSessionId: t.cliId, title });
    }
  });
  afterEach(async () => {
    await tui?.stop();
    tui = undefined;
  });
  after(async () => {
    await destroyWorld(world);
  });

  it('(a) shows the environment and the menu, and quits with exit code 0', { timeout: 20_000 }, async () => {
    const t = open();
    await t.waitFor('Environment');
    await t.waitFor('What next?');
    const shown = t.output();
    for (const line of ['desktop data', 'CLI data', 'tool data']) assert.ok(shown.includes(line), `${line} in:\n${shown}`);
    for (const entry of ['Transfer conversations', 'Accounts', 'Restore from journal', 'Rescan', 'Quit']) assert.ok(shown.includes(entry), entry);
    await t.quit(true);
  });

  it('(b) names an account on the accounts screen and keeps the name in accounts.json', { timeout: 20_000 }, async () => {
    const t = open();
    await t.answer('What next?', KEY.down + KEY.enter);
    // Account A comes first; its label is its e-mail, found in its transcripts.
    await t.answer('Edit an account?', KEY.enter);
    await t.answer('Set a name', KEY.enter);
    await t.answer('e.g. work, private', 'Work' + KEY.enter);
    await t.waitFor('Name set to "Work".');
    const stored = await readJson<{ accounts: { accountId: string; name: string | null }[] }>(path.join(world.paths.dataDir, 'accounts.json'));
    assert.equal(stored.accounts.find((account) => account.accountId === world.a.accountId)?.name, 'Work');
    // The list comes back with the new label; Back is its last entry.
    await t.answer('Edit an account?', KEY.up + KEY.enter);
    await t.quit();
    // The name stays for the scenarios below; they pick accounts by position, not by label.
  });

  it('(c) copies every conversation of A to B after showing the plan and asking', { timeout: 20_000 }, async () => {
    const t = open();
    await t.answer('What next?', KEY.enter);
    await t.answer('Source', KEY.enter);
    await t.answer('Target account', KEY.enter);
    await t.answer('Which conversations to transfer to', KEY.enter);
    assert.ok(t.output().includes('All 2 conversations'), t.recent());
    // Nothing on B yet, so no pair question: the plan comes next, every line counted.
    await t.waitFor('Plan');
    // The confirmation is a clack confirm: "y" answers it at once.
    await t.answer('Apply 2 operations?', 'y');
    const plan = t.output();
    assert.equal(plan.split('[dry-run] created "').length - 1, 2, plan);
    for (const at of ['[1/2] [dry-run] created "', '[2/2] [dry-run] created "']) assert.ok(plan.includes(at), `${at} in:\n${plan}`);
    await t.waitFor('Result');
    await t.waitFor('Start the Claude app to see the result');
    // The two fixtures have the same last activity, so their order in the box is not fixed.
    const result = t.flat().slice(t.flat().lastIndexOf('Result'));
    for (const title of ['first chat', 'second chat']) {
      assert.match(result, new RegExp(`\\[[12]/2\\] created "${title}" on bbbbbbbb\\.\\.\\. as local_\\S+ \\[journal \\S+\\]`), result);
    }
    assert.ok(t.flat().includes('Planned 2 conversations'), t.flat());
    assert.ok(t.flat().includes('Done, 2 conversations'), t.flat());
    await t.quit();
    assert.equal((await localRecords(world.b.dir)).length, 2);
  });

  it('(m) asks about every identical pair, and "Skip all" plans and reports them as skipped without writing', { timeout: 30_000 }, async () => {
    // Right after (c): both conversations have an identical copy on B.
    assert.equal((await localRecords(world.b.dir)).length, 2);
    const journal = path.join(world.paths.dataDir, 'journal.jsonl');
    const entriesBefore = (await readLines(journal)).length;
    const t = open();
    await t.answer('What next?', KEY.enter);
    await t.answer('Source', KEY.enter);
    await t.answer('Target account', KEY.enter);
    await t.answer('Which conversations to transfer to', KEY.enter);
    assert.ok(t.recent().includes('2 up to date'), t.recent());
    await t.waitFor('is the same on both accounts');
    assert.match(t.flat(), /\[1\/2\] "(first|second) chat" is the same on both accounts \(\d+ lines each\)\. What to do\?/, t.flat());
    // Skip, Keep, Copy anyway, Skip all, Keep all, Copy all anyway, Cancel: the fourth.
    t.child.stdin.write(KEY.down + KEY.down + KEY.down + KEY.enter);
    await t.waitFor('Skipped: nothing is done to any of them');
    // The question (printed as the prompt and again with its answer) and the two pairs the note lists.
    assert.equal(t.flat().split('is the same on both accounts').length - 1, 4, `the question twice and the two listed pairs:\n${t.flat()}`);
    await t.answer('Skip all 2 remaining identical conversations?', 'y');
    await t.waitFor('Plan');
    assert.ok(!t.output().includes('[2/2] "'), 'the second pair was not asked about');
    assert.equal(t.flat().split('[dry-run] skipped "').length - 1, 2, t.flat());
    await t.answer('Apply 2 operations?', 'y');
    await t.waitFor('Result');
    const result = t.flat().slice(t.flat().lastIndexOf('Result'));
    for (const title of ['first chat', 'second chat']) assert.ok(result.includes(`skipped "${title}": the target copy is identical; left as answered`), result);
    await t.quit();
    assert.equal((await readLines(journal)).length, entriesBefore, 'skipping writes nothing');
  });

  it('(d) restores operations from the journal, newest first, until B is empty again', { timeout: 20_000 }, async () => {
    // Makes the copies itself when (c) did not; after (c) this only reports them up to date.
    const copied = await runCli(world, 'transfer', '--from', EMAIL_A, '--to', 'bbbbbbbb', '--all');
    assert.equal(copied.code, 0, copied.stderr);
    assert.equal((await localRecords(world.b.dir)).length, 2);
    const t = open();
    // One journal entry per conversation, so two restores.
    for (let left = 2; left > 0; left -= 1) {
      await t.answer('What next?', KEY.down + KEY.down + KEY.enter);
      await t.answer('Operation to undo', KEY.enter);
      await t.waitFor('Restore plan');
      await t.answer('Undo this operation?', 'y');
      await t.waitFor('Restored');
      assert.equal((await localRecords(world.b.dir)).length, left - 1);
    }
    await t.quit();
    assert.deepEqual(await localRecords(world.b.dir), []);
  });

  it('(e) asks about an interrupted operation before the menu: Undo puts it back, Exit ends with code 4', { timeout: 20_000 }, async () => {
    // A world of its own: an entry left running would stop every later scenario at the same question.
    const own = await makeWorld();
    try {
      const journal = path.join(own.paths.dataDir, 'journal.jsonl');
      const leftover = path.join(own.root, 'half-written.txt');
      await writeFile(leftover, 'half-written');
      await appendFile(journal, `${JSON.stringify(cutShortEntry('20261006T090000Z-aaaaaa', leftover))}\n`);
      const undo = (tui = new Tui(own));
      await undo.answer('What should happen to it?', KEY.enter);
      await undo.waitFor('Undone: 20261006T090000Z-aaaaaa');
      assert.equal(await pathExists(leftover), false, 'the created file went into the backup');
      await undo.quit();

      const second = path.join(own.root, 'second-half.txt');
      await writeFile(second, 'half-written too');
      await appendFile(journal, `${JSON.stringify(cutShortEntry('20261006T090100Z-bbbbbb', second))}\n`);
      const exit = (tui = new Tui(own));
      // Exit is the last of Undo, Leave, Exit. It is confirmed after a note
      // that says what stays interrupted; No there asks the question again.
      await exit.answer('What should happen to it?', KEY.up + KEY.enter);
      await exit.waitFor('Undone so far: nothing.');
      await exit.waitFor('Still interrupted, asked about again before the next write');
      assert.ok(exit.flat().includes('20261006T090100Z-bbbbbb: copy "cut short"'), exit.flat());
      await exit.answer('Exit now?', 'n');
      await exit.answer('What should happen to it?', KEY.up + KEY.enter);
      await exit.answer('Exit now?', 'y');
      await exit.waitFor('Nothing more was changed.');
      assert.equal(await exit.finish(), 4);
      assert.ok(await pathExists(second), 'Exit changes nothing');
      assert.ok(!exit.output().includes('What next?'), 'the menu never appeared');
    } finally {
      await tui?.stop();
      tui = undefined;
      await destroyWorld(own);
    }
  });

  it('(f) with --dry-run shows the plan and writes nothing', { timeout: 20_000 }, async () => {
    const t = open('--dry-run');
    await t.waitFor('dry run: plans are shown, nothing is written');
    await t.answer('What next?', KEY.enter);
    // A dry run runs without the lock (lock.ts): it writes nothing another ccas could lose.
    assert.equal(await pathExists(path.join(world.paths.dataDir, LOCK_FILE_NAME)), false);
    await t.answer('Source', KEY.enter);
    await t.answer('Target account', KEY.enter);
    await t.answer('Which conversations to transfer to', KEY.enter);
    await t.waitFor('Plan');
    await t.waitFor('Dry run: nothing was changed');
    assert.equal(t.output().split('[dry-run] created "').length - 1, 2);
    assert.ok(!t.output().includes('Apply 2 operations?'), 'nothing to confirm in a dry run');
    await t.quit();
    assert.deepEqual(await localRecords(world.b.dir), []);
  });

  it('(g) Ctrl+C inside the transfer flow returns to the menu instead of ending the process', { timeout: 20_000 }, async () => {
    const t = open();
    await t.answer('What next?', KEY.enter);
    await t.answer('Source', KEY.ctrlC);
    await t.waitFor('What next?');
    assert.equal(t.child.exitCode, null, 'still running');
    await t.quit(true);
  });

  it('(h) holds the data directory lock while open, so a transfer next to it is refused', { timeout: 20_000 }, async () => {
    const t = open();
    await t.waitFor('What next?');
    const lock = path.join(world.paths.dataDir, LOCK_FILE_NAME);
    assert.equal((await readJson<{ pid: number }>(lock)).pid, t.child.pid);
    const second = await runCli(world, 'transfer', '--from', EMAIL_A, '--to', 'bbbbbbbb', '--all');
    assert.equal(second.code, 1);
    assert.match(second.stderr, new RegExp(`another ccas is running \\(PID ${t.child.pid},`));
    assert.deepEqual(await localRecords(world.b.dir), [], 'the refused transfer wrote nothing');
    await t.quit(true);
    assert.equal(await pathExists(lock), false, 'released when the TUI ended');
  });

  /** Appends one round to the transcript of every record in `dir` (an account's records): on B each pair then reads "target is longer", on A "source is longer". */
  async function growRecordsIn(dir: string, startAt: number): Promise<void> {
    for (const name of await localRecords(dir)) {
      const record = await readJson<{ cliSessionId?: string; cwd: string }>(path.join(dir, name));
      assert.ok(record.cliSessionId, `${name} names its transcript`);
      const projectDir = path.join(world.paths.projectsRoot, encodeCwd(record.cwd));
      const transcript = { cliId: record.cliSessionId, path: path.join(projectDir, `${record.cliSessionId}.jsonl`), projectDir, sidecarDir: '', cwd: record.cwd, lines: [], uuids: [] };
      await appendRounds(transcript, 1, startAt);
    }
  }

  /** Walks the transfer screen up to the first pair question: source A, target B, all conversations. */
  async function reachPairQuestion(t: Tui, stateHint: string): Promise<void> {
    await t.answer('What next?', KEY.enter);
    await t.answer('Source', KEY.enter);
    await t.answer('Target account', KEY.enter);
    await t.answer('Which conversations to transfer to', KEY.enter);
    assert.ok(t.recent().includes(stateHint), t.recent());
    await t.waitFor('What to do?');
  }

  it('(i) answers one question for every pair of the same kind left, after a note and a confirmation', { timeout: 30_000 }, async () => {
    const copied = await runCli(world, 'transfer', '--from', EMAIL_A, '--to', 'bbbbbbbb', '--all');
    assert.equal(copied.code, 0, copied.stderr);
    await growRecordsIn(world.b.dir, Date.UTC(2026, 8, 5));
    const t = open();
    await reachPairQuestion(t, '2 target is newer');
    assert.match(t.flat(), /\[1\/2\] "(first|second) chat" differs: the target is longer \(source \d+ lines, target \d+\)\. What to do\?/, t.flat());
    // Skip, Overwrite, Skip all, Overwrite all, Cancel: the fourth.
    t.child.stdin.write(KEY.down + KEY.down + KEY.down + KEY.enter);
    await t.waitFor('Overwritten: each target copy is replaced by its shorter source.');
    // The question (printed as the prompt and again with its answer) and the two pairs the note lists.
    assert.equal(t.flat().split('differs: the target is longer').length - 1, 4, `the question twice and the two listed pairs:\n${t.flat()}`);
    await t.answer('Overwrite the target copies of all 2 remaining where the target is longer?', 'y');
    await t.waitFor('Plan');
    // The question carries its position; the note lists pairs without one.
    const asked = ['first chat', 'second chat'].filter((title) => t.output().includes(`/2] "${title}" differs`));
    assert.equal(asked.length, 1, `only the first pair was asked about: ${asked.join(', ')}`);
    assert.equal(t.output().split('[dry-run] updated "').length - 1, 2, t.output());
    await t.answer('Apply 2 operations?', 'y');
    await t.waitFor('Result');
    const result = t.flat().slice(t.flat().lastIndexOf('Result'));
    for (const title of ['first chat', 'second chat']) assert.match(result, new RegExp(`\\[[12]/2\\] updated "${title}" on bbbbbbbb`), result);
    await t.quit();
  });

  it('(j) declines a batch answer, then cancels the transfer after the note, with nothing written', { timeout: 30_000 }, async () => {
    await growRecordsIn(world.b.dir, Date.UTC(2026, 8, 7));
    const journal = path.join(world.paths.dataDir, 'journal.jsonl');
    const entriesBefore = (await readLines(journal)).length;
    const t = open();
    await reachPairQuestion(t, '2 target is newer');
    // Skip all (the third answer), declined at its confirmation.
    t.child.stdin.write(KEY.down + KEY.down + KEY.enter);
    await t.waitFor('Skipped: the target copy of each stays as it is');
    await t.answer('Skip all 2 remaining where the target is longer?', 'n');
    // The same question again; Cancel is the last answer.
    await t.answer('What to do?', KEY.up + KEY.enter);
    await t.waitFor('Nothing has been written: these questions come before the plan');
    await t.answer('Cancel the transfer?', 'y');
    await t.waitFor('Transfer cancelled: nothing was changed.');
    await t.quit();
    assert.equal((await readLines(journal)).length, entriesBefore, 'no operation ran');
  });

  it('(n) where the source is longer, "Copy all" brings every copy up to date', { timeout: 30_000 }, async () => {
    // Back to identical pairs first, then the sources grow.
    const overwritten = await runCli(world, 'transfer', '--from', EMAIL_A, '--to', 'bbbbbbbb', '--all', '--on-conflict', 'overwrite');
    assert.equal(overwritten.code, 0, overwritten.stderr);
    assert.match(overwritten.stdout, /summary: 0 created, 2 updated/);
    await growRecordsIn(world.a.dir, Date.UTC(2026, 8, 8));
    const t = open();
    await reachPairQuestion(t, '2 update available');
    assert.match(t.flat(), /\[1\/2\] "(first|second) chat" differs: the source is longer \(source \d+ lines, target \d+\)\. What to do\?/, t.flat());
    // Copy, Skip, Copy all, Skip all, Cancel: the third.
    t.child.stdin.write(KEY.down + KEY.down + KEY.enter);
    await t.waitFor('Updated: each target copy is brought up to date with its source.');
    await t.answer('Copy all 2 remaining where the source is longer?', 'y');
    await t.waitFor('Plan');
    assert.equal(t.output().split('[dry-run] updated "').length - 1, 2, t.output());
    await t.answer('Apply 2 operations?', 'y');
    await t.waitFor('Result');
    const result = t.flat().slice(t.flat().lastIndexOf('Result'));
    for (const title of ['first chat', 'second chat']) assert.match(result, new RegExp(`updated "${title}" on bbbbbbbb`), result);
    await t.quit();
    const again = await runCli(world, 'transfer', '--from', EMAIL_A, '--to', 'bbbbbbbb', '--all', '--dry-run');
    assert.match(again.stdout, /summary: 0 created, 0 updated, 2 up to date/);
  });

  describe('(k) a conversation fails during the run', { concurrency: false }, () => {
    let own: World;
    const openOwn = (): Tui => (tui = new Tui(own));

    before(async () => {
      own = await makeWorld();
      // Lists are newest first, so the run goes: good chat, ssh chat (its host
      // cannot be reached, see test/fake-ssh.sh), third chat.
      const good = await writeTranscript(own, { prompts: 1, email: EMAIL_A, title: 'good chat' });
      await writeRecord(own, own.a, { cliSessionId: good.cliId, title: 'good chat', lastActivityAt: Date.UTC(2026, 8, 3) });
      const ssh = await writeSshTranscript(own, { prompts: 1 });
      await writeRecord(own, own.a, {
        cliSessionId: ssh.cliId,
        title: 'ssh chat',
        lastActivityAt: Date.UTC(2026, 8, 2),
        ...sshRecordFields(ssh.cliId),
        sshConfig: { sshHost: 'build@unreachable.local' },
      });
      const third = await writeTranscript(own, { prompts: 1, email: EMAIL_A, title: 'third chat' });
      await writeRecord(own, own.a, { cliSessionId: third.cliId, title: 'third chat', lastActivityAt: Date.UTC(2026, 8, 1) });
    });
    after(async () => {
      await destroyWorld(own);
    });

    /**
     * Walks the transfer screen to the failure question: all of A to B, the
     * plan applied. Once B holds copies (after (k2)), the two good chats are
     * identical pairs and the pair question comes first; "Keep all" answers
     * it the way the run went before the question existed (up to date).
     */
    async function reachFailureQuestion(t: Tui, copiesOnB: boolean): Promise<void> {
      await t.answer('What next?', KEY.enter);
      await t.answer('Source', KEY.enter);
      await t.answer('Target account', KEY.enter);
      await t.answer('Which conversations to transfer to', KEY.enter);
      if (copiesOnB) {
        await t.waitFor('[1/3] "good chat" is the same on both accounts');
        // Skip, Keep, Copy anyway, Skip all, Keep all, Copy all anyway, Cancel: the fifth.
        t.child.stdin.write(KEY.down + KEY.down + KEY.down + KEY.down + KEY.enter);
        await t.waitFor('Kept: nothing is copied');
        await t.answer('Keep all 2 remaining identical conversations?', 'y');
      }
      await t.waitFor('Plan');
      assert.ok(t.flat().includes('[2/3] [dry-run] FAILED "ssh chat"'), t.flat());
      await t.answer('Apply 3 operations?', 'y');
      await t.waitFor('[2/3] "ssh chat" failed. What now?');
    }

    it('(k1) stops at the failed conversation and undoes what the run did when the transfer is cancelled', { timeout: 30_000 }, async () => {
      const t = openOwn();
      await reachFailureQuestion(t, false);
      assert.ok(t.flat().includes('Stopped at 2/3 "ssh chat"'), t.flat());
      // Skip, Continue without asking, Stop, Cancel and undo: the last.
      t.child.stdin.write(KEY.up + KEY.enter);
      await t.waitFor('Undone, newest first');
      assert.ok(t.flat().includes('created "good chat" ['), t.flat());
      await t.answer('Undo 1 operation and stop the transfer?', 'y');
      await t.waitFor('Result');
      await t.waitFor('1 conversation not attempted');
      await t.waitFor('Transfer cancelled: everything it did was undone.');
      await t.quit();
      assert.deepEqual(await localRecords(own.b.dir), []);
      const journal = await readLines(path.join(own.paths.dataDir, 'journal.jsonl'));
      assert.deepEqual(
        journal.map((entry) => [entry['action'], entry['status']]),
        [
          ['created', 'restored'],
          ['none', 'done'],
        ],
      );
    });

    it('(k2) skips the failed conversation and goes on with the next', { timeout: 30_000 }, async () => {
      const t = openOwn();
      await reachFailureQuestion(t, false);
      t.child.stdin.write(KEY.enter);
      await t.waitFor('Result');
      const result = t.flat().slice(t.flat().lastIndexOf('Result'));
      for (const expected of ['[1/3] created "good chat" on bbbbbbbb', '[2/3] FAILED "ssh chat"', '[3/3] created "third chat" on bbbbbbbb']) assert.ok(result.includes(expected), `${expected} in:\n${result}`);
      await t.quit();
      assert.equal((await localRecords(own.b.dir)).length, 2);
    });

    it('(k3) stops after the failed conversation, keeping what was done', { timeout: 30_000 }, async () => {
      const t = openOwn();
      await reachFailureQuestion(t, true);
      // Stop here is the third answer.
      t.child.stdin.write(KEY.down + KEY.down + KEY.enter);
      await t.waitFor('Stopped; the 1 conversation left was not attempted.');
      await t.waitFor('Result');
      const result = t.flat().slice(t.flat().lastIndexOf('Result'));
      assert.ok(result.includes('up to date "good chat"'), result);
      assert.ok(!result.includes('"third chat"'), `third chat was not attempted:\n${result}`);
      await t.quit();
      assert.equal((await localRecords(own.b.dir)).length, 2, 'nothing undone');
    });

    it('(k4) goes on without asking again once that is confirmed, after declining it once', { timeout: 30_000 }, async () => {
      const t = openOwn();
      await reachFailureQuestion(t, true);
      t.child.stdin.write(KEY.down + KEY.enter);
      // The first words of the note: a note is a box wrapped at 80 columns, so
      // a phrase from its middle may be split over two rows (see flat()).
      await t.waitFor('The 1 conversation left are transferred one after another');
      assert.ok(t.flat().includes('A failure or a refusal no longer stops the run'), t.flat());
      await t.answer('Continue without asking again?', 'n');
      await t.answer('What now?', KEY.down + KEY.enter);
      await t.answer('Continue without asking again?', 'y');
      await t.waitFor('Result');
      const result = t.flat().slice(t.flat().lastIndexOf('Result'));
      assert.ok(result.includes('up to date "third chat"'), result);
      await t.quit();
    });
  });

  it('(l) undoes every interrupted operation at once after a note and a confirmation', { timeout: 20_000 }, async () => {
    const own = await makeWorld();
    try {
      const journal = path.join(own.paths.dataDir, 'journal.jsonl');
      const ids = ['20261006T090000Z-c00000', '20261006T090001Z-c00001'];
      const files = ids.map((id) => path.join(own.root, `${id}.txt`));
      for (const [index, file] of files.entries()) {
        await writeFile(file, 'half-written');
        await appendFile(journal, `${JSON.stringify(cutShortEntry(ids[index] ?? '', file))}\n`);
      }
      const t = (tui = new Tui(own));
      // Undo, Leave, Undo all, Leave all, Exit: the third.
      await t.answer('What should happen to it?', KEY.down + KEY.down + KEY.enter);
      await t.waitFor('Each is restored in turn');
      for (const id of ids) assert.ok(t.flat().includes(`${id}: copy "cut short"`), t.flat());
      await t.answer('Undo all 2 remaining?', 'y');
      for (const id of ids) await t.waitFor(`Undone: ${id}`);
      await t.quit();
      for (const file of files) assert.equal(await pathExists(file), false, `${file} went into the backup`);
      assert.equal(t.output().split('An earlier operation was interrupted').length - 1, 1, 'the second entry was not asked about');
    } finally {
      await tui?.stop();
      tui = undefined;
      await destroyWorld(own);
    }
  });
});
