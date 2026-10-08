import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  CWD_BETA,
  EMAIL_A,
  EMAIL_B,
  SSH_HOST,
  appendRounds,
  buildTranscriptLines,
  destroyWorld,
  hostHome,
  hostProjectDir,
  localHostRunner,
  makeWorld,
  readJson,
  readTree,
  replaceInBytes,
  sessionKeyedFixtureFiles,
  sshRecordFields,
  unreachableHostRunner,
  writeHostTranscript,
  writeRecord,
  writeSshTranscript,
  writeTranscript,
  type World,
  type WrittenSshTranscript,
} from '../test/fixtures.ts';
import { AccountStore, accountKey, type AccountInfo } from './accounts.ts';
import { pathExists } from './fsx.ts';
import { assessSync, buildInventory, conversationsOf, type Conversation, type Inventory } from './inventory.ts';
import { Journal, type JournalEntry } from './journal.ts';
import { LineageStore } from './lineage.ts';
import { executeTransfer, restoreEntry, type ExistingPolicy, type OperationContext, type TransferOutcome } from './operations.ts';
import { SOURCE_BOUND_FIELDS, type SessionRecord } from './records.ts';
import { bridgeTombstone, isSshMirror, sshMirrorDir, summarizeTranscript } from './transcripts.ts';

/** Helpers shared by both suites, bound to one world and one inventory at a time. */
function harness(options: { withLineage: boolean }) {
  const state = {} as { world: World; inventory: Inventory; context: OperationContext };
  const rebuild = async (): Promise<void> => {
    state.inventory = await buildInventory(state.world.paths, {
      store: await AccountStore.load(state.world.paths.dataDir),
      lineage: options.withLineage ? state.context.lineage : undefined,
    });
  };
  const account = (which: typeof ACCOUNT_A): AccountInfo => {
    const found = state.inventory.accounts.find((candidate) => candidate.accountId === which.accountId);
    assert.ok(found);
    return found;
  };
  const listed = (which: typeof ACCOUNT_A, title: string): Conversation => {
    const found = state.inventory.byAccount.get(accountKey(which.accountId, which.orgId))?.find((conversation) => conversation.title === title);
    assert.ok(found, `conversation "${title}" on ${which.accountId}`);
    return found;
  };
  /** One transfer with the policy given for an existing copy ('sync' is what the command line does without --on-conflict). */
  const transfer = async (
    source: Conversation,
    target: AccountInfo,
    onExisting: ExistingPolicy = 'sync',
    dryRun = false,
    context: OperationContext = state.context,
  ): Promise<TransferOutcome> => {
    const assessment = assessSync(source, conversationsOf(state.inventory, target));
    const outcome = await executeTransfer({ ...context, dryRun }, { source, target, assessment, onExisting });
    if (!dryRun) await rebuild();
    return outcome;
  };
  const recordsIn = async (dir: string): Promise<string[]> => (await readdir(dir)).filter((name) => name.startsWith('local_')).sort();
  return { state, rebuild, account, listed, transfer, recordsIn };
}

