import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountInfo } from './accounts.ts';
import type { ChainComparison, Relation } from './compare.ts';
import {
  ACCOUNT_HEADER,
  accountRow,
  describeComparison,
  describeFlags,
  describeOrigin,
  describeState,
  formatSize,
  formatWhen,
  renderTable,
  shortenPath,
  truncate,
} from './format.ts';
import type { Conversation, ConversationFlag, Origin, SyncAssessment, SyncState } from './inventory.ts';

const OWNER_ID = 'cccccccc-3333-4333-8333-333333333333';

function account(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    accountId: 'aaaaaaaa-1111-4111-8111-111111111111',
    orgId: 'a0a0a0a0-1111-4111-8111-111111111111',
    dir: '/sessions/a/a0',
    email: 'alpha@example.com',
    emailSource: 'transcripts',
    emailEvidence: '3 of 3 sessions name it',
    name: null,
    orgName: null,
    loggedIn: false,
    sessionCount: 3,
    ...overrides,
  };
}

/** A conversation with every field set to something plain; tests override what they look at. */
function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    key: 'root-uuid',
    keySource: 'root-uuid',
    account: null,
    record: null,
    cliSessionId: null,
    transcript: null,
    summary: null,
    origin: 'desktop',
    bridgeOwner: null,
    flags: [],
    title: 'A conversation',
    cwd: null,
    createdAt: null,
    lastActivityAt: 0,
    sizeBytes: 0,
    promptCount: null,
    messageCount: null,
    email: null,
    links: [],
    ...overrides,
  };
}

function assessment(state: SyncState, comparison: ChainComparison | null = null): SyncAssessment {
  return { state, existing: null, comparison, warnings: [] };
}

describe('formatWhen', () => {
  it('shows a dash for null, zero, negative and non-finite times', () => {
    assert.equal(formatWhen(null), '-');
    assert.equal(formatWhen(0), '-');
    assert.equal(formatWhen(-5), '-');
    assert.equal(formatWhen(Number.NaN), '-');
    assert.equal(formatWhen(Number.POSITIVE_INFINITY), '-');
  });

  it('renders local time with zero-padded fields', () => {
    // The Date constructor with parts is local time, the same zone formatWhen renders in.
    assert.equal(formatWhen(new Date(2026, 0, 5, 7, 3, 59).getTime()), '2026-01-05 07:03');
    assert.equal(formatWhen(new Date(2026, 11, 31, 23, 59).getTime()), '2026-12-31 23:59');
  });
});

describe('formatSize', () => {
  it('shows bytes below 1 KiB', () => {
    assert.equal(formatSize(0), '0 B');
    assert.equal(formatSize(1023), '1023 B');
  });

  it('switches to whole kilobytes at 1024 bytes and rounds', () => {
    assert.equal(formatSize(1024), '1 KB');
    assert.equal(formatSize(1536), '2 KB');
    assert.equal(formatSize(1535), '1 KB');
  });

  it('switches to megabytes with one decimal at 1 MiB', () => {
    assert.equal(formatSize(1024 * 1024), '1.0 MB');
    assert.equal(formatSize(1.5 * 1024 * 1024), '1.5 MB');
    assert.equal(formatSize(300 * 1024 * 1024), '300.0 MB');
  });
});

describe('shortenPath', () => {
  it('shows a dash for null and an empty path', () => {
    assert.equal(shortenPath(null), '-');
    assert.equal(shortenPath(''), '-');
  });

  it('leaves a path within the limit unchanged', () => {
    assert.equal(shortenPath('/Volumes/Store/Dev/alpha'), '/Volumes/Store/Dev/alpha');
    const exact = `/${'x'.repeat(35)}`;
    assert.equal(shortenPath(exact), exact);
  });

  it('keeps the tail of a long path behind a ... prefix', () => {
    const long = '/Volumes/Store/Dev/some-very-long-parent/project-alpha-beta';
    const short = shortenPath(long);
    assert.equal(short.length, 36);
    assert.ok(short.startsWith('...'));
    assert.ok(long.endsWith(short.slice(3)));
    assert.equal(shortenPath(long, 12), '...lpha-beta');
  });
});

describe('truncate', () => {
  it('collapses runs of whitespace and trims the ends', () => {
    assert.equal(truncate('  fix\n\tthe   bug  ', 40), 'fix the bug');
  });

  it('keeps text of exactly max characters', () => {
    assert.equal(truncate('abcdefghij', 10), 'abcdefghij');
  });

  it('cuts longer text to exactly max characters ending in ...', () => {
    const cut = truncate('abcdefghijk', 10);
    assert.equal(cut, 'abcdefg...');
    assert.equal(cut.length, 10);
  });

  it('leaves shorter text unchanged', () => {
    assert.equal(truncate('short', 10), 'short');
  });
});

describe('renderTable', () => {
  it('aligns columns and puts a dashed line under the header', () => {
    assert.equal(
      renderTable([
        ['a', 'bb'],
        ['ccc', 'd'],
      ]),
      ['a    bb', '---  --', 'ccc  d'].join('\n'),
    );
  });

  it('leaves the dashed line out when header is false', () => {
    assert.equal(
      renderTable(
        [
          ['a', 'bb'],
          ['ccc', 'd'],
        ],
        false,
      ),
      ['a    bb', 'ccc  d'].join('\n'),
    );
  });

  it('adds no dashed line under a header without rows', () => {
    assert.equal(renderTable([['name', 'e-mail']]), 'name  e-mail');
  });

  it('renders empty input as an empty string', () => {
    assert.equal(renderTable([]), '');
  });

  it('leaves no trailing spaces on any line', () => {
    // Empty trailing cells, as accountRow gives for an account that is not logged in.
    const text = renderTable([
      ['name', 'note', 'logged in'],
      ['x', '', ''],
      ['longer name', 'n', ''],
    ]);
    for (const line of text.split('\n')) assert.doesNotMatch(line, / $/, JSON.stringify(line));
  });
});

