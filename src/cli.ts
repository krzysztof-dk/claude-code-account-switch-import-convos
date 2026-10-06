#!/usr/bin/env node
// Entry point. Without a command the interactive TUI starts; with one, the
// same operations run non-interactively, which is what tests, scripts and
// rehearsals on copied data use:
//
//   ccas [--dry-run]                       interactive TUI (dry run: plans only)
//   ccas accounts [--json]                 accounts, e-mails, names
//   ccas list --from <acct|none> [--to <acct>] [--json]
//   ccas transfer --from <acct|none> --to <acct> --mode copy|move
//                 (--session <id> [--session <id> ...] | --all [--exclude <id> ...])
//                 [--on-conflict skip|overwrite] [--dry-run]
//   ccas journal [--json]                  past operations
//   ccas restore <journalId> [--dry-run]   undo one operation
//   ccas resolve <journalId>               keep the files of an interrupted operation
//
// Global options: --user-data <dir>, --claude-dir <dir>, --data <dir>.
// Accounts are selected by display name, e-mail, accountId/orgId or a prefix
// of the account uuid; "none" is the pseudo-account of unlisted transcripts.
// Conversations are selected by record id (local_...), CLI session id, or
// the first transcript uuid, or a prefix of at least six characters of any
// of them; --all takes every conversation of the source, minus --exclude.
//
// Exit codes: 0 success, 1 usage or other error (including a selector that
// names no conversation or several), 2 writes refused (Claude Code running,
// or it could not be told), 3 part of a transfer failed, 4 an interrupted
// operation is unresolved (see interrupted.ts).
//
// Conversations that run on an SSH host are copied on that host too, over
// the Mac's ssh (ssh-host.ts); a dry run looks at the host as well, read
// only. CCAS_SSH names another ssh program (the tests use a stand-in).
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AccountStore, accountKey, accountLabel, matchAccount, type AccountDir, type AccountInfo } from './accounts.ts';
import { GuardRefusal, makeGuard } from './app-guard.ts';
import { ACCOUNT_HEADER, accountRow, describeComparison, describeFlags, describeOrigin, describeState, formatSize, formatWhen, renderTable, shortenPath, truncate } from './format.ts';
import { interruptedHelp } from './interrupted.ts';
import { assessSync, buildInventory, conversationsOf, type Conversation, type Inventory } from './inventory.ts';
import { Journal, displayStatus } from './journal.ts';
import { LineageStore } from './lineage.ts';
import {
  executeTransfer,
  restoreEntry,
  type ConflictPolicy,
  type OutcomeAction,
  type TransferItem,
  type TransferMode,
  type TransferOutcome,
} from './operations.ts';
import { packageRoot, resolvePaths, type Paths } from './paths.ts';
import { SummaryCache } from './summary-cache.ts';

/** Exit code 0: the command did what was asked. */
export const EXIT_OK = 0;
/**
 * Exit code 1: a usage error or another error, also a conversation selector
 * that does not match exactly one conversation.
 */
export const EXIT_USAGE = 1;
/**
 * Exit code 2: writing refused, because the app or a claude process runs
 * (also one that appeared during the operation, which was then rolled
 * back) or because that could not be checked.
 */
export const EXIT_REFUSED = 2;
/** Exit code 3: part of a transfer failed; the result lines name the conversations. */
export const EXIT_PARTIAL = 3;
/**
 * Exit code 4: an interrupted operation needs `ccas restore <id>` or
 * `ccas resolve <id>` first (see interrupted.ts). The TUI ends with it too
 * when the person chooses to exit at that question.
 */
export const EXIT_INTERRUPTED = 4;

