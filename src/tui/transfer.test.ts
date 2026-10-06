import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ACCOUNT_A, ACCOUNT_B, EMAIL_A, appendRounds, destroyWorld, makeWorld, writeRecord, writeTranscript, type World } from '../../test/fixtures.ts';
import { AccountStore, accountKey, type AccountInfo } from '../accounts.ts';
import { assessSync, buildInventory, conversationsOf, type Conversation, type Inventory } from '../inventory.ts';
import { Journal } from '../journal.ts';
import { LineageStore } from '../lineage.ts';
import { executeTransfer, type OperationContext, type TransferOutcome } from '../operations.ts';
import { applySelection, conflictAnswers, describeConflict, failureAnswers, isConflict, isFailure, type Assessed } from './transfer.ts';

describe('tui: choosing conversations', () => {
  const entries = ['a', 'b', 'c', 'd'];

  it('takes every conversation without picking any', () => {
    assert.deepEqual(applySelection(entries, 'all', []), ['a', 'b', 'c', 'd']);
    assert.deepEqual(applySelection(entries, 'all', [1]), ['a', 'b', 'c', 'd'], 'picks do not matter for all');
  });

  it('takes all but the picked ones, in list order', () => {
    assert.deepEqual(applySelection(entries, 'all-but', [3, 1]), ['a', 'c']);
    assert.deepEqual(applySelection(entries, 'all-but', []), ['a', 'b', 'c', 'd'], 'leaving out nothing is all');
  });

  it('takes only the picked ones, in list order', () => {
    assert.deepEqual(applySelection(entries, 'pick', [2, 0]), ['a', 'c']);
    assert.deepEqual(applySelection(entries, 'pick', []), []);
  });
});

/**
 * The answers of the two questions, built from real conversations: a world
 * where account A holds three conversations, two of them with a copy on B
 * that was continued there (one "target is newer", one "diverged").
 */
