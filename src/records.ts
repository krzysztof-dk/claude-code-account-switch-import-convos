// Session records of the Claude desktop app (Code tab).
//
// One record per conversation lives at
//   <userData>/claude-code-sessions/<accountId>/<orgId>/local_<uuid>.json
// The app loads a file when its name matches local_*.json and the JSON carries
// a string sessionId plus numeric createdAt and lastActivityAt; this module
// mirrors that validation. Everything else is opaque to this tool: unknown
// fields are kept verbatim, so records written by older and newer app
// versions survive a round trip (July 2026 records carry spawnSeed and
// effort, September ones carry completedTurns and toolSurfaceSnapshot, for
// example). The app itself is less forgiving: it writes records from a list
// of fields it knows, so a field only this tool knows (the ccas stamp) is
// gone the first time the app saves the record again.
//
// The field lists below were first read from the record serializer of
// Claude.app 2.9939.2 (September 2026) and checked again against 2.19675.0
// on 2026-10-05: its serializer and deserializer in app.asar, the function
// that builds a fork's record, and "uD", which promotes local_*.json.tmp
// files to records. What that check found and this module relies on:
//   - the serializer writes about 120 fields. The ones that name the source
//     account or things that live under it are in SOURCE_BOUND_FIELDS, the
//     Remote Control ones in REMOTE_CONTROL_FIELDS, the ones a copy may
//     carry in KNOWN_RECORD_FIELDS; unknownFields() names everything else,
//     so a newer app shows its new fields in this tool's output instead of
//     leaking them into copies unnoticed (records.test.ts keeps every field
//     of the 2.19675.0 serializer in exactly one list)
//   - at load time the app derives remoteControlUserToggled from
//     remoteControlUserEnabled === false, remoteControlUserRequested from
//     remoteControlUserEnabled (or a pending first start that asked for
//     Remote Control) and sshRemoteProjectDir from sshRemoteTranscriptPath;
//     withRemoteControlOff and SOURCE_BOUND_FIELDS agree with that
//   - a file named local_<uuid>.json.tmp younger than 30 days is promoted to
//     a record when the record is missing or unparsable, so the temporary
//     names this tool writes through (fsx.ts, tempPathFor) must never end in
//     ".json.tmp"
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './fsx.ts';

/** Start of every record id and record file name ("local_<uuid>"), as the desktop app names them. */
export const RECORD_PREFIX = 'local_';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Permission bits of the records the app writes (checked on disk: -rw-------); copies get the same. */
export const RECORD_FILE_MODE = 0o600;

/**
 * Stamp this tool leaves on every record it creates or updates: where the
 * copy came from, and how many lines the source transcript had at that
 * moment (the copied transcript still carries the source account's
 * session_context lines, and sourceLineCount marks where they end). The app
 * drops the stamp the next time it saves the record, so it is a hint that
 * helps until then; lineage.json is the lasting record of where copies came
 * from (see lineage.ts).
 */
export interface CcasStamp {
  copiedFrom: {
    accountId?: string | undefined;
    orgId?: string | undefined;
    sessionId?: string | undefined;
    cliSessionId: string;
  };
  rootUuid: string | null;
  /** Non-blank line count of the source transcript when it was copied. */
  sourceLineCount: number;
  /** Epoch milliseconds. */
  at: number;
}

/**
 * Where an SSH session runs. The app connects with the Mac's own ssh and
 * these three fields (host as "user@host" or a ~/.ssh/config alias, optional
 * port and key file); this tool does the same to create copies on the host
 * (ssh-host.ts).
 */
export interface SshConfig {
  sshHost?: string | undefined;
  sshPort?: number | undefined;
  sshIdentityFile?: string | undefined;
  [key: string]: unknown;
}

/**
 * A record as the desktop app writes it. The fields this tool reads are
 * named; every other field is kept as it is (the index signature), so a
 * record keeps what the tool does not set. parseRecord accepts what the
 * app accepts.
 */
