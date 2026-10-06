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
//   - by the npm-installed CLI's command line, "node .../node_modules/
//     @anthropic-ai/claude-code/cli.js": that process is named "node", so
//     only its first two arguments tell it apart (added 2026-10-05; before
//     that the README listed it as undetected).
//   - from the CLI's own session index, <claudeDir>/sessions/<pid>.json. The
//     CLI writes one file per running session (pid, procStart, sessionId,
//     cwd, status, version, entrypoint; seen with CLI 2.1.286, the build the
//     desktop app bundles, on 2026-10-05) and removes it on exit; files of
//     sessions that crashed stay until the next launch clears them (code.
//     claude.com, "Claude directory"), so a file alone proves nothing and
//     the pid is checked for life with signal 0. EPERM counts as alive: the
//     process exists under another user, or the sandbox hides it, and not
//     knowing is not permission. This finds CLI processes whatever their
//     binary is called. A pid that an unrelated process reused after a
//     crash counts as running until the next CLI launch clears the file;
//     the refusal names the session file so the person can tell.
// When pgrep cannot list processes at all (inside the Claude Code sandbox it
// fails with "Cannot get process list"), the status is "unknown" and writes
// into the live directory are refused as well: not knowing is not permission.
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Paths } from './paths.ts';

const execFileAsync = promisify(execFile);

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
  // The CLI installed with npm, which runs as "node <global node_modules>/
  // @anthropic-ai/claude-code/cli.js": two arguments, since the first one is
  // any node binary. Other cli.js files under other names stay out.
  '[^ ]*node [^ ]*/@anthropic-ai/claude-code/cli\\.js',
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

export interface ProcessMatch {
  pid: number;
  /** The process name, or the first argument of a process found by its argument list. */
  command: string;
}

export interface ProcessDetection {
  /** What was looked for, as shown to the person: "Claude" (the app) or "claude" (the CLI). */
  label: string;
  status: AppStatus;
  /** Matching processes; empty unless the status is "running". */
  processes: ProcessMatch[];
  /** Why the status is "unknown": pgrep's own message, or how it failed. */
  error?: string | undefined;
}

/** What one pgrep run found; tests build these by hand to stand in for pgrep. */
export interface PgrepResult {
  status: AppStatus;
  /** Non-empty output lines: a pid each, followed by the argument list with -l -f. */
  lines: string[];
  error?: string | undefined;
}

/** Runs pgrep with the given arguments (see pgrepArgs, pgrepArgvArgs); tests pass a stand-in. */
export type PgrepRunner = (args: readonly string[]) => Promise<PgrepResult>;

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
export async function detectProcess(name: string, pgrep: PgrepRunner = runPgrep): Promise<ProcessDetection> {
  const result = await pgrep(pgrepArgs(name));
  const processes = result.lines
    .map((line) => Number(line))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .map((pid) => ({ pid, command: name }));
  return { label: name, status: result.status, processes, error: result.error };
}

/**
 * Whether a process with this pid exists: signal 0 is delivered to nothing,
 * but fails with ESRCH when there is no such process. EPERM means the
 * process exists under another user, or that the sandbox refuses to tell;
 * both count as alive, because not knowing is not permission to write.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The name of the CLI's session index directory under its config directory. */
export const SESSIONS_DIR_NAME = 'sessions';

/**
 * CLI sessions according to the CLI's own index: <claudeDir>/sessions holds
 * one <pid>.json per running session, with the pid, the session id and the
 * folder (see the header). A file whose pid is dead is a leftover of a
 * crashed session and is skipped; a torn file (a session dying while
 * writing it) or one without a usable pid is skipped too. A missing
 * directory means no session ever ran with this CLI; an unreadable one
 * means "unknown", like a pgrep that cannot list processes.
 */