const USAGE = `ccas - move or copy Claude Code Desktop conversations between accounts

Usage:
  ccas [--dry-run]                              interactive mode (--dry-run: plans only, never writes)
  ccas accounts [--json]
  ccas list --from <account|none> [--to <account>] [--json]
  ccas transfer --from <account|none> --to <account> --mode copy|move
                (--session <id> [--session <id> ...] | --all [--exclude <id> ...])
                [--on-conflict skip|overwrite] [--dry-run]
  ccas journal [--json]
  ccas restore <journalId> [--dry-run]
  ccas resolve <journalId>                      keep the files of an interrupted operation as they are

Global options:
  --user-data <dir>   desktop app data dir (default ~/Library/Application Support/Claude)
  --claude-dir <dir>  Claude Code CLI dir (default $CLAUDE_CONFIG_DIR or ~/.claude)
  --data <dir>        this tool's state dir (default <package>/data)
  --help, --version

Conversations on an SSH host are also copied on the host, over ssh in batch
mode: "ssh <host> true" must work without a prompt. CCAS_SSH=<program> uses
another ssh. Copies and moves switch Remote Control off; copies made before
that are repaired when transferred again.

Exit codes: 0 ok, 1 usage or other error, 2 writes refused (Claude Code running),
3 part of a transfer failed, 4 an interrupted operation needs restore or resolve.
`;

/**
 * Where the commands of main write their output. The entry point at the end
 * of this file binds it to standard output and standard error. The TUI,
 * started when no command is given, writes to the terminal itself.
 */
export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

interface Session {
  paths: Paths;
  store: AccountStore;
  cache: SummaryCache;
  journal: Journal;
  lineage: LineageStore;
}

/** Inventory of a session, with lineage so copies made by this tool pair up and do not vote for e-mails. */
function inventoryOf(session: Session): ReturnType<typeof buildInventory> {
  return buildInventory(session.paths, { store: session.store, cache: session.cache, lineage: session.lineage });
}

async function openSession(paths: Paths): Promise<Session> {
  return {
    paths,
    store: await AccountStore.load(paths.dataDir),
    cache: await SummaryCache.load(paths.dataDir),
    journal: new Journal(paths.dataDir),
    lineage: await LineageStore.load(paths.dataDir),
  };
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function accountOrNone(inventory: Inventory, selector: string): AccountInfo | null {
  if (selector.trim().toLowerCase() === 'none') return null;
  return matchAccount(inventory.accounts, selector);
}

/** Finds one conversation among a list by any of its ids or a prefix of at least six characters. */
export function findConversation(conversations: readonly Conversation[], selector: string): Conversation {
  const needle = selector.trim().toLowerCase();
  const idsOf = (conversation: Conversation): string[] =>
    [conversation.key, conversation.record?.record.sessionId, conversation.cliSessionId, conversation.transcript?.cliSessionId]
      .filter((id): id is string => typeof id === 'string')
      .map((id) => id.toLowerCase());
  const exact = conversations.filter((conversation) => idsOf(conversation).includes(needle));
  const matches =
    exact.length > 0
      ? exact
      : needle.length >= 6
        ? conversations.filter((conversation) => idsOf(conversation).some((id) => id.startsWith(needle) || id.startsWith(`local_${needle}`)))
        : [];
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`no conversation matches "${selector}"`);
  throw new Error(`"${selector}" is ambiguous (${matches.length} matches)`);
}

/** The id a conversation is shown with: the record id, else the CLI session id. */
function conversationId(conversation: Conversation): string {
  return conversation.record?.record.sessionId ?? conversation.cliSessionId ?? conversation.key;
}

function conversationJson(conversation: Conversation, accounts: readonly AccountInfo[], target: readonly Conversation[] | null): Record<string, unknown> {
  const assessment = target ? assessSync(conversation, target) : null;
  return {
    key: conversation.key,
    sessionId: conversation.record?.record.sessionId ?? null,
    cliSessionId: conversation.cliSessionId,
    title: conversation.title,
    cwd: conversation.cwd,
    origin: describeOrigin(conversation, accounts),
    flags: conversation.flags,
    createdAt: conversation.createdAt,
    lastActivityAt: conversation.lastActivityAt,
    sizeBytes: conversation.sizeBytes,
    promptCount: conversation.promptCount,
    messageCount: conversation.messageCount,
    email: conversation.email,
    transcript: conversation.transcript?.path ?? null,
    ...(assessment
      ? {
          state: assessment.state,
          comparison: assessment.comparison,
          existingSessionId: assessment.existing?.record?.record.sessionId ?? null,
          warnings: assessment.warnings,
        }
      : {}),
  };
}