export interface SessionRecord {
  sessionId: string;
  createdAt: number;
  lastActivityAt: number;
  /** CLI session whose transcript the app resumes. */
  cliSessionId?: string;
  /** Fallbacks the app consults when cliSessionId is unset (unarchive, /clear history). */
  unarchivedCliSessionId?: string;
  preClearCliSessionId?: string;
  priorCliSessionIds?: string[];
  cwd?: string;
  originCwd?: string;
  title?: string;
  titleSource?: string;
  isArchived?: boolean;
  model?: string;
  completedTurns?: number | null;
  /** claude.ai session ids when the conversation was driven through Remote Control. */
  bridgeSessionIds?: string[];
  /** Set by the app when it adopted a session that started on another surface. */
  adoptedFromOtherSurface?: boolean;
  /**
   * Present on conversations that run on another machine over SSH. Copies
   * keep it, so they show the same host as the original.
   */
  sshConfig?: SshConfig;
  /** Present on records this tool created or updated (until the app saves the record again). */
  ccas?: CcasStamp;
  [key: string]: unknown;
}

/**
 * A record read from an account directory, with the path and file name it
 * came from; readRecords returns these and each listed Conversation keeps
 * one.
 */
export interface LoadedRecord {
  path: string;
  fileName: string;
  record: SessionRecord;
}

/**
 * Whether a value is a uuid string (8-4-4-4-12 hex digits, any case).
 * Account and organization directories, CLI session ids and the ids of the
 * CLI login are checked with it.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Whether a file name in an account directory is one the app loads as a record (local_*.json). */
export function isRecordFileName(name: string): boolean {
  return name.startsWith(RECORD_PREFIX) && name.endsWith('.json');
}

/** Same acceptance rule as the desktop app; returns undefined for anything it would skip. */
export function parseRecord(text: string): SessionRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate['sessionId'] !== 'string' ||
    typeof candidate['createdAt'] !== 'number' ||
    typeof candidate['lastActivityAt'] !== 'number'
  ) {
    return undefined;
  }
  return candidate as SessionRecord;
}

/**
 * Every CLI session id a record points at, current one first, without
 * duplicates. Used to decide which transcripts are "listed" by some account.
 */
export function transcriptRefs(record: SessionRecord): string[] {
  const refs: string[] = [];
  const push = (value: unknown): void => {
    if (isUuid(value) && !refs.includes(value)) refs.push(value);
  };
  push(record.cliSessionId);
  push(record.unarchivedCliSessionId);
  push(record.preClearCliSessionId);
  for (const prior of record.priorCliSessionIds ?? []) push(prior);
  return refs;
}

/** The transcript the app would actually resume for this record. */
export function effectiveCliSessionId(record: SessionRecord): string | undefined {
  if (isUuid(record.cliSessionId)) return record.cliSessionId;
  if (isUuid(record.unarchivedCliSessionId)) return record.unarchivedCliSessionId;
  return undefined;
}

/**
 * Record fields that tie a conversation to the live state of the source: a
 * process, files and sessions that belong to the original only. A copy made
 * by this tool leaves them out, as the app's own fork does: it builds the
 * forked record from an explicit list of fields, and none of these is on it.
 * In real records sshRemoteProcessId, sshReattach, sshRemoteTranscriptPath
 * and bridgeSessionIds have been seen; the rest are known from the app's code.
 */
