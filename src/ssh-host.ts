// Work on the SSH host of a conversation.
//
// A Code-tab conversation can run on another machine over SSH. Its transcript
// then lives on that machine, next to the transcripts of every other session
// of the same folder:
//   <host ~/.claude>/projects/<encoded cwd>/<cliSessionId>.jsonl
//   <host ~/.claude>/projects/<encoded cwd>/<cliSessionId>/   (tool results,
//                                                sub-agents, custom title)
// and the desktop app keeps only a local mirror of it for display
// (transcripts.ts). Whenever the app starts the conversation (a message is
// sent, or the app warms an idle conversation up when it becomes visible
// again) it runs the CLI on the host with --resume <cliSessionId>, and the
// CLI looks for that file on the host. A copy with a new id that exists only
// in the local mirror therefore fails there with "No conversation found with
// session ID"; the app then removes the CLI session id from the copy's
// record (it calls this a stale resume handle), shows "Session history
// unavailable", and the copy's history is gone from view. Seen live on
// 2026-09-28 with ccas copies made before this module existed.
//
// So a copy of an SSH conversation also gets a transcript of its own on the
// host, made the way the desktop app makes the host side of its own fork of
// an SSH conversation: a copy of the original's file under the new id, in
// the original's folder, finished with bridge tombstones so the copy does
// not link up with the original's Remote Control session. Unlike the app's
// fork, which copies the file as it is, the copy here gets the session id
// rewritten everywhere, like every copy this tool makes (see
// SessionIdRewriter in transcripts.ts), and the original's side folder is
// copied along, so the paths inside the transcript that point into it still
// lead somewhere. Rewriting the original on the host instead of uploading
// the local mirror keeps the invariant the app's sync relies on: the local
// mirror of the copy (made from the local mirror of the original, which is a
// byte prefix of the host file) is a byte prefix of the host copy, because
// the id has the same length and nothing else changes; whatever the host has
// beyond it (newer lines, the tombstones) reaches the mirror with the app's
// next sync.
//
// How the host is reached: the Mac's own ssh with the record's sshConfig
// (host, port, key file), which is also what the app uses, in batch mode so
// that nothing ever waits for a password. The work is a POSIX sh script sent
// on standard input to `sh -s`, so the remote login shell only ever parses
// "sh -s" and the script needs no quoting for it. Every value the script
// uses is quoted for sh (shQuote). Environment variable CCAS_SSH names
// another ssh program; the tests point it at a stand-in that runs the script
// locally against a fake host directory.
//
// Undo: the host changes are journaled like local ones (journal.ts,
// JournalEntry.remote): created paths are set aside by renaming them to
// "<path>.ccas-removed-<tag>" and replaced ones come back from
// "<path>.ccas-backup-<tag>". Names that do not end in .jsonl are ignored by
// the CLI, so a set-aside or backed-up transcript never counts as a session.
// Nothing on the host is deleted.
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { SessionRecord } from './records.ts';

/** How to reach the host of an SSH conversation (from the record's sshConfig). */
export interface HostTarget {
  /** "user@host" or an alias from ~/.ssh/config, exactly as the app has it. */
  host: string;
  port?: number | undefined;
  identityFile?: string | undefined;
}

/** The host an SSH conversation runs on, or null for a local conversation. */
export function hostTargetOf(record: SessionRecord | null | undefined): HostTarget | null {
  const config = record?.sshConfig;
  const host = config?.sshHost;
  if (typeof host !== 'string' || host.trim().length === 0) return null;
  const target: HostTarget = { host };
  if (typeof config?.sshPort === 'number' && Number.isInteger(config.sshPort) && config.sshPort > 0) target.port = config.sshPort;
  if (typeof config?.sshIdentityFile === 'string' && config.sshIdentityFile.length > 0) target.identityFile = config.sshIdentityFile;
  return target;
}

/** The host as shown in messages: "user@host", with ":port" when one is set. */
export function describeHost(target: HostTarget): string {
  return target.port === undefined ? target.host : `${target.host}:${target.port}`;
}

