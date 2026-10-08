import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ACCOUNT_A, ACCOUNT_B, EMAIL_A, appendRounds, destroyWorld, makeWorld, writeRecord, writeTranscript, type World } from '../../test/fixtures.ts';
import { AccountStore, accountKey, type AccountInfo } from '../accounts.ts';
import { assessSync, buildInventory, conversationsOf, type Conversation, type Inventory } from '../inventory.ts';
import { Journal } from '../journal.ts';
import { LineageStore } from '../lineage.ts';
import { executeTransfer, type OperationContext, type TransferOutcome } from '../operations.ts';
import {
  NOTE_LIST_LIMIT,
  POLICY_OF,
  applySelection,
  describeListedPair,
  describePair,
  failureAnswers,
  isFailure,
  listed,
  pairAnswers,
  pairKindOf,
  pairQuestion,
  type Assessed,
  type PairKind,
} from './transfer.ts';

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

describe('tui: the lists of the notes', () => {
  const items = Array.from({ length: NOTE_LIST_LIMIT + 2 }, (_, index) => `item ${index + 1}`);

  it('lists every item while they fit', () => {
    assert.equal(listed([]), '');
    assert.equal(listed(['one', 'two']), '  one\n  two');
    assert.equal(listed(items.slice(0, NOTE_LIST_LIMIT)).split('\n').length, NOTE_LIST_LIMIT);
  });

  it('stops at the limit and says how many more there are', () => {
    const lines = listed(items).split('\n');
    assert.equal(lines.length, NOTE_LIST_LIMIT + 1);
    assert.equal(lines[0], '  item 1');
    assert.equal(lines[NOTE_LIST_LIMIT - 1], `  item ${NOTE_LIST_LIMIT}`);
    assert.equal(lines.at(-1), '  ... and 2 more');
  });
});

/**
 * The pair question and the failure question, built from real conversations:
 * a world where account A holds five conversations, four of them with a copy
 * on B in one of the four states the pair question asks about (the same,
 * the source longer, the target longer, diverged) and one never copied.
 */