function conversationRow(conversation: Conversation, accounts: readonly AccountInfo[], target: readonly Conversation[] | null): string[] {
  const row = [
    conversationId(conversation),
    truncate(conversation.title, 48),
    shortenPath(conversation.cwd, 30),
    formatWhen(conversation.lastActivityAt),
    conversation.promptCount === null ? '-' : String(conversation.promptCount),
    formatSize(conversation.sizeBytes),
    describeOrigin(conversation, accounts),
    describeFlags(conversation),
  ];
  if (target) {
    const assessment = assessSync(conversation, target);
    row.push(`${describeState(assessment.state)}${assessment.comparison ? ` (${describeComparison(assessment)})` : ''}`);
  }
  return row;
}

/**
 * One result line of a transfer, as `ccas transfer` prints it and the TUI
 * shows it: what happened to the conversation and on which account, with
 * the new record id, the SSH host step and the journal id where there are
 * any. A dry run gets a "[dry-run] " prefix.
 */
export function describeOutcome(outcome: TransferOutcome): string {
  const target = accountLabel(outcome.item.target);
  const prefix = outcome.dryRun ? '[dry-run] ' : '';
  const ids = outcome.newSessionId ? ` as ${outcome.newSessionId}` : '';
  const reason = outcome.reason ? `: ${outcome.reason}` : '';
  const journal = outcome.journalId ? ` [journal ${outcome.journalId}]` : '';
  const host = outcome.host ? `, ${outcome.host}` : '';
  const title = truncate(outcome.item.source.title, 60);
  switch (outcome.action) {
    case 'created':
      return `${prefix}created "${title}" on ${target}${ids}${host}${journal}`;
    case 'updated':
      return `${prefix}updated "${title}" on ${target}${host}${journal}`;
    case 'repaired':
      return `${prefix}repaired "${title}" on ${target}${reason}${journal}`;
    case 'moved':
      return `${prefix}moved "${title}" to ${target}${reason}${host}${journal}`;
    case 'up-to-date':
      return `${prefix}up to date "${title}" on ${target}`;
    case 'skipped':
      return `${prefix}skipped "${title}"${reason}`;
    case 'refused':
      return `${prefix}REFUSED "${title}"${reason}${journal}`;
    default:
      return `${prefix}FAILED "${title}"${reason}${journal}`;
  }
}

/**
 * The last line of a transfer: how many conversations ended how. The six
 * counts always appear, in this order; repaired, moved and refused only when
 * some were.
 */
export function summaryLine(tally: ReadonlyMap<OutcomeAction, number>, excluded: number): string {
  const count = (action: OutcomeAction): number => tally.get(action) ?? 0;
  const parts = [
    `${count('created')} created`,
    `${count('updated')} updated`,
    `${count('up-to-date')} up to date`,
    `${count('skipped')} skipped`,
    `${excluded} excluded`,
    `${count('failed')} failed`,
  ];
  if (count('repaired') > 0) parts.push(`${count('repaired')} repaired`);
  if (count('moved') > 0) parts.push(`${count('moved')} moved`);
  if (count('refused') > 0) parts.push(`${count('refused')} refused`);
  return `summary: ${parts.join(', ')}`;
}

/** Builds the transfer items for a batch, resolving conflicts with one policy. */
export function planTransfers(
  inventory: Inventory,
  source: AccountDir | null,
  target: AccountInfo,
  conversations: readonly Conversation[],
  mode: TransferMode,
  onConflict: ConflictPolicy,
): TransferItem[] {
  const targetConversations = conversationsOf(inventory, target);
  void source;
  return conversations.map((conversation) => ({
    source: conversation,
    target,
    mode,
    assessment: assessSync(conversation, targetConversations),
    onConflict,
  }));
}

function hasTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** For commands that only read: a warning on stderr about interrupted operations, nothing more. */
async function warnInterrupted(session: Session, io: Io): Promise<void> {
  const entries = await session.journal.interrupted();
  if (entries.length > 0) io.err(`warning: ${interruptedHelp(entries)}\n`);
}

/**
 * Before a command writes: operations an earlier run left interrupted are
 * settled first. With a terminal the person is asked (undo, leave, exit);
 * without one the command stops with the instructions. `except` leaves out
 * the entry the command is about to restore itself.
 *   clear    nothing to settle, or everything left as it is
 *   changed  something was undone: files changed, plans made before are stale
 *   exit     stop (the caller exits with EXIT_INTERRUPTED)
 */
