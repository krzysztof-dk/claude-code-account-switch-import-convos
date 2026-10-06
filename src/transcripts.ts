// Transcripts written by the Claude Code CLI.
//
// Every conversation the desktop app runs is executed by the bundled CLI, which
// appends one JSON object per line to
//   <claudeDir>/projects/<encoded cwd>/<cliSessionId>.jsonl
// and keeps side files (tool results, sub-agent transcripts, custom title) in a
// sibling directory named after the same id. The directory name is the cwd with
// every character outside [a-zA-Z0-9] replaced by "-" (and truncated with a
// hash when very long), but we never rebuild that encoding: like the desktop
// app we look for <cliSessionId>.jsonl in every project directory.
//
// SSH sessions (a Code-tab conversation that runs on another machine) keep
// the transcript on that machine; the app mirrors it locally, append-only,
// from the remote side to this one, into a directory of its own:
//   <claudeDir>/projects/ssh-<cliSessionId>/<cliSessionId>.jsonl
//   <claudeDir>/projects/ssh-<cliSessionId>/agent-<hex>.jsonl   (sub-agents, flat)
// The app finds the mirror from the record's cliSessionId, so a copy with a
// new id needs a mirror directory of its own (see operations.ts). The mirror
// is only for display, though: the CLI runs on the host and resumes
// <cliSessionId>.jsonl there, so a copy also needs a transcript of its own on
// the host, next to the original (ssh-host.ts). The app extends a mirror by
// byte offset with what the host file has past the mirror's end, so a mirror
// must always be an exact prefix of the host file.
//
// What this module knows about the line format was read from real transcripts:
//   - user / assistant lines carry uuid, parentUuid, timestamp, cwd, version,
//     isSidechain and a message object (content is a string or content blocks)
//   - attachment lines with attachment.type "session_context" carry the e-mail
//     of the account that ran the session, as a sentence in context.userEmail
//   - bridge-session lines appear when the conversation was driven from
//     claude.ai (Remote Control) and name the owning account and organization;
//     the last one per session id says which claude.ai session the CLI links
//     up with again on resume, and one with an empty bridgeSessionId (a
//     "tombstone") ends the link (see appendBridgeTombstones)
//   - custom-title lines record titles set through the session-title tool
//   - the sessionId field repeats the file's id on most lines and never changes
//     across resumes; the file is append-only
//
// The uuid chain of a transcript tells how far two copies of one conversation
// got (compare.ts); copies made by this tool only rewrite the session id, so
// the chain survives copying. The first uuid is not an identity, though: a
// fork starts with its parent's lines and so with the same uuid. Which
// conversation on another account is the copy of which is decided by links
// the tool records when it copies (inventory.ts, lineage.ts), never by content.
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, copyFile, cp, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isDirectory, tempPathFor } from './fsx.ts';
import { isUuid } from './records.ts';

/**
 * Where a transcript is on disk, as found by locateTranscript or
 * listTranscripts: the inventory keeps one per conversation, operations
 * copy from it, and the summary cache keys on its path, size and time.
 */
export interface TranscriptLocation {
  cliSessionId: string;
  /** Absolute path of the .jsonl file. */
  path: string;
  /** Project directory that holds the transcript (encoded cwd). */
  projectDir: string;
  /** Sibling directory with tool results and sub-agent transcripts, when present. */
  sidecarDir: string | null;
  sizeBytes: number;
  mtimeMs: number;
}

/** Name prefix of the directories the app mirrors SSH transcripts into. */
export const SSH_MIRROR_PREFIX = 'ssh-';

/** The mirror directory of an SSH session: <projectsRoot>/ssh-<cliSessionId>. */
export function sshMirrorDir(projectsRoot: string, cliSessionId: string): string {
  return path.join(projectsRoot, `${SSH_MIRROR_PREFIX}${cliSessionId}`);
}

/**
 * Whether a transcript lives in its own SSH mirror directory. Only a directory
 * named after this very session counts, so code that moves a mirror as a
 * whole can never take an ordinary project directory with it.
 */
export function isSshMirror(location: Pick<TranscriptLocation, 'projectDir' | 'cliSessionId'>): boolean {
  return path.basename(location.projectDir) === `${SSH_MIRROR_PREFIX}${location.cliSessionId}`;
}

