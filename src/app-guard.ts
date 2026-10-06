// Refusing to write while Claude Code is running.
//
// The desktop app reads its session records once, at start-up or when
// switching accounts, and writes them back when they change and when it
// quits. Files changed underneath a running app are therefore either ignored
// until the next start or overwritten at quit. The Claude Code CLI keeps
// appending to transcripts for as long as a session runs, whether the app
// drives it or it was started in a terminal. The tool consequently refuses to
// write into the live userData directory while either runs: the app (process
// "Claude") or any CLI process ("claude"). There is no exception for an
// account that is not the active one.
//
// The check is not a start-up decision: reading and planning always work, and
// the guard runs immediately before every operation that writes, and once
// more before the record (the file the app reads) is written, so a process
// started while the tool is open is noticed at the moment it matters. A copy
// of the directory (tests, rehearsals with --user-data) is never the app's,
// so the guard does not apply there.
//
// How the processes are found (macOS pgrep):
//   - by name, `pgrep -a -x Claude` and `pgrep -a -x claude`. Without -a,
//     macOS pgrep leaves its own ancestors out of the match list. ccas started
//     from a Claude Code session has the app and the CLI among its ancestors,
//     which is precisely the case the guard exists for, so -a is essential.
//   - by first argument, `pgrep -a -l -f CLI_ARGV_PATTERN`. macOS names a
//     process after the file it executed, and most CLI binaries are files
//     named after their version: the native installer keeps the CLI in
//     ~/.local/share/claude/versions/<version> (linked from ~/.local/bin/claude),
//     and the desktop app installs the CLI it runs over SSH on the remote host
//     as ~/.claude/remote/ccd-cli/<version>. Such processes are called
//     "2.1.281", not "claude"; on the Mac mini on 2026-09-28 the name match
//     found none of the twenty-odd ccd-cli processes of the SSH sessions. The
//     first argument (how the process was started) still shows what it is.
// When pgrep cannot list processes at all (inside the Claude Code sandbox it
// fails with "Cannot get process list"), the status is "unknown" and writes
// into the live directory are refused as well: not knowing is not permission.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Paths } from './paths.ts';

const execFileAsync = promisify(execFile);

/**
 * Result of looking for a process: running, not-running, or unknown when
 * pgrep could not list processes at all. For the live directory, writeGate
 * refuses writing on unknown just as on running.
 */
export type AppStatus = 'running' | 'not-running' | 'unknown';

/** The Electron main process of the desktop app is named exactly "Claude". */
export const APP_PROCESS_NAME = 'Claude';

/**
 * The Claude Code CLI: the copy the desktop app runs for every Code-tab
 * session (its binary is called "claude") and one started in a terminal.
 * Process names are case sensitive, so this never matches the app itself.
 */
export const CLI_PROCESS_NAME = 'claude';

/**
 * The first arguments a Claude Code CLI process can have, as extended regular
 * expressions. pgrep sees the argument list joined with spaces, so [^ ] keeps a
 * form inside the first argument.
 */
const CLI_FIRST_ARGUMENTS = [
  // Started as "claude", or through a path ending in /claude: a terminal session
  // (~/.local/bin/claude links to the native installer's binary), Homebrew.
  '([^ ]*/)?claude',
  // The native installer's binary itself, a file named after its version.
  '[^ ]*/claude/versions/[^ /]+',
  // The CLI the desktop app installs on a host it reaches over SSH, also named
  // after its version (seen as ~/.claude/remote/ccd-cli/2.1.281).
  '[^ ]*/\\.claude/remote/ccd-cli/[^ /]+',
  // The CLI the desktop app bundles, whose path has a space in it
  // ("Application Support"); its process name "claude" finds it as well.
  '.*/claude\\.app/Contents/MacOS/claude',
];

/**
 * Extended regular expression over a process's whole argument list: the first
 * argument is one of CLI_FIRST_ARGUMENTS. Anything else is not a CLI process,
 * among them the desktop app's helpers ("Claude Helper") and the server the app
 * runs on an SSH host (~/.claude/remote/srv/<hash>/server), which only starts
 * CLI processes; those are found themselves.
 */
export const CLI_ARGV_PATTERN = `^(${CLI_FIRST_ARGUMENTS.join('|')})( |$)`;

/** pgrep arguments for an exact process-name match, the caller's ancestors included (-a). */
export function pgrepArgs(name: string): string[] {
  return ['-a', '-x', name];
}

/** pgrep arguments for a match over whole argument lists, printing each list (-l) after the pid. */
export function pgrepArgvArgs(pattern: string): string[] {
  return ['-a', '-l', '-f', pattern];
}

/** One process that blocks writing, as a refusal names it: its pid and what it is called. */
export interface ProcessMatch {
  pid: number;
  /** The process name, or the first argument of a process found by its argument list. */
  command: string;
}

/**
 * What one lookup found, for the desktop app or for the CLI: the status and
 * the matching processes. detectProcess and detectClaudeCli build it,
 * writeGate turns a list of them into a decision, and the TUI start screen
 * shows them.
 */
export interface ProcessDetection {
  /** What was looked for, as shown to the person: "Claude" (the app) or "claude" (the CLI). */
  label: string;
  status: AppStatus;
  /** Matching processes; empty unless the status is "running". */
  processes: ProcessMatch[];
  /** Why the status is "unknown": pgrep's own message, or how it failed. */
  error?: string | undefined;
}

interface PgrepResult {
  status: AppStatus;
  /** Non-empty output lines: a pid each, followed by the argument list with -l -f. */
  lines: string[];
  error?: string | undefined;
}

