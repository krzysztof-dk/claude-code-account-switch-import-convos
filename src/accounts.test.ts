import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ACCOUNT_A, ACCOUNT_B, EMAIL_A, EMAIL_B, destroyWorld, makeWorld, type World } from '../test/fixtures.ts';
import {
  AccountStore,
  accountKey,
  accountLabel,
  discoverAccountDirs,
  matchAccount,
  readCliOauthAccount,
  readLastKnownAccountUuid,
  resolveEmail,
  type AccountInfo,
} from './accounts.ts';

describe('accounts', () => {
  let world: World;
  before(async () => {
    world = await makeWorld();
  });
  after(async () => {
    await destroyWorld(world);
  });

  it('discovers account/org pairs and ignores other directories', async () => {
    await mkdir(path.join(world.paths.sessionsRoot, 'skills-plugin', ACCOUNT_A.orgId), { recursive: true });
    await mkdir(path.join(world.paths.sessionsRoot, ACCOUNT_A.accountId, 'imported-staging'), { recursive: true });
    const dirs = await discoverAccountDirs(world.paths.sessionsRoot);
    assert.deepEqual(
      dirs.map((dir) => [dir.accountId, dir.orgId]),
      [
        [ACCOUNT_A.accountId, ACCOUNT_A.orgId],
        [ACCOUNT_B.accountId, ACCOUNT_B.orgId],
      ],
    );
    assert.deepEqual(await discoverAccountDirs(path.join(world.root, 'nowhere')), []);
  });

  it('reads the last known account from the desktop config and nothing else', async () => {
    assert.equal(await readLastKnownAccountUuid(world.paths.desktopConfigFile), ACCOUNT_A.accountId);
    assert.equal(await readLastKnownAccountUuid(path.join(world.root, 'missing.json')), null);
  });

  it('reduces the CLI login to the four fields it needs', async () => {
    await writeFile(
      world.paths.cliConfigFile,
      JSON.stringify({
        oauthAccount: { accountUuid: ACCOUNT_B.accountId, organizationUuid: ACCOUNT_B.orgId, emailAddress: EMAIL_B, organizationName: ' Beta Org ', displayName: 'x', billingType: 'y' },
        somethingElse: 'must-not-leak',
      }),
    );
    assert.deepEqual(await readCliOauthAccount(world.paths.cliConfigFile), {
      accountUuid: ACCOUNT_B.accountId,
      organizationUuid: ACCOUNT_B.orgId,
      emailAddress: EMAIL_B,
      organizationName: 'Beta Org',
    });
    await writeFile(world.paths.cliConfigFile, JSON.stringify({ oauthAccount: { accountUuid: 'nope' } }));
    assert.equal(await readCliOauthAccount(world.paths.cliConfigFile), null);
    await writeFile(world.paths.cliConfigFile, '{}');
    assert.equal(await readCliOauthAccount(world.paths.cliConfigFile), null);
  });

  it('remembers names and e-mails across loads, detection beating manual entry', async () => {
    const store = await AccountStore.load(world.paths.dataDir);
    store.setName(ACCOUNT_A.accountId, ACCOUNT_A.orgId, '  work ');
    assert.equal(store.setEmail(ACCOUNT_A.accountId, ACCOUNT_A.orgId, 'manual@example.com', 'manual'), true);
    assert.equal(store.setEmail(ACCOUNT_A.accountId, ACCOUNT_A.orgId, EMAIL_A, 'transcripts'), true);
    assert.equal(store.setEmail(ACCOUNT_A.accountId, ACCOUNT_A.orgId, 'late@example.com', 'manual'), false);
    await store.save();
    const again = await AccountStore.load(world.paths.dataDir);
    const entry = again.find(ACCOUNT_A.accountId, ACCOUNT_A.orgId);
    assert.equal(entry?.name, 'work');
    assert.equal(entry?.email, EMAIL_A);
    assert.equal(entry?.emailSource, 'transcripts');
    again.setName(ACCOUNT_A.accountId, ACCOUNT_A.orgId, null);
    assert.equal(again.find(ACCOUNT_A.accountId, ACCOUNT_A.orgId)?.name, null);
  });

  it('resolves an e-mail from the most reliable source available', () => {
    const dir = { ...ACCOUNT_A, dir: '/x' };
    const cli = { accountUuid: ACCOUNT_A.accountId, organizationUuid: ACCOUNT_A.orgId, emailAddress: 'cli@example.com', organizationName: null };
    const votes = [
      { email: 'minor@example.com', count: 1 },
      { email: EMAIL_A, count: 3 },
    ];
    const stored = { ...ACCOUNT_A, email: 'old@example.com', emailSource: 'manual' as const, name: null, orgName: null, firstSeenAt: 0, lastSeenAt: Date.UTC(2026, 0, 2) };
    assert.equal(resolveEmail(dir, cli, votes, stored).email, 'cli@example.com');
    assert.equal(resolveEmail(dir, { ...cli, organizationUuid: null }, votes, stored).source, 'cli-config');
    assert.equal(resolveEmail(dir, { ...cli, organizationUuid: ACCOUNT_B.orgId }, votes, stored).email, EMAIL_A);
    const fromVotes = resolveEmail(dir, null, votes, stored);
    assert.equal(fromVotes.source, 'transcripts');
    assert.equal(fromVotes.evidence, '3 of 4 sessions name it');
    const fromStore = resolveEmail(dir, null, [], stored);
    assert.deepEqual(fromStore, { email: 'old@example.com', source: 'stored', evidence: 'entered manually' });
    assert.deepEqual(resolveEmail(dir, null, [], undefined), { email: null, source: null, evidence: null });
  });

  it('matches accounts by name, e-mail, key or uuid prefix', () => {
    const accounts: AccountInfo[] = [
      { ...ACCOUNT_A, dir: '/a', email: EMAIL_A, emailSource: 'transcripts', emailEvidence: null, name: 'Work', orgName: 'Acme', loggedIn: true, sessionCount: 1 },
      { ...ACCOUNT_B, dir: '/b', email: null, emailSource: null, emailEvidence: null, name: null, orgName: null, loggedIn: false, sessionCount: 0 },
    ];
    assert.equal(matchAccount(accounts, 'work').accountId, ACCOUNT_A.accountId);
    assert.equal(matchAccount(accounts, EMAIL_A.toUpperCase()).accountId, ACCOUNT_A.accountId);
    assert.equal(matchAccount(accounts, `${ACCOUNT_B.accountId}/${ACCOUNT_B.orgId}`).accountId, ACCOUNT_B.accountId);
    assert.equal(matchAccount(accounts, 'bbbb').accountId, ACCOUNT_B.accountId);
    assert.throws(() => matchAccount(accounts, 'zzz'), /no account matches/);
    assert.throws(() => matchAccount(accounts, ''), /empty/);
    const twins: AccountInfo[] = [accounts[0]!, { ...accounts[0]!, orgId: ACCOUNT_B.orgId, name: null }];
    assert.throws(() => matchAccount(twins, 'aaaaaaaa'), /ambiguous/);
  });

  it('labels an account by its name, else its e-mail, else the start of its uuid', () => {
    const base = { accountId: ACCOUNT_A.accountId, name: 'Work', email: EMAIL_A };
    assert.equal(accountLabel(base), 'Work');
    assert.equal(accountLabel({ ...base, name: null }), EMAIL_A);
    // Eight characters of a uuid are enough to tell accounts apart by eye; the dots say it is cut.
    assert.equal(accountLabel({ ...base, name: null, email: null }), 'aaaaaaaa...');
  });

  it('keys an account directory as accountId/orgId, the form a person may type to name it', () => {
    assert.equal(accountKey(ACCOUNT_A.accountId, ACCOUNT_A.orgId), `${ACCOUNT_A.accountId}/${ACCOUNT_A.orgId}`);
    assert.notEqual(accountKey(ACCOUNT_A.accountId, ACCOUNT_B.orgId), accountKey(ACCOUNT_A.accountId, ACCOUNT_A.orgId), 'one account in two organizations is two keys');
  });
});