/**
 * Directories the CLI keeps per session outside projects/, one subdirectory
 * per session id in each (documented on code.claude.com under "Claude
 * directory" and "Checkpointing", checked 2026-10-05):
 *   file-history/<id>/   pre-edit snapshots of the files the session changed,
 *                        named <hash>@v<N>, which /rewind restores from.
 *                        Without them a rewind in the copy ends with "No
 *                        files were restored"; the app's own fork copies them
 *                        (Claude Code changelog v2.1.275)
 *   uploads/<id>/        attachments a Remote Control session refers to by
 *                        path from the transcript; the transcript of a copy
 *                        has those paths rewritten to the new id, so they
 *                        lead nowhere unless the directory comes along
 *   image-cache/<id>/    images cached for the conversation
 * The files inside never carry the session id in their names or contents,
 * only the directory does, so a copy is a plain copy under the new id, no
 * rewriting (unlike the transcript and its side folder). Left behind on
 * purpose: session-env/<id> and tasks/<id> (state of a CLI process, not of
 * the conversation), debug/<id>.txt, dev-mods/<id> and the scratchpad under
 * /private/tmp; the CLI sweeps all of these with the transcript after
 * cleanupPeriodDays anyway. A conversation that runs on an SSH host has
 * these directories on the host, where its CLI runs; ssh-host.ts copies
 * them there, and nothing is found for it here.
 */
export const SESSION_KEYED_DIRS = ['file-history', 'uploads', 'image-cache'] as const;

/** One of SESSION_KEYED_DIRS; the only directory names ever joined to a session id on this machine or in a host script. */
export type SessionKeyedDirName = (typeof SESSION_KEYED_DIRS)[number];

/** The directories of SESSION_KEYED_DIRS a session has under a CLI directory, by name, with their absolute paths. */
export async function sessionKeyedDirs(claudeDir: string, cliSessionId: string): Promise<{ name: SessionKeyedDirName; path: string }[]> {
  const found: { name: SessionKeyedDirName; path: string }[] = [];
  for (const name of SESSION_KEYED_DIRS) {
    const dir = path.join(claudeDir, name, cliSessionId);
    if (await isDirectory(dir)) found.push({ name, path: dir });
  }
  return found;
}

/**
 * Copies one session-keyed directory as it is (every file and its
 * permission bits) under another session id. The destination must not
 * exist: an update moves the old directory into the backup first
 * (operations.ts), and a copy whose destination is taken is a mistake
 * worth an error, never a silent merge of two sessions' files.
 */
export async function copySessionKeyedDir(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
}

/**
 * What the bridge-session lines of a transcript say about Remote Control:
 * which account on claude.ai owned the sessions and which claude.ai
 * sessions were ever linked. Part of TranscriptSummary; the inventory reads
 * the owner for the origin and the e-mail votes, operations read the ids to
 * tell links inherited from the source from ones made on the target.
 */
export interface BridgeInfo {
  /** Account and organization on the claude.ai side, from the last bridge-session line. */
  ownerAccountId: string | null;
  ownerOrgId: string | null;
  bridgeSessionIds: string[];
}

/**
 * Everything the tool needs to know about a transcript without reading it
 * again: produced by summarizeTranscript in one pass, cached by
 * summary-cache.ts, carried on every Conversation (inventory.ts) and
 * compared between a conversation and its copy (compare.ts, the uuid chain).
 */
