// Builders for a throw-away "world": a fake desktop userData directory with
// two accounts, a fake ~/.claude with transcripts, and a data directory for
// the tool, all under one temporary root. Tests describe transcripts by a few
// numbers (prompts, e-mail, bridge owner) and get files shaped like the real
// ones written by the CLI, so every module runs against realistic input.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccountDir } from '../src/accounts.ts';
import { resolvePaths, type Paths } from '../src/paths.ts';
import { recordFileName, type SessionRecord } from '../src/records.ts';
import type { HostRunner } from '../src/ssh-host.ts';

export const ACCOUNT_A = { accountId: 'aaaaaaaa-1111-4111-8111-111111111111', orgId: 'a0a0a0a0-1111-4111-8111-111111111111' };
export const ACCOUNT_B = { accountId: 'bbbbbbbb-2222-4222-8222-222222222222', orgId: 'b0b0b0b0-2222-4222-8222-222222222222' };
export const CWD_ALPHA = '/Volumes/Store/Dev/alpha';
export const CWD_BETA = '/Volumes/Store/Dev/beta';
export const EMAIL_A = 'alpha@example.com';
export const EMAIL_B = 'beta@example.com';

export interface World {
  root: string;
  paths: Paths;
  a: AccountDir;
  b: AccountDir;
}

