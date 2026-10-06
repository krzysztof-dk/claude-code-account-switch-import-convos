import assert from 'node:assert/strict';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { destroyWorld, makeWorld, writeRecord as writeFixtureRecord, type World } from '../test/fixtures.ts';
import {
  KNOWN_RECORD_FIELDS,
  REMOTE_CONTROL_FIELDS,
  SOURCE_BOUND_FIELDS,
  effectiveCliSessionId,
  hasRemoteControlOff,
  inheritsRemoteControl,
  isRecordFileName,
  isUuid,
  newLocalSessionId,
  parseRecord,
  readRecords,
  transcriptRefs,
  unknownFields,
  withRemoteControlOff,
  withoutSourceBoundFields,
  writeRecord,
  type SessionRecord,
} from './records.ts';

/**
 * The top-level keys of the record serializer in Claude.app 2.19675.0, read
 * from app.asar on 2026-10-05 (the object literal that starts with
 * sessionId and cliSessionId; 161 keys). When a newer app version adds a
 * field, add it here and sort it into SOURCE_BOUND_FIELDS or
 * KNOWN_RECORD_FIELDS; the test below names what is missing.
 */
const SERIALIZER_FIELDS_2_19675 = `
  sessionId cliSessionId cwd originCwd worktreePath worktreeName worktreeLazy worktreePinned gitAnchors
  gitAnchorsLookupOnly gitAnchorsFolderRealpath lastFocusedAt sourceBranch branch pendingSystemReminder
  pendingFirstStart createdAt lastActivityAt model effort effortInherited sessionSettings agent isArchived
  title titleSource previousTitles permissionMode enabledMcpTools remoteMcpServersConfig withheldConnectorHosts
  sshConfig wslConfig sshRemoteProcessId sshReattach sshRemoteTranscriptPath sessionPermissionUpdates
  alwaysAllowedReasons prs writtenBranches autoArchiveExempt autoArchiveOnPrClose isStarred movedToCloud
  keptDirtyWorktree keptDirtyAt keptWorktreeLeftover seenCommentIds autoFixDelivered chromePermissionMode
  chromeAllowedDomains chromeTabGroupId cuAllowedApps cuGrantFlags cuFlagsGrantedAt cuLastScreenshotDims
  cuSelectedDisplayId recap recapAt scheduledTaskId spaceId contextExceededCount completedTurns titleTurn
  titleCheck titleOffers titleSuggestionsOff transcriptUnavailable subagentsTruncatedFor error errorCategory
  tccFolderKind errorAt postTurnSummary postTurnSummaryFor lastAssistantUuid turnWrapUp priorErrorMark
  interruptedByQuitAt interruptedUnseenResume sshProcessLossStoodDownAt sshKillRecoveryGrantedAt
  sshForeignDaemonLossAt lastSpawnRootDetected bypassChosenInApp autoChosenInApp _startedThroughHostCliLauncher
  launcherAtSpawn ranInSandboxVm armedWorkAtQuit queryCrashes publishedArtifacts scratchPromptRecents
  scratchOfferFolder scratchFilesLeftIn scratchCarried dispatchParentId dispatchParentOrigin forkedFromSessionId
  forkedAtMessageUuid lineageDetached titleFromPr priorCliSessionIds rewindEdges transcriptModelStates
  transcriptCuts importedFrom indexedAt resumeConfirmed stagedTranscriptPath spawnedFrom spawnedFromEndNotified
  lastTurnReport sideSessionReportOwed sideSessionNotes queuedSideSessionNotes backgroundTaskSuggestions
  peerReceipts peerInbound resolvedBackgroundTaskSuggestions cloudSpawnedTasks emailAddress envScopeId
  startedFromEnvironmentId bridgeSessionIds cloudSessionId remoteControlSpawn remoteControlDescendant
  remoteControlAutoEligible remoteControlUserEnabled scheduledRunContinued steeredByRemoteClient
  sideSessionStartsSinceUserMessage latestUserFrameAt color classifierSummaryEnabled reportFindingsCard
  turnBoxDeclared sideSessionOffersMuted setupTools midTaskReplyTool conversationPluginLoaded asides
  turnBoxMounted violinBowPrompts violinBowPromptKinds lanyardOfferPrompt autoModeServerFallbackPrompt violinBow
  violinBowHomeSettings spawnSeed cliBinaryPin promptAppendSnapshot toolSurfaceSnapshot adoptedFromOtherSurface
  surfaceNoticeUuid autoFixNoticeSent devIntents devIntentTriggers cliMcpAppServerNames terminalClaudeTabOrdinal
`
  .split(/\s+/)
  .filter((field) => field.length > 0);