export interface TranscriptSummary {
  /** First uuid in file order, shown and selectable; a fork shares it with its parent. Null for files without any uuid. */
  rootUuid: string | null;
  /** Every uuid in file order; compared as a prefix chain between copies. */
  uuidChain: string[];
  lineCount: number;
  unparsableLines: number;
  /** user + assistant lines of the main conversation (sub-agent lines excluded). */
  messageCount: number;
  /** user lines that are prompts typed by the person, not tool results (sub-agent lines excluded). */
  promptCount: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  cwd: string | null;
  /** CLI version of the last line that carried one. */
  version: string | null;
  /** Distinct entrypoint values ("claude-desktop" for the desktop app, "cli" for a terminal). */
  entrypoints: string[];
  /** Present only when at least one bridge-session line exists. */
  bridge: BridgeInfo | null;
  /** Distinct account e-mails from session_context attachments, in order of first appearance. */
  emails: string[];
  /** Every session_context sighting with its line number (1-based, counting non-blank lines), in file order. */
  emailSightings: { email: string; line: number }[];
  /** The last custom-title line, when any. */
  customTitle: string | null;
  /** First real user message, trimmed, for lists of transcripts without a record. */
  firstUserText: string | null;
  /** Model of the last assistant line. */
  lastModel: string | null;
  /** Distinct sessionId values found in the lines; more than one means a hand-edited file. */
  sessionIds: string[];
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const FIRST_TEXT_LIMIT = 120;

/** Extracts an e-mail address from free text such as "The user's email address is x@y.z. Use it ...". */
export function extractEmail(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const match = EMAIL_RE.exec(text);
  return match ? match[0] : null;
}

async function statOrNull(target: string): Promise<{ size: number; mtimeMs: number; isDirectory: boolean } | null> {
  try {
    const info = await stat(target);
    return { size: info.size, mtimeMs: info.mtimeMs, isDirectory: info.isDirectory() };
  } catch {
    return null;
  }
}

async function locationIn(projectDir: string, cliSessionId: string): Promise<TranscriptLocation | null> {
  const filePath = path.join(projectDir, `${cliSessionId}.jsonl`);
  const info = await statOrNull(filePath);
  if (info === null || info.isDirectory) return null;
  const sidecar = path.join(projectDir, cliSessionId);
  const sidecarInfo = await statOrNull(sidecar);
  return {
    cliSessionId,
    path: filePath,
    projectDir,
    sidecarDir: sidecarInfo?.isDirectory ? sidecar : null,
    sizeBytes: info.size,
    mtimeMs: info.mtimeMs,
  };
}

async function projectDirs(projectsRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(projectsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projectsRoot, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Finds the transcript of a CLI session in any project directory; first hit wins, as in the app. */
export async function locateTranscript(projectsRoot: string, cliSessionId: string): Promise<TranscriptLocation | null> {
  if (!isUuid(cliSessionId)) return null;
  for (const dir of await projectDirs(projectsRoot)) {
    const found = await locationIn(dir, cliSessionId);
    if (found) return found;
  }
  return null;
}

/** Every top-level <uuid>.jsonl under the projects root. Sub-agent transcripts live deeper and are skipped. */
export async function listTranscripts(projectsRoot: string): Promise<TranscriptLocation[]> {
  const result: TranscriptLocation[] = [];
  for (const dir of await projectDirs(projectsRoot)) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (!isUuid(id)) continue;
      const found = await locationIn(dir, id);
      if (found) result.push(found);
    }
  }
  return result;
}

interface Line {
  type?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  version?: unknown;
  entrypoint?: unknown;
  isSidechain?: unknown;
  sessionId?: unknown;
  toolUseResult?: unknown;
  customTitle?: unknown;
  bridgeSessionId?: unknown;
  ownerAccountUuid?: unknown;
  ownerOrganizationUuid?: unknown;
  attachment?: { type?: unknown; context?: { userEmail?: unknown } };
  message?: { model?: unknown; content?: unknown };
}

/** First text block of a message, ignoring injected markup such as <system-reminder> or <command-name>. */
function userText(content: unknown): string | null {
  const candidates: string[] = [];
  if (typeof content === 'string') candidates.push(content);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string') candidates.push(text);
      }
    }
  }
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0 || trimmed.startsWith('<')) continue;
    return trimmed.length > FIRST_TEXT_LIMIT ? `${trimmed.slice(0, FIRST_TEXT_LIMIT - 3)}...` : trimmed;
  }
  return null;
}

/** Reads a whole transcript once, line by line, without holding the file in memory. */
export async function summarizeTranscript(filePath: string): Promise<TranscriptSummary> {
  const summary: TranscriptSummary = {
    rootUuid: null,
    uuidChain: [],
    lineCount: 0,
    unparsableLines: 0,
    messageCount: 0,
    promptCount: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    cwd: null,
    version: null,
    entrypoints: [],
    bridge: null,
    emails: [],
    emailSightings: [],
    customTitle: null,
    firstUserText: null,
    lastModel: null,
    sessionIds: [],
  };
  const reader = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const raw of reader) {
    if (raw.trim().length === 0) continue;
    summary.lineCount += 1;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      summary.unparsableLines += 1;
      continue;
    }
    if (line === null || typeof line !== 'object') {
      summary.unparsableLines += 1;
      continue;
    }
    if (isUuid(line.uuid)) {
      summary.uuidChain.push(line.uuid);
      summary.rootUuid ??= line.uuid;
    }
    if (typeof line.timestamp === 'string') {
      summary.firstTimestamp ??= line.timestamp;
      summary.lastTimestamp = line.timestamp;
    }
    if (typeof line.cwd === 'string' && summary.cwd === null) summary.cwd = line.cwd;
    if (typeof line.version === 'string') summary.version = line.version;
    if (typeof line.entrypoint === 'string' && !summary.entrypoints.includes(line.entrypoint)) {
      summary.entrypoints.push(line.entrypoint);
    }
    if (typeof line.sessionId === 'string' && !summary.sessionIds.includes(line.sessionId)) {
      summary.sessionIds.push(line.sessionId);
    }
    switch (line.type) {
      case 'user':
        if (line.isSidechain !== true) {
          summary.messageCount += 1;
          // Tool results come back as user lines too; only lines without one are prompts.
          if (line.toolUseResult === undefined) summary.promptCount += 1;
        }
        if (summary.firstUserText === null && line.isSidechain !== true) {
          summary.firstUserText = userText(line.message?.content);
        }
        break;
      case 'assistant':
        if (line.isSidechain !== true) summary.messageCount += 1;
        if (typeof line.message?.model === 'string') summary.lastModel = line.message.model;
        break;
      case 'attachment':
        if (line.attachment?.type === 'session_context') {
          const email = extractEmail(line.attachment.context?.userEmail);
          if (email) {
            summary.emailSightings.push({ email, line: summary.lineCount });
            if (!summary.emails.includes(email)) summary.emails.push(email);
          }
        }
        break;
      case 'bridge-session': {
        const bridge = summary.bridge ?? { ownerAccountId: null, ownerOrgId: null, bridgeSessionIds: [] };
        if (isUuid(line.ownerAccountUuid)) bridge.ownerAccountId = line.ownerAccountUuid;
        if (isUuid(line.ownerOrganizationUuid)) bridge.ownerOrgId = line.ownerOrganizationUuid;
        // A tombstone (empty id) ends a link and names no claude.ai session.
        if (typeof line.bridgeSessionId === 'string' && line.bridgeSessionId !== '' && !bridge.bridgeSessionIds.includes(line.bridgeSessionId)) {
          bridge.bridgeSessionIds.push(line.bridgeSessionId);
        }
        summary.bridge = bridge;
        break;
      }
      case 'custom-title':
        if (typeof line.customTitle === 'string' && line.customTitle.trim().length > 0) {
          summary.customTitle = line.customTitle.trim();
        }
        break;
      default:
        break;
    }
  }
  return summary;
}

