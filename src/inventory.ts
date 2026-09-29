// The inventory: every conversation the tool can see, with its account, its
// transcript and how it relates to the copies on other accounts.
//
// Two kinds of conversation exist:
//   - listed: a record on some account plus (usually) a transcript
//   - unlisted: a transcript that no record on any account points at, which
//     is what sessions driven from claude.ai (Remote Control) or from a
//     terminal leave behind
//
// Every entry in the app's side panel is a conversation of its own, and the
// tool does not judge conversations: it never decides from their content
// whether two of them are "the same", similar, short or unfinished. A
// conversation on the source and one on the target are treated as one
// conversation (a copy to bring up to date) only on explicit evidence:
//   (a) they have the same record id (a record moved between accounts)
//   (b) lineage.json links them, in either direction (for a transcript
//       without a record, by its CLI session id)
//   (c) the ccas stamp of either record names the other one
// Anything else is new on the target, even when it starts exactly like a
// conversation there (a fork does). Only for a linked pair are the transcripts
// compared, to tell whether the copy is up to date, behind, ahead, diverged or
// holds a different conversation now.
import path from 'node:path';
import {
  AccountStore,
  accountKey,
  discoverAccountDirs,
  readCliOauthAccount,
  readLastKnownAccountUuid,
  resolveEmail,
  type AccountDir,
  type AccountInfo,
  type CliOauthAccount,
  type EmailVote,
} from './accounts.ts';
import { compareChains, consistencyWarnings, type ChainComparison } from './compare.ts';
import type { Paths } from './paths.ts';
import { effectiveCliSessionId, readRecords, transcriptRefs, type LoadedRecord } from './records.ts';
import type { LineageEndpoint, LineageLink, LineageStore } from './lineage.ts';
import type { SummaryCache } from './summary-cache.ts';
import { listTranscripts, summarizeTranscript, type TranscriptLocation, type TranscriptSummary } from './transcripts.ts';

/**
 * Where a conversation came from:
 *   desktop          started in the desktop app, has a record
 *   remote-control   has a record and was driven from claude.ai at some point
 *   claude.ai        no record; driven from claude.ai through the local app
 *   desktop-unlisted no record although the desktop CLI ran it (never persisted or removed)
 *   terminal         no record; run by the CLI outside the desktop app
 *   unknown          no record and no entrypoint marker in the transcript
 */
export type Origin = 'desktop' | 'remote-control' | 'claude.ai' | 'desktop-unlisted' | 'terminal' | 'unknown';

export type ConversationFlag = 'archived' | 'no-transcript' | 'adopted';

export interface Conversation {
  /**
   * First transcript uuid, or the CLI session id when there is none: shown in
   * lists and accepted as a selector. It is not an identity: a fork shares it
   * with its parent. Which conversations are copies of each other is decided
   * by `links` and record ids (see assessSync).
   */
  key: string;
  keySource: 'root-uuid' | 'cli-session-id';
  /** Account whose directory holds the record; null for unlisted transcripts. */
  account: AccountDir | null;
  record: LoadedRecord | null;
  /** The CLI session the app would resume (or the transcript's own id when unlisted). */
  cliSessionId: string | null;
  transcript: TranscriptLocation | null;
  summary: TranscriptSummary | null;
  origin: Origin;
  /** Account on the claude.ai side, when the transcript carries bridge-session lines. */
  bridgeOwner: { accountId: string; orgId: string | null } | null;
  flags: ConversationFlag[];
  title: string;
  cwd: string | null;
  createdAt: number | null;
  lastActivityAt: number;
  sizeBytes: number;
  promptCount: number | null;
  messageCount: number | null;
  /** Last account e-mail seen in the transcript. */
  email: string | null;
  /**
   * The other ends of every link that names this conversation: lineage links
   * in both directions and ccas stamps, its own and those that name it. Filled
   * in by buildInventory once every conversation is known.
   */
  links: LineageEndpoint[];
}

export interface Inventory {
  accounts: AccountInfo[];
  /** Listed conversations per account key (accountId/orgId). */
  byAccount: Map<string, Conversation[]>;
  unlisted: Conversation[];
  problems: string[];
  cli: CliOauthAccount | null;
  loggedInAccountId: string | null;
}