/** The CLI's project directory name: every character outside [a-zA-Z0-9] becomes "-". */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export async function makeWorld(): Promise<World> {
  const root = await mkdtemp(path.join(tmpdir(), 'ccas-test-'));
  const userData = path.join(root, 'userData');
  const claudeDir = path.join(root, 'claude');
  const dataDir = path.join(root, 'data');
  const paths = resolvePaths({ userData, claudeDir, data: dataDir, home: root, env: {} });
  const a: AccountDir = { ...ACCOUNT_A, dir: path.join(paths.sessionsRoot, ACCOUNT_A.accountId, ACCOUNT_A.orgId) };
  const b: AccountDir = { ...ACCOUNT_B, dir: path.join(paths.sessionsRoot, ACCOUNT_B.accountId, ACCOUNT_B.orgId) };
  await mkdir(a.dir, { recursive: true });
  await mkdir(b.dir, { recursive: true });
  await mkdir(paths.projectsRoot, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(paths.desktopConfigFile, JSON.stringify({ lastKnownAccountUuid: ACCOUNT_A.accountId, other: 'ignored' }));
  return { root, paths, a, b };
}

export async function destroyWorld(world: World): Promise<void> {
  await rm(world.root, { recursive: true, force: true });
}

export interface TranscriptSpec {
  cliId?: string;
  cwd?: string;
  /** Number of prompt/answer rounds; each round also gets one tool-result user line. */
  prompts?: number;
  /** One or more session_context e-mails, injected at the start and (for later ones) mid-way. */
  email?: string | string[] | null;
  bridgeOwner?: { accountId: string; orgId: string } | null;
  /** Value of the entrypoint field on message lines; null omits the field. */
  entrypoint?: string | null;
  title?: string | null;
  /** Epoch milliseconds of the first line; later lines follow one second apart. */
  startAt?: number;
  model?: string;
  /** Text of the first prompt; defaults to "prompt 1". */
  firstPrompt?: string;
}

export interface BuiltTranscript {
  cliId: string;
  lines: Record<string, unknown>[];
  /** uuids in file order, the chain the tool compares. */
  uuids: string[];
}

export function buildTranscriptLines(spec: TranscriptSpec = {}): BuiltTranscript {
  const cliId = spec.cliId ?? randomUUID();
  const cwd = spec.cwd ?? CWD_ALPHA;
  const prompts = spec.prompts ?? 2;
  const emails = spec.email === undefined ? [EMAIL_A] : spec.email === null ? [] : Array.isArray(spec.email) ? spec.email : [spec.email];
  const startAt = spec.startAt ?? Date.UTC(2026, 8, 1, 10, 0, 0);
  const model = spec.model ?? 'claude-opus-5';
  const lines: Record<string, unknown>[] = [];
  const uuids: string[] = [];
  let tick = 0;
  const stamp = (): string => new Date(startAt + tick++ * 1000).toISOString();
  const base = (): Record<string, unknown> => ({
    cwd,
    version: '2.1.275',
    isSidechain: false,
    userType: 'external',
    sessionId: cliId,
    ...(spec.entrypoint === null ? {} : { entrypoint: spec.entrypoint ?? 'claude-desktop' }),
  });
  const withUuid = (line: Record<string, unknown>): Record<string, unknown> => {
    const uuid = randomUUID();
    uuids.push(uuid);
    return { uuid, parentUuid: uuids.at(-2) ?? null, ...line };
  };
  const sessionContext = (email: string): Record<string, unknown> =>
    withUuid({
      ...base(),
      type: 'attachment',
      timestamp: stamp(),
      attachment: { type: 'session_context', context: { userEmail: `The user's email address is ${email}. Use it only to identify the user.` } },
    });

  lines.push({ type: 'queue-operation', operation: 'enqueue', timestamp: stamp(), sessionId: cliId, content: spec.firstPrompt ?? 'prompt 1' });
  if (emails[0]) lines.push(sessionContext(emails[0]));
  for (let round = 1; round <= prompts; round += 1) {
    if (round === Math.ceil(prompts / 2) + 1) {
      // Later e-mails model a conversation continued under another account.
      for (const email of emails.slice(1)) lines.push(sessionContext(email));
    }
    const text = round === 1 && spec.firstPrompt !== undefined ? spec.firstPrompt : `prompt ${round}`;
    lines.push(withUuid({ ...base(), type: 'user', timestamp: stamp(), message: { role: 'user', content: text } }));
    lines.push(
      withUuid({
        ...base(),
        type: 'assistant',
        timestamp: stamp(),
        message: { role: 'assistant', model, content: [{ type: 'tool_use', id: `toolu_${round}`, name: 'Read', input: { file_path: '/tmp/x' } }] },
      }),
    );
    lines.push(
      withUuid({
        ...base(),
        type: 'user',
        timestamp: stamp(),
        message: { role: 'user', content: [{ tool_use_id: `toolu_${round}`, type: 'tool_result', content: 'file content' }] },
        toolUseResult: { stdout: 'file content' },
      }),
    );
    lines.push(
      withUuid({ ...base(), type: 'assistant', timestamp: stamp(), message: { role: 'assistant', model, content: [{ type: 'text', text: `answer ${round}` }] } }),
    );
  }
  if (spec.bridgeOwner) {
    lines.push({
      type: 'bridge-session',
      sessionId: cliId,
      bridgeSessionId: `cse_${cliId.slice(0, 8)}`,
      lastSequenceNum: 0,
      ownerAccountUuid: spec.bridgeOwner.accountId,
      ownerOrganizationUuid: spec.bridgeOwner.orgId,
    });
  }
  if (spec.title) lines.push({ type: 'custom-title', customTitle: spec.title, sessionId: cliId });
  return { cliId, lines, uuids };
}

/** Time of the last timestamped line, used as the file modification time. */
function lastStamp(lines: readonly Record<string, unknown>[]): Date {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const stamp = lines[index]?.['timestamp'];
    if (typeof stamp === 'string') return new Date(stamp);
  }
  return new Date(Date.UTC(2026, 8, 1));
}

export interface WrittenTranscript extends BuiltTranscript {
  path: string;
  projectDir: string;
  sidecarDir: string;
  cwd: string;
}

