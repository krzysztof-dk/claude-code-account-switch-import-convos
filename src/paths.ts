// Filesystem locations used by the tool.
//
// The Claude desktop app keeps one JSON record per Code-tab conversation under
// its Electron userData directory, split by account and organization:
//   <userData>/claude-code-sessions/<accountId>/<orgId>/local_<uuid>.json
// The Claude Code CLI bundled with the app keeps the transcripts under a single
// config directory shared by every account:
//   <claudeDir>/projects/<encoded cwd>/<cliSessionId>.jsonl
// Every root can be overridden, which is how tests and rehearsals run against
// copies instead of the live directories.
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Overrides for resolvePaths: the command-line options --user-data,
 * --claude-dir and --data, and for tests the home directory and the
 * environment.
 */
export interface PathOverrides {
  /** Electron userData directory of the desktop app. */
  userData?: string | undefined;
  /** Claude Code CLI config directory (CLAUDE_CONFIG_DIR). */
  claudeDir?: string | undefined;
  /** Directory for this tool's own state: accounts, lineage, journal, backups. */
  data?: string | undefined;
  /** Home directory, only overridden by tests. */
  home?: string | undefined;
  /** Environment to read CLAUDE_CONFIG_DIR from, only overridden by tests. */
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Every location the tool reads or writes, resolved once per run by
 * resolvePaths and passed to the modules that need them.
 */
export interface Paths {
  home: string;
  userData: string;
  /** <userData>/claude-code-sessions: one subtree per account and organization. */
  sessionsRoot: string;
  /** <userData>/config.json: read only for lastKnownAccountUuid. */
  desktopConfigFile: string;
  claudeDir: string;
  /** <claudeDir>/projects: transcript directories keyed by encoded cwd. */
  projectsRoot: string;
  /** CLI state file holding oauthAccount; read only for account uuid, org uuid and e-mail. */
  cliConfigFile: string;
  dataDir: string;
  backupsDir: string;
  /**
   * True when userData is the directory the running desktop app really uses.
   * Writes into the live directory are refused while the app runs; a copy of
   * the directory (tests, rehearsals) is never blocked by that guard.
   */
  liveUserData: boolean;
}

/** Root of this package, valid both when running from src/ and from dist/. */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Where the desktop app keeps its data on macOS, under the given home. The
 * live-directory check compares the resolved userData with this path.
 */
export function defaultUserData(home: string): string {
  return path.join(home, 'Library', 'Application Support', 'Claude');
}

/**
 * Resolves every location from the overrides, CLAUDE_CONFIG_DIR and the
 * defaults. liveUserData is true whenever userData resolves to the app's
 * own directory, also when --user-data names it explicitly.
 */
export function resolvePaths(overrides: PathOverrides = {}): Paths {
  const home = overrides.home ?? homedir();
  const env = overrides.env ?? process.env;
  const userData = path.resolve(overrides.userData ?? defaultUserData(home));
  // Found while smoke-testing the TUI with --user-data pointing at the real
  // directory: "live" used to mean "no override given", which would have
  // switched the running-app guard off for an explicit path to the live
  // directory. Live now means the resolved path is the app's own directory.
  const liveUserData = userData === path.resolve(defaultUserData(home));

  // CLAUDE_CONFIG_DIR moves the whole CLI state, including the .claude.json
  // file that normally sits directly in the home directory.
  const envConfigDir = env['CLAUDE_CONFIG_DIR'];
  const claudeDir = path.resolve(overrides.claudeDir ?? envConfigDir ?? path.join(home, '.claude'));
  const cliConfigFile =
    overrides.claudeDir !== undefined || envConfigDir
      ? path.join(claudeDir, '.claude.json')
      : path.join(home, '.claude.json');

  const dataDir = path.resolve(overrides.data ?? path.join(packageRoot(), 'data'));
  return {
    home,
    userData,
    sessionsRoot: path.join(userData, 'claude-code-sessions'),
    desktopConfigFile: path.join(userData, 'config.json'),
    claudeDir,
    projectsRoot: path.join(claudeDir, 'projects'),
    cliConfigFile,
    dataDir,
    backupsDir: path.join(dataDir, 'backups'),
    liveUserData,
  };
}