describe('describeState', () => {
  it('words every state', () => {
    const expected: Record<SyncState, string> = {
      new: 'new on target',
      'up-to-date': 'up to date',
      'update-available': 'update available',
      'target-ahead': 'target is newer',
      diverged: 'diverged',
      unrelated: 'linked copy holds another conversation',
      ambiguous: 'linked to several on target',
      'no-transcript': 'no transcript',
    };
    for (const [state, text] of Object.entries(expected)) assert.equal(describeState(state as SyncState), text, state);
  });
});

describe('describeComparison', () => {
  const comparison = (relation: Relation, commonPrefix: number, sourceExtra: number, targetExtra: number): ChainComparison => ({
    relation,
    commonPrefix,
    sourceExtra,
    targetExtra,
  });

  it('is empty without a comparison', () => {
    assert.equal(describeComparison(assessment('new')), '');
  });

  it('is empty for identical chains', () => {
    assert.equal(describeComparison(assessment('up-to-date', comparison('identical', 4, 0, 0))), '');
  });

  it('counts the lines the target lacks, singular and plural', () => {
    assert.equal(describeComparison(assessment('update-available', comparison('target-behind', 4, 1, 0))), 'target lacks 1 line');
    assert.equal(describeComparison(assessment('update-available', comparison('target-behind', 4, 12, 0))), 'target lacks 12 lines');
  });

  it('counts the extra lines of the target, singular and plural', () => {
    assert.equal(describeComparison(assessment('target-ahead', comparison('target-ahead', 4, 0, 1))), 'target has 1 extra line');
    assert.equal(describeComparison(assessment('target-ahead', comparison('target-ahead', 4, 0, 3))), 'target has 3 extra lines');
  });

  it('gives the shared part and both additions for diverged chains', () => {
    assert.equal(describeComparison(assessment('diverged', comparison('diverged', 5, 2, 3))), 'shared 5, source +2, target +3');
  });

  it('says there is no shared history for unrelated chains', () => {
    assert.equal(describeComparison(assessment('unrelated', comparison('unrelated', 0, 2, 2))), 'no shared history');
  });
});

describe('describeOrigin', () => {
  const owner = account({ accountId: OWNER_ID, name: 'Work' });

  it('names the origins without an owner', () => {
    const expected: [Origin, string][] = [
      ['desktop', 'desktop'],
      ['remote-control', 'remote-control'],
      ['claude.ai', 'claude.ai'],
      ['desktop-unlisted', 'desktop, unlisted'],
      ['terminal', 'terminal'],
      ['unknown', 'unknown'],
    ];
    for (const [origin, text] of expected) assert.equal(describeOrigin(conversation({ origin }), [owner]), text, origin);
  });

  it('shows the label of an owner that is a known account', () => {
    const bridgeOwner = { accountId: OWNER_ID, orgId: null };
    assert.equal(describeOrigin(conversation({ origin: 'remote-control', bridgeOwner }), [account(), owner]), 'remote-control (owner Work)');
    assert.equal(describeOrigin(conversation({ origin: 'claude.ai', bridgeOwner }), [owner]), 'claude.ai (owner Work)');
  });

  it('shows the start of the uuid for an owner that is not a known account', () => {
    const bridgeOwner = { accountId: OWNER_ID, orgId: null };
    assert.equal(describeOrigin(conversation({ origin: 'claude.ai', bridgeOwner }), [account()]), 'claude.ai (owner cccccccc...)');
    assert.equal(describeOrigin(conversation({ origin: 'remote-control', bridgeOwner }), []), 'remote-control (owner cccccccc...)');
  });

  it('leaves the owner out of the desktop origin', () => {
    const bridgeOwner = { accountId: OWNER_ID, orgId: null };
    assert.equal(describeOrigin(conversation({ origin: 'desktop', bridgeOwner }), [owner]), 'desktop');
  });
});

describe('describeFlags', () => {
  it('is empty without flags', () => {
    assert.equal(describeFlags(conversation()), '');
  });

  it('words every flag and joins them in order', () => {
    const flags: ConversationFlag[] = ['archived', 'no-transcript', 'adopted'];
    assert.equal(describeFlags(conversation({ flags })), 'archived, no transcript, adopted');
  });
});

describe('accountRow and ACCOUNT_HEADER', () => {
  it('have the same number of columns', () => {
    assert.equal(accountRow(account()).length, ACCOUNT_HEADER.length);
  });

  it('fills every column of a fully known account', () => {
    const row = accountRow(account({ name: 'Home', orgName: 'Acme', loggedIn: true, sessionCount: 12 }));
    assert.deepEqual(row, ['Home', 'alpha@example.com', '3 of 3 sessions name it', 'aaaaaaaa...', 'a0a0a0a0...', 'Acme', '12', 'yes']);
  });

  it('shows placeholders for what is not known', () => {
    const row = accountRow(account({ email: null, emailSource: null, emailEvidence: null, sessionCount: 0 }));
    assert.deepEqual(row, ['-', '(unknown)', '-', 'aaaaaaaa...', 'a0a0a0a0...', '-', '0', '']);
  });
});