export async function detectCliSessionFiles(sessionsDir: string, isAlive: (pid: number) => boolean = processAlive): Promise<ProcessDetection> {
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { label: CLI_PROCESS_NAME, status: 'not-running', processes: [] };
    return { label: CLI_PROCESS_NAME, status: 'unknown', processes: [], error: `${sessionsDir}: ${(error as Error).message}` };
  }
  const processes: ProcessMatch[] = [];
  for (const name of names.filter((candidate) => /^\d+\.json$/.test(candidate)).sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(sessionsDir, name), 'utf8'));
    } catch {
      continue;
    }
    const entry = parsed !== null && typeof parsed === 'object' ? (parsed as { pid?: unknown; sessionId?: unknown; cwd?: unknown }) : {};
    const pid = typeof entry.pid === 'number' ? entry.pid : Number(name.slice(0, -'.json'.length));
    if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) continue;
    const session = typeof entry.sessionId === 'string' ? `session ${entry.sessionId.slice(0, 8)}` : 'a session';
    const where = typeof entry.cwd === 'string' ? ` in ${entry.cwd}` : '';
    processes.push({ pid, command: `${session}${where}, from its session file ${name}` });
  }
  return { label: CLI_PROCESS_NAME, status: processes.length > 0 ? 'running' : 'not-running', processes };
}

/** How the CLI is looked for; tests replace the parts that need a real process list. */
export interface DetectOptions {
  /** Runs pgrep; tests pass a stand-in, since pgrep cannot list processes inside the Claude Code sandbox. */
  pgrep?: PgrepRunner | undefined;
  /** The CLI's session index (<claudeDir>/sessions); null or undefined leaves the session files out. */
  sessionsDir?: string | null | undefined;
  /** Tells whether a process with that pid exists (processAlive); tests pass a stand-in. */
  isAlive?: ((pid: number) => boolean) | undefined;
}

/**
 * Every Claude Code CLI process: found by name, by first argument for
 * binaries named after their version (and by the first two for the npm
 * install), and through the CLI's own session index. The lists are merged
 * by pid. Only the first argument is kept for messages, never the rest of
 * the command line, which may hold a prompt. A process found anywhere
 * means "running", even when another source could not tell; "unknown" only
 * when nothing was found and some source failed.
 */
export async function detectClaudeCli(options: DetectOptions = {}): Promise<ProcessDetection> {
  const pgrep = options.pgrep ?? runPgrep;
  const [byName, byArgv, bySession] = await Promise.all([
    detectProcess(CLI_PROCESS_NAME, pgrep),
    pgrep(pgrepArgvArgs(CLI_ARGV_PATTERN)),
    options.sessionsDir ? detectCliSessionFiles(options.sessionsDir, options.isAlive) : Promise.resolve(null),
  ]);
  const found = new Map<number, ProcessMatch>();
  for (const match of byName.processes) found.set(match.pid, match);
  for (const line of byArgv.lines) {
    const parsed = /^(\d+)\s+(\S+)/.exec(line);
    if (!parsed) continue;
    const pid = Number(parsed[1]);
    if (!found.has(pid)) found.set(pid, { pid, command: parsed[2] ?? CLI_PROCESS_NAME });
  }
  for (const match of bySession?.processes ?? []) if (!found.has(match.pid)) found.set(match.pid, match);
  const processes = [...found.values()].sort((a, b) => a.pid - b.pid);
  if (processes.length > 0) return { label: CLI_PROCESS_NAME, status: 'running', processes };
  const sources = [byName, byArgv, ...(bySession ? [bySession] : [])];
  const failures = sources.map((source) => source.error).filter((error): error is string => typeof error === 'string');
  if (sources.some((source) => source.status === 'unknown')) {
    return { label: CLI_PROCESS_NAME, status: 'unknown', processes: [], error: failures.join('; ') || 'pgrep failed' };
  }
  return { label: CLI_PROCESS_NAME, status: 'not-running', processes: [] };
}

/**
 * The desktop app and the CLI, in that order. With the CLI's config
 * directory the session index there is read as well (see detectClaudeCli);
 * without it only the process list counts, which is what the README's
 * one-line check uses.
 */
export async function detectClaudeProcesses(claudeDir?: string, options: Omit<DetectOptions, 'sessionsDir'> = {}): Promise<ProcessDetection[]> {
  return Promise.all([
    detectProcess(APP_PROCESS_NAME, options.pgrep),
    detectClaudeCli({ ...options, sessionsDir: claudeDir ? path.join(claudeDir, SESSIONS_DIR_NAME) : null }),
  ]);
}

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

export function makeGuard(paths: Paths): Guard {
  return async () => (paths.liveUserData ? writeGate(paths, await detectClaudeProcesses(paths.claudeDir)) : { allowed: true, reason: null });
}

/** Thrown when the guard closes in the middle of an operation; the operation rolls itself back. */
export class GuardRefusal extends Error {
  constructor(reason: string | null) {
    super(reason ?? 'writes are not allowed');
    this.name = 'GuardRefusal';
  }
}