/** Session ids as the app accepts them in bridge-session lines. */
const BRIDGE_SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * The line that ends a conversation's Remote Control link: a bridge-session
 * line with an empty claude.ai session id. The CLI writes exactly this when
 * Remote Control is switched off, and the desktop app appends it to a fork's
 * transcript so the fork does not take over the parent's claude.ai session.
 */
export function bridgeTombstone(sessionId: string): string {
  return JSON.stringify({ type: 'bridge-session', sessionId, bridgeSessionId: '', lastSequenceNum: 0 });
}

/** A Remote Control link a transcript still has: the session id and the claude.ai session its last bridge-session line names. */
export interface LiveBridge {
  sessionId: string;
  bridgeSessionId: string;
}

/**
 * The live links of a transcript: per session id whose last bridge-session
 * line still names a claude.ai session, in order of first appearance. The
 * CLI keeps the last bridge-session line per session id and links up with
 * that claude.ai session again when the conversation resumes with Remote
 * Control on; these are the links a transferred conversation must not
 * inherit. Same rule as the desktop app uses before it appends tombstones to
 * a fork.
 */
export async function liveBridges(filePath: string): Promise<LiveBridge[]> {
  const last = new Map<string, string>();
  const reader = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const raw of reader) {
    if (!raw.includes('"bridge-session"')) continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    if (line?.type !== 'bridge-session' || typeof line.sessionId !== 'string' || !BRIDGE_SESSION_ID_RE.test(line.sessionId)) continue;
    // Map.set keeps the position of the first insertion, hence first-appearance order.
    last.set(line.sessionId, typeof line.bridgeSessionId === 'string' ? line.bridgeSessionId : '');
  }
  return [...last].filter(([, bridge]) => bridge !== '').map(([sessionId, bridgeSessionId]) => ({ sessionId, bridgeSessionId }));
}

/**
 * Switches Remote Control off in a transcript: appends a tombstone
 * (bridgeTombstone) for every live link, or only for those `only` accepts,
 * after a newline when the file does not end with one. Returns the session
 * ids it ended; a file without such links is left alone.
 *
 * Never for the local mirror of an SSH session: the app extends a mirror
 * with the bytes of the host file past the mirror's length, so a mirror must
 * stay an exact prefix of the host file. SSH transcripts get their
 * tombstones on the host (ssh-host.ts), and the mirror receives them with
 * the next sync.
 */
export async function appendBridgeTombstones(filePath: string, only?: (bridge: LiveBridge) => boolean): Promise<string[]> {
  const ids = (await liveBridges(filePath)).filter((bridge) => only?.(bridge) ?? true).map((bridge) => bridge.sessionId);
  if (ids.length === 0) return ids;
  const handle = await open(filePath, 'r');
  let endsWithNewline = true;
  try {
    const { size } = await handle.stat();
    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      endsWithNewline = last[0] === 0x0a;
    }
  } finally {
    await handle.close();
  }
  await appendFile(filePath, `${endsWithNewline ? '' : '\n'}${ids.map((id) => `${bridgeTombstone(id)}\n`).join('')}`, 'utf8');
  return ids;
}