describe('operations', () => {
  const { state, rebuild, account, listed, transfer, recordsIn } = harness({ withLineage: false });
  const unlisted = (title: string): Conversation => {
    const found = state.inventory.unlisted.find((conversation) => conversation.title === title);
    assert.ok(found, `unlisted "${title}"`);
    return found;
  };

  before(async () => {
    state.world = await makeWorld();
    const world = state.world;
    state.context = { paths: world.paths, journal: new Journal(world.paths.dataDir), lineage: await LineageStore.load(world.paths.dataDir), dryRun: false };
    const t1 = await writeTranscript(world, { prompts: 2, email: EMAIL_A, title: 'T1' });
    await writeRecord(world, world.a, {
      cliSessionId: t1.cliId,
      title: 'R1',
      priorCliSessionIds: ['55555555-5555-4555-8555-555555555555'],
      bridgeSessionIds: ['session_x'],
      toolSurfaceSnapshot: { cliVersion: '2.1.275', note: `refers to ${t1.cliId}` },
    });
    await rebuild();
  });
  after(async () => {
    await destroyWorld(state.world);
  });

  it('refuses a transfer onto the same account', async () => {
    const outcome = await transfer(listed(ACCOUNT_A, 'R1'), account(ACCOUNT_A));
    assert.equal(outcome.action, 'failed');
    assert.match(outcome.reason ?? '', /same account/);
  });

  it('dry run reports the plan and touches nothing', async () => {
    const outcome = await transfer(listed(ACCOUNT_A, 'R1'), account(ACCOUNT_B), 'sync', true);
    assert.equal(outcome.action, 'created');
    assert.equal(outcome.dryRun, true);
    assert.ok(outcome.newSessionId?.startsWith('local_'));
    assert.deepEqual(await recordsIn(state.world.b.dir), []);
    assert.deepEqual(await state.context.journal.list(), []);
  });

  it('refuses to write when the guard says Claude is running', async () => {
    const closed = { ...state.context, guard: async () => ({ allowed: false, reason: 'Claude is running' }) };
    const outcome = await transfer(listed(ACCOUNT_A, 'R1'), account(ACCOUNT_B), 'sync', false, closed);
    assert.equal(outcome.action, 'refused');
    assert.match(outcome.reason ?? '', /running/);
    assert.deepEqual(await recordsIn(state.world.b.dir), []);
    assert.deepEqual(await state.context.journal.list(), []);
  });

  it('rolls back when Claude Code appears in the middle of an operation', async () => {
    // The guard is consulted before the first write and again before the record
    // is written; here it closes between the two, as if the app was launched.
    let calls = 0;
    const flaky = { ...state.context, guard: async () => (++calls === 1 ? { allowed: true, reason: null } : { allowed: false, reason: 'Claude started' }) };
    const source = listed(ACCOUNT_A, 'R1');
    const outcome = await transfer(source, account(ACCOUNT_B), 'sync', false, flaky);
    assert.equal(outcome.action, 'refused');
    assert.match(outcome.reason ?? '', /rolled back/);
    assert.deepEqual(await recordsIn(state.world.b.dir), []);
    assert.ok(source.transcript);
    const leftovers = (await readdir(source.transcript.projectDir)).filter((name) => name.endsWith('.jsonl'));
    assert.deepEqual(leftovers, [`${source.transcript.cliSessionId}.jsonl`]);
    const entry = await state.context.journal.get(outcome.journalId!);
    assert.equal(entry?.status, 'failed');
    assert.deepEqual(entry?.created, []);
    assert.match(entry?.error ?? '', /rolled back/);
    // The lineage link is written after the last guard check, so a refusal leaves none.
    assert.equal(state.context.lineage.all().length, 0);
  });

  it('copy creates an independent copy with new ids and a journal trail', async () => {
    const source = listed(ACCOUNT_A, 'R1');
    const outcome = await transfer(source, account(ACCOUNT_B));
    assert.equal(outcome.action, 'created');
    assert.ok(outcome.journalId);
    const names = await recordsIn(state.world.b.dir);
    assert.equal(names.length, 1);
    const record = await readJson<SessionRecord>(path.join(state.world.b.dir, names[0]!));
    assert.equal(record.sessionId, outcome.newSessionId);
    assert.equal(record.cliSessionId, outcome.newCliSessionId);
    assert.equal(record.title, 'R1');
    assert.ok(!('priorCliSessionIds' in record) && !('bridgeSessionIds' in record));
    // Nested snapshots that mentioned the old id now mention the new one.
    assert.equal((record['toolSurfaceSnapshot'] as { note: string }).note, `refers to ${outcome.newCliSessionId}`);
    assert.ok(source.transcript);
    const copied = await summarizeTranscript(path.join(source.transcript.projectDir, `${outcome.newCliSessionId}.jsonl`));
    assert.deepEqual(copied.uuidChain, source.summary?.uuidChain);
    assert.deepEqual(copied.sessionIds, [outcome.newCliSessionId]);
    assert.ok(await pathExists(path.join(source.transcript.projectDir, outcome.newCliSessionId!, 'tool-results', 'result1.txt')));
    const entry = await state.context.journal.get(outcome.journalId!);
    assert.equal(entry?.status, 'done');
    // Transcript, side folder, file-history and uploads directories, record.
    assert.equal(entry?.created.length, 5);
    assert.equal(entry?.backedUp.length, 0);
    assert.equal(state.context.lineage.byRoot(source.key).length, 1);
    // The source stayed exactly as it was.
    assert.deepEqual(await recordsIn(state.world.a.dir), [`local_${source.record?.record.sessionId.slice(6)}.json`]);
  });

  it('copying again is a no-op while the copies are identical', async () => {
    // This suite builds its inventory without lineage.json: the record stamp alone links the pair.
    const outcome = await transfer(listed(ACCOUNT_A, 'R1'), account(ACCOUNT_B));
    assert.equal(outcome.action, 'up-to-date');
    // Only the copy itself is journaled as done; the rolled-back attempt above stays as a failed entry.
    assert.equal((await state.context.journal.list()).filter((entry) => entry.status === 'done').length, 1);
  });

  it('an identical pair is skipped, kept or written again as the pair question answers (the TUI policies)', async () => {
    // The TUI asks about every conversation the target already holds (asked
    // for by the operator on 2026-10-07); its three answers for an identical
    // pair are skip, keep (the sync policy) and overwrite. A pair of its own,
    // so the R1 pair above keeps the shape the tests below expect.
    const world = state.world;
    const t = await writeTranscript(world, { prompts: 1, title: 'T-same' });
    const { path: recordPath } = await writeRecord(world, world.a, { cliSessionId: t.cliId, title: 'R-same' });
    await rebuild();
    assert.equal((await transfer(listed(ACCOUNT_A, 'R-same'), account(ACCOUNT_B))).action, 'created');
    // The source record is renamed in the app; the transcripts stay identical.
    const saved = await readJson<SessionRecord>(recordPath);
    await writeFile(recordPath, JSON.stringify({ ...saved, title: 'R-same renamed' }, null, 2));
    await rebuild();
    const source = listed(ACCOUNT_A, 'R-same renamed');
    assert.equal(assessSync(source, conversationsOf(state.inventory, account(ACCOUNT_B))).state, 'up-to-date');
    const journalBefore = (await state.context.journal.list()).length;

    const skipped = await transfer(source, account(ACCOUNT_B), 'skip');
    assert.equal(skipped.action, 'skipped');
    assert.equal(skipped.reason, 'the target copy is identical; left as answered');
    assert.equal(skipped.journalId, null);
    assert.equal((await state.context.journal.list()).length, journalBefore, 'skipping writes nothing');
    assert.equal(listed(ACCOUNT_B, 'R-same').title, 'R-same', 'the copy keeps its old title');

    assert.equal((await transfer(source, account(ACCOUNT_B))).action, 'up-to-date', 'keep: as before');
    assert.equal((await transfer(source, account(ACCOUNT_B), 'overwrite-conflicts')).action, 'up-to-date', 'the command line never rewrites an identical copy');

    const overwritten = await transfer(source, account(ACCOUNT_B), 'overwrite');
    assert.equal(overwritten.action, 'updated');
    const copy = listed(ACCOUNT_B, 'R-same renamed');
    assert.deepEqual(copy.summary?.uuidChain, source.summary?.uuidChain, 'the same transcript');
    const entry = await state.context.journal.get(overwritten.journalId!);
    assert.equal(entry?.mode, 'copy');
    assert.deepEqual(entry?.backedUp, [copy.record!.path], 'the previous record went into the backup');
    assert.ok(entry?.moved.some((move) => move.from === copy.transcript!.path), 'and so did the previous transcript');
  });

  it('copying after the source grew updates the target copy and keeps the old one in the backup', async () => {
    const source = listed(ACCOUNT_A, 'R1');
    assert.ok(source.transcript);
    await appendRounds({ cliId: source.transcript.cliSessionId, path: source.transcript.path, projectDir: source.transcript.projectDir, sidecarDir: '', cwd: source.cwd ?? '', lines: [], uuids: [] }, 1);
    await rebuild();
    const before = listed(ACCOUNT_B, 'R1');
    // The TUI's "Skip" for a pair where the source is longer leaves the copy behind.
    const left = await transfer(listed(ACCOUNT_A, 'R1'), account(ACCOUNT_B), 'skip');
    assert.equal(left.action, 'skipped');
    assert.equal(left.reason, 'the target copy is behind the source; left as answered');
    assert.equal(listed(ACCOUNT_B, 'R1').summary?.uuidChain.length, before.summary?.uuidChain.length);
    const outcome = await transfer(listed(ACCOUNT_A, 'R1'), account(ACCOUNT_B));
    assert.equal(outcome.action, 'updated');
    const after = listed(ACCOUNT_B, 'R1');
    assert.equal(after.record?.record.sessionId, before.record?.record.sessionId);
    assert.equal(after.cliSessionId, before.cliSessionId);
    assert.deepEqual(after.summary?.uuidChain, listed(ACCOUNT_A, 'R1').summary?.uuidChain);
    const entry = await state.context.journal.get(outcome.journalId!);
    // The record is backed up; the old transcript, sidecar and per-session directories are moved into the backup whole.
    assert.equal(entry?.backedUp.length, 1);
    assert.deepEqual(
      entry?.moved.map((move) => move.from),
      [
        before.transcript!.path,
        before.transcript!.sidecarDir!,
        path.join(state.world.paths.claudeDir, 'file-history', before.cliSessionId!),
        path.join(state.world.paths.claudeDir, 'uploads', before.cliSessionId!),
      ],
    );
    assert.ok(entry?.backupDir);
    const backedTranscript = path.join(entry.backupDir, ...before.transcript!.path.split(path.sep).filter(Boolean));
    assert.equal((await summarizeTranscript(backedTranscript)).uuidChain.length, before.summary?.uuidChain.length);
  });

  it('a newer target copy is skipped unless overwrite is chosen', async () => {
    const copy = listed(ACCOUNT_B, 'R1');
    assert.ok(copy.transcript);
    await appendRounds({ cliId: copy.transcript.cliSessionId, path: copy.transcript.path, projectDir: '', sidecarDir: '', cwd: '', lines: [], uuids: [] }, 1, Date.UTC(2026, 8, 5));
    await rebuild();
    const skipped = await transfer(listed(ACCOUNT_A, 'R1'), account(ACCOUNT_B));
    assert.equal(skipped.action, 'skipped');
    assert.match(skipped.reason ?? '', /newer/);
    // The TUI's "Skip" answer says so in its own words; both write nothing.
    const answered = await transfer(listed(ACCOUNT_A, 'R1'), account(ACCOUNT_B), 'skip');
    assert.equal(answered.action, 'skipped');
    assert.equal(answered.reason, 'the target copy is newer than the source; left as answered');
    const overwritten = await transfer(listed(ACCOUNT_A, 'R1'), account(ACCOUNT_B), 'overwrite-conflicts');
    assert.equal(overwritten.action, 'updated');
    assert.deepEqual(listed(ACCOUNT_B, 'R1').summary?.uuidChain, listed(ACCOUNT_A, 'R1').summary?.uuidChain);
  });

  it('diverged copies need an explicit overwrite too', async () => {
    const source = listed(ACCOUNT_A, 'R1');
    const copy = listed(ACCOUNT_B, 'R1');
    assert.ok(source.transcript && copy.transcript);
    await appendRounds({ cliId: source.transcript.cliSessionId, path: source.transcript.path, projectDir: '', sidecarDir: '', cwd: '', lines: [], uuids: [] }, 1, Date.UTC(2026, 8, 6));
    await appendRounds({ cliId: copy.transcript.cliSessionId, path: copy.transcript.path, projectDir: '', sidecarDir: '', cwd: '', lines: [], uuids: [] }, 1, Date.UTC(2026, 8, 7));
    await rebuild();
    const assessment = assessSync(listed(ACCOUNT_A, 'R1'), conversationsOf(state.inventory, account(ACCOUNT_B)));
    assert.equal(assessment.state, 'diverged');
    assert.equal((await transfer(listed(ACCOUNT_A, 'R1'), account(ACCOUNT_B))).action, 'skipped');
    const answered = await transfer(listed(ACCOUNT_A, 'R1'), account(ACCOUNT_B), 'skip');
    assert.equal(answered.reason, 'the target copy is diverged from the source; left as answered');
    // The TUI's "Overwrite" and the command line's --on-conflict overwrite do the same here.
    assert.equal((await transfer(listed(ACCOUNT_A, 'R1'), account(ACCOUNT_B), 'overwrite')).action, 'updated');
  });

  it('restores a journal entry of mode "move" written by a version from before 2026-10-07', async () => {
    // The move path is gone, but journals written before keep such entries, and
    // "Restore from journal" must still put a moved record back: a restore only
    // walks the entry's created, moved and backed-up lists, whatever its mode.
    const world = state.world;
    const t = await writeTranscript(world, { prompts: 1, title: 'T-old-move' });
    const { path: recordPath } = await writeRecord(world, world.a, { cliSessionId: t.cliId, title: 'R-old-move' });
    const destination = path.join(world.b.dir, path.basename(recordPath));
    await rebuild();
    const source = listed(ACCOUNT_A, 'R-old-move');
    assert.ok(source.record && source.summary);
    // What an old move left: the record renamed into the other account's
    // directory, rewritten with the copy-point stamp (so the source account's
    // e-mail in its transcript does not vote for the target account), and a
    // finished entry listing exactly that rename.
    await rename(recordPath, destination);
    const stamp = {
      copiedFrom: { accountId: ACCOUNT_A.accountId, orgId: ACCOUNT_A.orgId, sessionId: source.record.record.sessionId, cliSessionId: t.cliId },
      rootUuid: source.summary.rootUuid,
      sourceLineCount: source.summary.lineCount,
      at: Date.UTC(2026, 9, 1, 10, 0, 0),
    };
    await writeFile(destination, JSON.stringify({ ...source.record.record, ccas: stamp }, null, 2));
    const id = '20261001T100000Z-0ddm0v';
    await state.context.journal.append({
      id,
      at: '2026-10-01T10:00:00.000Z',
      mode: 'move',
      action: 'moved',
      status: 'done',
      title: 'R-old-move',
      rootUuid: null,
      source: { accountId: ACCOUNT_A.accountId, orgId: ACCOUNT_A.orgId, sessionId: path.basename(recordPath, '.json'), cliSessionId: t.cliId },
      target: { accountId: ACCOUNT_B.accountId, orgId: ACCOUNT_B.orgId, sessionId: path.basename(recordPath, '.json'), cliSessionId: t.cliId },
      relation: 'new',
      backupDir: null,
      backedUp: [],
      created: [],
      moved: [{ from: recordPath, to: destination }],
      warnings: [],
    });
    await rebuild();
    assert.ok(listed(ACCOUNT_B, 'R-old-move'));
    const restored = await restoreEntry(state.context, id);
    assert.deepEqual(restored.steps, [`moved ${destination} back to ${recordPath}`]);
    assert.ok(await pathExists(recordPath));
    assert.equal(await pathExists(destination), false);
    assert.equal((await state.context.journal.get(id))?.status, 'restored');
    await rebuild();
    assert.ok(listed(ACCOUNT_A, 'R-old-move'));
  });

  it('imports an unlisted transcript with a synthesized record', async () => {
    const world = state.world;
    const t = await writeTranscript(world, { prompts: 2, cwd: CWD_BETA, title: 'U-import', model: 'claude-sonnet-5', bridgeOwner: ACCOUNT_A });
    await rebuild();
    const outcome = await transfer(unlisted('U-import'), account(ACCOUNT_B));
    assert.equal(outcome.action, 'created');
    const record = await readJson<SessionRecord>(path.join(world.b.dir, `${outcome.newSessionId}.json`));
    assert.equal(record.cwd, CWD_BETA);
    assert.equal(record.originCwd, CWD_BETA);
    assert.equal(record.title, 'U-import');
    assert.equal(record.titleSource, 'tool');
    assert.equal(record.model, 'claude-sonnet-5');
    assert.equal(record.adoptedFromOtherSurface, true);
    assert.equal(record.isArchived, false);
    assert.equal(record.createdAt, Date.parse(t.lines[0]!['timestamp'] as string));
    assert.ok(record.lastActivityAt > record.createdAt);
    assert.ok(await pathExists(t.path), 'original transcript untouched');
    const entry = await state.context.journal.get(outcome.journalId!);
    assert.equal(entry?.mode, 'import');
    // Importing the same transcript again finds the copy through its stamp and has nothing to add.
    assert.equal((await transfer(unlisted('U-import'), account(ACCOUNT_B))).action, 'up-to-date');
  });

  it('a record without a transcript is copied as a record alone', async () => {
    const world = state.world;
    await writeRecord(world, world.a, { cliSessionId: '77777777-7777-4777-8777-777777777777', title: 'R-orphan' });
    await rebuild();
    const copied = await transfer(listed(ACCOUNT_A, 'R-orphan'), account(ACCOUNT_B));
    assert.equal(copied.action, 'created');
    assert.notEqual(copied.newCliSessionId, '77777777-7777-4777-8777-777777777777');
    assert.equal((await transfer(listed(ACCOUNT_A, 'R-orphan'), account(ACCOUNT_B))).action, 'up-to-date');
  });

  it('restore undoes a copy and an update', async () => {
    const world = state.world;
    const context = state.context;
    const t = await writeTranscript(world, { prompts: 1, title: 'T-restore' });
    await writeRecord(world, world.a, { cliSessionId: t.cliId, title: 'R-restore' });
    await rebuild();
    const created = await transfer(listed(ACCOUNT_A, 'R-restore'), account(ACCOUNT_B));
    assert.equal(created.action, 'created');
    const createdRecord = path.join(world.b.dir, `${created.newSessionId}.json`);
    assert.ok(await pathExists(createdRecord));

    await assert.rejects(
      () => restoreEntry({ ...context, guard: async () => ({ allowed: false, reason: 'Claude is running' }) }, created.journalId!),
      /running/,
    );
    assert.equal((await context.journal.get(created.journalId!))?.status, 'done');
    const preview = await restoreEntry({ ...context, dryRun: true }, created.journalId!);
    assert.equal(preview.dryRun, true);
    // One removal per created path: record, uploads, file-history, side folder, transcript.
    assert.equal(preview.steps.length, 5);
    assert.ok(await pathExists(createdRecord));

    const restored = await restoreEntry(context, created.journalId!);
    assert.equal(restored.steps.length, 5);
    assert.equal(await pathExists(createdRecord), false);
    for (const dir of ['file-history', 'uploads']) {
      assert.equal(await pathExists(path.join(world.paths.claudeDir, dir, created.newCliSessionId!)), false, `${dir} of the copy is gone`);
    }
    assert.equal(await pathExists(path.join(t.projectDir, `${created.newCliSessionId}.jsonl`)), false);
    assert.equal((await context.journal.get(created.journalId!))?.status, 'restored');
    await assert.rejects(() => restoreEntry(context, created.journalId!), /already restored/);
    await assert.rejects(() => restoreEntry(context, restored.restoreJournalId!), /itself a restore/);
    await assert.rejects(() => restoreEntry(context, 'nope'), /not found/);
    await rebuild();

    const copied = await transfer(listed(ACCOUNT_A, 'R-restore'), account(ACCOUNT_B));
    assert.equal(copied.action, 'created');
    await appendRounds(t, 1, Date.UTC(2026, 8, 8));
    await rebuild();
    const beforeUpdate = listed(ACCOUNT_B, 'R-restore');
    const copySidecar = beforeUpdate.transcript!.sidecarDir!;
    const sidecarBefore = await readTree(copySidecar);
    // The source gained a tool result, which the update carries into the copy's
    // sidecar; after the restore the copy's sidecar must be exactly as before.
    await writeFile(path.join(t.sidecarDir, 'tool-results', 'result2.txt'), 'added later\n');
    const updated = await transfer(listed(ACCOUNT_A, 'R-restore'), account(ACCOUNT_B));
    assert.equal(updated.action, 'updated');
    assert.ok(await pathExists(path.join(copySidecar, 'tool-results', 'result2.txt')));
    const longChain = listed(ACCOUNT_B, 'R-restore').summary?.uuidChain.length ?? 0;
    await restoreEntry(context, updated.journalId!);
    await rebuild();
    assert.ok((listed(ACCOUNT_B, 'R-restore').summary?.uuidChain.length ?? 0) < longChain);
    assert.deepEqual(await readTree(copySidecar), sidecarBefore);
    assert.ok((await stat(t.path)).size > 0, 'the source transcript is never touched');
  });

  it('copies switch Remote Control off in the record and end the link in the transcript', async () => {
    const world = state.world;
    const rc = { remoteControlUserEnabled: true, remoteControlAutoEligible: true };
    const t = await writeTranscript(world, { prompts: 1, title: 'T-rc', bridgeOwner: ACCOUNT_A });
    await writeRecord(world, world.a, { cliSessionId: t.cliId, title: 'R-rc', bridgeSessionIds: ['session_rc'], ...rc });
    await rebuild();
    const sourceBytes = await readFile(t.path);
    const outcome = await transfer(listed(ACCOUNT_A, 'R-rc'), account(ACCOUNT_B));
    assert.equal(outcome.action, 'created');
    const newCli = outcome.newCliSessionId!;
    const record = await readJson<SessionRecord>(path.join(world.b.dir, `${outcome.newSessionId}.json`));
    assert.equal(record['remoteControlUserEnabled'], false);
    assert.equal(record['remoteControlUserToggled'], true);
    assert.ok(!('remoteControlAutoEligible' in record) && !('bridgeSessionIds' in record));
    const copyPath = path.join(t.projectDir, `${newCli}.jsonl`);
    const copied = await readFile(copyPath);
    assert.ok(copied.equals(Buffer.concat([replaceInBytes(sourceBytes, t.cliId, newCli), Buffer.from(`${bridgeTombstone(newCli)}\n`)])));
    assert.ok((await readFile(t.path)).equals(sourceBytes), 'the source transcript is untouched');

    // A copy made before 2026-09-28: Remote Control as the source had it, the link still live.
    const copy = listed(ACCOUNT_B, 'R-rc');
    const saved = await readJson<SessionRecord>(copy.record!.path);
    delete saved['remoteControlUserEnabled'];
    delete saved['remoteControlUserToggled'];
    await writeFile(copy.record!.path, JSON.stringify({ ...saved, ...rc }, null, 2));
    await writeFile(copyPath, replaceInBytes(sourceBytes, t.cliId, newCli));
    await rebuild();
    const repaired = await transfer(listed(ACCOUNT_A, 'R-rc'), account(ACCOUNT_B));
    assert.equal(repaired.action, 'repaired');
    assert.equal(repaired.reason, 'Remote Control switched off');
    assert.ok((await readFile(copyPath)).equals(copied), 'the repaired copy equals a fresh one');
    assert.equal((await readJson<SessionRecord>(copy.record!.path))['remoteControlUserToggled'], true);
    await rebuild();
    assert.equal((await transfer(listed(ACCOUNT_A, 'R-rc'), account(ACCOUNT_B))).action, 'up-to-date');
  });

  it('transferred transcripts do not lend their e-mail to the target account', async () => {
    // By now account B holds copies whose transcripts all carry EMAIL_A
    // session_context lines from before the transfer; none may count.
    assert.equal(account(ACCOUNT_B).email, null);
    const copy = listed(ACCOUNT_B, 'R1');
    assert.ok(copy.transcript);
    // Once the target account continues the copy, the CLI injects its own session_context line.
    const continued = buildTranscriptLines({ cliId: copy.transcript.cliSessionId, prompts: 0, email: EMAIL_B }).lines.filter((line) => line['type'] === 'attachment');
    await appendFile(copy.transcript.path, continued.map((line) => JSON.stringify(line)).join('\n') + '\n');
    await rebuild();
    assert.equal(account(ACCOUNT_B).email, EMAIL_B);
    assert.equal(account(ACCOUNT_A).email, EMAIL_A);
  });

  it('a copy carries the session-keyed directories (file-history, uploads) under the new id', async () => {
    // The CLI keeps checkpoint backups and Remote Control attachments under
    // ~/.claude/<dir>/<cliSessionId>/. A copy with a new id needs its own,
    // otherwise /rewind in the copy fails with "No files were restored" and
    // attachment paths rewritten to the new id lead nowhere.
    const world = state.world;
    const t = await writeTranscript(world, { prompts: 1, title: 'T-dirs' });
    await writeRecord(world, world.a, { cliSessionId: t.cliId, title: 'R-dirs' });
    await rebuild();
    const outcome = await transfer(listed(ACCOUNT_A, 'R-dirs'), account(ACCOUNT_B));
    assert.equal(outcome.action, 'created');
    const newCli = outcome.newCliSessionId!;
    for (const file of sessionKeyedFixtureFiles(t.cliId)) {
      const copied = path.join(world.paths.claudeDir, file.rel.split(t.cliId).join(newCli));
      assert.ok(await pathExists(copied), copied);
      assert.ok((await readFile(copied)).equals(file.bytes), copied);
      assert.ok((await readFile(path.join(world.paths.claudeDir, file.rel))).equals(file.bytes), 'the original is untouched');
    }
    const entry = await state.context.journal.get(outcome.journalId!);
    for (const dir of ['file-history', 'uploads']) {
      assert.ok(entry?.created.includes(path.join(world.paths.claudeDir, dir, newCli)), `${dir} announced in the journal`);
    }
    // Undoing the copy takes the directories away with it.
    await restoreEntry(state.context, outcome.journalId!);
    for (const dir of ['file-history', 'uploads']) {
      assert.equal(await pathExists(path.join(world.paths.claudeDir, dir, newCli)), false, dir);
      assert.ok(await pathExists(path.join(world.paths.claudeDir, dir, t.cliId)), `${dir} of the original stays`);
    }
    await rebuild();
  });
});