/** Writes a transcript plus a sidecar directory with a tool result, a sub-agent transcript and a custom title. */
export async function writeTranscript(world: World, spec: TranscriptSpec = {}): Promise<WrittenTranscript> {
  const built = buildTranscriptLines(spec);
  const cwd = spec.cwd ?? CWD_ALPHA;
  const projectDir = path.join(world.paths.projectsRoot, encodeCwd(cwd));
  await mkdir(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${built.cliId}.jsonl`);
  await writeFile(filePath, built.lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const sidecarDir = path.join(projectDir, built.cliId);
  await mkdir(path.join(sidecarDir, 'tool-results'), { recursive: true });
  await mkdir(path.join(sidecarDir, 'subagents'), { recursive: true });
  await writeFile(path.join(sidecarDir, 'tool-results', 'result1.txt'), `output referencing ${built.cliId}\n`);
  await writeFile(
    path.join(sidecarDir, 'subagents', `agent-${built.cliId.slice(0, 8)}.jsonl`),
    `${JSON.stringify({ type: 'user', sessionId: built.cliId, isSidechain: true, uuid: randomUUID(), message: { role: 'user', content: 'sub task' } })}\n`,
  );
  if (spec.title) await writeFile(path.join(sidecarDir, 'custom-title.json'), JSON.stringify({ customTitle: spec.title }));
  // The file gets the modification time of its last line, as a real transcript
  // of a finished session has; the tool falls back to it for the last activity
  // of a transcript without timestamps.
  await utimes(filePath, lastStamp(built.lines), lastStamp(built.lines));
  return { ...built, path: filePath, projectDir, sidecarDir, cwd };
}

/** Host of the SSH sessions in these fixtures. */
export const SSH_HOST = 'build@mini.local';

/** The last byte of the first 64 KiB a read stream delivers: a character starting here is cut in two. */
export const BOUNDARY_BYTE = 65535;

export interface SshTranscriptSpec extends TranscriptSpec {
  /** Sub-agent transcripts (flat agent-<hex>.jsonl files next to the main one); 2 unless given. */
  agents?: number;
  /** Put a multi-byte character on byte 65535 of the main file and of every agent file. */
  straddle64k?: boolean;
}

export interface WrittenSshTranscript extends BuiltTranscript {
  path: string;
  /** <projectsRoot>/ssh-<cliId> */
  mirrorDir: string;
  agentPaths: string[];
  cwd: string;
}

/**
 * Serialises lines the way the CLI writes them (one JSON object per line, a
 * final newline). With `char`, a padding line goes in before the last line so
 * that `char` starts exactly on BOUNDARY_BYTE; the padding line is an
 * attachment without a uuid, so the uuid chain stays as built.
 */
function serializeLines(lines: readonly Record<string, unknown>[], sessionId: string, char: string | null): string {
  const serialize = (part: readonly Record<string, unknown>[]): string => part.map((line) => `${JSON.stringify(line)}\n`).join('');
  if (char === null) return serialize(lines);
  const head = serialize(lines.slice(0, -1));
  const tail = serialize(lines.slice(-1));
  const opening = `{"type":"attachment","sessionId":"${sessionId}","attachment":{"type":"note","text":"`;
  const padding = BOUNDARY_BYTE - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(opening, 'utf8');
  if (padding < 0) throw new Error('fixture too long to put a character on byte 65535');
  return `${head}${opening}${'a'.repeat(padding)}${char} zażółć gęślą jaźń"}}\n${tail}`;
}

async function writePrivateFile(filePath: string, text: string): Promise<void> {
  await writeFile(filePath, text, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

/**
 * Writes the local mirror of an SSH session the way the desktop app keeps it:
 * <projectsRoot>/ssh-<id>/<id>.jsonl plus flat agent-<hex>.jsonl files, the
 * directory 0700 and the files 0600. Every file holds the session id, Polish
 * characters and emoji, and the main transcript ends with the bridge-session
 * line of the source account, as real mirrors do.
 */
export async function writeSshTranscript(world: World, spec: SshTranscriptSpec = {}): Promise<WrittenSshTranscript> {
  const built = buildTranscriptLines({ firstPrompt: 'zażółć gęślą jaźń 🙂', bridgeOwner: ACCOUNT_A, ...spec, title: null });
  const cwd = spec.cwd ?? CWD_ALPHA;
  const mirrorDir = path.join(world.paths.projectsRoot, `ssh-${built.cliId}`);
  await mkdir(mirrorDir, { recursive: true, mode: 0o700 });
  await chmod(mirrorDir, 0o700);
  const filePath = path.join(mirrorDir, `${built.cliId}.jsonl`);
  await writePrivateFile(filePath, serializeLines(built.lines, built.cliId, spec.straddle64k ? '🙂' : null));
  const agentPaths: string[] = [];
  for (let index = 0; index < (spec.agents ?? 2); index += 1) {
    const agentPath = path.join(mirrorDir, `agent-${randomBytes(8).toString('hex')}.jsonl`);
    const lines = [
      { type: 'user', sessionId: built.cliId, isSidechain: true, uuid: randomUUID(), message: { role: 'user', content: `podzadanie ${index + 1}: źdźbło 🙂` } },
      { type: 'assistant', sessionId: built.cliId, isSidechain: true, uuid: randomUUID(), message: { role: 'assistant', content: [{ type: 'text', text: 'gotowe, łódź €' }] } },
    ];
    await writePrivateFile(agentPath, serializeLines(lines, built.cliId, spec.straddle64k ? 'ł' : null));
    agentPaths.push(agentPath);
  }
  await utimes(filePath, lastStamp(built.lines), lastStamp(built.lines));
  return { ...built, path: filePath, mirrorDir, agentPaths, cwd };
}

/** The fields an SSH record carries in the app, shaped like real ones (see SOURCE_BOUND_FIELDS in records.ts). */
export function sshRecordFields(cliId: string): RecordSpec {
  return {
    sshConfig: { sshHost: SSH_HOST },
    sshRemoteProcessId: 'rp_4242',
    sshReattach: {
      v: 1,
      processId: 'rp_4242',
      hostKey: 'SHA256:fixture',
      checkpoint: 12,
      state: 'adoptable',
      remoteControl: false,
      recordedAt: Date.UTC(2026, 8, 1, 10, 30, 0),
    },
    sshRemoteTranscriptPath: `/Users/build/.claude/projects/-Users-build-alpha/${cliId}.jsonl`,
    bridgeSessionIds: ['session_ssh'],
    lastAssistantUuid: '5c1e7a2b-0d4f-4e8a-9b3c-6f2d8e1a7b40',
    interruptedByQuitAt: Date.UTC(2026, 8, 1, 10, 31, 0),
  };
}

/** Home directory of the world's fake SSH host; its ~/.claude is <root>/host/.claude. */
export function hostHome(world: World): string {
  return path.join(world.root, 'host');
}

/** Folder the CLI on the host keeps the fixtures' SSH conversations in (they run in /Users/build/alpha there). */
export function hostProjectDir(world: World): string {
  return path.join(hostHome(world), '.claude', 'projects', encodeCwd('/Users/build/alpha'));
}

export interface WrittenHostTranscript {
  path: string;
  sidecarDir: string;
}

/**
 * Writes the host side of an SSH conversation as the CLI keeps it there: the
 * transcript with the bytes of the local mirror (the app's mirror is a byte
 * copy of it) and a side folder with the sub-agent transcripts under
 * subagents/, a tool result that names the session id, and a custom title.
 */
export async function writeHostTranscript(world: World, ssh: WrittenSshTranscript): Promise<WrittenHostTranscript> {
  const dir = hostProjectDir(world);
  const sidecarDir = path.join(dir, ssh.cliId);
  await mkdir(path.join(sidecarDir, 'subagents'), { recursive: true });
  await mkdir(path.join(sidecarDir, 'tool-results'), { recursive: true });
  const filePath = path.join(dir, `${ssh.cliId}.jsonl`);
  await copyFile(ssh.path, filePath);
  for (const agentPath of ssh.agentPaths) await copyFile(agentPath, path.join(sidecarDir, 'subagents', path.basename(agentPath)));
  await writeFile(path.join(sidecarDir, 'tool-results', 'toolu_1.txt'), `saved output of ${ssh.cliId}\n`);
  await writeFile(path.join(sidecarDir, 'custom-title.json'), JSON.stringify({ customTitle: `title of ${ssh.cliId}` }));
  return { path: filePath, sidecarDir };
}

/**
 * Runs host scripts on this machine the way ssh runs them on the host
 * ("sh -s", the script on standard input), with the fake host's home as HOME
 * and without CLAUDE_CONFIG_DIR, so they work on the world's host directory
 * and nowhere else.
 */
export function localHostRunner(home: string): HostRunner {
  return (_target, script) =>
    new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
      delete env['CLAUDE_CONFIG_DIR'];
      const child = spawn('/bin/sh', ['-s'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(script);
    });
}

/** A host ssh cannot connect to: exit 255 and ssh's message, as a real refused connection gives. */
export const unreachableHostRunner: HostRunner = async (target) => ({
  code: 255,
  stdout: '',
  stderr: `ssh: connect to host ${target.host} port 22: Connection refused\n`,
});

/** The stand-in for ssh the CLI tests point CCAS_SSH at (see test/fake-ssh.sh). */
export const FAKE_SSH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-ssh.sh');

/** Replaces an ASCII id inside raw bytes and leaves every other byte exactly as it is. */
export function replaceInBytes(bytes: Buffer, from: string, to: string): Buffer {
  return Buffer.from(bytes.toString('latin1').split(from).join(to), 'latin1');
}

/** Every file under a directory, by path relative to it, with its bytes and permission bits. */
export async function readTree(dir: string): Promise<Map<string, { bytes: Buffer; mode: number }>> {
  const tree = new Map<string, { bytes: Buffer; mode: number }>();
  const names = (await readdir(dir, { recursive: true })).sort();
  for (const name of names) {
    const target = path.join(dir, name);
    const info = await stat(target);
    if (info.isFile()) tree.set(name, { bytes: await readFile(target), mode: info.mode & 0o777 });
  }
  return tree;
}

/** Appends more prompt rounds to an existing transcript, continuing the uuid chain. */
export async function appendRounds(transcript: WrittenTranscript, rounds: number, startAt?: number): Promise<string[]> {
  const extra = buildTranscriptLines({ cliId: transcript.cliId, cwd: transcript.cwd, prompts: rounds, email: null, startAt: startAt ?? Date.UTC(2026, 8, 2, 10, 0, 0) });
  // Drop the queue-operation opener so the appended block looks like a resumed session.
  const lines = extra.lines.filter((line) => line['type'] !== 'queue-operation');
  await appendFile(transcript.path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  await utimes(transcript.path, lastStamp(lines), lastStamp(lines));
  transcript.lines.push(...lines);
  transcript.uuids.push(...extra.uuids);
  return extra.uuids;
}

export interface RecordSpec extends Partial<SessionRecord> {
  cliSessionId?: string;
}

/** Writes a record in the shape the app writes in September 2026 unless overridden. */
export async function writeRecord(world: World, account: AccountDir, spec: RecordSpec): Promise<{ path: string; record: SessionRecord }> {
  const sessionId = spec.sessionId ?? `local_${spec.cliSessionId ?? randomUUID()}`;
  const record: SessionRecord = {
    cwd: CWD_ALPHA,
    originCwd: CWD_ALPHA,
    createdAt: Date.UTC(2026, 8, 1, 10, 0, 0),
    lastActivityAt: Date.UTC(2026, 8, 1, 10, 30, 0),
    lastFocusedAt: Date.UTC(2026, 8, 1, 10, 30, 0),
    title: 'Fixture conversation',
    titleSource: 'auto',
    isArchived: false,
    model: 'claude-opus-5',
    permissionMode: 'default',
    completedTurns: 2,
    ...spec,
    sessionId,
  };
  // exactOptionalPropertyTypes forbids an explicit undefined, so the id is only set when given.
  if (spec.cliSessionId === undefined) delete record.cliSessionId;
  else record.cliSessionId = spec.cliSessionId;
  await mkdir(account.dir, { recursive: true });
  const filePath = path.join(account.dir, recordFileName(sessionId));
  await writeFile(filePath, JSON.stringify(record, null, 2));
  return { path: filePath, record };
}

export async function readJson<T = unknown>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

export async function readLines(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
