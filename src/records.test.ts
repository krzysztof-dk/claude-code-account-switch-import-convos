import assert from 'node:assert/strict';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { destroyWorld, makeWorld, writeRecord as writeFixtureRecord, type World } from '../test/fixtures.ts';
import {
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
  withRemoteControlOff,
  withoutSourceBoundFields,
  writeRecord,
  type SessionRecord,
} from './records.ts';

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