/**
 * How a script run on the host ended, as a HostRunner reports it. The
 * callers read the CCAS_* marker lines from stdout and take the reason of a
 * failure from them, else from stderr.
 */
export interface HostRunResult {
  /** Exit code of the remote script, 255 when ssh could not connect, null when killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a POSIX sh script on a host and reports how it ended; rejects only when ssh could not be started at all. */
export type HostRunner = (target: HostTarget, script: string) => Promise<HostRunResult>;

/**
 * Why a host step did not work:
 *   unreachable  ssh could not connect (or could not be started)
 *   missing      the transcript to work on is not on the host
 *   conflict     what the step would create exists already
 *   failed       the script ran and failed (a write on the host went wrong)
 */
export type HostStepFailure = 'unreachable' | 'missing' | 'conflict' | 'failed';

/**
 * A host step that did not work. Operations treat it like a refusal: they
 * undo what they did and report the message.
 */
export class HostStepError extends Error {
  readonly target: HostTarget;
  readonly kind: HostStepFailure;

  constructor(target: HostTarget, kind: HostStepFailure, message: string) {
    super(message);
    this.name = 'HostStepError';
    this.target = target;
    this.kind = kind;
  }
}

/**
 * Arguments for ssh. BatchMode makes a missing key or an unknown host key an
 * error instead of a prompt nobody answers (the script arrives on standard
 * input, so ssh could not ask there anyway); the keepalive options end a
 * connection to a host that went away instead of hanging.
 */
export function sshArguments(target: HostTarget): string[] {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=20',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
    ...(target.port === undefined ? [] : ['-p', String(target.port)]),
    ...(target.identityFile === undefined ? [] : ['-i', target.identityFile]),
    '--',
    target.host,
    'sh -s',
  ];
}

/** Output kept from one remote run; the scripts print a few short lines, anything past this is noise. */
const OUTPUT_LIMIT = 1024 * 1024;

/** The default runner: the Mac's ssh (or the program in CCAS_SSH) with the script on standard input. */
export function sshRunner(program: string = process.env['CCAS_SSH'] || 'ssh'): HostRunner {
  return (target, script) =>
    new Promise((resolve, reject) => {
      const child = spawn(program, sshArguments(target), { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < OUTPUT_LIMIT) stderr += chunk;
      });
      child.on('error', (error) => {
        reject(new HostStepError(target, 'unreachable', `could not start ${program}: ${error.message}`));
      });
      // A remote side that closes standard input early (ssh failed to connect)
      // makes the write fail with EPIPE; the exit code tells what happened.
      child.stdin.on('error', () => undefined);
      child.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(script);
    });
}

/** Quotes a value for sh: single quotes, with every single quote inside closed, escaped and reopened. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Session ids as they appear in file names; everything the scripts build names from must match. */
const ID_RE = /^[A-Za-z0-9_-]+$/;
/** Journal ids tag backups on the host (see journal.ts, newJournalId). */
const TAG_RE = /^[A-Za-z0-9_-]+$/;

function assertId(value: string, what: string): void {
  if (!ID_RE.test(value)) throw new Error(`refusing to use ${JSON.stringify(value)} as a ${what} on the host`);
}

/**
 * Lines every script starts with: stop on unset variables, private files
 * (transcripts are 0600, as the CLI writes them), byte semantics for sed and
 * awk (a transcript may hold any UTF-8, and a session id is plain ASCII, so
 * replacing it byte by byte changes nothing else), and the CLI's config
 * directory, which CLAUDE_CONFIG_DIR moves.
 */
const PRELUDE = ['set -u', 'umask 077', 'LC_ALL=C', 'export LC_ALL', 'C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"'];

/**
 * awk program that prints a bridge tombstone for every session id whose last
 * bridge-session line still names a claude.ai session. It is the desktop
 * app's own program (the one it runs on the host when it forks an SSH
 * conversation), so a copy ends up exactly like a fork of the app. The line
 * prefix below is how the CLI serialises the start of a bridge-session line.
 */
