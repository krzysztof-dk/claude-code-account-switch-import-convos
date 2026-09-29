// The writes: copying, moving and importing conversations, and undoing them.
//
// Every operation follows the same shape:
//   1. decide what to do from the sync assessment (inventory.ts) and the mode;
//      for a conversation on an SSH host, look at the host (read only)
//   2. ask the guard (app-guard.ts) whether writing is allowed right now
//   3. open a journal entry (status "running") so an interruption leaves a trail
//   4. back up whatever will be overwritten, move whatever will be replaced
//      into the backup dir; every step is journaled before it happens
//      (operation-log.ts)
//   5. write the new files atomically (temp file + rename), then the host
//      side of an SSH conversation; ask the guard once more, record the
//      lineage link, then write the record, the file the desktop app reads at
//      start-up
//   6. only then remove source files, and only by moving them into the backup dir
//   7. close the journal entry (done / failed)
// Nothing is ever deleted outright, and `restore <journalId>` walks the entry
// backwards. A dry run stops after step 1 and reports what would happen. When
// the guard closes during an operation (the app or a CLI session was started
// meanwhile), the operation rolls back everything it did and reports
// "refused"; when a host step fails, it rolls back the same way and reports
// "failed".
//
// Why copies get new ids: the desktop app parks sessions by sessionId when
// switching accounts, so one id living on two accounts could route a write to
// the wrong directory. A moved record keeps its ids because after the move
// only one account holds it.
//
// What a copy changes: in the transcript files the technical session id, and
// at the end of the transcript a tombstone for every live Remote Control link
// (see below); content and title stay as they are. In the record the ids, the
// ccas stamp, the removal of the fields that tie the record to the source's
// live state (records.ts, SOURCE_BOUND_FIELDS), and Remote Control switched
// off. A copy therefore looks like a conversation held on the target account:
// the same title, the same SSH host, the same archive state.
//
// Remote Control: a conversation followed or driven from claude.ai is linked
// to a claude.ai session of the account it ran under. Copies and moves switch
// that off, on the operator's request of 2026-09-28: the record says
// "switched off by the person" (records.ts, withRemoteControlOff) and the
// transcript gets bridge tombstones, so neither the app nor the CLI links the
// conversation up with the old account's claude.ai session again. Switching
// Remote Control on in the app links it to a new session of the new account.
//
// SSH sessions (transcripts.ts has the mirror layout, ssh-host.ts the host
// side): the copy gets a mirror directory of its own, ssh-<new id>/, holding
// the transcript and the sub-agent files with the id rewritten, and a
// transcript of its own on the host, next to the original, so the app can
// resume it there like any conversation. Without the host transcript the app
// fails to resume the copy and drops its history (seen on 2026-09-28 with
// copies made before this). An SSH copy that cannot get its host transcript
// (host unreachable, original not on the host) is not made: the operation
// rolls back and says why.
//
// Copies made before 2026-09-28 lack both the host transcript and Remote
// Control off. Transferring such a conversation again finds the copy up to
// date and repairs it (action "repaired"); a copy whose record lost its CLI
// session id when resuming failed gets that id back with a fresh transcript.
//
// archived-sessions.idx next to the records ({"v":1,"archived":["local_..."]})
// is only a hint for the order the app loads records in, and the app rewrites
// it itself. Whether a conversation is archived is decided by isArchived in its
// record, which copies keep, so the index is never touched. waiting-input/ is
// never copied either: restored for an SSH session it can make the app send
// on its own.
import { randomUUID } from 'node:crypto';
import { cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { accountKey, type AccountInfo } from './accounts.ts';
import { GuardRefusal, makeGuard, type Guard, type WriteGate } from './app-guard.ts';
import { mirrorPath, pathExists, tempSiblings } from './fsx.ts';
import { endpointOf, refersTo, type Conversation, type SyncAssessment } from './inventory.ts';
import type { Journal, JournalEntry } from './journal.ts';
import type { LineageStore } from './lineage.ts';
import { OperationLog, type OperationFields } from './operation-log.ts';
import type { Paths } from './paths.ts';
import {
  hasRemoteControlOff,
  inheritsRemoteControl,
  isUuid,
  newLocalSessionId,
  recordFileName,
  withRemoteControlOff,
  withoutSourceBoundFields,
  writeRecord,
  type CcasStamp,
  type SessionRecord,
} from './records.ts';
import {
  copyOnHost,
  describeHost,
  hostCopyPaths,
  hostTargetOf,
  HostStepError,
  probeHost,
  sshRunner,
  tombstoneOnHost,
  undoOnHost,
  type HostProbe,
  type HostRunner,
  type HostTarget,
} from './ssh-host.ts';
import { appendBridgeTombstones, copyRewritingSessionId, copySidecar, isSshMirror, liveBridges, sshMirrorDir } from './transcripts.ts';

export type TransferMode = 'copy' | 'move';
export type ConflictPolicy = 'skip' | 'overwrite';

export interface TransferItem {
  source: Conversation;
  target: AccountInfo;
  mode: TransferMode;
  assessment: SyncAssessment;
  /** What to do when the target copy is newer or diverged. */
  onConflict: ConflictPolicy;
}

/**
 * refused: the guard said no (Claude running); nothing of this operation remains on disk.
 * repaired: an up-to-date copy got Remote Control off or its transcript on the SSH host.
 */
export type OutcomeAction = 'created' | 'updated' | 'moved' | 'repaired' | 'up-to-date' | 'skipped' | 'refused' | 'failed';

export interface TransferOutcome {
  item: TransferItem;
  action: OutcomeAction;
  /** Why nothing happened, what went wrong, or (for repaired) what was repaired. */
  reason: string | null;
  journalId: string | null;
  newSessionId: string | null;
  newCliSessionId: string | null;
  /** What happened (or would happen) on the SSH host of the conversation, for the outcome line. */
  host: string | null;
  warnings: string[];
  dryRun: boolean;
}

export interface OperationContext {
  paths: Paths;
  journal: Journal;
  lineage: LineageStore;
  dryRun: boolean;
  /** Write gate consulted before every write; defaults to the process detector for the live directory. */
  guard?: Guard | undefined;
  now?: (() => number) | undefined;
  /** Reaches the SSH host of a conversation; defaults to the Mac's ssh (ssh-host.ts, sshRunner). */
  host?: HostRunner | undefined;
}

/** Name of the per-account file that may reference sessions by id. */
const SCHEDULED_TASKS_FILE = 'scheduled-tasks.json';

function guardOf(context: OperationContext): Guard {
  return context.guard ?? makeGuard(context.paths);
}

function hostRunnerOf(context: OperationContext): HostRunner {
  return context.host ?? sshRunner();
}

function nowOf(context: OperationContext): number {
  return (context.now ?? Date.now)();
}

/** The mid-operation check: throws when the guard closed since the operation started. */
async function assertStillAllowed(context: OperationContext): Promise<void> {
  const gate = await guardOf(context)();
  if (!gate.allowed) throw new GuardRefusal(gate.reason);
}

function openLog(context: OperationContext, at: number, fields: OperationFields): OperationLog {
  return new OperationLog({ journal: context.journal, backupsDir: context.paths.backupsDir, at, host: hostRunnerOf(context) }, fields);
}

/** Rewrites one uuid everywhere inside a record, including nested snapshots. */
function replaceIdDeep(record: SessionRecord, from: string, to: string): SessionRecord {
  return JSON.parse(JSON.stringify(record).split(from).join(to)) as SessionRecord;
}

/**
 * Record for a transcript that never had one (sessions driven from claude.ai
 * or a terminal). The shape follows records the app itself writes when it
 * adopts a session from another surface; fields the app requires are always
 * present, the rest are filled from the transcript where known.
 */
function synthesizedRecord(source: Conversation, sessionId: string, cliSessionId: string, now: number): SessionRecord {
  const summary = source.summary;
  const first = summary?.firstTimestamp ? Date.parse(summary.firstTimestamp) : Number.NaN;
  const last = summary?.lastTimestamp ? Date.parse(summary.lastTimestamp) : Number.NaN;
  const fallback = source.transcript?.mtimeMs ?? now;
  const createdAt = Number.isFinite(first) ? first : fallback;
  const lastActivityAt = Number.isFinite(last) ? last : fallback;
  const cwd = source.cwd ?? '/';
  const record: SessionRecord = {
    sessionId,
    cliSessionId,
    cwd,
    originCwd: cwd,
    createdAt,
    lastActivityAt,
    lastFocusedAt: lastActivityAt,
    isArchived: false,
    permissionMode: 'default',
    titleSource: summary?.customTitle ? 'tool' : 'auto',
    adoptedFromOtherSurface: true,
  };
  if (source.title !== '(untitled)') record.title = source.title;
  if (summary?.lastModel) record.model = summary.lastModel;
  return record;
}

/** The stamp a record gets when this tool copies or moves it (see CcasStamp). */
function stampFor(source: Conversation, now: number): CcasStamp {
  return {
    copiedFrom: endpointOf(source),
    rootUuid: source.summary?.rootUuid ?? null,
    sourceLineCount: source.summary?.lineCount ?? 0,
    at: now,
  };
}

/**
 * The record a copy gets: the source record without the fields that tie it
 * to the source's live state (SOURCE_BOUND_FIELDS), with Remote Control off,
 * with new ids, and with every other mention of the old CLI session id
 * (nested snapshots, paths) rewritten to the new one. A transcript no record
 * lists gets a synthesized record instead, also with Remote Control off.
 */
function recordForCopy(source: Conversation, sessionId: string, cliSessionId: string, now: number): SessionRecord {
  const ccas = stampFor(source, now);
  if (!source.record) return { ...withRemoteControlOff(synthesizedRecord(source, sessionId, cliSessionId, now)), ccas };
  const base = withoutSourceBoundFields(source.record.record);
  const rewritten = source.cliSessionId ? replaceIdDeep(base, source.cliSessionId, cliSessionId) : base;
  return { ...withRemoteControlOff(rewritten), sessionId, cliSessionId, ccas };
}

async function scheduledTaskWarning(source: Conversation): Promise<string | null> {
  if (!source.account || !source.record) return null;
  try {
    const text = await readFile(path.join(source.account.dir, SCHEDULED_TASKS_FILE), 'utf8');
    if (text.includes(source.record.record.sessionId)) {
      return `scheduled-tasks.json on the source account references this session; scheduled tasks are not transferred`;
    }
  } catch {
    // No scheduled-tasks file: nothing to warn about.
  }
  return null;
}

/**
 * A move onto an existing copy takes the source record away. When that record
 * pointed at a CLI process on an SSH host, nothing is left to adopt or stop
 * the process (the app does both only through the record), so the person is
 * told where it runs.
 */
function remoteProcessWarning(source: Conversation): string | null {
  const record = source.record?.record;
  const processId = record?.['sshRemoteProcessId'];
  if (processId === undefined || processId === null) return null;
  const host = record?.sshConfig?.sshHost ?? 'the SSH host';
  return `the source record pointed at process ${String(processId)} on ${host}; with the record gone nothing adopts or stops that process, so stop it there if it still runs`;
}

function outcomeOf(
  item: TransferItem,
  action: OutcomeAction,
  reason: string | null,
  warnings: string[],
  dryRun: boolean,
  extra: Partial<Pick<TransferOutcome, 'journalId' | 'newSessionId' | 'newCliSessionId' | 'host'>> = {},
): TransferOutcome {
  return {
    item,
    action,
    reason,
    journalId: null,
    newSessionId: null,
    newCliSessionId: null,
    host: null,
    warnings,
    dryRun,
    ...extra,
  };
}

/** Consults the guard before the first write; a closed gate becomes a "refused" outcome. */
async function openGate(context: OperationContext, item: TransferItem, warnings: string[]): Promise<TransferOutcome | WriteGate> {
  const gate = await guardOf(context)();
  if (!gate.allowed) return outcomeOf(item, 'refused', gate.reason, warnings, false);
  if (gate.reason && !warnings.includes(gate.reason)) warnings.push(gate.reason);
  return gate;
}

function isOutcome(value: TransferOutcome | WriteGate): value is TransferOutcome {
  return 'item' in value;
}

/**
 * Turns a failure inside an operation into an outcome. When the guard closed
 * or a host step failed, everything the operation did is rolled back first,
 * so nothing half-made is left (a copy without its host transcript would
 * break the first time the app starts it).
 */
async function failed(log: OperationLog, item: TransferItem, error: unknown): Promise<TransferOutcome> {
  if (error instanceof GuardRefusal) {
    await log.rollback();
    await log.fail(new Error(`${error.message} Claude Code appeared during the operation; its changes were rolled back.`));
    return outcomeOf(item, 'refused', log.entry.error ?? error.message, log.entry.warnings, false, { journalId: log.entry.id });
  }
  if (error instanceof HostStepError) {
    await log.rollback();
    await log.fail(new Error(`${error.message}; the operation's changes were rolled back.`));
    return outcomeOf(item, 'failed', log.entry.error ?? error.message, log.entry.warnings, false, { journalId: log.entry.id });
  }
  await log.fail(error);
  return outcomeOf(item, 'failed', log.entry.error ?? 'unknown error', log.entry.warnings, false, { journalId: log.entry.id });
}

/**
 * Moves the source record and its transcript files into the backup mirror
 * (the "remove" half of a move). For an SSH session the whole mirror goes,
 * but only a directory that really is this session's mirror (ssh-<its id>).
 * The transcript on the SSH host stays: the host is not this tool's to clean
 * up, and a transcript no record points at does no harm there.
 */
async function removeSourceFiles(log: OperationLog, source: Conversation, target: Conversation | null): Promise<void> {
  if (source.record) await log.moveAway(source.record.path);
  const transcript = source.transcript;
  if (!transcript) return;
  // Found while adding SSH mirrors: a record copied by hand to a second account
  // keeps its record id and CLI session id, so both accounts point at one
  // transcript and pairing matches the two by record id. Moving "the source
  // transcript" away then took the target's transcript with it. A transcript
  // the target uses as well stays where it is.
  if (target?.transcript?.path === transcript.path) return;
  if (isSshMirror(transcript)) {
    await log.moveAway(transcript.projectDir);
    return;
  }
  await log.moveAway(transcript.path);
  if (transcript.sidecarDir) await log.moveAway(transcript.sidecarDir);
}

/** The CLI session id of a conversation's transcript (the record's, else the transcript's own). */
function cliSessionIdOf(conversation: Conversation): string | null {
  return conversation.cliSessionId ?? conversation.transcript?.cliSessionId ?? null;
}

/**
 * The SSH host of a transferred conversation: the one the source record
 * names. A copy keeps that sshConfig, so it is the copy's host as well.
 */
function sshHostOf(source: Conversation): HostTarget | null {
  return hostTargetOf(source.record?.record);
}

/** A conversation that runs on an SSH host but whose transcript the local mirror does not hold (never synced, or gone). */
function isSshWithoutMirror(source: Conversation): boolean {
  return sshHostOf(source) !== null && source.transcript === null;
}

/** What the host holds for a copy, and where its transcript goes (see planHostCopy). */
interface HostCopyPlan {
  target: HostTarget;
  probe: HostProbe & { dir: string };
  sourceCliSessionId: string;
  targetCliSessionId: string;
}

/**
 * Looks at the host of an SSH conversation (read only) before its copy is
 * made or updated there: the original's transcript must be on the host, and
 * for a fresh copy nothing under the new id may be. Throws HostStepError
 * otherwise, and when the host cannot be reached.
 */
async function planHostCopy(
  context: OperationContext,
  target: HostTarget,
  source: Conversation,
  targetCliSessionId: string,
  mode: 'create' | 'replace',
): Promise<HostCopyPlan> {
  const sourceCliSessionId = cliSessionIdOf(source);
  const host = describeHost(target);
  if (!sourceCliSessionId || !isUuid(sourceCliSessionId)) {
    throw new HostStepError(target, 'missing', `the source record names no transcript, so there is nothing to copy on ${host}`);
  }
  const probe = await probeHost(hostRunnerOf(context), target, {
    sourceCliSessionId,
    targetCliSessionId,
    hint: source.record?.record.sshRemoteTranscriptPath as string | undefined,
  });
  if (probe.dir === null) {
    throw new HostStepError(
      target,
      'missing',
      `${host} has no transcript ${sourceCliSessionId}.jsonl, so a copy could not be resumed there (the original cannot be resumed either)`,
    );
  }
  if (mode === 'create' && (probe.target !== null || probe.targetSidecar !== null)) {
    throw new HostStepError(target, 'conflict', `${probe.target ?? probe.targetSidecar} exists on ${host} already`);
  }
  if (probe.target !== null && path.posix.dirname(probe.target) !== probe.dir) {
    throw new HostStepError(
      target,
      'conflict',
      `the copy's transcript on ${host} is ${probe.target}, not next to the original in ${probe.dir}; move it there or set it aside by hand`,
    );
  }
  return { target, probe: { ...probe, dir: probe.dir }, sourceCliSessionId, targetCliSessionId };
}

/**
 * Makes the copy on the host (ssh-host.ts, copyOnHost), journaling every path
 * before the remote script runs: what an update replaces is kept aside under
 * the journal id, then the new side folder and transcript are announced.
 */
async function applyHostCopy(context: OperationContext, log: OperationLog, plan: HostCopyPlan, replaceTag: string | null): Promise<void> {
  const request = { dir: plan.probe.dir, sourceCliSessionId: plan.sourceCliSessionId, targetCliSessionId: plan.targetCliSessionId, replaceTag };
  const paths = hostCopyPaths(request, plan.probe.sourceSidecar);
  if (paths.backupSuffix) {
    if (plan.probe.target) await log.remoteMoved(plan.target, plan.probe.target, `${plan.probe.target}${paths.backupSuffix}`);
    if (plan.probe.targetSidecar) await log.remoteMoved(plan.target, plan.probe.targetSidecar, `${plan.probe.targetSidecar}${paths.backupSuffix}`);
  }
  if (paths.sidecar) await log.remoteCreated(plan.target, paths.sidecar);
  await log.remoteCreated(plan.target, paths.transcript);
  await copyOnHost(hostRunnerOf(context), plan.target, request);
}

/**
 * The CLI session id a linked copy had when this tool last wrote it, for a
 * copy whose record lost it. The app removes the id when resuming fails (as
 * with SSH copies made before copies got their transcript on the host); as
 * long as no new session was started in the copy, it can get the same id
 * back together with a transcript under it, and its old mirror is replaced
 * instead of being left behind.
 */
function lastLinkedCliSessionId(context: OperationContext, existing: Conversation): string | undefined {
  const linked = context.lineage.all().filter((link) => refersTo(link.target, existing));
  const id = linked.at(-1)?.target.cliSessionId;
  return id !== undefined && isUuid(id) ? id : undefined;
}

/**
 * A new copy on the target. Three shapes, by what the source has: an SSH
 * mirror (the copy gets ssh-<new id>/ with every file in it, and its
 * transcript on the host), an ordinary transcript (the copy's transcript and
 * sidecar go next to the source's), or no transcript at all (the copy is the
 * record alone, still with new ids and without the source-bound fields: it
 * is a conversation in the side panel; for an SSH conversation whose
 * original is on the host it gets its host transcript too).
 */
async function createCopy(context: OperationContext, item: TransferItem, warnings: string[]): Promise<TransferOutcome> {
  const { source, target } = item;
  const transcript = source.transcript;
  const now = nowOf(context);
  const newSessionId = newLocalSessionId();
  const newCliSessionId = randomUUID();
  const recordPath = path.join(target.dir, recordFileName(newSessionId));
  const record = recordForCopy(source, newSessionId, newCliSessionId, now);
  const mirrorDir = transcript && isSshMirror(transcript) ? sshMirrorDir(context.paths.projectsRoot, newCliSessionId) : null;
  if (mirrorDir && (await pathExists(mirrorDir))) {
    return outcomeOf(item, 'failed', `${mirrorDir} already exists`, warnings, context.dryRun);
  }
  const extra = { newSessionId, newCliSessionId };

  // The host side of an SSH copy is planned before anything is written, so a
  // host that cannot take the copy stops the operation while nothing exists yet.
  const sshTarget = sshHostOf(source);
  let hostPlan: HostCopyPlan | null = null;
  if (sshTarget && (mirrorDir || isSshWithoutMirror(source))) {
    try {
      hostPlan = await planHostCopy(context, sshTarget, source, newCliSessionId, 'create');
    } catch (error) {
      if (!(error instanceof HostStepError)) throw error;
      // A record without a transcript anywhere was never resumable; its copy
      // stays what it was before, a record alone.
      if (!transcript && error.kind === 'missing') warnings.push(`${error.message}; the copy is the record alone`);
      else return outcomeOf(item, 'failed', error.message, warnings, context.dryRun, extra);
    }
  } else if (mirrorDir) {
    warnings.push('the source record names no SSH host, so the copy gets no transcript on a host and cannot be resumed there; it is for reading');
  }
  const host = hostPlan ? `transcript also on ${describeHost(hostPlan.target)}` : null;
  if (context.dryRun) return outcomeOf(item, 'created', null, warnings, true, { ...extra, host });
  const gate = await openGate(context, item, warnings);
  if (isOutcome(gate)) return gate;

  const targetEndpoint = { accountId: target.accountId, orgId: target.orgId, sessionId: newSessionId, cliSessionId: newCliSessionId };
  const log = openLog(context, now, {
    mode: source.account ? 'copy' : 'import',
    action: 'created',
    title: source.title,
    rootUuid: source.summary?.rootUuid ?? null,
    source: endpointOf(source),
    target: targetEndpoint,
    relation: item.assessment.state,
  });
  for (const warning of warnings) log.warn(warning);
  await log.start();
  try {
    if (transcript && mirrorDir) {
      // No tombstones here: an SSH mirror must stay a byte prefix of the host
      // file, and the host copy gets them (ssh-host.ts).
      await log.created(mirrorDir);
      await copySidecar(transcript.projectDir, mirrorDir, transcript.cliSessionId, newCliSessionId);
    } else if (transcript) {
      const transcriptPath = path.join(transcript.projectDir, `${newCliSessionId}.jsonl`);
      await log.created(transcriptPath);
      await copyRewritingSessionId(transcript.path, transcriptPath, transcript.cliSessionId, newCliSessionId);
      await appendBridgeTombstones(transcriptPath);
      if (transcript.sidecarDir) {
        const sidecarPath = path.join(transcript.projectDir, newCliSessionId);
        await log.created(sidecarPath);
        await copySidecar(transcript.sidecarDir, sidecarPath, transcript.cliSessionId, newCliSessionId);
      }
    }
    if (hostPlan) await applyHostCopy(context, log, hostPlan, null);
    await assertStillAllowed(context);
    // The link goes to disk before the record: a run cut short in between
    // leaves a link to a record that does not exist (ignored), never a copy
    // without a link (the stamp alone does not last, see CcasStamp).
    await context.lineage.add({
      rootUuid: source.summary?.rootUuid ?? source.key,
      at: now,
      journalId: log.entry.id,
      mode: source.account ? 'copy' : 'import',
      action: 'created',
      sourceLineCount: source.summary?.lineCount ?? 0,
      source: endpointOf(source),
      target: targetEndpoint,
    });
    await log.created(recordPath);
    await writeRecord(recordPath, record);
    await log.finish('created');
    return outcomeOf(item, 'created', null, log.entry.warnings, false, { ...extra, host, journalId: log.entry.id });
  } catch (error) {
    return failed(log, item, error);
  }
}

/**
 * Brings the linked copy on the target up to date with the source (and, for a
 * move, then removes the source). The copy keeps its ids. Its old transcript
 * files go into the backup mirror as a whole and fresh ones are written, so a
 * restore puts back exactly what was there; on an SSH host the old copy is
 * kept aside under the journal id the same way.
 */
async function updateExisting(context: OperationContext, item: TransferItem, warnings: string[]): Promise<TransferOutcome> {
  const { source, mode, assessment } = item;
  const existing = assessment.existing;
  const transcript = source.transcript;
  if (!existing?.record) return outcomeOf(item, 'failed', 'target copy has no record to update', warnings, context.dryRun);
  if (!transcript) return outcomeOf(item, 'failed', 'no transcript to update from', warnings, context.dryRun);
  const now = nowOf(context);
  // A target record without a usable transcript id gets back the one it had
  // (see lastLinkedCliSessionId), else a fresh one.
  const targetCli = existing.cliSessionId ?? lastLinkedCliSessionId(context, existing) ?? randomUUID();
  const record = recordForCopy(source, existing.record.record.sessionId, targetCli, now);
  const finalAction: OutcomeAction = mode === 'move' ? 'moved' : 'updated';
  if (mode === 'move') {
    const remote = remoteProcessWarning(source);
    if (remote) warnings.push(remote);
  }
  const sshTarget = sshHostOf(source);
  let hostPlan: HostCopyPlan | null = null;
  if (isSshMirror(transcript)) {
    if (sshTarget) {
      try {
        hostPlan = await planHostCopy(context, sshTarget, source, targetCli, 'replace');
      } catch (error) {
        if (!(error instanceof HostStepError)) throw error;
        return outcomeOf(item, 'failed', error.message, warnings, context.dryRun);
      }
    } else {
      warnings.push('the source record names no SSH host, so the copy gets no transcript on a host and cannot be resumed there; it is for reading');
    }
  }
  const host = hostPlan ? `transcript also on ${describeHost(hostPlan.target)}` : null;
  if (context.dryRun) return outcomeOf(item, finalAction, null, warnings, true, { host });
  const gate = await openGate(context, item, warnings);
  if (isOutcome(gate)) return gate;

  const targetEndpoint = { ...endpointOf(existing), cliSessionId: targetCli };
  const log = openLog(context, now, {
    mode,
    action: 'updated',
    title: source.title,
    rootUuid: source.summary?.rootUuid ?? null,
    source: endpointOf(source),
    target: targetEndpoint,
    relation: assessment.state,
  });
  for (const warning of warnings) log.warn(warning);
  await log.start();
  try {
    await log.backup(existing.record.path);
    if (isSshMirror(transcript)) {
      const mirrorDir = sshMirrorDir(context.paths.projectsRoot, targetCli);
      await log.moveAway(mirrorDir);
      await log.created(mirrorDir);
      await copySidecar(transcript.projectDir, mirrorDir, transcript.cliSessionId, targetCli);
    } else {
      const transcriptPath = existing.transcript?.path ?? path.join(transcript.projectDir, `${targetCli}.jsonl`);
      const sidecarPath = existing.transcript?.sidecarDir ?? path.join(path.dirname(transcriptPath), targetCli);
      // Found while making SSH updates restorable exactly: the target's transcript
      // and sidecar used to be backed up and then overwritten in place, and a
      // restore (or a rollback) copied the backup back over them. Files the
      // update had added to the sidecar (tool results and sub-agent transcripts
      // of the newer rounds) survived the restore. Moving the old ones away and
      // writing fresh ones makes restore a plain move back.
      await log.moveAway(transcriptPath);
      await log.moveAway(sidecarPath);
      await log.created(transcriptPath);
      await copyRewritingSessionId(transcript.path, transcriptPath, transcript.cliSessionId, targetCli);
      await appendBridgeTombstones(transcriptPath);
      if (transcript.sidecarDir) {
        await log.created(sidecarPath);
        await copySidecar(transcript.sidecarDir, sidecarPath, transcript.cliSessionId, targetCli);
      }
    }
    if (hostPlan) await applyHostCopy(context, log, hostPlan, log.entry.id);
    await assertStillAllowed(context);
    await context.lineage.add({
      rootUuid: source.summary?.rootUuid ?? source.key,
      at: now,
      journalId: log.entry.id,
      mode: source.account ? mode : 'import',
      action: 'updated',
      sourceLineCount: source.summary?.lineCount ?? 0,
      source: endpointOf(source),
      target: targetEndpoint,
    });
    await writeRecord(existing.record.path, record);
    if (mode === 'move') await removeSourceFiles(log, source, existing);
    await log.finish(finalAction);
    return outcomeOf(item, finalAction, null, log.entry.warnings, false, { host, journalId: log.entry.id });
  } catch (error) {
    return failed(log, item, error);
  }
}

/**
 * Where a moved conversation's transcript on its SSH host still links up
 * with a claude.ai session, found before the move (read only). An unreachable
 * host only costs a warning: the moved record has Remote Control off either
 * way, and the transcript lines matter only once it is switched on again.
 */
async function planMovedHostTombstones(context: OperationContext, source: Conversation, warnings: string[]): Promise<{ target: HostTarget; path: string } | null> {
  const target = sshHostOf(source);
  const cli = cliSessionIdOf(source);
  if (!target || !cli || !isUuid(cli) || (source.transcript !== null && !isSshMirror(source.transcript))) return null;
  try {
    const probe = await probeHost(hostRunnerOf(context), target, {
      sourceCliSessionId: cli,
      targetCliSessionId: cli,
      hint: source.record?.record.sshRemoteTranscriptPath as string | undefined,
    });
    return probe.target !== null && probe.targetLive.length > 0 ? { target, path: probe.target } : null;
  } catch (error) {
    if (!(error instanceof HostStepError)) throw error;
    warnings.push(`Remote Control could not be switched off in the transcript on ${describeHost(target)} (${error.message}); the moved record has it off`);
    return null;
  }
}

/**
 * A move whose target has no copy yet: the record file changes directory, ids
 * and transcript stay. Remote Control is switched off on the way: in the
 * record, and in the transcript (in place, after a backup, or on the SSH host).
 */
async function moveRecord(context: OperationContext, item: TransferItem, warnings: string[]): Promise<TransferOutcome> {
  const { source, target } = item;
  if (!source.record) return outcomeOf(item, 'failed', 'nothing to move: the source has no record', warnings, context.dryRun);
  const destination = path.join(target.dir, source.record.fileName);
  if (await pathExists(destination)) {
    return outcomeOf(item, 'failed', `a record named ${source.record.fileName} already exists on the target account`, warnings, context.dryRun);
  }
  const transcript = source.transcript;
  const localTombstones = transcript !== null && !isSshMirror(transcript) && (await liveBridges(transcript.path)).length > 0;
  const hostTombstones = await planMovedHostTombstones(context, source, warnings);
  const host = hostTombstones ? `Remote Control off on ${describeHost(hostTombstones.target)}` : null;
  if (context.dryRun) return outcomeOf(item, 'moved', null, warnings, true, { host });
  const gate = await openGate(context, item, warnings);
  if (isOutcome(gate)) return gate;

  const log = openLog(context, nowOf(context), {
    mode: 'move',
    action: 'moved',
    title: source.title,
    rootUuid: source.summary?.rootUuid ?? null,
    source: endpointOf(source),
    target: { accountId: target.accountId, orgId: target.orgId, sessionId: source.record.record.sessionId, cliSessionId: source.cliSessionId ?? undefined },
    relation: item.assessment.state,
  });
  for (const warning of warnings) log.warn(warning);
  await log.start();
  try {
    // The record keeps its ids, but it is rewritten with the copy-point stamp so
    // the e-mails its transcript carries from the source account do not count
    // for the target, and with Remote Control off. The original content is
    // backed up for restore, and so is the transcript before its tombstones.
    await log.backup(source.record.path);
    if (localTombstones && transcript) {
      await log.backup(transcript.path);
      await appendBridgeTombstones(transcript.path);
    }
    if (hostTombstones) {
      try {
        await log.remoteTombstoned(hostTombstones.target, hostTombstones.path);
        await tombstoneOnHost(hostRunnerOf(context), hostTombstones.target, hostTombstones.path);
      } catch (error) {
        if (!(error instanceof HostStepError)) throw error;
        log.warn(`Remote Control could not be switched off in the transcript on ${describeHost(hostTombstones.target)} (${error.message}); the moved record has it off`);
      }
    }
    await log.move(source.record.path, destination);
    await assertStillAllowed(context);
    await writeRecord(destination, { ...withRemoteControlOff(source.record.record), ccas: stampFor(source, nowOf(context)) });
    await log.finish('moved');
    return outcomeOf(item, 'moved', null, log.entry.warnings, false, { host, journalId: log.entry.id });
  } catch (error) {
    return failed(log, item, error);
  }
}

/**
 * What an up-to-date copy still lacks, if it was made before 2026-09-28:
 * Remote Control off in its record and its local transcript, and for an SSH
 * conversation its transcript on the host (or, when the host has it, the
 * tombstones there). Only what the copy inherited from its source counts:
 * record fields still equal to the source's (inheritsRemoteControl) and links
 * to the source's claude.ai sessions. A copy the person switched Remote
 * Control on for, on the target account, is left alone, so running the same
 * transfer again never undoes that.
 */
interface RepairPlan {
  existing: Conversation;
  /** The record needs Remote Control off. */
  record: boolean;
  /** claude.ai sessions of the source that the copy's local (non-SSH) transcript still links up with. */
  localTombstones: Set<string>;
  host:
    | { kind: 'copy'; plan: HostCopyPlan }
    | { kind: 'tombstones'; target: HostTarget; path: string }
    | null;
}

/** Plans the repair of the linked copy (read only, the host included); throws HostStepError when the host cannot be reached. */
async function planRepair(context: OperationContext, item: TransferItem, warnings: string[]): Promise<RepairPlan | null> {
  const existing = item.assessment.existing;
  if (!existing?.record) return null;
  const inherited = new Set(item.source.summary?.bridge?.bridgeSessionIds ?? []);
  const record = !hasRemoteControlOff(existing.record.record) && inheritsRemoteControl(existing.record.record, item.source.record?.record);
  const localTranscript = existing.transcript !== null && !isSshMirror(existing.transcript) ? existing.transcript : null;
  const localTombstones = new Set(
    localTranscript === null
      ? []
      : (await liveBridges(localTranscript.path)).map((bridge) => bridge.bridgeSessionId).filter((bridge) => inherited.has(bridge)),
  );
  let host: RepairPlan['host'] = null;
  const target = hostTargetOf(existing.record.record) ?? sshHostOf(item.source);
  const targetCli = existing.cliSessionId;
  if (target && targetCli && localTranscript === null) {
    const sourceCli = cliSessionIdOf(item.source);
    const probe = await probeHost(hostRunnerOf(context), target, {
      sourceCliSessionId: sourceCli !== null && isUuid(sourceCli) ? sourceCli : targetCli,
      targetCliSessionId: targetCli,
      hint: item.source.record?.record.sshRemoteTranscriptPath as string | undefined,
    });
    if (probe.target !== null) {
      if (probe.targetLive.some((bridge) => inherited.has(bridge))) host = { kind: 'tombstones', target, path: probe.target };
    } else if (probe.dir !== null && sourceCli !== null && isUuid(sourceCli) && probe.targetSidecar === null) {
      host = { kind: 'copy', plan: { target, probe: { ...probe, dir: probe.dir }, sourceCliSessionId: sourceCli, targetCliSessionId: targetCli } };
    } else if (probe.dir === null) {
      warnings.push(`neither the original's nor the copy's transcript is on ${describeHost(target)}, so the copy cannot be resumed there`);
    } else {
      warnings.push(`${probe.targetSidecar} exists on ${describeHost(target)} without a transcript next to it; set it aside by hand, then transfer again`);
    }
  }
  return { existing, record, localTombstones, host };
}

/** One line on what a repair does, or null when there is nothing to repair. */
function describeRepair(plan: RepairPlan | null): string | null {
  if (!plan) return null;
  const parts: string[] = [];
  if (plan.record || plan.localTombstones.size > 0) parts.push('Remote Control switched off');
  if (plan.host?.kind === 'tombstones') parts.push(`Remote Control switched off on ${describeHost(plan.host.target)}`);
  if (plan.host?.kind === 'copy') parts.push(`transcript created on ${describeHost(plan.host.plan.target)}`);
  return parts.length > 0 ? parts.join('; ') : null;
}

/** Carries out a repair inside an open operation; the record, the file the app reads, is written last. */
async function applyRepair(context: OperationContext, log: OperationLog, plan: RepairPlan): Promise<void> {
  const { existing } = plan;
  if (plan.localTombstones.size > 0 && existing.transcript) {
    await log.backup(existing.transcript.path);
    await appendBridgeTombstones(existing.transcript.path, (bridge) => plan.localTombstones.has(bridge.bridgeSessionId));
  }
  if (plan.host?.kind === 'copy') await applyHostCopy(context, log, plan.host.plan, null);
  if (plan.host?.kind === 'tombstones') {
    await log.remoteTombstoned(plan.host.target, plan.host.path);
    await tombstoneOnHost(hostRunnerOf(context), plan.host.target, plan.host.path);
  }
  await assertStillAllowed(context);
  if (plan.record && existing.record) {
    await log.backup(existing.record.path);
    await writeRecord(existing.record.path, withRemoteControlOff(existing.record.record));
  }
}

/**
 * Copy mode for a pair that is already in sync: nothing to copy, but a copy
 * made before 2026-09-28 is repaired (RepairPlan). Without anything to repair
 * this is the old "up to date".
 */
async function repairCopy(context: OperationContext, item: TransferItem, warnings: string[], upToDate: string): Promise<TransferOutcome> {
  let plan: RepairPlan | null;
  try {
    plan = await planRepair(context, item, warnings);
  } catch (error) {
    if (!(error instanceof HostStepError)) throw error;
    return outcomeOf(item, 'failed', error.message, warnings, context.dryRun);
  }
  const what = describeRepair(plan);
  if (!plan || !what) return outcomeOf(item, 'up-to-date', upToDate, warnings, context.dryRun);
  if (context.dryRun) return outcomeOf(item, 'repaired', what, warnings, true);
  const gate = await openGate(context, item, warnings);
  if (isOutcome(gate)) return gate;
  const log = openLog(context, nowOf(context), {
    mode: item.mode,
    action: 'repaired',
    title: item.source.title,
    rootUuid: item.source.summary?.rootUuid ?? null,
    source: endpointOf(item.source),
    target: endpointOf(plan.existing),
    relation: item.assessment.state,
  });
  for (const warning of warnings) log.warn(warning);
  await log.start();
  try {
    await applyRepair(context, log, plan);
    await log.finish('repaired');
    return outcomeOf(item, 'repaired', what, log.entry.warnings, false, { journalId: log.entry.id });
  } catch (error) {
    return failed(log, item, error);
  }
}

/**
 * A move whose target already holds an identical copy: only the source side
 * disappears, after the copy got what copies made before 2026-09-28 lack
 * (see RepairPlan), so the conversation that stays is one the app can resume.
 */
async function removeSource(context: OperationContext, item: TransferItem, warnings: string[], reason: string): Promise<TransferOutcome> {
  const { source, target } = item;
  const remote = remoteProcessWarning(source);
  if (remote) warnings.push(remote);
  let plan: RepairPlan | null;
  try {
    plan = await planRepair(context, item, warnings);
  } catch (error) {
    if (!(error instanceof HostStepError)) throw error;
    return outcomeOf(item, 'failed', `${error.message}; the source stays where it is`, warnings, context.dryRun);
  }
  const repair = describeRepair(plan);
  const fullReason = repair ? `${reason}; copy repaired: ${repair}` : reason;
  if (context.dryRun) return outcomeOf(item, 'moved', fullReason, warnings, true);
  const gate = await openGate(context, item, warnings);
  if (isOutcome(gate)) return gate;
  const log = openLog(context, nowOf(context), {
    mode: 'move',
    action: 'moved',
    title: source.title,
    rootUuid: source.summary?.rootUuid ?? null,
    source: endpointOf(source),
    target: item.assessment.existing ? endpointOf(item.assessment.existing) : { accountId: target.accountId, orgId: target.orgId },
    relation: item.assessment.state,
  });
  for (const warning of warnings) log.warn(warning);
  await log.start();
  try {
    if (plan && repair) await applyRepair(context, log, plan);
    await removeSourceFiles(log, source, item.assessment.existing);
    await log.finish('moved');
    return outcomeOf(item, 'moved', fullReason, log.entry.warnings, false, { journalId: log.entry.id });
  } catch (error) {
    return failed(log, item, error);
  }
}

/** Performs one transfer decision end to end. Never throws for a predictable refusal; those come back as outcomes. */
export async function executeTransfer(context: OperationContext, item: TransferItem): Promise<TransferOutcome> {
  const { source, target, mode, assessment } = item;
  const warnings = [...assessment.warnings];
  const dryRun = context.dryRun;

  if (source.account && accountKey(source.account.accountId, source.account.orgId) === accountKey(target.accountId, target.orgId)) {
    return outcomeOf(item, 'failed', 'source and target are the same account', warnings, dryRun);
  }
  if (mode === 'move' && !source.account) {
    return outcomeOf(item, 'failed', 'unlisted transcripts can only be copied; the original stays where the CLI put it', warnings, dryRun);
  }
  const scheduled = await scheduledTaskWarning(source);
  if (scheduled) warnings.push(scheduled);

  switch (assessment.state) {
    case 'no-transcript':
      if (mode === 'copy') {
        // A record without a transcript is still an entry in the side panel, so
        // Copy makes a copy of the record alone. Once the target has one there is
        // nothing to compare, so it counts as up to date (after a repair).
        if (assessment.existing) {
          return repairCopy(context, item, warnings, 'target already holds a copy of this record; the source has no transcript to compare');
        }
        return createCopy(context, item, warnings);
      }
      if (assessment.existing) {
        return outcomeOf(item, 'skipped', 'target already has this conversation and the source has no transcript to update it with', warnings, dryRun);
      }
      return moveRecord(context, item, warnings);
    case 'new':
      return mode === 'copy' ? createCopy(context, item, warnings) : moveRecord(context, item, warnings);
    case 'up-to-date':
      if (mode === 'copy') return repairCopy(context, item, warnings, 'target already holds an identical copy');
      return removeSource(context, item, warnings, 'target already held an identical copy; source removed');
    case 'update-available':
      return updateExisting(context, item, warnings);
    case 'target-ahead':
    case 'diverged':
      if (item.onConflict !== 'overwrite') {
        const why =
          assessment.state === 'target-ahead'
            ? 'target copy is newer than the source (choose overwrite to replace it)'
            : 'both copies changed since they diverged (choose overwrite to replace the target)';
        return outcomeOf(item, 'skipped', why, warnings, dryRun);
      }
      return updateExisting(context, item, warnings);
    case 'unrelated':
      return outcomeOf(
        item,
        'skipped',
        'the linked copy on the target holds a different conversation now (for example the app started a new session in it); refusing to overwrite it',
        warnings,
        dryRun,
      );
    case 'ambiguous':
      return outcomeOf(item, 'skipped', 'linked to more than one conversation on the target; refusing to choose one', warnings, dryRun);
    default:
      return outcomeOf(item, 'failed', `unexpected sync state ${String(assessment.state)}`, warnings, dryRun);
  }
}

export interface RestoreResult {
  entry: JournalEntry;
  restoreJournalId: string | null;
  /** Files and directories put back, moved back, moved away or set aside, here and on the SSH host. */
  steps: string[];
  warnings: string[];
  dryRun: boolean;
}

/** Moves the temp files a cut-short write left next to `target` into this restore's backup mirror. */
async function setAsideTemps(log: OperationLog, target: string, steps: string[]): Promise<void> {
  for (const temp of await tempSiblings(target)) {
    await log.moveAway(temp);
    steps.push(`set aside ${temp}`);
  }
}

/** The host steps a restore would take, for a dry run (the host is not asked). */
function plannedHostUndo(entry: JournalEntry): string[] {
  const remote = entry.remote;
  if (!remote) return [];
  const host = describeHost(remote.host);
  return [
    ...[...remote.created].reverse().map((created) => `set aside ${created} on ${host}`),
    ...[...remote.moved].reverse().map((move) => `move ${move.to} back to ${move.from} on ${host}`),
    ...remote.tombstoned.map((file) => `${file} on ${host} keeps its Remote Control tombstones`),
  ];
}

/**
 * Undoes a journal entry: created files are moved into the restore's own
 * backup mirror, moves are reversed, and overwritten files are copied back
 * from the original backup (after backing up their current state, so a
 * restore can itself be restored). Host changes are undone on the host:
 * created paths are set aside there, kept originals move back
 * (ssh-host.ts, undoOnHost); tombstones appended to a transcript on the host
 * stay, they only keep Remote Control off. A host that cannot be reached
 * leaves a warning naming the paths, and the local part is restored anyway.
 * Throws GuardRefusal when Claude is running; a guard that closes half-way
 * rolls the restore back.
 *
 * The entry may be one an interrupted run left behind: steps it announced but
 * never took are skipped (a path that is not there, a move whose destination
 * is missing), temp files of writes cut short are set aside, and a move whose
 * two ends both exist is left alone with a warning, since it cannot be told
 * which end is complete.
 */
export async function restoreEntry(context: OperationContext, id: string): Promise<RestoreResult> {
  const entry = await context.journal.get(id);
  if (!entry) throw new Error(`journal entry ${id} not found`);
  // A restore that completed is undone by restoring the entry it undid; one
  // that did not (interrupted, failed half-way, or left as it was) is undone
  // like any other operation, from its own journaled steps.
  if (entry.mode === 'restore' && entry.status === 'done') throw new Error(`${id} is itself a restore; restore the entry it undid instead`);
  if (entry.status === 'restored') throw new Error(`${id} was already restored`);
  const steps: string[] = [];
  const warnings: string[] = [];
  if (context.dryRun) {
    for (const created of [...entry.created].reverse()) {
      for (const temp of await tempSiblings(created)) steps.push(`set aside ${temp}`);
      if (await pathExists(created)) steps.push(`remove ${created}`);
    }
    for (const move of [...entry.moved].reverse()) steps.push(`move ${move.to} back to ${move.from}`);
    for (const backed of entry.backedUp) {
      for (const temp of await tempSiblings(backed)) steps.push(`set aside ${temp}`);
      steps.push(`restore ${backed} from backup`);
    }
    steps.push(...plannedHostUndo(entry));
    return { entry, restoreJournalId: null, steps, warnings, dryRun: true };
  }
  const gate = await guardOf(context)();
  if (!gate.allowed) throw new GuardRefusal(gate.reason);
  if (gate.reason) warnings.push(gate.reason);
  const log = openLog(context, nowOf(context), {
    mode: 'restore',
    action: 'none',
    title: entry.title,
    rootUuid: entry.rootUuid,
    source: entry.target,
    target: entry.source,
    relation: null,
    restores: id,
  });
  for (const warning of warnings) log.warn(warning);
  await log.start();
  try {
    for (const created of [...entry.created].reverse()) {
      await setAsideTemps(log, created, steps);
      if (await pathExists(created)) {
        await log.moveAway(created);
        steps.push(`removed ${created}`);
      }
    }
    for (const move of [...entry.moved].reverse()) {
      const [atDestination, atSource] = await Promise.all([pathExists(move.to), pathExists(move.from)]);
      if (atDestination && atSource) {
        // A move across volumes (fsx.moveTree) cut short between its copy and its
        // delete leaves both ends; which one is complete cannot be told.
        log.warn(`both ${move.from} and ${move.to} exist (the move was cut short); left as they are, check them by hand`);
        continue;
      }
      if (atDestination) {
        await log.move(move.to, move.from);
        steps.push(`moved ${move.to} back to ${move.from}`);
      }
    }
    await assertStillAllowed(context);
    for (const backed of entry.backedUp) {
      await setAsideTemps(log, backed, steps);
      const mirror = entry.backupDir ? mirrorPath(entry.backupDir, backed) : null;
      if (!mirror || !(await pathExists(mirror))) {
        log.warn(`backup of ${backed} is missing; left as is`);
        continue;
      }
      await log.backup(backed);
      await cp(mirror, backed, { recursive: true, force: true });
      steps.push(`restored ${backed}`);
    }
    const remote = entry.remote;
    if (remote) {
      const host = describeHost(remote.host);
      if (remote.created.length > 0 || remote.moved.length > 0) {
        try {
          const undone = await undoOnHost(hostRunnerOf(context), remote.host, { created: remote.created, moved: remote.moved, tag: log.entry.id });
          steps.push(...undone.steps);
          for (const warning of undone.warnings) log.warn(warning);
        } catch (error) {
          if (!(error instanceof HostStepError)) throw error;
          log.warn(
            `host changes not undone (${error.message}); on ${host}, set aside ${[...remote.created].reverse().join(', ') || 'nothing'} ` +
              `and move back ${[...remote.moved].reverse().map((move) => `${move.to} to ${move.from}`).join(', ') || 'nothing'}`,
          );
        }
      }
      for (const file of remote.tombstoned) {
        log.warn(`${file} on ${host} keeps its Remote Control tombstones; switch Remote Control on in the app to link the conversation up again`);
      }
    }
    entry.status = 'restored';
    await context.journal.update(entry);
    await log.finish('none');
    return { entry, restoreJournalId: log.entry.id, steps, warnings: log.entry.warnings, dryRun: false };
  } catch (error) {
    if (error instanceof GuardRefusal) {
      await log.rollback();
      await log.fail(new Error(`${error.message} Claude Code appeared during the restore; its changes were rolled back.`));
      throw new GuardRefusal(log.entry.error ?? error.message);
    }
    await log.fail(error);
    throw error;
  }
}
