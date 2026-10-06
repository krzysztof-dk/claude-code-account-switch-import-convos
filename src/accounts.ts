// Accounts of the Claude desktop app and how the tool names them.
//
// The app never writes an e-mail next to a session directory; it only knows
// the account by uuid. Two pieces of local state reveal which uuid is which:
//   - <userData>/config.json: lastKnownAccountUuid marks the account that is
//     logged in right now (that key is the only thing read from the file)
//   - ~/.claude.json: the CLI's oauthAccount block (accountUuid,
//     organizationUuid, emailAddress, organizationName) for the account the
//     CLI is logged in as; the file also holds other state, and nothing but
//     those four fields is read or kept (field names confirmed against a real
//     file on 2026-09-22)
// Transcripts add a third source: newer CLI versions inject a session_context
// attachment with the user's e-mail into every session, so the sessions of an
// account directory vote for its e-mail (see inventory.ts for the votes).
//
// Whatever was found is remembered in <dataDir>/accounts.json, so an account
// keeps its e-mail after the CLI logs into another one. The person can add a
// display name; a manual e-mail is accepted only as a last resort when no
// source knows the address.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './fsx.ts';
import { isUuid } from './records.ts';
import { listSubdirectories } from './fsx.ts';

/**
 * One account directory of the desktop app: the account and organization
 * uuids that name it and its path. discoverAccountDirs finds them under
 * claude-code-sessions, the records of the account live directly in `dir`,
 * and AccountInfo adds what the tool resolved about the account.
 */
export interface AccountDir {
  accountId: string;
  orgId: string;
  /** <sessionsRoot>/<accountId>/<orgId> */
  dir: string;
}

/**
 * The key an account directory is filed under ("accountId/orgId"): the
 * inventory's byAccount map uses it, and a person may type it on the
 * command line to name an account.
 */
export function accountKey(accountId: string, orgId: string): string {
  return `${accountId}/${orgId}`;
}