describe('tui: the answers of the conflict and the failure question', () => {
  let world: World;
  let context: OperationContext;
  let inventory: Inventory;
  let assessed: Assessed[];
  let created: TransferOutcome;
  let failed: TransferOutcome;
  let refused: TransferOutcome;

  const account = (which: typeof ACCOUNT_A): AccountInfo => {
    const found = inventory.accounts.find((candidate) => candidate.accountId === which.accountId);
    assert.ok(found);
    return found;
  };
  const rebuild = async (): Promise<void> => {
    inventory = await buildInventory(world.paths, { store: await AccountStore.load(world.paths.dataDir), lineage: context.lineage });
    const target = conversationsOf(inventory, account(ACCOUNT_B));
    assessed = conversationsOf(inventory, account(ACCOUNT_A)).map((conversation) => ({ conversation, assessment: assessSync(conversation, target) }));
  };
  const onA = (title: string): Conversation => {
    const found = inventory.byAccount.get(accountKey(ACCOUNT_A.accountId, ACCOUNT_A.orgId))?.find((conversation) => conversation.title === title);
    assert.ok(found, title);
    return found;
  };
  const onB = (title: string): Conversation => {
    const found = inventory.byAccount.get(accountKey(ACCOUNT_B.accountId, ACCOUNT_B.orgId))?.find((conversation) => conversation.title === title);
    assert.ok(found, title);
    return found;
  };
  const entry = (title: string): Assessed => {
    const found = assessed.find((candidate) => candidate.conversation.title === title);
    assert.ok(found, title);
    return found;
  };
  const transfer = (source: Conversation, override: Partial<OperationContext> = {}): Promise<TransferOutcome> =>
    executeTransfer(
      { ...context, ...override },
      { source, target: account(ACCOUNT_B), mode: 'copy', assessment: assessSync(source, conversationsOf(inventory, account(ACCOUNT_B))), onConflict: 'skip' },
    );

  before(async () => {
    world = await makeWorld();
    context = { paths: world.paths, journal: new Journal(world.paths.dataDir), lineage: await LineageStore.load(world.paths.dataDir), dryRun: false };
    const transcripts = new Map<string, Awaited<ReturnType<typeof writeTranscript>>>();
    for (const [title, startAt] of [
      ['newer on target', Date.UTC(2026, 8, 3, 10, 0, 0)],
      ['diverged pair', Date.UTC(2026, 8, 2, 10, 0, 0)],
      ['fresh', Date.UTC(2026, 8, 1, 10, 0, 0)],
    ] as const) {
      const t = await writeTranscript(world, { prompts: 1, email: EMAIL_A, title, startAt });
      transcripts.set(title, t);
      await writeRecord(world, world.a, { cliSessionId: t.cliId, title, lastActivityAt: startAt });
    }
    await rebuild();
    created = await transfer(onA('newer on target'), { dryRun: true });
    assert.equal(created.action, 'created');
    for (const title of ['newer on target', 'diverged pair']) assert.equal((await transfer(onA(title))).action, 'created');
    await rebuild();
    // The copy of each grows on B; the source of the second grows too.
    for (const title of ['newer on target', 'diverged pair']) {
      const copy = onB(title);
      assert.ok(copy.transcript);
      await appendRounds({ cliId: copy.transcript.cliSessionId, path: copy.transcript.path, projectDir: copy.transcript.projectDir, sidecarDir: '', cwd: '', lines: [], uuids: [] }, 1, Date.UTC(2026, 8, 5));
    }
    const source = transcripts.get('diverged pair');
    assert.ok(source);
    await appendRounds(source, 2, Date.UTC(2026, 8, 6));
    await rebuild();
    // A transfer onto the source's own account fails before anything is planned.
    failed = await executeTransfer({ ...context, dryRun: true }, { source: onA('fresh'), target: account(ACCOUNT_A), mode: 'copy', assessment: entry('fresh').assessment, onConflict: 'skip' });
    assert.equal(failed.action, 'failed');
    refused = await transfer(onA('fresh'), { guard: async () => ({ allowed: false, reason: 'Claude is running' }) });
    assert.equal(refused.action, 'refused');
  });
  after(async () => {
    await destroyWorld(world);
  });

  it('isConflict and describeConflict know the two states the transfer asks about', () => {
    assert.equal(entry('newer on target').assessment.state, 'target-ahead');
    assert.equal(entry('diverged pair').assessment.state, 'diverged');
    assert.equal(entry('fresh').assessment.state, 'new');
    assert.deepEqual(assessed.map(isConflict), [true, true, false]);
    assert.equal(describeConflict(entry('newer on target')), '"newer on target" (target is newer: target has 4 extra lines)');
    assert.match(describeConflict(entry('diverged pair')), /^"diverged pair" \(diverged: shared \d+, source \+8, target \+4\)$/);
  });

  it('conflictAnswers offers skip, overwrite and cancel for the last conflict, and the two "all" answers before that', () => {
    const last = conflictAnswers([entry('diverged pair')], ['skip']);
    assert.deepEqual(
      last.map((answer) => answer.value),
      ['skip', 'overwrite', 'cancel'],
    );
    assert.equal(last[0]?.label, 'Skip this conversation');
    assert.equal(last[0]?.confirm, undefined, 'the answer for this one conversation is taken at once');
    assert.equal(last[1]?.confirm, undefined);

    const both = conflictAnswers([entry('newer on target'), entry('diverged pair')], []);
    assert.deepEqual(
      both.map((answer) => answer.value),
      ['skip', 'overwrite', 'skip-all', 'overwrite-all', 'cancel'],
    );
    assert.equal(both[2]?.label, 'Skip all 2 remaining conflicts');
    assert.equal(both[2]?.hint, 'this one and the 1 after it; asks to confirm first');
    assert.equal(both[3]?.label, 'Overwrite all 2 remaining conflicts');
    assert.equal(both[3]?.confirm?.question, 'Overwrite the target copies of all 2 remaining conflicts?');
  });

  it('the notes list the conflicts involved and recap the answers already given', () => {
    const both = conflictAnswers([entry('newer on target'), entry('diverged pair')], ['overwrite', 'skip', 'skip']);
    const skipAll = both[2]?.confirm;
    const overwriteAll = both[3]?.confirm;
    const cancel = both[4]?.confirm;
    assert.ok(skipAll && overwriteAll && cancel);
    for (const note of [skipAll.note, overwriteAll.note]) {
      assert.ok(note.includes('  "newer on target" (target is newer: target has 4 extra lines)\n  "diverged pair" (diverged:'), note);
      assert.ok(note.endsWith('The 3 answers given before (1 overwrite, 2 skip) stay as given.'), note);
    }
    assert.ok(skipAll.note.startsWith('Skipped: the target copy of each stays as it is'), skipAll.note);
    assert.ok(overwriteAll.note.startsWith('Overwritten: each target copy is replaced by the source.'), overwriteAll.note);
    assert.ok(overwriteAll.note.includes('"Restore from journal"'), overwriteAll.note);
    assert.ok(cancel.note.startsWith('Nothing has been written: these questions come before the plan'), cancel.note);
    assert.ok(cancel.note.includes('and the 3 answers given so far (1 overwrite, 2 skip). Back to the menu.'), cancel.note);
    assert.equal(cancel.question, 'Cancel the transfer?');

    const first = conflictAnswers([entry('newer on target'), entry('diverged pair')], []);
    assert.ok(!(first[2]?.confirm?.note ?? '').includes('stay as given'), 'nothing to recap before the first answer');
    assert.ok((first[4]?.confirm?.note ?? '').endsWith('Discarded: the choice of source, target and conversations. Back to the menu.'));
  });

  it('isFailure stops the run for failed and refused outcomes only', () => {
    assert.equal(isFailure(created), false);
    assert.equal(isFailure(failed), true);
    assert.equal(isFailure(refused), true);
  });

  it('failureAnswers names what each answer keeps, skips and undoes', () => {
    const undoLines = ['created "a" [id-a]: 4 created, 0 moved, 0 backed up'];
    const answers = failureAnswers(failed, [created, failed], 5, undoLines);
    assert.deepEqual(
      answers.map((answer) => answer.value),
      ['skip', 'continue', 'stop', 'cancel'],
    );
    assert.equal(answers[0]?.label, 'Skip it and continue');
    assert.equal(answers[0]?.hint, 'go on with the 5 conversations left');
    assert.equal(answers[0]?.confirm, undefined);
    assert.equal(answers[1]?.confirm?.question, 'Continue without asking again?');
    assert.ok(answers[1]?.confirm?.note.startsWith('The 5 conversations left are transferred one after another.'));
    assert.equal(answers[2]?.label, 'Stop here');
    assert.equal(answers[2]?.hint, 'keep the 1 operation done; the 5 conversations left are not attempted');
    assert.equal(answers[2]?.confirm, undefined);
    assert.equal(answers[3]?.label, 'Cancel the transfer and undo what it did');
    assert.equal(answers[3]?.hint, 'undo the 1 operation done, newest first; asks to confirm first');
    assert.equal(answers[3]?.confirm?.question, 'Undo 1 operation and stop the transfer?');
    assert.ok(answers[3]?.confirm?.note.includes(`Undone, newest first; each undo is a journal entry of its own:\n  ${undoLines[0]}\nNot attempted: the 5 conversations left.`), answers[3]?.confirm?.note);
    assert.ok(answers[3]?.confirm?.note.includes('Claude Code must still be closed'));
  });

  it('failureAnswers only stops when the run wrote nothing, and tells after a refusal to quit Claude Code', () => {
    const answers = failureAnswers(refused, [refused], 1, []);
    assert.equal(answers[0]?.hint, 'go on with the 1 conversation left; the guard is asked again before each one, so quit Claude Code first');
    assert.equal(answers[1]?.hint, 'later failures or refusals no longer stop the run; the guard is asked again before each one, so quit Claude Code first; asks to confirm first');
    assert.equal(answers[2]?.hint, 'keep the 0 operations done; the 1 conversation left are not attempted');
    assert.equal(answers[3]?.label, 'Cancel the transfer');
    assert.equal(answers[3]?.hint, 'nothing has been written; asks to confirm first');
    assert.equal(answers[3]?.confirm?.note, 'Nothing to undo: no operation of this transfer wrote anything.\nNot attempted: the 1 conversation left.');
    assert.equal(answers[3]?.confirm?.question, 'Stop the transfer?');
  });
});