const TOMBSTONE_AWK = [
  'index($0, "{\\"type\\":\\"bridge-session\\",\\"sessionId\\":\\"") == 1 && match(substr($0, 39), /^[A-Za-z0-9_-]+/) {',
  's = substr($0, 39, RLENGTH);',
  'if ((s in seen) == 0) { n++; order[n] = s; seen[s] = 1 };',
  'r = substr($0, 39 + RLENGTH);',
  'if ($0 == "{\\"type\\":\\"bridge-session\\",\\"sessionId\\":\\"" s "\\",\\"bridgeSessionId\\":\\"\\",\\"lastSequenceNum\\":0}") live[s] = 0;',
  'else if (index(r, "\\",\\"bridgeSessionId\\":\\"") == 1 && (substr(r, 22, 1) == "\\"") == 0 && substr($0, length($0), 1) == "}") live[s] = 1 }',
  'END { for (i = 1; i <= n; i++) if (live[order[i]]) print "{\\"type\\":\\"bridge-session\\",\\"sessionId\\":\\"" order[i] "\\",\\"bridgeSessionId\\":\\"\\",\\"lastSequenceNum\\":0}" }',
].join(' ');

/**
 * awk program that prints the claude.ai session id of every live link: per
 * session id, the bridgeSessionId of its last bridge-session line, when that
 * is not empty. Same line parsing as TOMBSTONE_AWK; the probe uses it to tell
 * a link inherited from the original from one made on the target account.
 */
const LIVE_AWK = [
  'index($0, "{\\"type\\":\\"bridge-session\\",\\"sessionId\\":\\"") == 1 && match(substr($0, 39), /^[A-Za-z0-9_-]+/) {',
  's = substr($0, 39, RLENGTH);',
  'if ((s in seen) == 0) { n++; order[n] = s; seen[s] = 1 };',
  'r = substr($0, 39 + RLENGTH);',
  'if (index(r, "\\",\\"bridgeSessionId\\":\\"") == 1) { b = substr(r, 22); b = substr(b, 1, index(b, "\\"") - 1); last[s] = b } }',
  'END { for (i = 1; i <= n; i++) if (last[order[i]] != "") print last[order[i]] }',
].join(' ');

/**
 * sh function appending the tombstones of file "$1" to file "$2" (the same
 * file, or the copy being built from it) and reporting each ended session id
 * as "CCAS_TOMBSTONE:<id>". A newline goes first when the file does not end
 * with one, as the app does.
 */
const TOMBSTONE_FUNCTION = [
  'tombstones() {',
  `  B=$(awk '${TOMBSTONE_AWK}' "$1") || return 1`,
  '  [ -n "$B" ] || return 0',
  `  { [ -z "$(tail -c 1 "$2")" ] || printf '\\n'; printf '%s\\n' "$B"; } >> "$2" || return 1`,
  `  printf '%s\\n' "$B" | sed 's/^.*"sessionId":"\\([^"]*\\)".*$/CCAS_TOMBSTONE:\\1/'`,
  '}',
];

/**
 * sh function copying the side folder "$1" of the original into "$2" (which
 * must not exist), using "$3" as a scratch list: entry names and the contents
 * of .json and .jsonl files get $OLD replaced by $NEW, other files are copied
 * as they are. Names come from the CLI (ids, hex, fixed words), so reading
 * them line by line is safe. The loops read the list from a file rather than
 * from a pipe: a loop at the end of a pipe runs in a subshell in some shells
 * and in the script's own shell in others, so a failure inside it could not
 * be handled the same way everywhere.
 */
