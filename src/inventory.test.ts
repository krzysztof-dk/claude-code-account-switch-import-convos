import assert from 'node:assert/strict';
import { appendFile, writeFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  CWD_BETA,
  EMAIL_A,
  EMAIL_B,
  appendRounds,
  buildTranscriptLines,
  destroyWorld,
  makeWorld,
  readJson,
  writeRecord,
  writeTranscript,
  type World,
  type WrittenTranscript,
} from '../test/fixtures.ts';
import { AccountStore, accountKey } from './accounts.ts';
import { assessSync, buildInventory, conversationsOf, type Conversation, type Inventory } from './inventory.ts';
import { LineageStore } from './lineage.ts';
import { copyRewritingSessionId } from './transcripts.ts';

describe('inventory', () => {
  let world: World;
  let t1: WrittenTranscript;
  let inventory: Inventory;

  const rebuild = async (): Promise<Inventory> => {
    inventory = await buildInventory(world.paths, { store: await AccountStore.load(world.paths.dataDir) });
    return inventory;
  };
  const listed = (account: typeof ACCOUNT_A, title: string): Conversation => {
    const found = inventory.byAccount.get(accountKey(account.accountId, account.orgId))?.find((conversation) => conversation.title === title);
    assert.ok(found, `conversation "${title}" on ${account.accountId}`);
    return found;
  };

  before(async () => {
    world = await makeWorld();
    t1 = await writeTranscript(world, { prompts: 2, email: EMAIL_A, title: 'T1' });
    await writeRecord(world, world.a, { cliSessionId: t1.cliId, title: 'R1' });
    const t2 = await writeTranscript(world, { prompts: 1, email: EMAIL_B, bridgeOwner: ACCOUNT_B });
    await writeRecord(world, world.a, { cliSessionId: t2.cliId, title: 'R2', isArchived: true });
    await writeRecord(world, world.a, { cliSessionId: '99999999-9999-4999-8999-999999999999', title: 'R3' });
    const t4 = await writeTranscript(world, { prompts: 1, email: null, cwd: CWD_BETA });
    await writeRecord(world, world.b, { cliSessionId: t4.cliId, title: 'R4', cwd: CWD_BETA, originCwd: CWD_BETA });
    await writeTranscript(world, { prompts: 1, email: EMAIL_A, bridgeOwner: ACCOUNT_A, title: 'U1 claude.ai' });
    await writeTranscript(world, { prompts: 1, email: null, entrypoint: 'cli', title: 'U2 terminal' });
    await writeTranscript(world, { prompts: 1, email: null, entrypoint: null, title: 'U3 unknown' });
    await writeTranscript(world, { prompts: 1, email: EMAIL_A, title: 'U4 desktop' });
    await rebuild();
  });
  after(async () => {
    await destroyWorld(world);
  });

  it('lists conversations per account with origin and flags', () => {
    assert.equal(inventory.byAccount.get(accountKey(ACCOUNT_A.accountId, ACCOUNT_A.orgId))?.length, 3);
    const r1 = listed(ACCOUNT_A, 'R1');
    assert.equal(r1.origin, 'desktop');
    assert.deepEqual(r1.flags, []);
    assert.equal(r1.keySource, 'root-uuid');
    assert.equal(r1.key, t1.uuids[0]);
    assert.equal(r1.promptCount, 2);
    assert.equal(r1.email, EMAIL_A);
    const r2 = listed(ACCOUNT_A, 'R2');
    assert.equal(r2.origin, 'remote-control');
    assert.deepEqual(r2.flags, ['archived', 'adopted']);
    assert.deepEqual(r2.bridgeOwner, { accountId: ACCOUNT_B.accountId, orgId: ACCOUNT_B.orgId });
    const r3 = listed(ACCOUNT_A, 'R3');
    assert.deepEqual(r3.flags, ['no-transcript']);
    assert.equal(r3.keySource, 'cli-session-id');
    assert.equal(r3.transcript, null);
  });

  it('lists unlisted transcripts with their origin labels', () => {
    const byTitle = new Map(inventory.unlisted.map((conversation) => [conversation.title, conversation]));
    assert.equal(inventory.unlisted.length, 4);
    assert.equal(byTitle.get('U1 claude.ai')?.origin, 'claude.ai');
    assert.deepEqual(byTitle.get('U1 claude.ai')?.bridgeOwner, { accountId: ACCOUNT_A.accountId, orgId: ACCOUNT_A.orgId });
    assert.equal(byTitle.get('U2 terminal')?.origin, 'terminal');
    assert.equal(byTitle.get('U3 unknown')?.origin, 'unknown');
    assert.equal(byTitle.get('U4 desktop')?.origin, 'desktop-unlisted');
    // How recently a transcript changed is no flag: only a running Claude Code process counts (app-guard.ts).
    assert.deepEqual(byTitle.get('U4 desktop')?.flags, []);
    assert.equal(byTitle.get('U4 desktop')?.account, null);
  });

  it('resolves account e-mails from their own sessions, ignoring sessions owned elsewhere', async () => {
    const a = inventory.accounts.find((account) => account.accountId === ACCOUNT_A.accountId);
    const b = inventory.accounts.find((account) => account.accountId === ACCOUNT_B.accountId);
    assert.equal(a?.email, EMAIL_A);
    assert.equal(a?.emailSource, 'transcripts');
    assert.equal(a?.emailEvidence, '1 of 1 session name it');
    assert.equal(a?.loggedIn, true);
    assert.equal(a?.sessionCount, 3);
    assert.equal(b?.email, null);
    assert.equal(b?.loggedIn, false);
    const stored = await readJson<{ accounts: { accountId: string; email: string | null }[] }>(`${world.paths.dataDir}/accounts.json`);
    assert.equal(stored.accounts.find((entry) => entry.accountId === ACCOUNT_A.accountId)?.email, EMAIL_A);
  });

  it('prefers the CLI login over transcript votes', async () => {
    await writeFile(world.paths.cliConfigFile, JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT_B.accountId, organizationUuid: ACCOUNT_B.orgId, emailAddress: EMAIL_B, organizationName: 'Beta Org' } }));
    await rebuild();
    const b = inventory.accounts.find((account) => account.accountId === ACCOUNT_B.accountId);
    assert.equal(b?.email, EMAIL_B);
    assert.equal(b?.emailSource, 'cli-config');
    assert.equal(b?.orgName, 'Beta Org');
    await writeFile(world.paths.cliConfigFile, '{}');
    await rebuild();
    // The address is remembered even after the CLI logs into another account.
    const later = inventory.accounts.find((account) => account.accountId === ACCOUNT_B.accountId);
    assert.equal(later?.email, EMAIL_B);
    assert.equal(later?.emailSource, 'stored');
    assert.equal(later?.orgName, 'Beta Org');
  });

  const targetOf = (account: typeof ACCOUNT_B): Conversation[] => conversationsOf(inventory, { ...account, dir: '' });

  it('treats a conversation that only starts the same way as new on the target', async () => {
    assert.equal(assessSync(listed(ACCOUNT_A, 'R1'), targetOf(ACCOUNT_B)).state, 'new');
    assert.equal(assessSync(listed(ACCOUNT_A, 'R3'), targetOf(ACCOUNT_B)).state, 'no-transcript');
    // Same lines, same first uuid, nothing linking the two: still a conversation of its own.
    const lookalikeId = '44444444-4444-4444-8444-444444444444';
    await copyRewritingSessionId(t1.path, `${t1.projectDir}/${lookalikeId}.jsonl`, t1.cliId, lookalikeId);
    await writeRecord(world, world.b, { cliSessionId: lookalikeId, title: 'R1 lookalike' });
    await rebuild();
    const assessment = assessSync(listed(ACCOUNT_A, 'R1'), targetOf(ACCOUNT_B));
    assert.equal(assessment.state, 'new');
    assert.deepEqual(assessment.warnings, []);
  });

  it('pairs a copy through its stamp, from either side, and compares only that pair', async () => {
    const r1 = listed(ACCOUNT_A, 'R1');
    assert.ok(r1.record);
    const copyId = '88888888-8888-4888-8888-888888888888';
    await copyRewritingSessionId(t1.path, `${t1.projectDir}/${copyId}.jsonl`, t1.cliId, copyId);
    await writeRecord(world, world.b, {
      cliSessionId: copyId,
      title: 'R1 copy',
      ccas: {
        copiedFrom: { ...ACCOUNT_A, sessionId: r1.record.record.sessionId, cliSessionId: t1.cliId },
        rootUuid: t1.uuids[0] ?? null,
        sourceLineCount: t1.lines.length,
        at: Date.UTC(2026, 8, 2),
      },
    });
    await rebuild();
    const same = assessSync(listed(ACCOUNT_A, 'R1'), targetOf(ACCOUNT_B));
    assert.equal(same.state, 'up-to-date');
    assert.equal(same.existing?.title, 'R1 copy');

    await appendRounds(t1, 1);
    await rebuild();
    const behind = assessSync(listed(ACCOUNT_A, 'R1'), targetOf(ACCOUNT_B));
    assert.equal(behind.state, 'update-available');
    assert.equal(behind.comparison?.sourceExtra, 4);
    assert.equal(behind.existing?.title, 'R1 copy');
    // Seen from the copy's side the stamp still links the pair, which is now "target ahead".
    assert.equal(assessSync(listed(ACCOUNT_B, 'R1 copy'), targetOf(ACCOUNT_A)).state, 'target-ahead');

    const copy = listed(ACCOUNT_B, 'R1 copy');
    assert.ok(copy.transcript);
    await appendRounds({ ...t1, cliId: copyId, path: copy.transcript.path }, 1, Date.UTC(2026, 8, 3));
    await rebuild();
    assert.equal(assessSync(listed(ACCOUNT_A, 'R1'), targetOf(ACCOUNT_B)).state, 'diverged');
  });

  it('pairs through lineage links too, and refuses to choose between two linked copies', async () => {
    const r1 = listed(ACCOUNT_A, 'R1');
    const lookalike = listed(ACCOUNT_B, 'R1 lookalike');
    assert.ok(r1.record && lookalike.record);
    const lineage = await LineageStore.load(world.paths.dataDir);
    await lineage.add({
      rootUuid: r1.key,
      at: Date.UTC(2026, 8, 4),
      journalId: 'test',
      mode: 'copy',
      action: 'created',
      sourceLineCount: 0,
      source: { ...ACCOUNT_A, sessionId: r1.record.record.sessionId, cliSessionId: t1.cliId },
      target: { ...ACCOUNT_B, sessionId: lookalike.record.record.sessionId, cliSessionId: lookalike.cliSessionId ?? 'unknown' },
    });
    inventory = await buildInventory(world.paths, { store: await AccountStore.load(world.paths.dataDir), lineage });
    const assessment = assessSync(listed(ACCOUNT_A, 'R1'), targetOf(ACCOUNT_B));
    assert.equal(assessment.state, 'ambiguous');
    assert.equal(assessment.existing, null);
    assert.match(assessment.warnings[0] ?? '', new RegExp(lookalike.record.record.sessionId));
  });

  it('reports record fields no list in records.ts knows, once per account', async () => {
    // A field the app 2.19675.0 serializer does not write stands for one a
    // newer app version added; the report is what makes the next review
    // classify it instead of copies carrying it unnoticed.
    await writeRecord(world, world.b, { cliSessionId: '88888888-8888-4888-8888-888888888888', title: 'R-new-field', brandNewField: { nested: true }, anotherOne: 1 });
    await writeRecord(world, world.b, { cliSessionId: '87878787-8787-4878-8787-878787878787', title: 'R-new-field-2', brandNewField: 'x' });
    await rebuild();
    const reports = inventory.problems.filter((problem) => problem.includes('does not know'));
    assert.equal(reports.length, 1, 'one report for account B');
    assert.match(reports[0] ?? '', /anotherOne \(1\), brandNewField \(2\)/);
    assert.match(reports[0] ?? '', new RegExp(ACCOUNT_B.accountId.slice(0, 8)));
    // Known fields, source-bound ones included, are never reported.
    assert.ok(!reports[0]?.includes('cliSessionId') && !reports[0]?.includes('title'));
  });

  it('cuts the e-mail votes of a moved record at the line count the move link recorded', async () => {
    // A moved record keeps its transcript (with the source account's
    // session_context lines) and the move writes a link with the line count
    // of that moment; only sightings past it count for the new account. A
    // world of its own, so no other conversation of account B votes.
    const own = await makeWorld();
    try {
      const t = await writeTranscript(own, { prompts: 1, email: EMAIL_A, title: 'T-moved' });
      const { record } = await writeRecord(own, own.b, { cliSessionId: t.cliId, title: 'R-moved' });
      const lineage = await LineageStore.load(own.paths.dataDir);
      const build = async (): Promise<Inventory> => buildInventory(own.paths, { store: await AccountStore.load(own.paths.dataDir), lineage });
      const emailOf = (built: Inventory): string | null => built.accounts.find((account) => account.accountId === ACCOUNT_B.accountId)?.email ?? null;
      // The link is written before any inventory sees the moved record, as a
      // move does; an inventory built without it would remember the source
      // account's e-mail for B in accounts.json, and that memory is a
      // deliberate fallback when nothing else votes.
      await lineage.add({
        rootUuid: t.uuids[0]!,
        at: Date.UTC(2026, 9, 5),
        journalId: 'test-move',
        mode: 'move',
        action: 'moved',
        sourceLineCount: t.lines.length,
        source: { ...ACCOUNT_A, sessionId: record.sessionId, cliSessionId: t.cliId },
        target: { ...ACCOUNT_B, sessionId: record.sessionId, cliSessionId: t.cliId },
      });
      assert.equal(emailOf(await build()), null, 'with the link the source account e-mail does not vote for B');
      // Once the target account continues the conversation, its own line counts.
      const continued = buildTranscriptLines({ cliId: t.cliId, prompts: 0, email: EMAIL_B }).lines.filter((line) => line['type'] === 'attachment');
      await appendFile(t.path, continued.map((line) => JSON.stringify(line)).join('\n') + '\n');
      assert.equal(emailOf(await build()), EMAIL_B);
    } finally {
      await destroyWorld(own);
    }
  });
});
