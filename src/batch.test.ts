import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { ACCOUNT_A, ACCOUNT_B, EMAIL_A, destroyWorld, makeWorld, writeRecord, writeTranscript, type World } from '../test/fixtures.ts';
import { AccountStore, accountKey, type AccountInfo } from './accounts.ts';
import { describeBatchUndo, describeUndoOf, journalIdsOf, undoBatch } from './batch.ts';
import { assessSync, buildInventory, conversationsOf, type Conversation, type Inventory } from './inventory.ts';
import { Journal, type JournalEntry } from './journal.ts';
import { LineageStore } from './lineage.ts';
import { executeTransfer, type OperationContext, type TransferOutcome } from './operations.ts';

/** A journal entry with the fields describeUndoOf reads. */
function entry(overrides: Partial<JournalEntry>): JournalEntry {
  return {
    id: '20261006T100000Z-aaaaaa',
    at: '2026-10-06T10:00:00.000Z',
    mode: 'copy',
    action: 'created',
    status: 'done',
    title: 'a title',
    rootUuid: null,
    source: {},
    target: {},
    relation: 'new',
    backupDir: null,
    backedUp: [],
    created: ['/x/a', '/x/b'],
    moved: [{ from: '/x/c', to: '/y/c' }],
    warnings: [],
    ...overrides,
  };
}

/** An outcome with only the journal id set, which is all journalIdsOf reads. */
function outcomeWith(journalId: string | null): TransferOutcome {
  return { journalId } as unknown as TransferOutcome;
}

describe('batch: the ids and the lines of an undo', () => {
  it('journalIdsOf keeps the outcomes that opened an entry, newest first', () => {
    assert.deepEqual(journalIdsOf([outcomeWith('one'), outcomeWith(null), outcomeWith('two'), outcomeWith('three')]), ['three', 'two', 'one']);
    assert.deepEqual(journalIdsOf([outcomeWith(null)]), []);
    assert.deepEqual(journalIdsOf([]), []);
  });

  it('describeUndoOf names the action, the title, the id and the counts, and the status when not done', () => {
    assert.equal(describeUndoOf(entry({}), 'ignored'), 'created "a title" [20261006T100000Z-aaaaaa]: 2 created, 1 moved, 0 backed up');
    assert.equal(
      describeUndoOf(entry({ action: 'updated', status: 'failed', created: [], moved: [], backedUp: ['/x/r'] }), 'ignored'),
      'updated "a title" [20261006T100000Z-aaaaaa] (failed): 0 created, 0 moved, 1 backed up',
    );
    assert.equal(describeUndoOf(undefined, 'gone'), 'gone: not in the journal');
    assert.ok(describeUndoOf(entry({ title: 'x'.repeat(80) }), 'ignored').includes(`"${'x'.repeat(47)}..."`), 'the title is cut at 50');
  });
});

describe('batch: undoing a run', () => {
  let world: World;
  let context: OperationContext;
  let inventory: Inventory;
  const rebuild = async (): Promise<void> => {
    inventory = await buildInventory(world.paths, { store: await AccountStore.load(world.paths.dataDir), lineage: context.lineage });
  };
  const account = (which: typeof ACCOUNT_A): AccountInfo => {
    const found = inventory.accounts.find((candidate) => candidate.accountId === which.accountId);
    assert.ok(found);
    return found;
  };
  const onA = (title: string): Conversation => {
    const found = inventory.byAccount.get(accountKey(ACCOUNT_A.accountId, ACCOUNT_A.orgId))?.find((conversation) => conversation.title === title);
    assert.ok(found, title);
    return found;
  };
  const copy = async (title: string, override: Partial<OperationContext> = {}): Promise<TransferOutcome> => {
    const source = onA(title);
    const target = account(ACCOUNT_B);
    const outcome = await executeTransfer({ ...context, ...override }, { source, target, mode: 'copy', assessment: assessSync(source, conversationsOf(inventory, target)), onConflict: 'skip' });
    await rebuild();
    return outcome;
  };
  const recordsOnB = async (): Promise<string[]> => (await readdir(world.b.dir)).filter((name) => name.startsWith('local_'));

  before(async () => {
    world = await makeWorld();
    context = { paths: world.paths, journal: new Journal(world.paths.dataDir), lineage: await LineageStore.load(world.paths.dataDir), dryRun: false };
    for (const title of ['one', 'two', 'three']) {
      const t = await writeTranscript(world, { prompts: 1, email: EMAIL_A, title });
      await writeRecord(world, world.a, { cliSessionId: t.cliId, title });
    }
    await rebuild();
  });
  after(async () => {
    await destroyWorld(world);
  });

  it('describes and undoes the operations of a run newest first, each undo a restore entry of its own', async () => {
    const first = await copy('one');
    const second = await copy('two');
    const skipped = await copy('one');
    assert.equal(skipped.action, 'up-to-date');
    assert.equal(skipped.journalId, null, 'an up-to-date outcome opens no entry');
    const outcomes = [first, second, skipped];
    assert.equal((await recordsOnB()).length, 2);

    const lines = await describeBatchUndo(context.journal, outcomes);
    assert.deepEqual(
      lines.map((line) => line.split(' [')[0]),
      ['created "two"', 'created "one"'],
    );
    // A copy creates the transcript, its sidecar, two per-session directories and the record.
    assert.match(lines[0] ?? '', /\]: 5 created, 0 moved, 0 backed up$/);

    const result = await undoBatch(context, journalIdsOf(outcomes));
    assert.equal(result.refused, null);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.notTried, []);
    assert.deepEqual(
      result.undone.map((restore) => restore.entry.id),
      [second.journalId, first.journalId],
    );
    assert.deepEqual(await recordsOnB(), []);
    const journal = await context.journal.list();
    assert.equal(journal.filter((candidate) => candidate.status === 'restored').length, 2);
    assert.equal(journal.filter((candidate) => candidate.mode === 'restore' && candidate.status === 'done').length, 2);
    await rebuild();
  });

  it('reports an entry that cannot be undone and still undoes the others', async () => {
    const copied = await copy('three');
    const alreadyRestored = (await context.journal.list()).find((candidate) => candidate.status === 'restored');
    assert.ok(alreadyRestored);
    const result = await undoBatch(context, [alreadyRestored.id, copied.journalId!]);
    assert.deepEqual(result.failed.map((failure) => failure.id), [alreadyRestored.id]);
    assert.match(result.failed[0]?.error ?? '', /already restored/);
    assert.deepEqual(result.undone.map((restore) => restore.entry.id), [copied.journalId]);
    assert.deepEqual(await recordsOnB(), []);
    await rebuild();
  });

  it('stops at the guard closing and names the entries it did not try', async () => {
    const first = await copy('one');
    const second = await copy('two');
    assert.equal((await recordsOnB()).length, 2);
    // Each restore asks the guard twice (before the first step and before the
    // last); a guard that allows two calls lets exactly one restore through.
    let calls = 0;
    const closing = { ...context, guard: async () => (++calls <= 2 ? { allowed: true, reason: null } : { allowed: false, reason: 'Claude is running' }) };
    const result = await undoBatch(closing, journalIdsOf([first, second]));
    assert.deepEqual(result.undone.map((restore) => restore.entry.id), [second.journalId]);
    assert.match(result.refused ?? '', /Claude is running/);
    assert.deepEqual(result.notTried, [first.journalId]);
    assert.equal((await recordsOnB()).length, 1, 'the first copy is still there');
    assert.equal((await context.journal.get(first.journalId!))?.status, 'done');
    await rebuild();
  });
});