export const SOURCE_BOUND_FIELDS = [
  // The CLI process of the conversation on the SSH host. At start-up (record
  // younger than 7 days, not archived, sshReattach.state "adoptable", no Remote
  // Control) or when the conversation is opened, the app adopts that process;
  // when the conditions do not hold it kills it, and archiving or deleting the
  // record kills it too. A copy carrying these would take over or kill the
  // original's process.
  'sshRemoteProcessId',
  'sshReattach',
  'sshProcessLossStoodDownAt',
  'sshKillRecoveryGrantedAt',
  'sshForeignDaemonLossAt',
  // The source's transcript on the SSH host. The app syncs the local mirror
  // from it without checking that it belongs to the record's cliSessionId, and
  // when the first lines differ it empties the mirror and downloads the remote
  // file; a path with no file behind it can pull in the agent files of the
  // source's remote directory. Without the field the app looks for
  // <cliSessionId>.jsonl on the host; for a copy that is the transcript this
  // tool created next to the original (ssh-host.ts).
  'sshRemoteTranscriptPath',
  // Found while making SSH copies resumable on their host (2026-09-28): copies
  // used to keep the source's byte-sync cache. The app syncs a mirror by byte
  // offset (it appends the remote bytes past sshLocalTranscriptSize), and it
  // clears these four fields itself whenever a record's CLI session id
  // changes ("clearing byte-sync cache" in its code). A copy has a new CLI
  // session id, so the source's offsets do not describe it; without them the
  // app measures the copy's mirror against the host file before its first sync.
  'sshRemoteProjectDir',
  'sshLocalTranscriptSize',
  'sshSubagentSyncedSizes',
  // The source's sessions on claude.ai (Remote Control, cloud).
  'bridgeSessionIds',
  'remoteControlSpawn',
  'cloudSessionId',
  // Earlier transcripts of the source (unarchive, /clear history); a copy
  // carries only its own transcript.
  'priorCliSessionIds',
  'unarchivedCliSessionId',
  'preClearCliSessionId',
  // Triggers for sending on its own: work interrupted by quitting the app is
  // resumed automatically, and a queued first task is started.
  'interruptedByQuitAt',
  'interruptedUnseenResume',
  'armedWorkAtQuit',
  'pendingFirstStart',
  // Added 2026-10-05 after checking the serializer of Claude.app 2.19675.0
  // (the lists above came from 2.9939.2, and copies carried the new fields
  // verbatim). The account the record belongs to, by e-mail: a copy lives
  // under another account, and the app would show and use the wrong address.
  'emailAddress',
  // Artifacts published on claude.ai under the source account and tasks the
  // source spawned in the cloud; both belong to that account's claude.ai.
  'publishedArtifacts',
  'cloudSpawnedTasks',
  // Messages exchanged with other sessions of the source account (peers) and
  // the session that dispatched this one; the copy's account has none of them.
  'peerInbound',
  'peerReceipts',
  'dispatchParentId',
  'dispatchParentOrigin',
  // The app's own fork lineage: the record this one was forked from and the
  // message it was forked at, both of the source account.
  'forkedFromSessionId',
  'forkedAtMessageUuid',
  'lineageDetached',
  // The app's own importer and index: where it imported the record from,
  // when it indexed it, whether a resume was confirmed, and a staged
  // transcript it still has to move into place. All of it is the source's
  // history with the app; stagedTranscriptPath in particular makes the app
  // read the transcript from that path instead of the projects directory.
  'importedFrom',
  'indexedAt',
  'resumeConfirmed',
  'stagedTranscriptPath',
  // Cloud environments and Cowork spaces are resources of the organization
  // the source ran under.
  'envScopeId',
  'startedFromEnvironmentId',
  'spaceId',
  // A scheduled task of the source account started or continued this
  // conversation; scheduled tasks are not transferred (operations.ts warns).
  'scheduledTaskId',
  'scheduledRunContinued',
  // The source was moved to Anthropic's cloud under its account, or the app
  // could not read the source's transcript; the copy has its own, complete
  // transcript on this machine (or its SSH host).
  'movedToCloud',
  'transcriptUnavailable',
] as const;

/** A shallow copy of a record without SOURCE_BOUND_FIELDS; the input is left as it is. */
export function withoutSourceBoundFields(record: SessionRecord): SessionRecord {
  const copy: Record<string, unknown> = { ...record };
  for (const field of SOURCE_BOUND_FIELDS) delete copy[field];
  return copy as SessionRecord;
}