/**
 * Stream transform that replaces every occurrence of one session id with
 * another. It rewrites whole lines only, so an id can never be split across
 * chunk boundaries, and it touches nothing else: JSON is not re-serialised.
 *
 * Bytes become text through a StringDecoder, which holds back the first bytes
 * of a multi-byte character cut by a chunk boundary (a file is read 64 KiB at
 * a time) until the next chunk completes it. Decoding each chunk on its own
 * turned such a character into U+FFFD replacement characters, and because the
 * uuid chain stayed intact, later runs took the damaged copy for an
 * up-to-date one. With the decoder, a copy of valid UTF-8 (every transcript:
 * the CLI writes JSON.stringify output) is byte-identical to the source apart
 * from the id. Invalid UTF-8, such as a last line torn by a crash in the
 * middle of a character, would still come out as U+FFFD.
 *
 * Replacing every occurrence (not only the sessionId field) also fixes
 * absolute paths inside tool results that point at the sibling directory,
 * which is renamed along with the file.
 */
export class SessionIdRewriter extends Transform {
  private carry = '';
  private readonly decoder = new StringDecoder('utf8');
  private readonly from: string;
  private readonly to: string;

  constructor(from: string, to: string) {
    super({ decodeStrings: true });
    this.from = from;
    this.to = to;
  }

  private rewrite(text: string): string {
    return this.from === this.to ? text : text.split(this.from).join(this.to);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: string) => void): void {
    const fresh = this.decoder.write(chunk);
    // The carried text never holds a newline (it is what followed the last
    // one), so only the fresh part needs searching.
    const lastNewline = fresh.lastIndexOf('\n');
    if (lastNewline === -1) {
      this.carry += fresh;
      callback();
      return;
    }
    const complete = this.carry + fresh.slice(0, lastNewline + 1);
    this.carry = fresh.slice(lastNewline + 1);
    callback(null, this.rewrite(complete));
  }

  override _flush(callback: (error?: Error | null, data?: string) => void): void {
    const rest = this.carry + this.decoder.end();
    this.carry = '';
    callback(null, this.rewrite(rest));
  }
}

/** Permission bits of a file or directory, to give a copy the same ones (the umask still applies). */
async function permissionsOf(target: string): Promise<number> {
  return (await stat(target)).mode & 0o777;
}

/**
 * Copies a transcript (or any line-oriented text file) rewriting one session
 * id into another, atomically, with the source's permission bits: the CLI and
 * the app keep transcripts private (0600) and so does the copy.
 */
export async function copyRewritingSessionId(source: string, destination: string, from: string, to: string): Promise<void> {
  const mode = await permissionsOf(source);
  await mkdir(path.dirname(destination), { recursive: true });
  const tmp = tempPathFor(destination);
  try {
    await pipeline(createReadStream(source), new SessionIdRewriter(from, to), createWriteStream(tmp, { mode }));
    await rename(tmp, destination);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

const REWRITTEN_EXTENSIONS = new Set(['.jsonl', '.json']);

/**
 * Copies a directory of transcript files into the directory of another
 * session id: the sibling directory of a transcript (tool results, sub-agent
 * transcripts, custom title), or a whole SSH mirror (the transcript itself and
 * the flat agent-<hex>.jsonl files). Entry names containing the old id get the
 * new one (<old>.jsonl becomes <new>.jsonl), JSON and JSONL files get the id
 * rewritten inside, everything else is copied as is. Directories keep their
 * permission bits (an SSH mirror is 0700), files too. Existing files in the
 * destination are overwritten.
 */
export async function copySidecar(sourceDir: string, destinationDir: string, from: string, to: string): Promise<void> {
  await mkdir(destinationDir, { recursive: true, mode: await permissionsOf(sourceDir) });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    // .cc-writes is a directory the Claude Code desktop harness keeps next to
    // files it edits (its own write tracking), not part of the conversation;
    // seen inside side folders on 2026-10-05 and left out of copies since.
    if (entry.name === '.cc-writes') continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name.split(from).join(to));
    if (entry.isDirectory()) {
      await copySidecar(sourcePath, destinationPath, from, to);
    } else if (entry.isFile()) {
      if (REWRITTEN_EXTENSIONS.has(path.extname(entry.name))) {
        await copyRewritingSessionId(sourcePath, destinationPath, from, to);
      } else {
        await copyFile(sourcePath, destinationPath);
      }
    }
  }
}