describe('records', () => {
  let world: World;
  before(async () => {
    world = await makeWorld();
  });
  after(async () => {
    await destroyWorld(world);
  });

  it('accepts exactly what the desktop app accepts', () => {
    assert.ok(parseRecord('{"sessionId":"local_x","createdAt":1,"lastActivityAt":2}'));
    assert.equal(parseRecord('{"sessionId":"local_x","createdAt":"1","lastActivityAt":2}'), undefined);
    assert.equal(parseRecord('{"createdAt":1,"lastActivityAt":2}'), undefined);
    assert.equal(parseRecord('not json'), undefined);
    assert.equal(parseRecord('[]'), undefined);
  });

  it('keeps unknown fields of older records verbatim', () => {
    const july = parseRecord('{"sessionId":"local_j","createdAt":1,"lastActivityAt":2,"spawnSeed":"abc","effort":"high","classifierSummaryEnabled":true}');
    assert.ok(july);
    assert.equal(july['spawnSeed'], 'abc');
    assert.equal(july['effort'], 'high');
  });

  it('recognises record file names and uuids', () => {
    assert.ok(isRecordFileName('local_1da5f251-7526-4b25-8719-15699cea3759.json'));
    assert.ok(!isRecordFileName('scheduled-tasks.json'));
    assert.ok(!isRecordFileName('local_x.json.tmp'));
    assert.ok(isUuid('1da5f251-7526-4b25-8719-15699cea3759'));
    assert.ok(!isUuid('local_1da5f251-7526-4b25-8719-15699cea3759'));
    assert.ok(newLocalSessionId().startsWith('local_'));
  });

  it('lists every transcript a record points at, current first, without duplicates', () => {
    const record = parseRecord(
      JSON.stringify({
        sessionId: 'local_a',
        createdAt: 1,
        lastActivityAt: 2,
        cliSessionId: '11111111-1111-4111-8111-111111111111',
        unarchivedCliSessionId: '22222222-2222-4222-8222-222222222222',
        preClearCliSessionId: '11111111-1111-4111-8111-111111111111',
        priorCliSessionIds: ['33333333-3333-4333-8333-333333333333', 'not-a-uuid'],
      }),
    );
    assert.ok(record);
    assert.deepEqual(transcriptRefs(record), [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ]);
    assert.equal(effectiveCliSessionId(record), '11111111-1111-4111-8111-111111111111');
  });

  it('drops the fields that tie a record to its source, and only those, without touching the input', () => {
    const bound = Object.fromEntries(SOURCE_BOUND_FIELDS.map((field) => [field, `value of ${field}`]));
    const record = parseRecord(
      JSON.stringify({
        sessionId: 'local_a',
        createdAt: 1,
        lastActivityAt: 2,
        cliSessionId: '11111111-1111-4111-8111-111111111111',
        title: 'kept',
        isArchived: true,
        sshConfig: { sshHost: 'build@mini.local' },
        lastAssistantUuid: '5c1e7a2b-0d4f-4e8a-9b3c-6f2d8e1a7b40',
        spawnedFrom: 'local_parent',
        postTurnSummaryFor: 'turn-7',
        remoteMcpServersConfig: { servers: [] },
        ...bound,
      }),
    );
    assert.ok(record);
    const before = structuredClone(record);
    const stripped = withoutSourceBoundFields(record);
    for (const field of SOURCE_BOUND_FIELDS) assert.ok(!(field in stripped), field);
    assert.deepEqual(stripped, {
      sessionId: 'local_a',
      createdAt: 1,
      lastActivityAt: 2,
      cliSessionId: '11111111-1111-4111-8111-111111111111',
      title: 'kept',
      isArchived: true,
      sshConfig: { sshHost: 'build@mini.local' },
      lastAssistantUuid: '5c1e7a2b-0d4f-4e8a-9b3c-6f2d8e1a7b40',
      spawnedFrom: 'local_parent',
      postTurnSummaryFor: 'turn-7',
      remoteMcpServersConfig: { servers: [] },
    });
    assert.deepEqual(record, before);
  });

  it('drops the byte-sync cache the app keeps for the source mirror', () => {
    // The app clears these four itself whenever a record's CLI session id changes.
    for (const field of ['sshRemoteTranscriptPath', 'sshRemoteProjectDir', 'sshLocalTranscriptSize', 'sshSubagentSyncedSizes']) {
      assert.ok((SOURCE_BOUND_FIELDS as readonly string[]).includes(field), field);
    }
  });

  it('drops the identity and lineage fields the app 2.19675.0 serializer writes', () => {
    // Read from the record serializer of Claude.app 2.19675.0 (2026-10-05):
    // these name the source account (its e-mail), things that live under it
    // on claude.ai (published artifacts, cloud tasks, environments, spaces),
    // sessions it talked to (peers, the dispatch parent) and records it was
    // forked or imported from. None of it describes the copy.
    const identity = {
      emailAddress: 'alpha@example.com',
      publishedArtifacts: [{ id: 'art_1' }],
      peerInbound: [{ uuid: 'p1', from: 'local_other' }],
      peerReceipts: [{ uuid: 'p1' }],
      dispatchParentId: 'local_parent',
      dispatchParentOrigin: 'code',
      forkedFromSessionId: 'local_parent',
      forkedAtMessageUuid: '5c1e7a2b-0d4f-4e8a-9b3c-6f2d8e1a7b40',
      lineageDetached: true,
      stagedTranscriptPath: '/tmp/staging/.import-1.tmp',
      envScopeId: 'env_1',
      startedFromEnvironmentId: 'env_1',
      spaceId: 'space_1',
      scheduledTaskId: 'task_1',
      scheduledRunContinued: true,
      cloudSpawnedTasks: [{ id: 'cloud_1' }],
      importedFrom: { kind: 'previous-profile' },
      indexedAt: 3,
      resumeConfirmed: true,
    };
    const record = parseRecord(JSON.stringify({ sessionId: 'local_a', createdAt: 1, lastActivityAt: 2, title: 'kept', effort: 'high', ...identity }));
    assert.ok(record);
    const stripped = withoutSourceBoundFields(record);
    for (const field of Object.keys(identity)) assert.ok(!(field in stripped), `${field} must not reach the copy`);
    assert.equal(stripped.title, 'kept');
    assert.equal(stripped['effort'], 'high');
  });

  it('classifies every record field the app 2.19675.0 serializer writes', () => {
    assert.equal(SERIALIZER_FIELDS_2_19675.length, 161);
    const classified = new Set<string>([...SOURCE_BOUND_FIELDS, ...REMOTE_CONTROL_FIELDS, ...KNOWN_RECORD_FIELDS]);
    assert.deepEqual(
      SERIALIZER_FIELDS_2_19675.filter((field) => !classified.has(field)),
      [],
      'fields the 2.19675.0 serializer writes that no list in records.ts classifies',
    );
    // A field is either dropped from a copy or kept, never both: the kept list
    // shares nothing with the two dropped ones (which overlap on purpose, the
    // claude.ai session fields being both source-bound and Remote Control).
    const dropped = new Set<string>([...SOURCE_BOUND_FIELDS, ...REMOTE_CONTROL_FIELDS]);
    assert.deepEqual(
      KNOWN_RECORD_FIELDS.filter((field) => dropped.has(field)),
      [],
      'fields listed as kept and as dropped',
    );
  });

  it('names the fields of a record that no list knows', () => {
    const record = parseRecord(
      JSON.stringify({
        sessionId: 'local_a',
        createdAt: 1,
        lastActivityAt: 2,
        title: 't',
        emailAddress: 'alpha@example.com',
        ccas: { copiedFrom: { cliSessionId: 'x' }, rootUuid: null, sourceLineCount: 0, at: 0 },
        brandNewField: 1,
        anotherOne: 'x',
      }),
    );
    assert.ok(record);
    assert.deepEqual(unknownFields(record), ['anotherOne', 'brandNewField']);
    assert.deepEqual(unknownFields({ sessionId: 'local_b', createdAt: 1, lastActivityAt: 2 }), []);
  });

  it('switches Remote Control off the way the app records a conversation started without it', () => {
    const rc = Object.fromEntries(REMOTE_CONTROL_FIELDS.map((field) => [field, `value of ${field}`]));
    const record: SessionRecord = { sessionId: 'local_a', createdAt: 1, lastActivityAt: 2, title: 'kept', remoteControlUserEnabled: true, ...rc };
    const before = structuredClone(record);
    const off = withRemoteControlOff(record);
    assert.deepEqual(off, { sessionId: 'local_a', createdAt: 1, lastActivityAt: 2, title: 'kept', remoteControlUserEnabled: false, remoteControlUserToggled: true });
    assert.deepEqual(record, before, 'the input is left as it is');
    assert.ok(hasRemoteControlOff(off));
    assert.equal(hasRemoteControlOff(record), false);
    assert.equal(hasRemoteControlOff({ ...off, remoteControlAutoEligible: false }), false, 'any other Remote Control field counts');
  });

  it('tells a copy that still has its source Remote Control state from one changed on the target', () => {
    const source: SessionRecord = { sessionId: 'local_s', createdAt: 1, lastActivityAt: 2, remoteControlUserEnabled: true, bridgeSessionIds: ['cse_1'] };
    // A copy made before 2026-09-28: the source-bound bridgeSessionIds dropped, the rest kept.
    const oldCopy: SessionRecord = { sessionId: 'local_c', createdAt: 1, lastActivityAt: 3, remoteControlUserEnabled: true };
    assert.ok(inheritsRemoteControl(oldCopy, source));
    assert.equal(inheritsRemoteControl({ ...oldCopy, remoteControlUserToggled: true }, source), false);
    assert.equal(inheritsRemoteControl(withRemoteControlOff(oldCopy), source), false);
    // A copy of a transcript without a record came with no Remote Control fields.
    assert.ok(inheritsRemoteControl({ sessionId: 'local_i', createdAt: 1, lastActivityAt: 2 }, null));
    assert.equal(inheritsRemoteControl(oldCopy, null), false);
  });

  it('falls back to unarchivedCliSessionId when cliSessionId is unset', () => {
    const record = parseRecord('{"sessionId":"local_a","createdAt":1,"lastActivityAt":2,"unarchivedCliSessionId":"22222222-2222-4222-8222-222222222222"}');
    assert.ok(record);
    assert.equal(effectiveCliSessionId(record), '22222222-2222-4222-8222-222222222222');
  });

  it('reads a directory, reporting files the app would skip', async () => {
    await writeFixtureRecord(world, world.a, { cliSessionId: '11111111-1111-4111-8111-111111111111', title: 'one' });
    await writeFile(path.join(world.a.dir, 'local_broken.json'), '{"nope":true}');
    await writeFile(path.join(world.a.dir, 'scheduled-tasks.json'), '{"scheduledTasks":[]}');
    const { records, problems } = await readRecords(world.a.dir);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.record.title, 'one');
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /local_broken\.json/);
    const missing = await readRecords(path.join(world.root, 'does-not-exist'));
    assert.deepEqual(missing, { records: [], problems: [] });
  });

  it('writes records atomically, private like the app does, without leaving temp files behind', async () => {
    const target = path.join(world.b.dir, 'local_written.json');
    await writeRecord(target, { sessionId: 'local_written', createdAt: 1, lastActivityAt: 2, title: 'w' });
    const names = await readdir(world.b.dir);
    assert.deepEqual(names, ['local_written.json']);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    const { records } = await readRecords(world.b.dir);
    assert.equal(records[0]?.record.title, 'w');
  });
});