/**
 * Record fields that hold a conversation's Remote Control state: its link to
 * a claude.ai session, through which the conversation is followed and driven
 * from the web or the phone. The list was read from the record serializer of
 * the desktop app (Claude.app 2.9939.2):
 *   bridgeSessionIds, cloudSessionId  the claude.ai sessions it was linked to
 *   remoteControlSpawn                claude.ai started the conversation
 *   remoteControlDescendant           a conversation started by such a one
 *   remoteControlAutoEligible         the app may switch Remote Control on by itself
 *   remoteControlUserRequested,       the person asked for Remote Control
 *   remoteControlStartChoice          (for the next start)
 *   steeredByRemoteClient             a claude.ai client sent turns into it
 * plus the person's own switch, remoteControlUserEnabled and
 * remoteControlUserToggled, which withRemoteControlOff sets rather than drops.
 * The claude.ai sessions belong to the account the conversation ran under, so
 * none of this is carried to another account (see withRemoteControlOff).
 */
export const REMOTE_CONTROL_FIELDS = [
  'bridgeSessionIds',
  'cloudSessionId',
  'remoteControlSpawn',
  'remoteControlDescendant',
  'remoteControlAutoEligible',
  'remoteControlUserRequested',
  'remoteControlStartChoice',
  'steeredByRemoteClient',
] as const;

/**
 * A shallow copy of a record with Remote Control switched off, in the form
 * the app itself gives a conversation started with Remote Control off:
 * remoteControlUserEnabled false and remoteControlUserToggled true, and none
 * of the other REMOTE_CONTROL_FIELDS. The app then never switches Remote
 * Control on by itself (it only does so for records that are auto-eligible or
 * asked for it, and never after the person toggled it), and the person can
 * still switch it on in the app, which links the conversation to a new
 * claude.ai session of the account it now belongs to. Copies go through
 * this because the claude.ai session of the source belongs to the source
 * account. The transcript half of the switch is the bridge tombstone
 * (transcripts.ts, appendBridgeTombstones).
 */
export function withRemoteControlOff(record: SessionRecord): SessionRecord {
  const copy: Record<string, unknown> = { ...record };
  for (const field of REMOTE_CONTROL_FIELDS) delete copy[field];
  copy['remoteControlUserEnabled'] = false;
  copy['remoteControlUserToggled'] = true;
  return copy as SessionRecord;
}

/** Whether a record already has Remote Control off exactly as withRemoteControlOff leaves it. */
export function hasRemoteControlOff(record: SessionRecord): boolean {
  return (
    record['remoteControlUserEnabled'] === false &&
    record['remoteControlUserToggled'] === true &&
    REMOTE_CONTROL_FIELDS.every((field) => !(field in record))
  );
}

/** Every Remote Control field of a record, the person's switch included, as one comparable string. */
function remoteControlState(record: SessionRecord): string {
  const fields = [...REMOTE_CONTROL_FIELDS, 'remoteControlUserEnabled', 'remoteControlUserToggled'].sort();
  return JSON.stringify(fields.map((field) => [field, record[field] ?? null]));
}

/**
 * Whether a copy still has the Remote Control state it got from its source,
 * which is what copies made before 2026-09-28 carry. Compared with the source
 * as a copy was made from it then (SOURCE_BOUND_FIELDS dropped); a copy of a
 * transcript without a record came with no Remote Control fields at all. A
 * copy whose state differs was changed on the target account, most likely by
 * the person switching Remote Control on there, and a repair leaves it alone.
 */
export function inheritsRemoteControl(copy: SessionRecord, source: SessionRecord | null | undefined): boolean {
  const base: SessionRecord = source ? withoutSourceBoundFields(source) : { sessionId: '', createdAt: 0, lastActivityAt: 0 };
  return remoteControlState(copy) === remoteControlState(base);
}

