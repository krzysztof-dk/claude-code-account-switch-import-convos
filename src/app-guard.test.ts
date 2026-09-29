import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  APP_PROCESS_NAME,
  CLI_ARGV_PATTERN,
  CLI_PROCESS_NAME,
  detectProcess,
  makeGuard,
  pgrepArgs,
  pgrepArgvArgs,
  writeGate,
  type ProcessDetection,
} from './app-guard.ts';
import { resolvePaths } from './paths.ts';

const idle = (label: string): ProcessDetection => ({ label, status: 'not-running', processes: [] });

describe('app guard', () => {
  const live = resolvePaths({ home: '/Users/me', env: {} });
  const copy = resolvePaths({ home: '/Users/me', env: {}, userData: '/tmp/copy' });

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
    ];
    for (const line of cli) assert.ok(pattern.test(line), line);
    const other = [
      // Also from the Mac mini: the app, its helpers and the server it runs for SSH sessions.
      '/Applications/Claude.app/Contents/MacOS/Claude',
      '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer',
      '/Users/llmbot/.claude/remote/srv/90fca6e6a55c4d4c659e8c6ed511b7969ab17315/server',
      'node /opt/lib/claude-code/cli.js',
      'vim /Users/me/.claude/settings.json',
      'ls /Users/llmbot/.claude/remote/ccd-cli/2.1.280',
      'grep claude',
    ];
    for (const line of other) assert.ok(!pattern.test(line), line);
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
