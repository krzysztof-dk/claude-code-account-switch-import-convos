import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  APP_PROCESS_NAME,
  GuardRefusal,
  CLI_ARGV_PATTERN,
  CLI_PROCESS_NAME,
  detectClaudeCli,
  detectClaudeProcesses,
  detectCliSessionFiles,
  detectProcess,
  makeGuard,
  pgrepArgs,
  pgrepArgvArgs,
  processAlive,
  writeGate,
  type PgrepResult,
  type ProcessDetection,
} from './app-guard.ts';
import { resolvePaths } from './paths.ts';

const idle = (label: string): ProcessDetection => ({ label, status: 'not-running', processes: [] });

/** A pgrep stand-in that answers every run the same way. */
const pgrepSaying = (result: PgrepResult) => async (): Promise<PgrepResult> => result;
const nothingRuns = pgrepSaying({ status: 'not-running', lines: [] });
const cannotTell = pgrepSaying({ status: 'unknown', lines: [], error: 'pgrep: Cannot get process list' });

/** A pid no process on macOS can have (pids stop at 99998). */
const DEAD_PID = 4194303;

describe('app guard', () => {
  const live = resolvePaths({ home: '/Users/me', env: {} });
  const copy = resolvePaths({ home: '/Users/me', env: {}, userData: '/tmp/copy' });
  /** A fake <claudeDir>/sessions with the files the CLI leaves there. */
  let sessionsDir: string;

  before(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ccas-guard-'));
    sessionsDir = path.join(root, 'sessions');
    await mkdir(sessionsDir);
    await writeFile(path.join(sessionsDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: '1c8a9ee4-d34e-4a86-b2c9-7018bd13fab4', cwd: '/Users/me/project', status: 'busy' }));
    // A session that crashed: its file stayed, its pid is gone.
    await writeFile(path.join(sessionsDir, `${DEAD_PID}.json`), JSON.stringify({ pid: DEAD_PID, sessionId: 'dead', cwd: '/Users/me/old' }));
    // A session dying while writing its file, and a file that is not a session at all.
    await writeFile(path.join(sessionsDir, '777.json'), '{"pid": 777, "sessionId": "to');
    await writeFile(path.join(sessionsDir, 'notes.txt'), 'ignored');
  });
  after(async () => {
    await rm(path.dirname(sessionsDir), { recursive: true, force: true });
  });

  it('asks pgrep to include its own ancestors', () => {
    assert.deepEqual(pgrepArgs(APP_PROCESS_NAME), ['-a', '-x', 'Claude']);
    assert.ok(pgrepArgs(CLI_PROCESS_NAME).includes('-a'));
    assert.ok(pgrepArgvArgs(CLI_ARGV_PATTERN).includes('-a'));
  });

  it('recognises the CLI by its first argument, whatever its binary is called', () => {
    // pgrep reads the pattern as an extended regular expression; RegExp agrees for this one.
    const pattern = new RegExp(CLI_ARGV_PATTERN);
    const cli = [
      'claude',
      'claude --resume 1234',
      '/Users/me/.local/bin/claude -p hello',
      '/Users/me/.local/share/claude/versions/2.1.270 --resume 1234',
      // Taken from `ps -axo pid=,comm=` on the Mac mini: CLI processes of SSH sessions.
      '/Users/llmbot/.claude/remote/ccd-cli/2.1.280',
      '/Users/llmbot/.claude/remote/ccd-cli/2.1.281 --output-format stream-json',
      '/Users/me/Library/Application Support/Claude/claude-code/2.1.281/claude.app/Contents/MacOS/claude --resume 1234',
      // The npm install runs as node with the package's cli.js as the first script argument.
      'node /Users/me/.nvm/versions/node/v24.21.0/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume 1234',
      '/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    ];
    for (const line of cli) assert.ok(pattern.test(line), line);
    const other = [
      // Also from the Mac mini: the app, its helpers and the server it runs for SSH sessions.
      '/Applications/Claude.app/Contents/MacOS/Claude',
      '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer',
      '/Users/llmbot/.claude/remote/srv/90fca6e6a55c4d4c659e8c6ed511b7969ab17315/server',
      'node /opt/lib/claude-code/cli.js',
      'node /Users/me/project/node_modules/@anthropic-ai/other-tool/cli.js',
      'vim /Users/me/.claude/settings.json',
      'ls /Users/llmbot/.claude/remote/ccd-cli/2.1.280',
      'grep claude',
    ];
    for (const line of other) assert.ok(!pattern.test(line), line);
  });

  it('reads the CLI session index, counting only files whose pid is alive', async () => {
    // Signal 0 says whether a pid exists; the test process itself is alive, DEAD_PID is not.
    assert.equal(processAlive(process.pid), true);
    assert.equal(processAlive(DEAD_PID), false);
    const found = await detectCliSessionFiles(sessionsDir);
    assert.equal(found.status, 'running');
    assert.deepEqual(found.processes, [{ pid: process.pid, command: `session 1c8a9ee4 in /Users/me/project, from its session file ${process.pid}.json` }]);
    // With every pid dead the index says not running; a missing directory says the same; an unreadable one cannot tell.
    assert.equal((await detectCliSessionFiles(sessionsDir, () => false)).status, 'not-running');
    assert.equal((await detectCliSessionFiles(path.join(sessionsDir, 'none'))).status, 'not-running');
    const unreadable = await detectCliSessionFiles(path.join(sessionsDir, 'notes.txt'));
    assert.equal(unreadable.status, 'unknown');
    assert.match(unreadable.error ?? '', /notes\.txt/);
  });

  it('finds a CLI through its session file when pgrep sees nothing, and reports unknown only when nothing was found', async () => {
    const bySession = await detectClaudeCli({ pgrep: nothingRuns, sessionsDir });
    assert.equal(bySession.status, 'running');
    assert.equal(bySession.processes[0]?.pid, process.pid);
    // pgrep lists are merged with the session files by pid, the name match winning the description.
    const both = await detectClaudeCli({
      pgrep: async (args) => (args.includes('-x') ? { status: 'running', lines: [String(process.pid)] } : { status: 'running', lines: ['42 /Users/me/.local/bin/claude --resume 1'] }),
      sessionsDir,
    });
    assert.deepEqual(
      both.processes.map((match) => [match.pid, match.command]),
      [
        [42, '/Users/me/.local/bin/claude'],
        [process.pid, CLI_PROCESS_NAME],
      ],
    );
    // A found process beats a pgrep that cannot tell; nothing found plus a failure is unknown.
    assert.equal((await detectClaudeCli({ pgrep: cannotTell, sessionsDir })).status, 'running');
    assert.equal((await detectClaudeCli({ pgrep: cannotTell, sessionsDir, isAlive: () => false })).status, 'unknown');
    assert.equal((await detectClaudeCli({ pgrep: nothingRuns, sessionsDir, isAlive: () => false })).status, 'not-running');
    assert.equal((await detectClaudeCli({ pgrep: nothingRuns, sessionsDir: null })).status, 'not-running');
    // The gate names the session file, so a leftover of a crashed session can be told from a running one.
    const [app, cli] = await detectClaudeProcesses(path.dirname(sessionsDir), { pgrep: nothingRuns });
    assert.equal(app?.status, 'not-running');
    assert.match(writeGate(live, [app!, cli!]).reason ?? '', new RegExp(`from its session file ${process.pid}\\.json`));
  });

  it('refuses writes into the live directory while the app or a CLI runs, naming the processes', () => {
    const gate = writeGate(live, [
      { label: APP_PROCESS_NAME, status: 'running', processes: [{ pid: 612, command: APP_PROCESS_NAME }] },
      {
        label: CLI_PROCESS_NAME,
        status: 'running',
        processes: [
          { pid: 7021, command: CLI_PROCESS_NAME },
          { pid: 7100, command: '/Users/me/.local/bin/claude' },
        ],
      },
    ]);
    assert.equal(gate.allowed, false);
    assert.match(gate.reason ?? '', /Claude \(PID 612\)/);
    assert.match(gate.reason ?? '', /claude \(PID 7021\)/);
    assert.match(gate.reason ?? '', /claude \(PID 7100 \/Users\/me\/\.local\/bin\/claude\)/);
    assert.match(gate.reason ?? '', /Cmd\+Q/);
    const cliOnly = writeGate(live, [idle(APP_PROCESS_NAME), { label: CLI_PROCESS_NAME, status: 'running', processes: [{ pid: 9, command: CLI_PROCESS_NAME }] }]);
    assert.equal(cliOnly.allowed, false);
  });

  it('refuses writes into the live directory when the process list cannot be read', () => {
    const gate = writeGate(live, [idle(APP_PROCESS_NAME), { label: CLI_PROCESS_NAME, status: 'unknown', processes: [], error: 'pgrep: Cannot get process list' }]);
    assert.equal(gate.allowed, false);
    assert.match(gate.reason ?? '', /Cannot get process list/);
    assert.match(gate.reason ?? '', /Terminal\.app/);
  });

  it('allows writes when neither the app nor a CLI runs', () => {
    assert.deepEqual(writeGate(live, [idle(APP_PROCESS_NAME), idle(CLI_PROCESS_NAME)]), { allowed: true, reason: null });
  });

  it('never blocks a copied data directory', async () => {
    assert.deepEqual(writeGate(copy, [{ label: APP_PROCESS_NAME, status: 'running', processes: [{ pid: 1, command: APP_PROCESS_NAME }] }]), {
      allowed: true,
      reason: null,
    });
    assert.deepEqual(await makeGuard(copy)(), { allowed: true, reason: null });
  });

  it('answers with a gate for the live directory whatever the process listing says', async () => {
    const gate = await makeGuard(live)();
    assert.equal(typeof gate.allowed, 'boolean');
  });

  // The two checks below need a readable process list. Inside the Claude Code
  // sandbox pgrep fails with "Cannot get process list", so they skip there and
  // say why; in a terminal they run for real.
  it('sees the test process itself, the parent of pgrep, among the matches', async (t) => {
    const found = await detectProcess('node');
    if (found.status === 'unknown') return t.skip(`pgrep cannot list processes here: ${found.error ?? 'no reason given'}`);
    assert.equal(found.status, 'running');
    // Without -a, macOS pgrep would leave its own parent out.
    assert.ok(found.processes.some((match) => match.pid === process.pid));
  });

  it('reports a name no process has as not running', async (t) => {
    const found = await detectProcess('ccas-none-such');
    if (found.status === 'unknown') return t.skip(`pgrep cannot list processes here: ${found.error ?? 'no reason given'}`);
    assert.equal(found.status, 'not-running');
    assert.deepEqual(found.processes, []);
  });
});

describe('GuardRefusal', () => {
  it('carries the reason of the closed gate as its message, under its own name', () => {
    const refusal = new GuardRefusal('Claude Code is running: Claude (PID 1)');
    assert.ok(refusal instanceof Error);
    assert.equal(refusal.name, 'GuardRefusal');
    assert.equal(refusal.message, 'Claude Code is running: Claude (PID 1)');
  });

  it('falls back to a general message when the gate gave no reason', () => {
    assert.equal(new GuardRefusal(null).message, 'writes are not allowed');
  });
});