async function settleInterrupted(session: Session, io: Io, except?: string): Promise<'clear' | 'changed' | 'exit'> {
  const entries = await session.journal.interrupted(except);
  if (entries.length === 0) return 'clear';
  if (!hasTerminal()) {
    io.err(`${interruptedHelp(entries)}\n`);
    return 'exit';
  }
  const { askAboutInterrupted } = await import('./tui/interrupted.ts');
  const answer = await askAboutInterrupted({ paths: session.paths, journal: session.journal, lineage: session.lineage, dryRun: false }, entries);
  if (answer.choice === 'exit') return 'exit';
  return answer.changedFiles ? 'changed' : 'clear';
}

async function runAccounts(session: Session, io: Io, json: boolean): Promise<number> {
  const inventory = await inventoryOf(session);
  await warnInterrupted(session, io);
  if (json) {
    io.out(`${JSON.stringify(inventory.accounts.map((account) => ({ ...account, key: accountKey(account.accountId, account.orgId) })), null, 2)}\n`);
    return EXIT_OK;
  }
  if (inventory.accounts.length === 0) {
    io.out(`No account directories under ${session.paths.sessionsRoot}\n`);
    return EXIT_OK;
  }
  io.out(`${renderTable([ACCOUNT_HEADER, ...inventory.accounts.map(accountRow)])}\n`);
  io.out(`unlisted transcripts (no record on any account): ${inventory.unlisted.length}\n`);
  for (const problem of inventory.problems) io.err(`warning: ${problem}\n`);
  return EXIT_OK;
}

async function runList(session: Session, io: Io, from: string, to: string | undefined, json: boolean): Promise<number> {
  const inventory = await inventoryOf(session);
  await warnInterrupted(session, io);
  const source = accountOrNone(inventory, from);
  const target = to === undefined ? null : matchAccount(inventory.accounts, to);
  const conversations = conversationsOf(inventory, source);
  const targetConversations = target ? conversationsOf(inventory, target) : null;
  if (json) {
    io.out(`${JSON.stringify(conversations.map((conversation) => conversationJson(conversation, inventory.accounts, targetConversations)), null, 2)}\n`);
    return EXIT_OK;
  }
  const header = ['id', 'title', 'project', 'last activity', 'prompts', 'size', 'origin', 'flags'];
  if (target) header.push(`vs ${accountLabel(target)}`);
  io.out(`${conversations.length} conversation${conversations.length === 1 ? '' : 's'} on ${source ? accountLabel(source) : 'no account'}\n`);
  if (conversations.length > 0) {
    io.out(`${renderTable([header, ...conversations.map((conversation) => conversationRow(conversation, inventory.accounts, targetConversations))])}\n`);
  }
  return EXIT_OK;
}

interface TransferOptions {
  from: string;
  to: string;
  mode: TransferMode;
  /** Conversations named one by one (--session). */
  sessions: string[];
  /** Every conversation of the source (--all), minus `excludes`. */
  all: boolean;
  excludes: string[];
  onConflict: ConflictPolicy;
  dryRun: boolean;
}

interface TransferPlan {
  items: TransferItem[];
  excluded: Conversation[];
}

/**
 * Turns the command line into transfer items. Every selector must name
 * exactly one conversation of the source, otherwise this throws, before
 * anything is written. The same conversation named twice counts once; nothing
 * else is merged: two conversations are two, however alike they look.
 */
async function planTransfer(session: Session, options: TransferOptions): Promise<TransferPlan> {
  const inventory = await inventoryOf(session);
  const source = accountOrNone(inventory, options.from);
  const target = matchAccount(inventory.accounts, options.to);
  const pool = conversationsOf(inventory, source);
  const excluded = [...new Set(options.excludes.map((selector) => findConversation(pool, selector)))];
  const chosen = options.all
    ? pool.filter((conversation) => !excluded.includes(conversation))
    : [...new Set(options.sessions.map((selector) => findConversation(pool, selector)))];
  return { excluded, items: planTransfers(inventory, source, target, chosen, options.mode, options.onConflict) };
}