/**
 * Fields a copy may carry as they are, read from the serializer of
 * Claude.app 2.19675.0 on 2026-10-05 (plus two seen in records on disk that
 * day, promptSuggestion and planPath): they describe the conversation (its
 * folder and worktree, title, archive state, model, permission mode, rewind
 * points, the branches it wrote, side-session bookkeeping) or this machine,
 * which both accounts share. Together with SOURCE_BOUND_FIELDS and
 * REMOTE_CONTROL_FIELDS this covers every field that serializer writes
 * (records.test.ts holds the serializer's list and fails on a field that is
 * in none of the three), and unknownFields() reports fields outside all
 * three, so a newer app version shows its new fields in the tool's output
 * for the next review to classify instead of copies carrying them
 * unnoticed. The fields this tool itself requires or writes (sessionId,
 * createdAt, lastActivityAt, cliSessionId, the Remote Control switch, the
 * ccas stamp) are listed here too.
 */
export const KNOWN_RECORD_FIELDS = [
  // Required by the app (parseRecord) and this tool.
  'sessionId',
  'createdAt',
  'lastActivityAt',
  'cliSessionId',
  // Where the conversation runs: its folder, worktree and git anchors on
  // this machine, the branches and pull requests it worked on.
  'cwd',
  'originCwd',
  'worktreePath',
  'worktreeName',
  'worktreeLazy',
  'worktreePinned',
  'keptDirtyWorktree',
  'keptDirtyAt',
  'keptWorktreeLeftover',
  'gitAnchors',
  'gitAnchorsLookupOnly',
  'gitAnchorsFolderRealpath',
  'sourceBranch',
  'branch',
  'writtenBranches',
  'prs',
  'seenCommentIds',
  'titleFromPr',
  'autoArchiveOnPrClose',
  // How it is shown: title, archive and star state, colour, when it was focused.
  'title',
  'titleSource',
  'previousTitles',
  'titleTurn',
  'titleCheck',
  'titleOffers',
  'titleSuggestionsOff',
  'isArchived',
  'isStarred',
  'autoArchiveExempt',
  'color',
  'lastFocusedAt',
  // How the CLI is started for it: model, effort, agent, permissions, MCP
  // servers, the binary and the tool surface it was last started with.
  'model',
  'effort',
  'effortInherited',
  'agent',
  'permissionMode',
  'sessionSettings',
  'enabledMcpTools',
  'remoteMcpServersConfig',
  'withheldConnectorHosts',
  'sessionPermissionUpdates',
  'alwaysAllowedReasons',
  'bypassChosenInApp',
  'autoChosenInApp',
  'lastSpawnRootDetected',
  'ranInSandboxVm',
  'tccFolderKind',
  '_startedThroughHostCliLauncher',
  'launcherAtSpawn',
  'cliBinaryPin',
  'cliMcpAppServerNames',
  'spawnSeed',
  'promptAppendSnapshot',
  'toolSurfaceSnapshot',
  'terminalClaudeTabOrdinal',
  // The machine it runs on (the same SSH host after a copy: sshConfig is
  // kept on purpose) and the browser and computer-use grants given to it.
  'sshConfig',
  'wslConfig',
  'chromePermissionMode',
  'chromeAllowedDomains',
  'chromeTabGroupId',
  'cuAllowedApps',
  'cuGrantFlags',
  'cuFlagsGrantedAt',
  'cuLastScreenshotDims',
  'cuSelectedDisplayId',
  // Positions in the transcript and what the app remembers about its turns.
  // Copies keep every message uuid (transcripts.ts), so these stay valid.
  'rewindEdges',
  'transcriptModelStates',
  'transcriptCuts',
  'lastAssistantUuid',
  'completedTurns',
  'contextExceededCount',
  'subagentsTruncatedFor',
  'recap',
  'recapAt',
  'postTurnSummary',
  'postTurnSummaryFor',
  'turnWrapUp',
  'lastTurnReport',
  'pendingSystemReminder',
  'promptSuggestion',
  'planPath',
  'error',
  'errorCategory',
  'errorAt',
  'priorErrorMark',
  'queryCrashes',
  // Sessions this one started (side sessions) and the one it was started
  // from: the app tolerates ids it cannot find, and spawnedFrom is kept so
  // a copy still says where it came from.
  'spawnedFrom',
  'spawnedFromEndNotified',
  'sideSessionNotes',
  'queuedSideSessionNotes',
  'sideSessionReportOwed',
  'sideSessionStartsSinceUserMessage',
  'sideSessionOffersMuted',
  'backgroundTaskSuggestions',
  'resolvedBackgroundTaskSuggestions',
  'latestUserFrameAt',
  // Interface state: scratch files, offered prompts, cards and panels shown.
  'scratchPromptRecents',
  'scratchOfferFolder',
  'scratchFilesLeftIn',
  'scratchCarried',
  'classifierSummaryEnabled',
  'reportFindingsCard',
  'turnBoxDeclared',
  'turnBoxMounted',
  'setupTools',
  'midTaskReplyTool',
  'conversationPluginLoaded',
  'asides',
  'violinBowPrompts',
  'violinBowPromptKinds',
  'violinBow',
  'violinBowHomeSettings',
  'lanyardOfferPrompt',
  'autoModeServerFallbackPrompt',
  'devIntents',
  'devIntentTriggers',
  'autoFixDelivered',
  'autoFixNoticeSent',
  // A session adopted from another surface keeps saying so (synthesized
  // records set it, see operations.ts).
  'adoptedFromOtherSurface',
  'surfaceNoticeUuid',
  // The person's own Remote Control switch, which withRemoteControlOff sets.
  'remoteControlUserEnabled',
  'remoteControlUserToggled',
  // This tool's own stamp (CcasStamp).
  'ccas',
] as const;

