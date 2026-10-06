// The versions of the desktop app and the CLI this tool's knowledge of
// their files was checked against, and a warning when the installed ones
// are newer.
//
// Everything this tool knows about records and transcripts comes from the
// app's and the CLI's code and from files on disk, not from a documented
// format: the transcript format "is internal to Claude Code and changes
// between versions" (code.claude.com, "Sessions"), and the record
// serializer grew from 2.9939.2 to 2.19675.0 with twenty-odd fields that
// name the source account before anyone noticed (review of 2026-10-05).
// So the versions the lists were checked against are recorded here, and a
// newer installed version is reported in the TUI's Environment box and in
// the command output: not a refusal, most changes are harmless, but a
// reminder to repeat the check (records.test.ts holds the serializer's
// field list, SESSION_KEYED_DIRS in transcripts.ts the per-session
// directories, app-guard.ts the shape of the session index).
//
// The app's version is read from its Info.plist (CFBundleShortVersionString,
// XML); the CLI's from the "version" field the CLI writes into every
// transcript line, taking the newest seen. Either may be unknown (no app in
// /Applications, no transcripts yet), which is no warning.
import { readFile } from 'node:fs/promises';
import type { Inventory } from './inventory.ts';

/** The versions whose files, fields and directories were checked on 2026-10-05. */
export const VERIFIED_AGAINST = { app: '2.19675.0', cli: '2.1.286' } as const;

/** Where the desktop app lives on macOS; its Info.plist carries the version. */
export const APP_INFO_PLIST = '/Applications/Claude.app/Contents/Info.plist';

/**
 * Compares two dotted version strings part by part as numbers (so 2.19675.0
 * is newer than 2.9939.2, which string order gets wrong); a missing part
 * counts as zero and a non-numeric part as zero too. Negative when `a` is
 * older, positive when newer, zero when equal.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.');
  const partsB = b.split('.');
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index += 1) {
    const numberA = Number.parseInt(partsA[index] ?? '0', 10) || 0;
    const numberB = Number.parseInt(partsB[index] ?? '0', 10) || 0;
    if (numberA !== numberB) return numberA < numberB ? -1 : 1;
  }
  return 0;
}

/** The CFBundleShortVersionString of an Info.plist in XML form, or null when there is none. */
export function parseBundleVersion(plist: string): string | null {
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
  return match ? match[1]!.trim() : null;
}

/** The installed desktop app's version, or null when the app (or the version in its Info.plist) is not there. */
export async function installedAppVersion(plistPath: string = APP_INFO_PLIST): Promise<string | null> {
  try {
    return parseBundleVersion(await readFile(plistPath, 'utf8'));
  } catch {
    return null;
  }
}

/** The newest of the given versions, nulls ignored; null when there is none. */
export function newestVersion(versions: readonly (string | null | undefined)[]): string | null {
  let newest: string | null = null;
  for (const version of versions) {
    if (typeof version !== 'string' || version.trim().length === 0) continue;
    if (newest === null || compareVersions(version, newest) > 0) newest = version;
  }
  return newest;
}

/**
 * One warning per component (the app, the CLI) whose installed version is
 * newer than the one this tool was checked against; nothing for unknown or
 * older versions. The wording says what was checked, so the reader knows
 * what to look at again.
 */
export async function driftOf(inventory: Inventory, plistPath?: string): Promise<string[]> {
  const conversations = [...[...inventory.byAccount.values()].flat(), ...inventory.unlisted];
  return driftWarnings({
    app: await installedAppVersion(plistPath),
    cli: newestVersion(conversations.map((conversation) => conversation.summary?.version ?? null)),
  });
}

/**
 * The drift warnings for an inventory: the installed app against the checked
 * app version, and the CLI that wrote the newest transcript seen against the
 * checked CLI version. Printed by the commands and shown in the TUI.
 */
export function driftWarnings(installed: { app: string | null; cli: string | null }): string[] {
  const warnings: string[] = [];
  if (installed.app !== null && compareVersions(installed.app, VERIFIED_AGAINST.app) > 0) {
    warnings.push(
      `the Claude app is ${installed.app}, newer than ${VERIFIED_AGAINST.app}, the version whose record fields this tool was checked against; ` +
        'copies carry fields the app added since as they are (the accounts command lists them)',
    );
  }
  if (installed.cli !== null && compareVersions(installed.cli, VERIFIED_AGAINST.cli) > 0) {
    warnings.push(
      `the CLI that wrote the newest transcript is ${installed.cli}, newer than ${VERIFIED_AGAINST.cli}, the version whose transcript layout ` +
        'and per-session directories this tool was checked against',
    );
  }
  return warnings;
}