async function runTransfer(session: Session, io: Io, options: TransferOptions): Promise<number> {
  let plan = await planTransfer(session, options);
  if (options.dryRun) {
    await warnInterrupted(session, io);
  } else {
    // The guard is consulted inside every operation, right before it writes; the
    // early check only spares a batch from starting when Claude Code is up.
    const gate = await makeGuard(session.paths)();
    if (!gate.allowed) {
      io.err(`refused: ${gate.reason}\n`);
      return EXIT_REFUSED;
    }
    const settled = await settleInterrupted(session, io);
    if (settled === 'exit') return EXIT_INTERRUPTED;
    if (settled === 'changed') plan = await planTransfer(session, options);
  }

  const prefix = options.dryRun ? '[dry-run] ' : '';
  for (const conversation of plan.excluded) io.out(`${prefix}excluded "${truncate(conversation.title, 60)}" (${conversationId(conversation)})\n`);
  const context = { paths: session.paths, journal: session.journal, lineage: session.lineage, dryRun: options.dryRun };
  const tally = new Map<OutcomeAction, number>();
  for (const item of plan.items) {
    const outcome = await executeTransfer(context, item);
    io.out(`${describeOutcome(outcome)}\n`);
    for (const warning of outcome.warnings) io.out(`  warning: ${warning}\n`);
    tally.set(outcome.action, (tally.get(outcome.action) ?? 0) + 1);
  }
  const wrote = (['created', 'updated', 'repaired', 'moved'] as const).some((action) => (tally.get(action) ?? 0) > 0);
  if (!options.dryRun && wrote) {
    io.out('Start the Claude app to see the result; it reads session records at start-up.\n');
  }
  io.out(`${prefix}${summaryLine(tally, plan.excluded.length)}\n`);
  if ((tally.get('refused') ?? 0) > 0) return EXIT_REFUSED;
  return (tally.get('failed') ?? 0) > 0 ? EXIT_PARTIAL : EXIT_OK;
}

async function runJournal(session: Session, io: Io, json: boolean): Promise<number> {
  const entries = await session.journal.list();
  if (json) {
    io.out(`${JSON.stringify(entries, null, 2)}\n`);
    await warnInterrupted(session, io);
    return EXIT_OK;
  }
  if (entries.length === 0) {
    io.out('journal is empty\n');
    return EXIT_OK;
  }
  const rows = entries.map((entry) => [entry.id, entry.at, entry.mode, entry.action, displayStatus(entry), truncate(entry.title, 50)]);
  io.out(`${renderTable([['id', 'at', 'mode', 'action', 'status', 'title'], ...rows])}\n`);
  await warnInterrupted(session, io);
  return EXIT_OK;
}

async function runRestore(session: Session, io: Io, id: string, dryRun: boolean): Promise<number> {
  if (dryRun) {
    await warnInterrupted(session, io);
  } else {
    const gate = await makeGuard(session.paths)();
    if (!gate.allowed) {
      io.err(`refused: ${gate.reason}\n`);
      return EXIT_REFUSED;
    }
    // Restoring an interrupted entry is itself how it gets settled, and other
    // interrupted entries must not stand in its way (each could then only be
    // restored after the others). Undoing a finished operation waits until
    // every interrupted one is settled.
    const target = await session.journal.get(id);
    if (target?.status !== 'running' && (await settleInterrupted(session, io)) === 'exit') return EXIT_INTERRUPTED;
  }
  let result;
  try {
    result = await restoreEntry({ paths: session.paths, journal: session.journal, lineage: session.lineage, dryRun }, id);
  } catch (error) {
    if (error instanceof GuardRefusal) {
      io.err(`refused: ${error.message}\n`);
      return EXIT_REFUSED;
    }
    throw error;
  }
  const prefix = dryRun ? '[dry-run] ' : '';
  io.out(`${prefix}restore of ${result.entry.id} (${result.entry.mode} ${result.entry.action}, "${truncate(result.entry.title, 60)}")\n`);
  for (const step of result.steps) io.out(`  ${prefix}${step}\n`);
  for (const warning of result.warnings) io.out(`  warning: ${warning}\n`);
  if (result.restoreJournalId) io.out(`journal ${result.restoreJournalId}\n`);
  return EXIT_OK;
}