const COPY_TREE_FUNCTION = [
  'copy_tree() {',
  '  [ -d "$1" ] || return 1',
  '  mkdir "$2" || return 1',
  '  ( cd "$1" && find . -type d ) > "$3" || return 1',
  '  while IFS= read -r d; do',
  '    [ "$d" = . ] && continue',
  '    mkdir -p "$2/$(printf \'%s\' "$d" | sed "s/$OLD/$NEW/g")" || return 1',
  '  done < "$3"',
  '  ( cd "$1" && find . -type f ) > "$3" || return 1',
  '  while IFS= read -r f; do',
  '    n=$(printf \'%s\' "$f" | sed "s/$OLD/$NEW/g")',
  '    case "$f" in',
  '      *.json|*.jsonl) sed "s/$OLD/$NEW/g" "$1/$f" > "$2/$n" || return 1 ;;',
  '      *) cp -p "$1/$f" "$2/$n" || return 1 ;;',
  '    esac',
  '  done < "$3"',
  '}',
];

/** What the host holds for a copy, found before anything is written there. */
export interface HostProbe {
  /** Folder of the original's transcript on the host; null when the host has no transcript under that id. */
  dir: string | null;
  /** Whether the original has a side folder next to its transcript. */
  sourceSidecar: boolean;
  /** The copy's transcript, when the host has one already. */
  target: string | null;
  /** The copy's side folder next to the original, when the host has one already. */
  targetSidecar: string | null;
  /** claude.ai sessions the copy's transcript on the host still links up with (see LIVE_AWK); empty when none. */
  targetLive: string[];
}

/**
 * What probeScript looks for on the host: the original's transcript, the
 * copy's, and the path the original's record gives as a hint.
 */
export interface ProbeRequest {
  /** CLI session id of the original, whose transcript is copied. */
  sourceCliSessionId: string;
  /** CLI session id of the copy. */
  targetCliSessionId: string;
  /** Where the original's record says its transcript is (sshRemoteTranscriptPath); checked, then searched for when wrong. */
  hint?: string | null | undefined;
}

/**
 * The read-only look at the host: finds the original's transcript (at the
 * hinted path when it is there and carries the id, otherwise by searching
 * every project folder, as the app does), whether the copy already has a
 * transcript or side folder there, and whether that transcript still links
 * up with a claude.ai session. The source and target ids may be the same, to
 * look at one conversation's own transcript (a move).
 */
export function probeScript(request: ProbeRequest): string {
  assertId(request.sourceCliSessionId, 'session id');
  assertId(request.targetCliSessionId, 'session id');
  return [
    ...PRELUDE,
    `OLD=${shQuote(request.sourceCliSessionId)}`,
    `NEW=${shQuote(request.targetCliSessionId)}`,
    `HINT=${shQuote(request.hint ?? '')}`,
    'P=""',
    'case "$HINT" in */"$OLD.jsonl") [ -f "$HINT" ] && P=$HINT ;; esac',
    'if [ -z "$P" ]; then P=$(find -L "$C/projects" -name "$OLD.jsonl" -type f 2>/dev/null | head -n 1); fi',
    'if [ -n "$P" ]; then',
    '  D=$(dirname "$P")',
    '  echo "CCAS_DIR:$D"',
    '  [ -d "$D/$OLD" ] && echo "CCAS_SOURCE_SIDECAR"',
    // The copy goes next to the original, so that is where its side folder counts.
    '  [ -e "$D/$NEW" ] && echo "CCAS_TARGET_SIDECAR:$D/$NEW"',
    'fi',
    'K=$(find -L "$C/projects" -name "$NEW.jsonl" -type f 2>/dev/null | head -n 1)',
    'if [ -n "$K" ]; then',
    '  echo "CCAS_TARGET:$K"',
    `  awk '${LIVE_AWK}' "$K" 2>/dev/null | sed 's/^/CCAS_TARGET_LIVE:/'`,
    'fi',
    'echo "CCAS_OK"',
  ].join('\n');
}