/**
 * Field names of a record that none of the three lists classifies: what a
 * newer app version added since 2.19675.0. The inventory reports them per
 * account (inventory.ts) so the next review sorts them into
 * SOURCE_BOUND_FIELDS or KNOWN_RECORD_FIELDS; until then a copy carries them
 * verbatim, as it does every field it does not know.
 */
export function unknownFields(record: SessionRecord): string[] {
  const known = new Set<string>([...SOURCE_BOUND_FIELDS, ...REMOTE_CONTROL_FIELDS, ...KNOWN_RECORD_FIELDS]);
  return Object.keys(record)
    .filter((field) => !known.has(field))
    .sort();
}

/**
 * Reads every record of one account directory, in file name order. A file
 * the app would skip (unreadable, not JSON, a required field missing) is
 * left out and named in `problems`; a missing directory gives no records.
 */
export async function readRecords(accountDir: string): Promise<{ records: LoadedRecord[]; problems: string[] }> {
  const records: LoadedRecord[] = [];
  const problems: string[] = [];
  let names: string[];
  try {
    names = await readdir(accountDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records, problems };
    throw error;
  }
  for (const fileName of names.filter(isRecordFileName).sort()) {
    const filePath = path.join(accountDir, fileName);
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      problems.push(`${filePath}: ${(error as Error).message}`);
      continue;
    }
    const record = parseRecord(text);
    if (record === undefined) {
      problems.push(`${filePath}: not a session record (the app would skip it too)`);
      continue;
    }
    records.push({ path: filePath, fileName, record });
  }
  return { records, problems };
}

/** A fresh record id for a copy, in the form the app uses (local_<uuid>). */
export function newLocalSessionId(): string {
  return `${RECORD_PREFIX}${randomUUID()}`;
}

/** The file name a record is kept under: its id plus ".json". */
export function recordFileName(sessionId: string): string {
  return `${sessionId}.json`;
}

/**
 * Writes a record atomically (temporary file, then rename) with the
 * permission bits of the app's own records, as indented JSON with a final
 * newline.
 */
export async function writeRecord(filePath: string, record: SessionRecord): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: RECORD_FILE_MODE });
}