/** Keeps the files of an interrupted operation as they are; only the tool's own journal changes. */
async function runResolve(session: Session, io: Io, id: string): Promise<number> {
  const entry = await session.journal.resolve(id);
  io.out(
    `resolved ${entry.id}: its files stay as they are (${entry.created.length} created, ${entry.moved.length} moved, ${entry.backedUp.length} backed up); ` +
      `"ccas restore ${entry.id}" can still undo it\n`,
  );
  return EXIT_OK;
}

const OPTION_SPEC = {
    help: { type: 'boolean' as const, short: 'h' },
    version: { type: 'boolean' as const },
    json: { type: 'boolean' as const },
    'dry-run': { type: 'boolean' as const },
    from: { type: 'string' as const },
    to: { type: 'string' as const },
    mode: { type: 'string' as const },
    session: { type: 'string' as const, multiple: true as const },
    all: { type: 'boolean' as const },
    exclude: { type: 'string' as const, multiple: true as const },
    'on-conflict': { type: 'string' as const },
    'user-data': { type: 'string' as const },
    'claude-dir': { type: 'string' as const },
    data: { type: 'string' as const },
} as const;

function parse(argv: string[]): ReturnType<typeof parseArgs<{ options: typeof OPTION_SPEC; allowPositionals: true; strict: true }>> {
  return parseArgs({ args: argv, options: OPTION_SPEC, allowPositionals: true, strict: true });
}

/**
 * Runs one command line (the arguments after the script path) and resolves
 * to the exit code. Usage and operation errors are reported through `io`
 * and end with EXIT_USAGE instead of a rejection. Without a command it
 * starts the TUI.
 */
export async function main(argv: string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err(`${(error as Error).message}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(USAGE);
    return EXIT_OK;
  }
  if (values.version) {
    io.out(`${version()}\n`);
    return EXIT_OK;
  }
  const paths = resolvePaths({ userData: values['user-data'], claudeDir: values['claude-dir'], data: values.data });
  const command = positionals[0];
  try {
    const session = await openSession(paths);
    switch (command) {
      case undefined: {
        const { runTui } = await import('./tui/index.ts');
        return runTui(session, { dryRun: values['dry-run'] === true });
      }
      case 'accounts':
        return await runAccounts(session, io, values.json === true);
      case 'list':
        if (!values.from) throw new Error('list needs --from <account|none>');
        return await runList(session, io, values.from, values.to, values.json === true);
      case 'transfer': {
        if (!values.from || !values.to) throw new Error('transfer needs --from and --to');
        if (values.mode !== 'copy' && values.mode !== 'move') throw new Error('transfer needs --mode copy|move');
        const onConflict = values['on-conflict'] ?? 'skip';
        if (onConflict !== 'skip' && onConflict !== 'overwrite') throw new Error('--on-conflict must be skip or overwrite');
        const sessions = values.session ?? [];
        const excludes = values.exclude ?? [];
        const all = values.all === true;
        if (all && sessions.length > 0) throw new Error('--all and --session cannot be combined');
        if (!all && excludes.length > 0) throw new Error('--exclude only works together with --all');
        if (!all && sessions.length === 0) throw new Error('transfer needs --all or at least one --session <id>');
        return await runTransfer(session, io, {
          from: values.from,
          to: values.to,
          mode: values.mode,
          sessions,
          all,
          excludes,
          onConflict,
          dryRun: values['dry-run'] === true,
        });
      }
      case 'journal':
        return await runJournal(session, io, values.json === true);
      case 'restore': {
        const id = positionals[1];
        if (!id) throw new Error('restore needs a journal id');
        return await runRestore(session, io, id, values['dry-run'] === true);
      }
      case 'resolve': {
        const id = positionals[1];
        if (!id) throw new Error('resolve needs a journal id');
        return await runResolve(session, io, id);
      }
      default:
        io.err(`unknown command "${command}"\n${USAGE}`);
        return EXIT_USAGE;
    }
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }
}

/** True when this file is the process entry point, also through the bin symlink npm creates. */
function isEntryPoint(): boolean {
  const meta = import.meta as { main?: boolean };
  if (typeof meta.main === 'boolean') return meta.main;
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const io: Io = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) };
  main(process.argv.slice(2), io).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      io.err(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = EXIT_USAGE;
    },
  );
}