/** A journal that stops accepting updates after the first few, as the disk does for a process that lost power. */
class CuttingJournal extends Journal {
  private updates = 0;
  private readonly allowed: number;

  constructor(dataDir: string, allowed: number) {
    super(dataDir);
    this.allowed = allowed;
  }

  override async update(entry: JournalEntry): Promise<void> {
    this.updates += 1;
    if (this.updates > this.allowed) throw new Error('simulated power cut');
    await super.update(entry);
  }
}

describe('operations: SSH sessions', () => {
  const { state, rebuild, account, listed, transfer, recordsIn } = harness({ withLineage: true });
  let ssh: WrittenSshTranscript;

  /** Adds an SSH conversation with a record on account A and, unless told otherwise, its transcript on the host. */
  const addSshConversation = async (
    title: string,
    spec: Parameters<typeof writeSshTranscript>[1] = {},
    options: { onHost?: boolean; record?: Partial<SessionRecord> } = {},
  ): Promise<WrittenSshTranscript> => {
    const written = await writeSshTranscript(state.world, spec);
    await writeRecord(state.world, state.world.a, { cliSessionId: written.cliId, title, cwd: '/Users/build/alpha', ...sshRecordFields(written.cliId), ...options.record });
    if (options.onHost !== false) await writeHostTranscript(state.world, written);
    return written;
  };
  /** A transcript on the fake host, by CLI session id. */
  const onHost = (cli: string): string => path.join(hostProjectDir(state.world), `${cli}.jsonl`);
  /** A per-session directory (file-history, uploads) on the fake host, by CLI session id. */
  const onHostDir = (name: string, cli: string): string => path.join(hostHome(state.world), '.claude', name, cli);
  /** Undoes what copies got on 2026-09-28, making a copy look like one made before: no host transcript, Remote Control as the source had it. */
  const makeOldStyle = async (copy: Conversation, record: Partial<SessionRecord>): Promise<void> => {
    await rm(onHost(copy.cliSessionId!), { force: true });
    await rm(path.join(hostProjectDir(state.world), copy.cliSessionId!), { recursive: true, force: true });
    // Copies made before 2026-10-05 got no per-session directories on the host either.
    for (const name of ['file-history', 'uploads']) await rm(onHostDir(name, copy.cliSessionId!), { recursive: true, force: true });
    const saved = await readJson<SessionRecord>(copy.record!.path);
    delete saved['remoteControlUserEnabled'];
    delete saved['remoteControlUserToggled'];
    await writeFile(copy.record!.path, JSON.stringify({ ...saved, ...record }, null, 2));
  };

  before(async () => {
    state.world = await makeWorld();
    state.context = {
      paths: state.world.paths,
      journal: new Journal(state.world.paths.dataDir),
      lineage: await LineageStore.load(state.world.paths.dataDir),
      dryRun: false,
      host: localHostRunner(hostHome(state.world)),
    };
    ssh = await addSshConversation('S1', { prompts: 3, agents: 2, straddle64k: true });
    await rebuild();
  });
  after(async () => {
    await destroyWorld(state.world);
  });

  it('plans an SSH copy by looking at the host, read only', async () => {
    const hostBefore = await readTree(hostHome(state.world));
    const outcome = await transfer(listed(ACCOUNT_A, 'S1'), account(ACCOUNT_B), 'sync', true);
    assert.equal(outcome.action, 'created');
    assert.equal(outcome.host, `transcript also on ${SSH_HOST}`);
    assert.deepEqual(await readTree(hostHome(state.world)), hostBefore);
    assert.deepEqual(await recordsIn(state.world.b.dir), []);
  });

  it('copies an SSH session into a mirror of its own and a transcript on the host, byte for byte apart from the id', async () => {
    const source = listed(ACCOUNT_A, 'S1');
    assert.ok(source.transcript && isSshMirror(source.transcript));
    const sourceBefore = await readTree(ssh.mirrorDir);
    const outcome = await transfer(source, account(ACCOUNT_B));
    assert.equal(outcome.action, 'created');
    const newCli = outcome.newCliSessionId!;
    const mirror = sshMirrorDir(state.world.paths.projectsRoot, newCli);
    const copied = await readTree(mirror);
    assert.deepEqual([...copied.keys()].map((name) => name.split(newCli).join(ssh.cliId)).sort(), [...sourceBefore.keys()].sort());
    for (const [name, file] of copied) {
      const original = sourceBefore.get(name.split(newCli).join(ssh.cliId));
      assert.ok(original, name);
      assert.ok(file.bytes.includes(newCli) && !file.bytes.includes(ssh.cliId), name);
      assert.ok(replaceInBytes(file.bytes, newCli, ssh.cliId).equals(original.bytes), name);
      assert.equal(file.mode, original.mode, name);
    }
    assert.equal((await stat(mirror)).mode & 0o777, 0o700);
    assert.deepEqual(await readTree(ssh.mirrorDir), sourceBefore, 'the source mirror is untouched');

    // On the host the copy sits next to the original: the original's bytes with
    // the id rewritten, then a tombstone that ends the original's Remote Control link.
    const hostOriginal = await readFile(onHost(ssh.cliId));
    const hostCopied = await readFile(onHost(newCli));
    assert.ok(hostCopied.equals(Buffer.concat([replaceInBytes(hostOriginal, ssh.cliId, newCli), Buffer.from(`${bridgeTombstone(newCli)}\n`)])));
    assert.equal((await stat(onHost(newCli))).mode & 0o777, 0o600);
    // The app extends the mirror by byte offset, so the mirror must be a prefix of the host file.
    const mirrored = await readFile(path.join(mirror, `${newCli}.jsonl`));
    assert.ok(hostCopied.subarray(0, mirrored.length).equals(mirrored));
    // The side folder came along; JSON and JSONL files carry the new id, other files are copied as they are.
    const hostSide = await readTree(path.join(hostProjectDir(state.world), newCli));
    const originalSide = await readTree(path.join(hostProjectDir(state.world), ssh.cliId));
    assert.deepEqual([...hostSide.keys()].sort(), [...originalSide.keys()].sort());
    for (const [name, file] of hostSide) {
      const original = originalSide.get(name)!;
      if (/\.jsonl?$/.test(name)) assert.ok(replaceInBytes(original.bytes, ssh.cliId, newCli).equals(file.bytes), name);
      else assert.ok(original.bytes.equals(file.bytes), name);
    }
    assert.deepEqual(originalSide, await readTree(path.join(hostProjectDir(state.world), ssh.cliId)), 'the original on the host is untouched');

    const recordPath = path.join(state.world.b.dir, `${outcome.newSessionId}.json`);
    const record = await readJson<SessionRecord>(recordPath);
    for (const field of SOURCE_BOUND_FIELDS) assert.ok(!(field in record), field);
    assert.equal(record.cliSessionId, newCli);
    assert.deepEqual(record.sshConfig, { sshHost: SSH_HOST });
    assert.equal(record.title, 'S1');
    assert.equal(record['lastAssistantUuid'], sshRecordFields(ssh.cliId)['lastAssistantUuid']);
    assert.equal(record['remoteControlUserEnabled'], false);
    assert.equal(record['remoteControlUserToggled'], true);
    assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
    const entry = await state.context.journal.get(outcome.journalId!);
    assert.deepEqual(entry?.created, [mirror, recordPath]);
    // Announced in the order the host script puts them in place: per-session directories, side folder, transcript.
    assert.deepEqual(entry?.remote, {
      host: { host: SSH_HOST },
      created: [onHostDir('file-history', newCli), onHostDir('uploads', newCli), path.join(hostProjectDir(state.world), newCli), onHost(newCli)],
      moved: [],
      tombstoned: [],
    });
    assert.equal(listed(ACCOUNT_B, 'S1').transcript?.path, path.join(mirror, `${newCli}.jsonl`));
  });

  it('finds the copy again on the next run, also after the app dropped the stamp', async () => {
    assert.equal((await transfer(listed(ACCOUNT_A, 'S1'), account(ACCOUNT_B))).action, 'up-to-date');
    // The app rewrites records from a list of fields it knows, so the stamp goes; lineage.json still links the pair.
    const copy = listed(ACCOUNT_B, 'S1');
    const { ccas, ...saved } = await readJson<SessionRecord>(copy.record!.path);
    assert.ok(ccas);
    await writeFile(copy.record!.path, JSON.stringify(saved, null, 2));
    await rebuild();
    assert.equal((await transfer(listed(ACCOUNT_A, 'S1'), account(ACCOUNT_B))).action, 'up-to-date');
  });

  it('skipping an identical SSH pair never asks the host, while keeping it does', async () => {
    // Why the TUI's "Skip" answer exists for identical pairs (2026-10-07): the
    // sync policy plans the repair of an old copy, which probes the host, and
    // a sync of hundreds of SSH conversations paid that probe for every one of
    // them. With the host unreachable, sync fails at the probe; skip never gets
    // there and writes nothing.
    const offline = { ...state.context, host: unreachableHostRunner };
    const journalBefore = (await state.context.journal.list()).length;
    const skipped = await transfer(listed(ACCOUNT_A, 'S1'), account(ACCOUNT_B), 'skip', false, offline);
    assert.equal(skipped.action, 'skipped');
    assert.equal(skipped.reason, 'the target copy is identical; left as answered');
    assert.equal((await state.context.journal.list()).length, journalBefore);
    const kept = await transfer(listed(ACCOUNT_A, 'S1'), account(ACCOUNT_B), 'sync', false, offline);
    assert.equal(kept.action, 'failed');
    assert.match(kept.reason ?? '', /could not reach build@mini\.local over ssh/);
  });

  it('updates the copy after the source grew, and restore puts the old mirror and the old host copy back exactly', async () => {
    const copy = listed(ACCOUNT_B, 'S1');
    const cli = copy.cliSessionId!;
    const copyMirror = copy.transcript!.projectDir;
    const copyBefore = await readTree(copyMirror);
    const hostBefore = await readFile(onHost(cli));
    await appendRounds({ ...ssh, projectDir: ssh.mirrorDir, sidecarDir: '' }, 1);
    // The CLI wrote the new rounds on the host, and the app mirrored them.
    await copyFile(ssh.path, onHost(ssh.cliId));
    await rebuild();
    const outcome = await transfer(listed(ACCOUNT_A, 'S1'), account(ACCOUNT_B));
    assert.equal(outcome.action, 'updated');
    const after = listed(ACCOUNT_B, 'S1');
    assert.equal(after.record?.record.sessionId, copy.record?.record.sessionId);
    assert.equal(after.cliSessionId, copy.cliSessionId);
    assert.deepEqual(after.summary?.uuidChain, listed(ACCOUNT_A, 'S1').summary?.uuidChain);
    const entry = await state.context.journal.get(outcome.journalId!);
    assert.deepEqual(entry?.moved.map((move) => move.from), [copyMirror]);
    assert.deepEqual(entry?.created, [copyMirror]);
    assert.deepEqual(entry?.backedUp, [copy.record!.path]);
    // The host copy was made again from the grown original, the old one kept aside under the journal id.
    const sideDir = path.join(hostProjectDir(state.world), cli);
    assert.deepEqual(entry?.remote?.moved, [
      { from: onHost(cli), to: `${onHost(cli)}.ccas-backup-${outcome.journalId}` },
      { from: sideDir, to: `${sideDir}.ccas-backup-${outcome.journalId}` },
      { from: onHostDir('file-history', cli), to: `${onHostDir('file-history', cli)}.ccas-backup-${outcome.journalId}` },
      { from: onHostDir('uploads', cli), to: `${onHostDir('uploads', cli)}.ccas-backup-${outcome.journalId}` },
    ]);
    const grown = await readFile(onHost(cli));
    assert.ok(grown.length > hostBefore.length);
    const mirrored = await readFile(path.join(copyMirror, `${cli}.jsonl`));
    assert.ok(grown.subarray(0, mirrored.length).equals(mirrored));

    const restored = await restoreEntry(state.context, outcome.journalId!);
    assert.ok(restored.steps.some((step) => step === `moved ${onHost(cli)} back on ${SSH_HOST}`));
    assert.deepEqual(await readTree(copyMirror), copyBefore);
    assert.ok((await readFile(onHost(cli))).equals(hostBefore), 'the old host copy is back');
    assert.ok(await pathExists(`${onHost(cli)}.ccas-removed-${restored.restoreJournalId}`), 'the newer one is set aside, not deleted');
    await rebuild();
  });

  it('rolls an SSH copy back, on the host too, when Claude Code appears half-way', async () => {
    await addSshConversation('S2', { prompts: 1, agents: 1 });
    await rebuild();
    const projectsBefore = (await readdir(state.world.paths.projectsRoot)).sort();
    const recordsBefore = await recordsIn(state.world.b.dir);
    const hostBefore = (await readdir(hostProjectDir(state.world))).sort();
    let calls = 0;
    const flaky = { ...state.context, guard: async () => (++calls === 1 ? { allowed: true, reason: null } : { allowed: false, reason: 'Claude started' }) };
    const outcome = await transfer(listed(ACCOUNT_A, 'S2'), account(ACCOUNT_B), 'sync', false, flaky);
    assert.equal(outcome.action, 'refused');
    assert.deepEqual((await readdir(state.world.paths.projectsRoot)).sort(), projectsBefore);
    assert.deepEqual(await recordsIn(state.world.b.dir), recordsBefore);
    // The host copy was made before the guard closed; it is set aside again, nothing is deleted.
    const added = (await readdir(hostProjectDir(state.world))).filter((name) => !hostBefore.includes(name));
    assert.equal(added.length, 2, added.join(', '));
    assert.ok(added.every((name) => name.includes(`.ccas-removed-${outcome.journalId}`)), added.join(', '));
  });

  it('copies a fork and its parent as two conversations and pairs each with its own copy later', async () => {
    const parent = await addSshConversation('P', { prompts: 2, agents: 0 });
    // A fork starts with its parent's lines, uuids included, under its own id and
    // then goes its own way; everything the old keying by first uuid confused.
    const forkId = randomUUID();
    const forkDir = sshMirrorDir(state.world.paths.projectsRoot, forkId);
    await mkdir(forkDir, { mode: 0o700 });
    const shared = parent.lines.filter((line) => line['type'] !== 'bridge-session').map((line) => ({ ...line, sessionId: forkId }));
    const own = buildTranscriptLines({ cliId: forkId, prompts: 1, email: null, startAt: Date.UTC(2026, 8, 3) }).lines.filter((line) => line['type'] !== 'queue-operation');
    const forkText = [...shared, ...own].map((line) => `${JSON.stringify(line)}\n`).join('');
    await writeFile(path.join(forkDir, `${forkId}.jsonl`), forkText, { mode: 0o600 });
    await writeFile(onHost(forkId), forkText, { mode: 0o600 });
    await writeRecord(state.world, state.world.a, { cliSessionId: forkId, title: 'F', ...sshRecordFields(forkId) });
    await rebuild();
    assert.equal(listed(ACCOUNT_A, 'P').key, listed(ACCOUNT_A, 'F').key, 'parent and fork start alike');

    assert.equal((await transfer(listed(ACCOUNT_A, 'P'), account(ACCOUNT_B))).action, 'created');
    assert.equal((await transfer(listed(ACCOUNT_A, 'F'), account(ACCOUNT_B))).action, 'created');
    assert.deepEqual(listed(ACCOUNT_B, 'P').summary?.uuidChain, listed(ACCOUNT_A, 'P').summary?.uuidChain);
    assert.deepEqual(listed(ACCOUNT_B, 'F').summary?.uuidChain, listed(ACCOUNT_A, 'F').summary?.uuidChain);
    assert.equal((await transfer(listed(ACCOUNT_A, 'P'), account(ACCOUNT_B))).action, 'up-to-date');
    assert.equal((await transfer(listed(ACCOUNT_A, 'F'), account(ACCOUNT_B))).action, 'up-to-date');
  });

  it('skips a copy that was continued as a new session and leaves it alone', async () => {
    // Resuming a copy fails on the host, the app clears its cliSessionId, and the
    // next message starts a new session under a new id (the app also dropped the stamp).
    const copy = listed(ACCOUNT_B, 'P');
    const fresh = await writeSshTranscript(state.world, { prompts: 1, agents: 0 });
    const { ccas, ...saved } = await readJson<SessionRecord>(copy.record!.path);
    void ccas;
    await writeFile(copy.record!.path, JSON.stringify({ ...saved, cliSessionId: fresh.cliId }, null, 2));
    await rebuild();
    const freshBefore = await readTree(fresh.mirrorDir);
    // Under every policy, the TUI's "overwrite" included: a copy that holds another conversation is never touched.
    for (const policy of ['sync', 'overwrite-conflicts', 'skip', 'overwrite'] as const) {
      const outcome = await transfer(listed(ACCOUNT_A, 'P'), account(ACCOUNT_B), policy);
      assert.equal(outcome.action, 'skipped');
      assert.match(outcome.reason ?? '', /different conversation/);
    }
    assert.deepEqual(await readTree(fresh.mirrorDir), freshBefore);
  });

  it('copies a record without a transcript as a record alone, without the source-bound fields', async () => {
    const orphanCli = randomUUID();
    await writeRecord(state.world, state.world.a, { cliSessionId: orphanCli, title: 'S-orphan', ...sshRecordFields(orphanCli) });
    await rebuild();
    const outcome = await transfer(listed(ACCOUNT_A, 'S-orphan'), account(ACCOUNT_B));
    assert.equal(outcome.action, 'created');
    assert.ok(outcome.warnings.some((warning) => warning.includes('the copy is the record alone')), outcome.warnings.join('; '));
    const recordPath = path.join(state.world.b.dir, `${outcome.newSessionId}.json`);
    const record = await readJson<SessionRecord>(recordPath);
    assert.equal(record.cliSessionId, outcome.newCliSessionId);
    assert.notEqual(record.cliSessionId, orphanCli);
    for (const field of SOURCE_BOUND_FIELDS) assert.ok(!(field in record), field);
    assert.deepEqual((await state.context.journal.get(outcome.journalId!))?.created, [recordPath]);
    assert.equal((await transfer(listed(ACCOUNT_A, 'S-orphan'), account(ACCOUNT_B))).action, 'up-to-date');
  });

  it('repairs a copy made before copies got their host transcript and Remote Control off', async () => {
    const inherited = { remoteControlUserEnabled: true, remoteControlAutoEligible: true };
    await addSshConversation('S4', { prompts: 1, agents: 1 }, { record: inherited });
    await rebuild();
    assert.equal((await transfer(listed(ACCOUNT_A, 'S4'), account(ACCOUNT_B))).action, 'created');
    const copy = listed(ACCOUNT_B, 'S4');
    await makeOldStyle(copy, inherited);
    await rebuild();

    const dry = await transfer(listed(ACCOUNT_A, 'S4'), account(ACCOUNT_B), 'sync', true);
    assert.equal(dry.action, 'repaired');
    assert.equal(await pathExists(onHost(copy.cliSessionId!)), false, 'a dry run changes nothing');
    const outcome = await transfer(listed(ACCOUNT_A, 'S4'), account(ACCOUNT_B));
    assert.equal(outcome.action, 'repaired');
    assert.equal(outcome.reason, `Remote Control switched off; transcript created on ${SSH_HOST}`);
    const hostCopied = await readFile(onHost(copy.cliSessionId!));
    assert.ok(hostCopied.toString('utf8').endsWith(`${bridgeTombstone(copy.cliSessionId!)}\n`));
    const mirrored = await readFile(copy.transcript!.path);
    assert.ok(hostCopied.subarray(0, mirrored.length).equals(mirrored), 'the old mirror is a prefix of the new host copy');
    const record = await readJson<SessionRecord>(copy.record!.path);
    assert.equal(record['remoteControlUserEnabled'], false);
    assert.equal(record['remoteControlUserToggled'], true);
    assert.ok(!('remoteControlAutoEligible' in record));
    const entry = await state.context.journal.get(outcome.journalId!);
    assert.equal(entry?.action, 'repaired');
    assert.deepEqual(entry?.backedUp, [copy.record!.path]);
    await rebuild();
    assert.equal((await transfer(listed(ACCOUNT_A, 'S4'), account(ACCOUNT_B))).action, 'up-to-date');

    // Undoing the repair takes the host copy away again and brings the old record back.
    await restoreEntry(state.context, outcome.journalId!);
    assert.equal(await pathExists(onHost(copy.cliSessionId!)), false);
    assert.equal((await readJson<SessionRecord>(copy.record!.path))['remoteControlUserEnabled'], true);
    await rebuild();
  });

  it('gives a copy whose record lost its CLI session id that id back, with a transcript on the host', async () => {
    // What the app does when resuming a copy fails on the host: it drops the
    // CLI session id from the record. No new session was started in it yet.
    await addSshConversation('S5', { prompts: 1, agents: 1 });
    await rebuild();
    assert.equal((await transfer(listed(ACCOUNT_A, 'S5'), account(ACCOUNT_B))).action, 'created');
    const copy = listed(ACCOUNT_B, 'S5');
    const lostCli = copy.cliSessionId!;
    await makeOldStyle(copy, {});
    const saved = await readJson<SessionRecord>(copy.record!.path);
    delete saved.cliSessionId;
    await writeFile(copy.record!.path, JSON.stringify(saved, null, 2));
    await rebuild();
    assert.equal(assessSync(listed(ACCOUNT_A, 'S5'), conversationsOf(state.inventory, account(ACCOUNT_B))).state, 'update-available');

    const outcome = await transfer(listed(ACCOUNT_A, 'S5'), account(ACCOUNT_B));
    assert.equal(outcome.action, 'updated');
    const record = await readJson<SessionRecord>(copy.record!.path);
    assert.equal(record.cliSessionId, lostCli);
    assert.ok(await pathExists(onHost(lostCli)));
    assert.equal(listed(ACCOUNT_B, 'S5').transcript?.path, path.join(sshMirrorDir(state.world.paths.projectsRoot, lostCli), `${lostCli}.jsonl`));
    const entry = await state.context.journal.get(outcome.journalId!);
    assert.deepEqual(entry?.moved.map((move) => move.from), [sshMirrorDir(state.world.paths.projectsRoot, lostCli)], 'the old mirror went into the backup');
    assert.equal((await transfer(listed(ACCOUNT_A, 'S5'), account(ACCOUNT_B))).action, 'up-to-date');
  });

  it('leaves Remote Control alone when it was switched on for the copy on the target account', async () => {
    await addSshConversation('S6', { prompts: 1, agents: 0 });
    await rebuild();
    assert.equal((await transfer(listed(ACCOUNT_A, 'S6'), account(ACCOUNT_B))).action, 'created');
    const copy = listed(ACCOUNT_B, 'S6');
    // The person switched Remote Control on for the copy: a new claude.ai session of account B.
    const saved = await readJson<SessionRecord>(copy.record!.path);
    await writeFile(copy.record!.path, JSON.stringify({ ...saved, remoteControlUserEnabled: true, remoteControlUserToggled: true }, null, 2));
    await appendFile(onHost(copy.cliSessionId!), `${JSON.stringify({ type: 'bridge-session', sessionId: copy.cliSessionId, bridgeSessionId: 'cse_of_account_b', lastSequenceNum: 4 })}\n`);
    await rebuild();
    const hostBefore = await readFile(onHost(copy.cliSessionId!));
    const outcome = await transfer(listed(ACCOUNT_A, 'S6'), account(ACCOUNT_B));
    assert.equal(outcome.action, 'up-to-date');
    assert.ok((await readFile(onHost(copy.cliSessionId!))).equals(hostBefore));
    assert.equal((await readJson<SessionRecord>(copy.record!.path))['remoteControlUserEnabled'], true);
  });

  it('does not copy an SSH conversation when the host cannot be reached, and writes nothing', async () => {
    await addSshConversation('S7', { prompts: 1, agents: 0 });
    await rebuild();
    const projectsBefore = (await readdir(state.world.paths.projectsRoot)).sort();
    const recordsBefore = await recordsIn(state.world.b.dir);
    const journalBefore = (await state.context.journal.list()).length;
    const offline = { ...state.context, host: unreachableHostRunner };
    const outcome = await transfer(listed(ACCOUNT_A, 'S7'), account(ACCOUNT_B), 'sync', false, offline);
    assert.equal(outcome.action, 'failed');
    assert.match(outcome.reason ?? '', /could not reach build@mini\.local over ssh .*Connection refused.*ssh build@mini\.local true/);
    assert.deepEqual((await readdir(state.world.paths.projectsRoot)).sort(), projectsBefore);
    assert.deepEqual(await recordsIn(state.world.b.dir), recordsBefore);
    assert.equal((await state.context.journal.list()).length, journalBefore);
  });

  it('does not copy an SSH conversation whose original is not on the host', async () => {
    await addSshConversation('S8', { prompts: 1, agents: 0 }, { onHost: false });
    await rebuild();
    const outcome = await transfer(listed(ACCOUNT_A, 'S8'), account(ACCOUNT_B));
    assert.equal(outcome.action, 'failed');
    assert.match(outcome.reason ?? '', /has no transcript .*\.jsonl, so a copy could not be resumed there/);
    assert.ok(!state.inventory.byAccount.get(accountKey(ACCOUNT_B.accountId, ACCOUNT_B.orgId))?.some((conversation) => conversation.title === 'S8'));
  });

  it('leaves a journal entry an interrupted copy can be undone from', async () => {
    await addSshConversation('S3', { prompts: 1, agents: 1 });
    await rebuild();
    const projectsBefore = (await readdir(state.world.paths.projectsRoot)).sort();
    const recordsBefore = await recordsIn(state.world.b.dir);
    // After the first recorded step the journal takes no more writes: from then on
    // the process is as good as gone, like after a power cut.
    const cut = { ...state.context, journal: new CuttingJournal(state.world.paths.dataDir, 1) };
    const source = listed(ACCOUNT_A, 'S3');
    await assert.rejects(
      () => executeTransfer(cut, { source, target: account(ACCOUNT_B), assessment: assessSync(source, conversationsOf(state.inventory, account(ACCOUNT_B))), onExisting: 'sync' }),
      /simulated power cut/,
    );
    const [entry] = await state.context.journal.interrupted();
    assert.ok(entry);
    assert.equal(entry.created.length, 1, 'the mirror was announced before it was written');
    const mirror = entry.created[0]!;
    assert.ok(await pathExists(mirror));
    // A temp file of a write cut short, as a dying process leaves one behind.
    await writeFile(`${mirror}.4242.1700000000000.tmp`, 'partial');
    const restored = await restoreEntry(state.context, entry.id);
    assert.ok(restored.steps.some((step) => step.startsWith('set aside')));
    assert.deepEqual((await readdir(state.world.paths.projectsRoot)).sort(), projectsBefore);
    assert.deepEqual(await recordsIn(state.world.b.dir), recordsBefore);
    assert.equal((await state.context.journal.get(entry.id))?.status, 'restored');
    assert.deepEqual(await state.context.journal.interrupted(), []);
  });

  it('an SSH copy gets the session-keyed directories on the host, next to its transcript', async () => {
    // The CLI that edits files and receives attachments runs on the host, so
    // that is where file-history/<id> and uploads/<id> live for an SSH
    // conversation; the copy needs them there under its own id.
    const written = await addSshConversation('S-dirs', { prompts: 1 });
    await rebuild();
    const outcome = await transfer(listed(ACCOUNT_A, 'S-dirs'), account(ACCOUNT_B));
    assert.equal(outcome.action, 'created');
    const newCli = outcome.newCliSessionId!;
    const hostClaude = path.join(hostHome(state.world), '.claude');
    for (const file of sessionKeyedFixtureFiles(written.cliId)) {
      const copied = path.join(hostClaude, file.rel.split(written.cliId).join(newCli));
      assert.ok(await pathExists(copied), copied);
      assert.ok((await readFile(copied)).equals(file.bytes), copied);
      assert.ok((await readFile(path.join(hostClaude, file.rel))).equals(file.bytes), 'the original on the host is untouched');
    }
    const entry = await state.context.journal.get(outcome.journalId!);
    for (const dir of ['file-history', 'uploads']) {
      assert.ok(entry?.remote?.created.includes(path.join(hostClaude, dir, newCli)), `${dir} announced in the journal before the host script ran`);
    }
    const restored = await restoreEntry(state.context, outcome.journalId!);
    for (const dir of ['file-history', 'uploads']) {
      assert.ok(restored.steps.some((step) => step.includes(path.join(hostClaude, dir, newCli))), `${dir} set aside on the host`);
      assert.equal(await pathExists(path.join(hostClaude, dir, newCli)), false, dir);
      assert.ok(await pathExists(path.join(hostClaude, dir, written.cliId)), `${dir} of the original stays`);
    }
    await rebuild();
  });
});