export interface BuildOptions {
  store: AccountStore;
  cache?: SummaryCache | undefined;
  /**
   * Links between copies made by this tool: they decide which conversations
   * are copies of each other, and they keep copies from voting with the
   * source account's e-mail. Without it only the record stamps link copies.
   */
  lineage?: LineageStore | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

async function summarize(location: TranscriptLocation, cache: SummaryCache | undefined): Promise<TranscriptSummary> {
  const cached = cache?.get(location.path, location.sizeBytes, location.mtimeMs);
  if (cached) return cached;
  const summary = await summarizeTranscript(location.path);
  cache?.set(location.path, location.sizeBytes, location.mtimeMs, summary);
  return summary;
}

function originOf(record: LoadedRecord | null, summary: TranscriptSummary | null): Origin {
  if (record) return summary?.bridge ? 'remote-control' : 'desktop';
  if (!summary) return 'unknown';
  if (summary.bridge) return 'claude.ai';
  if (summary.entrypoints.includes('claude-desktop')) return 'desktop-unlisted';
  if (summary.entrypoints.length > 0) return 'terminal';
  return 'unknown';
}

function titleOf(record: LoadedRecord | null, summary: TranscriptSummary | null): string {
  const recorded = record?.record.title;
  if (typeof recorded === 'string' && recorded.trim().length > 0) return recorded.trim();
  return summary?.customTitle ?? summary?.firstUserText ?? '(untitled)';
}

function buildConversation(
  account: AccountDir | null,
  record: LoadedRecord | null,
  cliSessionId: string | null,
  transcript: TranscriptLocation | null,
  summary: TranscriptSummary | null,
): Conversation {
  const rootUuid = summary?.rootUuid ?? null;
  const key = rootUuid ?? cliSessionId ?? record?.record.sessionId ?? transcript?.cliSessionId ?? 'unknown';
  const flags: ConversationFlag[] = [];
  if (record?.record.isArchived === true) flags.push('archived');
  if (record && !transcript) flags.push('no-transcript');
  const bridgeOwner =
    summary?.bridge?.ownerAccountId ? { accountId: summary.bridge.ownerAccountId, orgId: summary.bridge.ownerOrgId } : null;
  if (record && (record.record.adoptedFromOtherSurface === true || (bridgeOwner && account && bridgeOwner.accountId !== account.accountId))) {
    flags.push('adopted');
  }
  const recordActivity = record?.record.lastActivityAt;
  const summaryLast = summary?.lastTimestamp ? Date.parse(summary.lastTimestamp) : Number.NaN;
  const lastActivityAt =
    typeof recordActivity === 'number'
      ? recordActivity
      : Number.isFinite(summaryLast)
        ? summaryLast
        : (transcript?.mtimeMs ?? 0);
  const summaryFirst = summary?.firstTimestamp ? Date.parse(summary.firstTimestamp) : Number.NaN;
  return {
    key,
    keySource: rootUuid ? 'root-uuid' : 'cli-session-id',
    account,
    record,
    cliSessionId,
    transcript,
    summary,
    origin: originOf(record, summary),
    bridgeOwner,
    flags,
    title: titleOf(record, summary),
    cwd: record?.record.cwd ?? summary?.cwd ?? null,
    createdAt: record?.record.createdAt ?? (Number.isFinite(summaryFirst) ? summaryFirst : null),
    lastActivityAt,
    sizeBytes: transcript?.sizeBytes ?? 0,
    promptCount: summary?.promptCount ?? null,
    messageCount: summary?.messageCount ?? null,
    email: summary?.emails.at(-1) ?? null,
    links: [],
  };
}

/**
 * How lineage links and stamps name a conversation: its account and record
 * id, plus the CLI session id; a transcript without a record has only the
 * CLI session id.
 */
export function endpointOf(conversation: Conversation): LineageEndpoint {
  return {
    accountId: conversation.account?.accountId,
    orgId: conversation.account?.orgId,
    sessionId: conversation.record?.record.sessionId,
    cliSessionId: conversation.cliSessionId ?? conversation.transcript?.cliSessionId ?? 'unknown',
  };
}

/**
 * Whether a recorded endpoint names this conversation. A conversation with a
 * record is named by its account and record id: the record id survives
 * everything the app does to a record, while the CLI session id does not (the
 * app clears it when resuming a copy fails and starts a new session). A
 * transcript without a record has nothing but its CLI session id.
 */
export function refersTo(endpoint: LineageEndpoint, conversation: Conversation): boolean {
  if (conversation.record && conversation.account) {
    return (
      endpoint.sessionId === conversation.record.record.sessionId &&
      endpoint.accountId === conversation.account.accountId &&
      endpoint.orgId === conversation.account.orgId
    );
  }
  return endpoint.accountId === undefined && endpoint.sessionId === undefined && endpoint.cliSessionId === conversation.cliSessionId;
}

/**
 * Fills Conversation.links: for every lineage link and every ccas stamp, each
 * conversation one end names gets the other end. Both directions are
 * recorded, so a copy is found from its original and the original from its
 * copy, whichever account is the source of a later transfer.
 */
function linkConversations(conversations: readonly Conversation[], links: readonly LineageLink[]): void {
  const connect = (a: LineageEndpoint, b: LineageEndpoint): void => {
    for (const conversation of conversations) {
      if (refersTo(a, conversation)) conversation.links.push(b);
      if (refersTo(b, conversation)) conversation.links.push(a);
    }
  };
  for (const link of links) connect(link.source, link.target);
  for (const conversation of conversations) {
    const copiedFrom = conversation.record?.record.ccas?.copiedFrom;
    if (copiedFrom) connect(endpointOf(conversation), copiedFrom);
  }
}

/**
 * The e-mail a listed conversation may vote with. A copy made by this tool
 * still carries the source account's session_context lines, so only sightings
 * past the copy point count: those were written after the target account
 * continued the copy. The copy point comes from the record stamp, or from
 * lineage when the app dropped the stamp.
 */
function voteEmail(conversation: Conversation, lineage: LineageStore | undefined): string | null {
  const summary = conversation.summary;
  const record = conversation.record?.record;
  if (!summary || !record) return null;
  let cutoff = record.ccas?.sourceLineCount ?? 0;
  if (lineage) {
    for (const link of lineage.all()) {
      if (link.target.sessionId === record.sessionId && link.target.accountId === conversation.account?.accountId) {
        cutoff = Math.max(cutoff, link.sourceLineCount ?? 0);
      }
    }
  }
  return summary.emailSightings.filter((sighting) => sighting.line > cutoff).at(-1)?.email ?? null;
}

/** Reads every account directory and every transcript once and assembles the inventory. */
export async function buildInventory(paths: Paths, options: BuildOptions): Promise<Inventory> {
  const progress = options.onProgress ?? (() => undefined);
  const problems: string[] = [];

  progress('Scanning account directories');
  const dirs = await discoverAccountDirs(paths.sessionsRoot);

  progress('Listing transcripts');
  const transcripts = await listTranscripts(paths.projectsRoot);
  const byCli = new Map(transcripts.map((location) => [location.cliSessionId, location]));

  const byAccount = new Map<string, Conversation[]>();
  const referenced = new Set<string>();
  const votes = new Map<string, Map<string, number>>();
  let done = 0;
  const total = transcripts.length;

  for (const dir of dirs) {
    const key = accountKey(dir.accountId, dir.orgId);
    const { records, problems: recordProblems } = await readRecords(dir.dir);
    problems.push(...recordProblems);
    const conversations: Conversation[] = [];
    for (const loaded of records) {
      for (const ref of transcriptRefs(loaded.record)) referenced.add(ref);
      const cliSessionId = effectiveCliSessionId(loaded.record) ?? null;
      const transcript = cliSessionId ? (byCli.get(cliSessionId) ?? null) : null;
      let summary: TranscriptSummary | null = null;
      if (transcript) {
        progress(`Reading transcripts (${++done}/${total})`);
        summary = await summarize(transcript, options.cache);
      }
      const conversation = buildConversation(dir, loaded, cliSessionId, transcript, summary);
      conversations.push(conversation);
      // A transcript votes for the e-mail of the directory that lists it, unless
      // the bridge owner says the session really ran under another account.
      const email = voteEmail(conversation, options.lineage);
      const ownedElsewhere = conversation.bridgeOwner !== null && conversation.bridgeOwner.accountId !== dir.accountId;
      if (email && !ownedElsewhere) {
        const tally = votes.get(key) ?? new Map<string, number>();
        tally.set(email, (tally.get(email) ?? 0) + 1);
        votes.set(key, tally);
      }
    }
    conversations.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    byAccount.set(key, conversations);
  }

  const unlisted: Conversation[] = [];
  for (const location of transcripts) {
    if (referenced.has(location.cliSessionId)) continue;
    progress(`Reading transcripts (${++done}/${total})`);
    const summary = await summarize(location, options.cache);
    unlisted.push(buildConversation(null, null, location.cliSessionId, location, summary));
  }
  unlisted.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  await options.cache?.save();
  linkConversations([...[...byAccount.values()].flat(), ...unlisted], options.lineage?.all() ?? []);

  progress('Resolving accounts');
  const cli = await readCliOauthAccount(paths.cliConfigFile);
  const loggedInAccountId = await readLastKnownAccountUuid(paths.desktopConfigFile);
  const accounts: AccountInfo[] = [];
  for (const dir of dirs) {
    const key = accountKey(dir.accountId, dir.orgId);
    const tally = votes.get(key) ?? new Map<string, number>();
    const emailVotes: EmailVote[] = [...tally.entries()].map(([email, count]) => ({ email, count }));
    const stored = options.store.find(dir.accountId, dir.orgId);
    const resolution = resolveEmail(dir, cli, emailVotes, stored);
    const entry = options.store.ensure(dir.accountId, dir.orgId);
    if (resolution.email && (resolution.source === 'cli-config' || resolution.source === 'transcripts')) {
      options.store.setEmail(dir.accountId, dir.orgId, resolution.email, resolution.source);
    }
    // The organization name is only ever known from the CLI login, so it is
    // remembered whenever the login names this directory.
    if (cli?.organizationName && cli.accountUuid === dir.accountId && (cli.organizationUuid === null || cli.organizationUuid === dir.orgId)) {
      options.store.setOrgName(dir.accountId, dir.orgId, cli.organizationName);
    }
    accounts.push({
      ...dir,
      email: resolution.email,
      emailSource: resolution.source,
      emailEvidence: resolution.evidence,
      name: entry.name,
      orgName: entry.orgName,
      loggedIn: loggedInAccountId === dir.accountId,
      sessionCount: byAccount.get(key)?.length ?? 0,
    });
  }
  await options.store.save();

  return { accounts, byAccount, unlisted, problems, cli, loggedInAccountId };
}

/**
 * new               the target has no copy of this conversation
 * up-to-date        the copy holds the same transcript
 * update-available  the copy is behind (or has no transcript yet)
 * target-ahead      the copy went further than the source
 * diverged          both went on after the copy was made
 * unrelated         the linked copy holds a different conversation now, e.g.
 *                   the app started a new session in it
 * ambiguous         more than one conversation on the target is linked to it
 * no-transcript     the source record has no transcript
 */
export type SyncState =
  | 'new'
  | 'up-to-date'
  | 'update-available'
  | 'target-ahead'
  | 'diverged'
  | 'unrelated'
  | 'ambiguous'
  | 'no-transcript';

export interface SyncAssessment {
  state: SyncState;
  /** The copy already on the target account, when there is exactly one. */
  existing: Conversation | null;
  comparison: ChainComparison | null;
  warnings: string[];
}

/**
 * Whether two conversations on two accounts are one conversation: the same
 * record id, or a link between them (lineage or stamp, either direction).
 * Content never counts.
 */
export function isSameConversation(a: Conversation, b: Conversation): boolean {
  const recordId = a.record?.record.sessionId;
  if (recordId !== undefined && recordId === b.record?.record.sessionId) return true;
  return a.links.some((endpoint) => refersTo(endpoint, b)) || b.links.some((endpoint) => refersTo(endpoint, a));
}

/** How a source conversation relates to what the target account already holds. */
export function assessSync(source: Conversation, targetConversations: readonly Conversation[]): SyncAssessment {
  const linked = targetConversations.filter((candidate) => isSameConversation(source, candidate));
  if (linked.length > 1) {
    const ids = linked.map((candidate) => candidate.record?.record.sessionId ?? candidate.cliSessionId ?? candidate.key);
    return { state: 'ambiguous', existing: null, comparison: null, warnings: [`linked to: ${ids.join(', ')}`] };
  }
  const existing = linked[0] ?? null;
  if (!source.transcript) {
    return { state: 'no-transcript', existing, comparison: null, warnings: [] };
  }
  if (!existing) return { state: 'new', existing: null, comparison: null, warnings: [] };
  if (!existing.summary || !source.summary) {
    return { state: 'update-available', existing, comparison: null, warnings: ['target copy has no transcript; it will receive one'] };
  }
  const comparison = compareChains(source.summary.uuidChain, existing.summary.uuidChain);
  const warnings = consistencyWarnings(
    { record: source.record?.record, summary: source.summary },
    { record: existing.record?.record, summary: existing.summary },
  );
  const state: SyncState = (
    {
      identical: 'up-to-date',
      'target-behind': 'update-available',
      'target-ahead': 'target-ahead',
      diverged: 'diverged',
      unrelated: 'unrelated',
    } as const
  )[comparison.relation];
  return { state, existing, comparison, warnings };
}

/** Conversations of one account, or the unlisted ones for the pseudo-account "none". */
export function conversationsOf(inventory: Inventory, account: AccountDir | null): Conversation[] {
  if (account === null) return inventory.unlisted;
  return inventory.byAccount.get(accountKey(account.accountId, account.orgId)) ?? [];
}

/** Human-readable location of a transcript relative to the projects root, for reports. */
export function describeTranscript(paths: Paths, conversation: Conversation): string {
  if (!conversation.transcript) return '(no transcript)';
  return path.relative(paths.projectsRoot, conversation.transcript.path);
}