/** Every <accountId>/<orgId> pair under claude-code-sessions, in stable order. */
export async function discoverAccountDirs(sessionsRoot: string): Promise<AccountDir[]> {
  const result: AccountDir[] = [];
  for (const accountId of await listSubdirectories(sessionsRoot)) {
    if (!isUuid(accountId)) continue;
    for (const orgId of await listSubdirectories(path.join(sessionsRoot, accountId))) {
      if (!isUuid(orgId)) continue;
      result.push({ accountId, orgId, dir: path.join(sessionsRoot, accountId, orgId) });
    }
  }
  return result;
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The account uuid the desktop app last signed in with, or null when unknown. */
export async function readLastKnownAccountUuid(desktopConfigFile: string): Promise<string | null> {
  const config = await readJsonObject(desktopConfigFile);
  const value = config?.['lastKnownAccountUuid'];
  return isUuid(value) ? value : null;
}

/**
 * The CLI's login from the oauthAccount block of ~/.claude.json, reduced to
 * the four fields the tool uses (readCliOauthAccount). resolveEmail trusts
 * its e-mail for the account it names, and the inventory remembers its
 * organization name for that account.
 */
export interface CliOauthAccount {
  accountUuid: string;
  organizationUuid: string | null;
  emailAddress: string | null;
  /** Tells apart two directories of one e-mail in two organizations. */
  organizationName: string | null;
}

/**
 * The CLI's current login, reduced to the four fields the tool needs. The
 * rest of the file (including anything token-like) is dropped immediately.
 */
export async function readCliOauthAccount(cliConfigFile: string): Promise<CliOauthAccount | null> {
  const config = await readJsonObject(cliConfigFile);
  const block = config?.['oauthAccount'];
  if (block === null || typeof block !== 'object') return null;
  const fields = block as Record<string, unknown>;
  const accountUuid = fields['accountUuid'];
  if (!isUuid(accountUuid)) return null;
  const organizationUuid = fields['organizationUuid'];
  const emailAddress = fields['emailAddress'];
  const organizationName = fields['organizationName'];
  return {
    accountUuid,
    organizationUuid: isUuid(organizationUuid) ? organizationUuid : null,
    emailAddress: typeof emailAddress === 'string' && emailAddress.includes('@') ? emailAddress : null,
    organizationName: typeof organizationName === 'string' && organizationName.trim().length > 0 ? organizationName.trim() : null,
  };
}

/**
 * Where an account's e-mail came from: cli-config is the CLI login,
 * transcripts the session_context lines of the account's own sessions,
 * manual what the person typed in the TUI. Kept in accounts.json next to
 * the address, so a later run knows how much to trust it (see
 * AccountStore.setEmail).
 */
export type EmailSource = 'cli-config' | 'transcripts' | 'manual';

/**
 * One account as remembered in accounts.json between runs: the e-mail found
 * earlier and where it came from, the person's own name for the account,
 * the organization name, and when the tool first and last saw the
 * directory. AccountStore loads, changes and saves these.
 */
export interface StoredAccount {
  accountId: string;
  orgId: string;
  email: string | null;
  emailSource: EmailSource | null;
  /** Optional display name chosen by the person. */
  name: string | null;
  /** Organization name as reported by the CLI login, when it was ever seen. */
  orgName: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface AccountsFile {
  version: 1;
  accounts: StoredAccount[];
}

/** File name of the account memory in the tool's data directory (<dataDir>/accounts.json). */
export const ACCOUNTS_FILE_NAME = 'accounts.json';

/** Persistent memory of accounts: e-mails found earlier and names given by the person. */
export class AccountStore {
  private readonly file: string;
  private readonly accounts: StoredAccount[];

  private constructor(file: string, accounts: StoredAccount[]) {
    this.file = file;
    this.accounts = accounts;
  }

  static async load(dataDir: string): Promise<AccountStore> {
    const file = path.join(dataDir, ACCOUNTS_FILE_NAME);
    const parsed = await readJsonObject(file);
    const accounts: StoredAccount[] = [];
    if (parsed && Array.isArray(parsed['accounts'])) {
      for (const entry of parsed['accounts'] as unknown[]) {
        if (entry === null || typeof entry !== 'object') continue;
        const candidate = entry as Partial<StoredAccount>;
        if (!isUuid(candidate.accountId) || !isUuid(candidate.orgId)) continue;
        accounts.push({
          accountId: candidate.accountId,
          orgId: candidate.orgId,
          email: typeof candidate.email === 'string' ? candidate.email : null,
          emailSource: candidate.emailSource ?? null,
          name: typeof candidate.name === 'string' && candidate.name.length > 0 ? candidate.name : null,
          orgName: typeof candidate.orgName === 'string' && candidate.orgName.length > 0 ? candidate.orgName : null,
          firstSeenAt: typeof candidate.firstSeenAt === 'number' ? candidate.firstSeenAt : Date.now(),
          lastSeenAt: typeof candidate.lastSeenAt === 'number' ? candidate.lastSeenAt : Date.now(),
        });
      }
    }
    return new AccountStore(file, accounts);
  }

  async save(): Promise<void> {
    const data: AccountsFile = { version: 1, accounts: this.accounts };
    await writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`);
  }

  all(): readonly StoredAccount[] {
    return this.accounts;
  }

  find(accountId: string, orgId: string): StoredAccount | undefined {
    return this.accounts.find((entry) => entry.accountId === accountId && entry.orgId === orgId);
  }

  /** Returns the stored entry for a pair, creating it when the pair is new. */
  ensure(accountId: string, orgId: string): StoredAccount {
    const existing = this.find(accountId, orgId);
    if (existing) {
      existing.lastSeenAt = Date.now();
      return existing;
    }
    const created: StoredAccount = {
      accountId,
      orgId,
      email: null,
      emailSource: null,
      name: null,
      orgName: null,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.accounts.push(created);
    return created;
  }

  setOrgName(accountId: string, orgId: string, orgName: string): void {
    this.ensure(accountId, orgId).orgName = orgName;
  }

  setName(accountId: string, orgId: string, name: string | null): void {
    const entry = this.ensure(accountId, orgId);
    entry.name = name && name.trim().length > 0 ? name.trim() : null;
  }

  /**
   * Records an e-mail for a pair. Automatic sources overwrite older automatic
   * values and manual ones; a manual value only fills a gap, never replaces a
   * detected address (the detection is the better evidence).
   */
  setEmail(accountId: string, orgId: string, email: string, source: EmailSource): boolean {
    const entry = this.ensure(accountId, orgId);
    if (source === 'manual' && entry.email !== null && entry.emailSource !== 'manual') return false;
    entry.email = email;
    entry.emailSource = source;
    return true;
  }
}

/**
 * How many sessions of one account directory name an e-mail in their
 * session_context lines. The inventory counts them (for a copy, only lines
 * past the copy point) and resolveEmail takes the majority.
 */
export interface EmailVote {
  email: string;
  count: number;
}

/**
 * The e-mail chosen for an account directory, where it came from ("stored"
 * means remembered in accounts.json rather than found in this run), and a
 * short justification the account table shows next to it. All three are
 * null when no source knows the address.
 */
export interface EmailResolution {
  email: string | null;
  source: EmailSource | 'stored' | null;
  /** Human-readable justification shown next to the address. */
  evidence: string | null;
}

/**
 * Picks the e-mail of one account directory from the available evidence, in
 * order of reliability: the CLI login when it names this account, then the
 * majority of the account's own sessions, then whatever was remembered.
 */
export function resolveEmail(
  account: AccountDir,
  cli: CliOauthAccount | null,
  votes: readonly EmailVote[],
  stored: StoredAccount | undefined,
): EmailResolution {
  if (cli && cli.accountUuid === account.accountId && cli.emailAddress) {
    // The org uuid may be missing from older CLI state; the account uuid alone
    // is unambiguous enough for an address.
    if (cli.organizationUuid === null || cli.organizationUuid === account.orgId) {
      return { email: cli.emailAddress, source: 'cli-config', evidence: 'CLI login (~/.claude.json)' };
    }
  }
  const sorted = [...votes].sort((a, b) => b.count - a.count || a.email.localeCompare(b.email));
  const winner = sorted[0];
  if (winner) {
    const total = votes.reduce((sum, vote) => sum + vote.count, 0);
    return {
      email: winner.email,
      source: 'transcripts',
      evidence: `${winner.count} of ${total} session${total === 1 ? '' : 's'} name it`,
    };
  }
  if (stored?.email) {
    const how = stored.emailSource === 'manual' ? 'entered manually' : `remembered from ${new Date(stored.lastSeenAt).toISOString().slice(0, 10)}`;
    return { email: stored.email, source: 'stored', evidence: how };
  }
  return { email: null, source: null, evidence: null };
}

/**
 * An account directory with everything the tool resolved about it, as
 * buildInventory assembles it: the e-mail and its evidence, the person's
 * name for it, the organization name, whether the app is signed in with it,
 * and how many records it holds. The CLI, the TUI and format.ts show
 * accounts from this.
 */
export interface AccountInfo extends AccountDir {
  email: string | null;
  emailSource: EmailSource | 'stored' | null;
  emailEvidence: string | null;
  name: string | null;
  orgName: string | null;
  /** The desktop app signed in with this account most recently. */
  loggedIn: boolean;
  sessionCount: number;
}

/** Short human label: the chosen name, else the e-mail, else the start of the account uuid. */
export function accountLabel(account: Pick<AccountInfo, 'name' | 'email' | 'accountId'>): string {
  return account.name ?? account.email ?? `${account.accountId.slice(0, 8)}...`;
}

/**
 * Resolves a selector typed on the command line to exactly one account.
 * Accepted: display name, e-mail, "accountId/orgId", or a prefix (at least
 * four characters) of the account uuid. Throws a descriptive error otherwise.
 */
export function matchAccount(accounts: readonly AccountInfo[], selector: string): AccountInfo {
  const needle = selector.trim().toLowerCase();
  if (needle.length === 0) throw new Error('empty account selector');
  const exact = accounts.filter(
    (account) =>
      account.name?.toLowerCase() === needle ||
      account.email?.toLowerCase() === needle ||
      accountKey(account.accountId, account.orgId).toLowerCase() === needle ||
      account.accountId.toLowerCase() === needle,
  );
  const matches =
    exact.length > 0
      ? exact
      : needle.length >= 4
        ? accounts.filter((account) => account.accountId.toLowerCase().startsWith(needle))
        : [];
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`no account matches "${selector}"`);
  throw new Error(`"${selector}" is ambiguous: ${matches.map((account) => accountKey(account.accountId, account.orgId)).join(', ')}`);
}