async function runPgrep(args: readonly string[]): Promise<PgrepResult> {
  try {
    const { stdout } = await execFileAsync('pgrep', [...args]);
    return { status: 'running', lines: stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0) };
  } catch (error) {
    // pgrep exits with 1 when no process matches, 2 on a usage error and 3 when
    // it could not read the process list; a missing pgrep shows up as ENOENT.
    // Only the first one means "not running".
    const failure = error as { code?: unknown; stderr?: unknown };
    if (failure.code === 1) return { status: 'not-running', lines: [] };
    const stderr = typeof failure.stderr === 'string' ? failure.stderr.split('\n').map((line) => line.trim()).filter(Boolean).join('; ') : '';
    return { status: 'unknown', lines: [], error: stderr || `pgrep failed (${String(failure.code)})` };
  }
}

/** Processes named exactly `name`, the tool's own ancestors included. */
export async function detectProcess(name: string): Promise<ProcessDetection> {
  const result = await runPgrep(pgrepArgs(name));
  const processes = result.lines
    .map((line) => Number(line))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .map((pid) => ({ pid, command: name }));
  return { label: name, status: result.status, processes, error: result.error };
}

/**
 * Every Claude Code CLI process: found by name, and by first argument for
 * binaries named after their version. The two lists are merged by pid. Only
 * the first argument is kept for messages, never the rest of the command
 * line, which may hold a prompt.
 */
export async function detectClaudeCli(): Promise<ProcessDetection> {
  const [byName, byArgv] = await Promise.all([detectProcess(CLI_PROCESS_NAME), runPgrep(pgrepArgvArgs(CLI_ARGV_PATTERN))]);
  const found = new Map<number, ProcessMatch>();
  for (const match of byName.processes) found.set(match.pid, match);
  for (const line of byArgv.lines) {
    const parsed = /^(\d+)\s+(\S+)/.exec(line);
    if (!parsed) continue;
    const pid = Number(parsed[1]);
    if (!found.has(pid)) found.set(pid, { pid, command: parsed[2] ?? CLI_PROCESS_NAME });
  }
  const processes = [...found.values()].sort((a, b) => a.pid - b.pid);
  if (processes.length > 0) return { label: CLI_PROCESS_NAME, status: 'running', processes };
  const failures = [byName.error, byArgv.error].filter((error): error is string => typeof error === 'string');
  if (byName.status === 'unknown' || byArgv.status === 'unknown') {
    return { label: CLI_PROCESS_NAME, status: 'unknown', processes: [], error: failures.join('; ') || 'pgrep failed' };
  }
  return { label: CLI_PROCESS_NAME, status: 'not-running', processes: [] };
}

/** The desktop app and the CLI, in that order. */
export async function detectClaudeProcesses(): Promise<ProcessDetection[]> {
  return Promise.all([detectProcess(APP_PROCESS_NAME), detectClaudeCli()]);
}

/**
 * Whether the tool may write right now. Operations ask for one before every
 * write and once more before the record; when writing is not allowed,
 * `reason` is the message shown to the person.
 */
export interface WriteGate {
  allowed: boolean;
  /** Shown to the person when writes are refused. */
  reason: string | null;
}

function describeMatch(label: string, match: ProcessMatch): string {
  return match.command === label ? `${label} (PID ${match.pid})` : `${label} (PID ${match.pid} ${match.command})`;
}

/**
 * Whether writing into `paths` is allowed, given what the process detection
 * found. A copied data directory is always writable. The live one is writable
 * only when neither the app nor any CLI process runs and that could be told.
 */
export function writeGate(paths: Paths, detections: readonly ProcessDetection[]): WriteGate {
  if (!paths.liveUserData) return { allowed: true, reason: null };
  const running = detections.filter((detection) => detection.status === 'running');
  if (running.length > 0) {
    const list = running.flatMap((detection) => detection.processes.map((match) => describeMatch(detection.label, match))).join(', ');
    return {
      allowed: false,
      reason:
        `Claude Code is running: ${list}. Quit the app (Cmd+Q) and end every claude session in a terminal, then run ccas again from Terminal.app ` +
        '(a Claude Code session that started ccas counts as well). The app reads session records only at start-up and may overwrite them when it quits.',
    };
  }
  const unknown = detections.filter((detection) => detection.status === 'unknown');
  if (unknown.length > 0) {
    const why = unknown.map((detection) => `${detection.label}: ${detection.error ?? 'pgrep failed'}`).join('; ');
    return {
      allowed: false,
      reason: `Could not tell whether Claude Code is running (${why}), so writes to the live directory are refused. Run ccas from Terminal.app, where pgrep can list processes.`,
    };
  }
  return { allowed: true, reason: null };
}

/** A gate to call right before each write; skips process detection for copied directories. */
export type Guard = () => Promise<WriteGate>;

/**
 * The guard the operations, the CLI and the TUI call right before each
 * write. For a copied directory (tests, --user-data rehearsals) it allows
 * writing without looking at processes; for the live directory it detects
 * the app and the CLI again on every call, so a process started meanwhile
 * is noticed.
 */
export function makeGuard(paths: Paths): Guard {
  return async () => (paths.liveUserData ? writeGate(paths, await detectClaudeProcesses()) : { allowed: true, reason: null });
}

/** Thrown when the guard closes in the middle of an operation; the operation rolls itself back. */
export class GuardRefusal extends Error {
  constructor(reason: string | null) {
    super(reason ?? 'writes are not allowed');
    this.name = 'GuardRefusal';
  }
}