describe('tui: the pair question and the failure question', () => {
  let world: World;
  let context: OperationContext;
  let inventory: Inventory;
  let assessed: Assessed[];
  let created: TransferOutcome;
  let failed: TransferOutcome;
  let refused: TransferOutcome;
  /** Lines of the fixture transcript before any round was appended; one appended round adds four. */
  let base: number;
  const ROUND = 4;

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
  const grow = async (conversation: Conversation, rounds: number, at: number): Promise<void> => {
    assert.ok(conversation.transcript);
    await appendRounds({ cliId: conversation.transcript.cliSessionId, path: conversation.transcript.path, projectDir: conversation.transcript.projectDir, sidecarDir: '', cwd: '', lines: [], uuids: [] }, rounds, at);
  };
  const transfer = (source: Conversation, override: Partial<OperationContext> = {}): Promise<TransferOutcome> =>
    executeTransfer(
      { ...context, ...override },
      { source, target: account(ACCOUNT_B), assessment: assessSync(source, conversationsOf(inventory, account(ACCOUNT_B))), onExisting: 'sync' },
    );

  before(async () => {
    world = await makeWorld();
    context = { paths: world.paths, journal: new Journal(world.paths.dataDir), lineage: await LineageStore.load(world.paths.dataDir), dryRun: false };
    // Lists are newest first: the start times fix the order the question walks.
    for (const [title, startAt] of [
      ['same pair', Date.UTC(2026, 8, 5, 10, 0, 0)],
      ['behind pair', Date.UTC(2026, 8, 4, 10, 0, 0)],
      ['newer on target', Date.UTC(2026, 8, 3, 10, 0, 0)],
      ['diverged pair', Date.UTC(2026, 8, 2, 10, 0, 0)],
      ['fresh', Date.UTC(2026, 8, 1, 10, 0, 0)],
    ] as const) {
      const t = await writeTranscript(world, { prompts: 1, email: EMAIL_A, title, startAt });
      await writeRecord(world, world.a, { cliSessionId: t.cliId, title, lastActivityAt: startAt });
    }
    await rebuild();
    base = onA('same pair').summary?.uuidChain.length ?? 0;
    assert.ok(base > 0);
    created = await transfer(onA('fresh'), { dryRun: true });
    assert.equal(created.action, 'created');
    for (const title of ['same pair', 'behind pair', 'newer on target', 'diverged pair']) assert.equal((await transfer(onA(title))).action, 'created');
    await rebuild();
    await grow(onA('behind pair'), 1, Date.UTC(2026, 8, 6));
    await grow(onB('newer on target'), 1, Date.UTC(2026, 8, 6));
    await grow(onB('diverged pair'), 1, Date.UTC(2026, 8, 6));
    await grow(onA('diverged pair'), 2, Date.UTC(2026, 8, 7));
    await rebuild();
    // A transfer onto the source's own account fails before anything is planned.
    failed = await executeTransfer({ ...context, dryRun: true }, { source: onA('fresh'), target: account(ACCOUNT_A), assessment: entry('fresh').assessment, onExisting: 'sync' });
    assert.equal(failed.action, 'failed');
    refused = await transfer(onA('fresh'), { guard: async () => ({ allowed: false, reason: 'Claude is running' }) });
    assert.equal(refused.action, 'refused');
  });
  after(async () => {
    await destroyWorld(world);
  });

  it('pairKindOf sorts the states the transfer asks about into the four kinds, and leaves the rest alone', () => {
    assert.deepEqual(
      assessed.map((candidate) => [candidate.assessment.state, pairKindOf(candidate)]),
      [
        ['up-to-date', 'same'],
        ['update-available', 'source-longer'],
        ['target-ahead', 'target-longer'],
        ['diverged', 'diverged'],
        ['new', null],
      ],
    );
    const bare: Assessed = { conversation: onA('fresh'), assessment: { state: 'unrelated', existing: null, comparison: null, warnings: [] } };
    assert.equal(pairKindOf(bare), null);
    assert.equal(pairKindOf({ ...bare, assessment: { ...bare.assessment, state: 'ambiguous' } }), null);
    assert.equal(pairKindOf({ ...bare, assessment: { ...bare.assessment, state: 'no-transcript' } }), null);
  });

  it('describePair says whether the two are the same and which one is longer, with the line counts', () => {
    assert.equal(describePair(entry('same pair')), `is the same on both accounts (${base} lines each)`);
    assert.equal(describePair(entry('behind pair')), `differs: the source is longer (source ${base + ROUND} lines, target ${base})`);
    assert.equal(describePair(entry('newer on target')), `differs: the target is longer (source ${base} lines, target ${base + ROUND})`);
    assert.equal(
      describePair(entry('diverged pair')),
      `differs: both went on after ${base} lines shared (source ${base + 2 * ROUND} lines, target ${base + ROUND}; the source is longer)`,
    );
    // A copy without a transcript has nothing to compare; the source's own length is shown.
    const noTranscript: Assessed = { ...entry('behind pair'), assessment: { ...entry('behind pair').assessment, comparison: null } };
    assert.equal(describePair(noTranscript), `differs: the target copy has no transcript (source ${base + ROUND} lines)`);
    assert.equal(describeListedPair(entry('same pair')), `"same pair" is the same on both accounts (${base} lines each)`);
  });

  it('describePair names the longer side of a diverged pair either way, or that both are the same length', () => {
    const diverged = entry('diverged pair');
    const comparison = diverged.assessment.comparison;
    assert.ok(comparison);
    const withExtra = (sourceExtra: number, targetExtra: number): Assessed => ({ ...diverged, assessment: { ...diverged.assessment, comparison: { ...comparison, sourceExtra, targetExtra } } });
    assert.ok(describePair(withExtra(1, 5)).endsWith('; the target is longer)'));
    assert.ok(describePair(withExtra(3, 3)).endsWith('; both the same length)'));
    assert.ok(describePair(withExtra(5, 1)).endsWith('; the source is longer)'));
  });

  it('pairQuestion puts the position in the run in front of the title', () => {
    assert.equal(pairQuestion({ index: 2, total: 5 }, entry('behind pair')), `[2/5] "behind pair" differs: the source is longer (source ${base + ROUND} lines, target ${base}). What to do?`);
  });

  it('POLICY_OF maps the single answers to the policies executeTransfer takes', () => {
    assert.deepEqual(POLICY_OF, { skip: 'skip', keep: 'sync', overwrite: 'overwrite' });
  });

  it('offers skip, keep and copy anyway for an identical pair, the answer the operator asked for first', () => {
    const last = pairAnswers('same', [entry('same pair')], []);
    assert.deepEqual(
      last.map((answer) => answer.value),
      ['skip', 'keep', 'overwrite', 'cancel'],
    );
    assert.equal(last[0]?.label, 'Skip this conversation');
    assert.equal(last[0]?.hint, 'nothing is done and the SSH host is not asked; the result lists it as skipped');
    assert.equal(last[1]?.label, 'Keep it as it is (up to date)');
    assert.equal(last[2]?.label, 'Copy anyway: overwrite the target copy');
    for (const single of last.slice(0, 3)) assert.equal(single.confirm, undefined, 'the answer for this one conversation is taken at once');

    const several = pairAnswers('same', [entry('same pair'), entry('same pair'), entry('same pair')], []);
    assert.deepEqual(
      several.map((answer) => answer.value),
      ['skip', 'keep', 'overwrite', 'skip-all', 'keep-all', 'overwrite-all', 'cancel'],
    );
    assert.equal(several[3]?.label, 'Skip all 3 remaining identical conversations');
    assert.equal(several[3]?.hint, 'this one and the 2 after it; asks to confirm first');
    assert.equal(several[3]?.confirm?.question, 'Skip all 3 remaining identical conversations?');
    assert.equal(several[4]?.label, 'Keep all 3 remaining identical conversations');
    assert.ok(several[4]?.confirm?.note.startsWith('Kept: nothing is copied'), several[4]?.confirm?.note);
    assert.equal(several[5]?.label, 'Copy all 3 remaining identical conversations anyway');
    assert.equal(several[5]?.confirm?.question, 'Overwrite the target copies of all 3 remaining identical conversations?');
  });

  it('offers copy first where the source is longer, and skip first where the target is longer or the two diverged', () => {
    const behind = pairAnswers('source-longer', [entry('behind pair'), entry('behind pair')], []);
    assert.deepEqual(
      behind.map((answer) => answer.value),
      ['overwrite', 'skip', 'overwrite-all', 'skip-all', 'cancel'],
    );
    assert.equal(behind[0]?.label, 'Copy: bring the target copy up to date');
    assert.equal(behind[2]?.label, 'Copy all 2 remaining where the source is longer');
    assert.equal(behind[2]?.confirm?.question, 'Copy all 2 remaining where the source is longer?');
    assert.equal(behind[3]?.label, 'Skip all 2 remaining where the source is longer');

    const newer = pairAnswers('target-longer', [entry('newer on target'), entry('newer on target')], []);
    assert.deepEqual(
      newer.map((answer) => answer.value),
      ['skip', 'overwrite', 'skip-all', 'overwrite-all', 'cancel'],
    );
    assert.equal(newer[1]?.label, 'Overwrite the target copy');
    assert.equal(newer[2]?.label, 'Skip all 2 remaining where the target is longer');
    assert.equal(newer[3]?.confirm?.question, 'Overwrite the target copies of all 2 remaining where the target is longer?');

    const diverged = pairAnswers('diverged', [entry('diverged pair'), entry('diverged pair')], []);
    assert.deepEqual(
      diverged.map((answer) => answer.value),
      ['skip', 'overwrite', 'skip-all', 'overwrite-all', 'cancel'],
    );
    assert.equal(diverged[2]?.label, 'Skip all 2 remaining diverged conversations');
    assert.equal(diverged[3]?.label, 'Overwrite all 2 remaining diverged conversations');
  });

  it('the notes list the pairs involved, capped, and recap the answers already given', () => {
    const both = pairAnswers('target-longer', [entry('newer on target'), entry('newer on target')], ['overwrite', 'skip', 'skip', 'keep']);
    const skipAll = both[2]?.confirm;
    const overwriteAll = both[3]?.confirm;
    const cancel = both[4]?.confirm;
    assert.ok(skipAll && overwriteAll && cancel);
    const line = `  "newer on target" differs: the target is longer (source ${base} lines, target ${base + ROUND})`;
    for (const note of [skipAll.note, overwriteAll.note]) {
      assert.ok(note.includes(`${line}\n${line}`), note);
      assert.ok(note.endsWith('The 4 answers given before (1 overwrite, 2 skip, 1 keep) stay as given.'), note);
    }
    assert.ok(skipAll.note.startsWith('Skipped: the target copy of each stays as it is'), skipAll.note);
    assert.ok(overwriteAll.note.startsWith('Overwritten: each target copy is replaced by its shorter source.'), overwriteAll.note);
    assert.ok(overwriteAll.note.includes('"Restore from journal"'), overwriteAll.note);
    assert.ok(cancel.note.startsWith('Nothing has been written: these questions come before the plan'), cancel.note);
    assert.ok(cancel.note.includes('and the 4 answers given so far (1 overwrite, 2 skip, 1 keep). Back to the menu.'), cancel.note);
    assert.equal(cancel.question, 'Cancel the transfer?');

    const first = pairAnswers('target-longer', [entry('newer on target'), entry('newer on target')], []);
    assert.ok(!(first[2]?.confirm?.note ?? '').includes('stay as given'), 'nothing to recap before the first answer');
    assert.ok((first[4]?.confirm?.note ?? '').endsWith('Discarded: the choice of source, target and conversations. Back to the menu.'));

    // A sync of hundreds of identical conversations: the note names the first ten and counts the rest.
    const many = pairAnswers('same', Array.from({ length: 25 }, () => entry('same pair')), []);
    const note = many[3]?.confirm?.note ?? '';
    assert.equal(note.split('\n').filter((row) => row.startsWith('  "same pair"')).length, NOTE_LIST_LIMIT, note);
    assert.ok(note.endsWith('  ... and 15 more'), note);
    assert.equal(many[3]?.label, 'Skip all 25 remaining identical conversations');
  });

  it('the kinds cover every state the question asks about', () => {
    const kinds: PairKind[] = ['same', 'source-longer', 'target-longer', 'diverged'];
    for (const kind of kinds) {
      const answers = pairAnswers(kind, [entry('same pair')], []);
      assert.equal(answers.at(-1)?.value, 'cancel', kind);
      assert.ok(answers.some((answer) => answer.value === 'skip'), kind);
    }
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
    // The undo list is capped like every other note list.
    const manyUndos = failureAnswers(failed, [created, failed], 5, Array.from({ length: 30 }, (_, index) => `created "c${index}" [id-${index}]: 1 created, 0 moved, 0 backed up`));
    assert.ok(manyUndos[3]?.confirm?.note.includes('\n  ... and 20 more\n'), manyUndos[3]?.confirm?.note);
    assert.equal(manyUndos[3]?.confirm?.question, 'Undo 30 operations and stop the transfer?');
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