/** Values of the output lines "<marker>:<value>", in order. */
function markerValues(stdout: string, marker: string): string[] {
  const prefix = `${marker}:`;
  return stdout
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

function hasMarker(stdout: string, marker: string): boolean {
  return stdout.split('\n').some((line) => line === marker);
}

/**
 * A readable reason for a failed run: the script's own message, else what ssh
 * said. The scripts exit with 3 when a transcript is missing and 6 when a
 * target exists; ssh itself exits with 255 when it cannot connect.
 */
function failureOf(target: HostTarget, result: HostRunResult, doing: string): HostStepError {
  const kind: HostStepFailure = result.code === 255 ? 'unreachable' : result.code === 3 ? 'missing' : result.code === 6 ? 'conflict' : 'failed';
  const own = markerValues(result.stdout, 'CCAS_ERROR').at(-1);
  if (own) return new HostStepError(target, kind, `${doing} on ${describeHost(target)}: ${own}`);
  const said = result.stderr.trim().split('\n').filter((line) => line.trim().length > 0).at(-1) ?? '';
  if (kind === 'unreachable') {
    return new HostStepError(
      target,
      kind,
      `could not reach ${describeHost(target)} over ssh${said ? ` (${said})` : ''}; "ssh ${target.host} true" must work in Terminal without asking for anything (key loaded into the agent, host key known)`,
    );
  }
  return new HostStepError(target, kind, `${doing} on ${describeHost(target)} failed (exit ${result.code ?? 'by signal'}${said ? `: ${said}` : ''})`);
}

/** Looks at the host without changing anything (probeScript). */
export async function probeHost(runner: HostRunner, target: HostTarget, request: ProbeRequest): Promise<HostProbe> {
  const result = await runner(target, probeScript(request));
  if (result.code !== 0 || !hasMarker(result.stdout, 'CCAS_OK')) throw failureOf(target, result, 'looking for the transcripts');
  return {
    dir: markerValues(result.stdout, 'CCAS_DIR').at(0) ?? null,
    sourceSidecar: hasMarker(result.stdout, 'CCAS_SOURCE_SIDECAR'),
    target: markerValues(result.stdout, 'CCAS_TARGET').at(0) ?? null,
    targetSidecar: markerValues(result.stdout, 'CCAS_TARGET_SIDECAR').at(0) ?? null,
    targetLive: markerValues(result.stdout, 'CCAS_TARGET_LIVE'),
  };
}

/**
 * What copyScript makes on the host: a copy of the original's transcript
 * and side folder under the copy's CLI session id, in the original's folder
 * (found by probeHost).
 */
export interface HostCopyRequest {
  /** Folder of the original on the host (HostProbe.dir); the copy goes next to it. */
  dir: string;
  sourceCliSessionId: string;
  targetCliSessionId: string;
  /**
   * Set when the copy replaces an existing one (an update): the old
   * transcript and side folder are kept as "<path>.ccas-backup-<tag>". Without
   * it an existing target is an error and nothing is touched.
   */
  replaceTag?: string | null | undefined;
}

/** The paths a copy creates on the host, and where replaced ones are kept; for the journal, which records them first. */
export function hostCopyPaths(request: HostCopyRequest, sidecar: boolean): { transcript: string; sidecar: string | null; backupSuffix: string | null } {
  return {
    transcript: path.posix.join(request.dir, `${request.targetCliSessionId}.jsonl`),
    sidecar: sidecar ? path.posix.join(request.dir, request.targetCliSessionId) : null,
    backupSuffix: request.replaceTag ? `.ccas-backup-${request.replaceTag}` : null,
  };
}

/**
 * Makes the copy on the host: the original's transcript with the id
 * rewritten and tombstones appended, and its side folder with the id
 * rewritten, both built under temporary names and moved into place at the
 * end. The transcript comes last: the CLI resumes a session only once its
 * transcript exists, so nothing can start the copy before it is complete.
 * Exit codes: 3 the original is gone, 5 a write failed, 6 the target exists
 * (or appeared meanwhile).
 */
export function copyScript(request: HostCopyRequest): string {
  assertId(request.sourceCliSessionId, 'session id');
  assertId(request.targetCliSessionId, 'session id');
  const tag = request.replaceTag ?? '';
  if (tag !== '' && !TAG_RE.test(tag)) throw new Error(`refusing to use ${JSON.stringify(tag)} as a backup tag on the host`);
  return [
    ...PRELUDE,
    ...TOMBSTONE_FUNCTION,
    ...COPY_TREE_FUNCTION,
    `D=${shQuote(request.dir)}`,
    `OLD=${shQuote(request.sourceCliSessionId)}`,
    `NEW=${shQuote(request.targetCliSessionId)}`,
    `TAG=${shQuote(tag)}`,
    'P="$D/$OLD.jsonl"; F="$D/$NEW.jsonl"; S="$D/$OLD"; SN="$D/$NEW"',
    'T="$F.ccas-tmp.$$"; ST="$SN.ccas-tmp.$$"; LIST="$SN.ccas-tmp.$$.list"',
    'fail() { rm -f "$T" "$LIST"; rm -rf "$ST"; echo "CCAS_ERROR:$2"; exit "$1"; }',
    '[ -f "$P" ] || fail 3 "the transcript $P is not there any more"',
    'if [ -z "$TAG" ]; then',
    '  [ -e "$F" ] && fail 6 "$F exists already"',
    '  [ -e "$SN" ] && fail 6 "$SN exists already"',
    'fi',
    'sed "s/$OLD/$NEW/g" "$P" > "$T" || fail 5 "could not write $T"',
    'tombstones "$T" "$T" || fail 5 "could not end the Remote Control link in $T"',
    'if [ -d "$S" ]; then copy_tree "$S" "$ST" "$LIST" || fail 5 "could not copy $S"; rm -f "$LIST"; fi',
    'if [ -n "$TAG" ]; then',
    '  if [ -e "$F" ]; then mv "$F" "$F.ccas-backup-$TAG" || fail 5 "could not keep $F aside"; echo "CCAS_MOVED:$F"; fi',
    '  if [ -e "$SN" ]; then mv "$SN" "$SN.ccas-backup-$TAG" || fail 5 "could not keep $SN aside"; echo "CCAS_MOVED:$SN"; fi',
    'fi',
    'if [ -d "$ST" ]; then',
    '  [ -e "$SN" ] && fail 6 "$SN appeared meanwhile"',
    '  mv "$ST" "$SN" || fail 5 "could not create $SN"',
    '  echo "CCAS_CREATED:$SN"',
    'fi',
    // ln refuses an existing name, so a transcript that appeared meanwhile is never overwritten.
    'ln "$T" "$F" 2>/dev/null || fail 6 "$F appeared meanwhile"',
    'rm -f "$T"',
    'echo "CCAS_CREATED:$F"',
    'echo "CCAS_OK"',
  ].join('\n');
}

/**
 * What copyOnHost did, from the marker lines the script printed: the paths
 * it created, the ones it kept aside, and the session ids whose Remote
 * Control link it ended.
 */
export interface HostCopyResult {
  created: string[];
  /** Paths replaced ones were moved from (each now at path + backup suffix). */
  moved: string[];
  /** Session ids whose Remote Control link the copy ended. */
  tombstoned: string[];
}

/** Runs copyScript; a failure leaves no temporary files on the host (the script removes them). */
export async function copyOnHost(runner: HostRunner, target: HostTarget, request: HostCopyRequest): Promise<HostCopyResult> {
  const result = await runner(target, copyScript(request));
  if (result.code !== 0 || !hasMarker(result.stdout, 'CCAS_OK')) throw failureOf(target, result, 'copying the transcript');
  return {
    created: markerValues(result.stdout, 'CCAS_CREATED'),
    moved: markerValues(result.stdout, 'CCAS_MOVED'),
    tombstoned: markerValues(result.stdout, 'CCAS_TOMBSTONE'),
  };
}

/**
 * Ends the Remote Control links of a transcript already on the host (a moved
 * conversation, or a copy the host has already): appends the tombstones in
 * place. Appending is safe next to a CLI that still writes the file, since
 * both only ever append whole lines.
 */
export function tombstoneScript(transcriptPath: string): string {
  return [
    ...PRELUDE,
    ...TOMBSTONE_FUNCTION,
    `F=${shQuote(transcriptPath)}`,
    '[ -f "$F" ] || { echo "CCAS_ERROR:$F is not there"; exit 3; }',
    'tombstones "$F" "$F" || { echo "CCAS_ERROR:could not end the Remote Control link in $F"; exit 5; }',
    'echo "CCAS_OK"',
  ].join('\n');
}

/** Runs tombstoneScript; returns the session ids whose link it ended (none when there was nothing live). */
export async function tombstoneOnHost(runner: HostRunner, target: HostTarget, transcriptPath: string): Promise<string[]> {
  const result = await runner(target, tombstoneScript(transcriptPath));
  if (result.code !== 0 || !hasMarker(result.stdout, 'CCAS_OK')) throw failureOf(target, result, 'switching Remote Control off');
  return markerValues(result.stdout, 'CCAS_TOMBSTONE');
}

/**
 * What undoScript undoes on the host: the created and moved paths of a
 * journal entry (JournalEntry.remote) and the tag of the set-aside names.
 */
export interface HostUndoRequest {
  /** Paths the operation created, in the order it announced them. */
  created: readonly string[];
  /** Replaced paths and where they were kept, in order. */
  moved: readonly { from: string; to: string }[];
  /** Tag of the undo itself, for the names created paths are set aside under. */
  tag: string;
}

/**
 * Undoes host changes, newest first: every created path (and any temporary
 * file a cut-short copy left next to it) is set aside as
 * "<path>.ccas-removed-<tag>", then every kept original is moved back when
 * its place is free. A path that is not there is skipped, so an operation
 * that stopped half-way is undone as far as it got.
 */
export function undoScript(request: HostUndoRequest): string {
  if (!TAG_RE.test(request.tag)) throw new Error(`refusing to use ${JSON.stringify(request.tag)} as a tag on the host`);
  const lines = [...PRELUDE, `TAG=${shQuote(request.tag)}`];
  lines.push('aside() { if [ -e "$1" ]; then if mv "$1" "$1.ccas-removed-$TAG"; then echo "CCAS_SETASIDE:$1"; else echo "CCAS_WARN:could not set $1 aside"; fi; fi; }');
  for (const created of [...request.created].reverse()) {
    lines.push(`X=${shQuote(created)}`, 'for Y in "$X".ccas-tmp.*; do aside "$Y"; done', 'aside "$X"');
  }
  for (const move of [...request.moved].reverse()) {
    lines.push(
      `FROM=${shQuote(move.from)}`,
      `TO=${shQuote(move.to)}`,
      'if [ -e "$TO" ] && [ ! -e "$FROM" ]; then',
      '  if mv "$TO" "$FROM"; then echo "CCAS_MOVEDBACK:$FROM"; else echo "CCAS_WARN:could not move $TO back to $FROM"; fi',
      'elif [ -e "$TO" ]; then',
      '  echo "CCAS_WARN:both $FROM and $TO exist; left as they are"',
      'fi',
    );
  }
  lines.push('echo "CCAS_OK"');
  return lines.join('\n');
}

/**
 * What undoOnHost did, as lines for the restore output: the steps taken and
 * the warnings, each naming the host.
 */
export interface HostUndoResult {
  steps: string[];
  warnings: string[];
}

/** Runs undoScript and describes what it did; throws HostStepError when the host could not be reached. */
export async function undoOnHost(runner: HostRunner, target: HostTarget, request: HostUndoRequest): Promise<HostUndoResult> {
  const result = await runner(target, undoScript(request));
  if (result.code !== 0 || !hasMarker(result.stdout, 'CCAS_OK')) throw failureOf(target, result, 'undoing the host changes');
  const host = describeHost(target);
  return {
    steps: [
      ...markerValues(result.stdout, 'CCAS_SETASIDE').map((value) => `set aside ${value} on ${host}`),
      ...markerValues(result.stdout, 'CCAS_MOVEDBACK').map((value) => `moved ${value} back on ${host}`),
    ],
    warnings: markerValues(result.stdout, 'CCAS_WARN').map((value) => `${host}: ${value}`),
  };
}
