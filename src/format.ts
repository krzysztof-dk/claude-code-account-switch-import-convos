// Text formatting shared by the command line output and the TUI: dates,
// sizes, shortened paths, plain monospace tables and the wording of states.
// Everything here is presentation only; no module below the TUI imports it.
import type { AccountInfo } from './accounts.ts';
import { accountLabel } from './accounts.ts';
import type { Conversation, SyncAssessment, SyncState } from './inventory.ts';

/**
 * Epoch milliseconds as "YYYY-MM-DD HH:MM" in local time, for date columns;
 * a dash when the time is unknown (null, zero, negative or not finite).
 */
export function formatWhen(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return '-';
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A byte count for size columns, 1024-based: bytes below 1 KiB, whole
 * kilobytes below 1 MiB, megabytes with one decimal from there on.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Keeps the tail of a path, which is the part that tells projects apart. */
export function shortenPath(target: string | null, max = 36): string {
  if (!target) return '-';
  if (target.length <= max) return target;
  return `...${target.slice(target.length - (max - 3))}`;
}

/**
 * Fits free text such as a title into a column: every run of whitespace
 * (newlines included) becomes one space, and text longer than `max` is cut
 * to exactly `max` characters ending in "...".
 */
export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`;
}

/** Renders rows as aligned columns; the first row is treated as the header when `header` is true. */
export function renderTable(rows: readonly (readonly string[])[], header = true): string {
  if (rows.length === 0) return '';
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  const line = (row: readonly string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join('  ').trimEnd();
  const lines = rows.map(line);
  if (header && rows.length > 1) {
    lines.splice(1, 0, widths.map((width) => '-'.repeat(width)).join('  '));
  }
  return lines.join('\n');
}

/**
 * The words for a sync state, as the README's "States" table names them;
 * shown in lists, plans and the hint column of the TUI.
 */
export function describeState(state: SyncState): string {
  switch (state) {
    case 'new':
      return 'new on target';
    case 'up-to-date':
      return 'up to date';
    case 'update-available':
      return 'update available';
    case 'target-ahead':
      return 'target is newer';
    case 'diverged':
      return 'diverged';
    case 'unrelated':
      return 'linked copy holds another conversation';
    case 'ambiguous':
      return 'linked to several on target';
    case 'no-transcript':
      return 'no transcript';
    default:
      return String(state);
  }
}

/** One-line explanation of a comparison, e.g. "target lacks 12 lines". */
export function describeComparison(assessment: SyncAssessment): string {
  const comparison = assessment.comparison;
  if (!comparison) return '';
  switch (comparison.relation) {
    case 'target-behind':
      return `target lacks ${comparison.sourceExtra} line${comparison.sourceExtra === 1 ? '' : 's'}`;
    case 'target-ahead':
      return `target has ${comparison.targetExtra} extra line${comparison.targetExtra === 1 ? '' : 's'}`;
    case 'diverged':
      return `shared ${comparison.commonPrefix}, source +${comparison.sourceExtra}, target +${comparison.targetExtra}`;
    case 'unrelated':
      return 'no shared history';
    default:
      return '';
  }
}

/**
 * The origin label of a conversation (README, "Origin of a conversation").
 * For remote-control and claude.ai it adds the owner on the claude.ai side:
 * the account's label when the owner is a known account, else the start of
 * its uuid.
 */
export function describeOrigin(conversation: Conversation, accounts: readonly AccountInfo[]): string {
  const owner = conversation.bridgeOwner;
  const ownerLabel = owner
    ? (accounts.find((account) => account.accountId === owner.accountId) ?? null)
    : null;
  const ownerText = owner ? ` (owner ${ownerLabel ? accountLabel(ownerLabel) : `${owner.accountId.slice(0, 8)}...`})` : '';
  switch (conversation.origin) {
    case 'desktop':
      return 'desktop';
    case 'remote-control':
      return `remote-control${ownerText}`;
    case 'claude.ai':
      return `claude.ai${ownerText}`;
    case 'desktop-unlisted':
      return 'desktop, unlisted';
    case 'terminal':
      return 'terminal';
    default:
      return 'unknown';
  }
}

/** The flags of a conversation as words, comma separated; empty when it has none. */
export function describeFlags(conversation: Conversation): string {
  return conversation.flags
    .map((flag) => {
      switch (flag) {
        case 'archived':
          return 'archived';
        case 'no-transcript':
          return 'no transcript';
        case 'adopted':
          return 'adopted';
        default:
          return flag;
      }
    })
    .join(', ');
}

/**
 * One row of the account table of `ccas accounts` and the TUI, in the
 * column order of ACCOUNT_HEADER; the uuids are cut to their first eight
 * characters.
 */
export function accountRow(account: AccountInfo): string[] {
  return [
    account.name ?? '-',
    account.email ?? '(unknown)',
    account.emailEvidence ?? '-',
    `${account.accountId.slice(0, 8)}...`,
    `${account.orgId.slice(0, 8)}...`,
    account.orgName ?? '-',
    String(account.sessionCount),
    account.loggedIn ? 'yes' : '',
  ];
}

/** Column titles of the account table; accountRow fills the same columns in the same order. */
export const ACCOUNT_HEADER = ['name', 'e-mail', 'evidence', 'account', 'org', 'organization', 'sessions', 'logged in'];
