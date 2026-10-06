// State shared by the interactive screens: the open session (paths and
// stores), the current inventory and the write guard. Screens call reload()
// after they changed files so the lists they show stay truthful. The guard is
// a function, not a value: it is asked right before a write, never at start-up.
import type { AccountStore } from '../accounts.ts';
import type { Guard, ProcessDetection } from '../app-guard.ts';
import type { Inventory } from '../inventory.ts';
import type { Journal } from '../journal.ts';
import type { LineageStore } from '../lineage.ts';
import type { Paths } from '../paths.ts';
import type { SummaryCache } from '../summary-cache.ts';

/**
 * What every screen of the TUI works with: the open session (paths and the
 * tool's stores), the inventory as last scanned, the guard, the dry-run
 * flag and the warnings shown in the Environment box. Built once by runTui
 * (tui/index.ts) and passed to each flow; `reload()` refreshes the parts
 * that change when files do.
 */
export interface TuiContext {
  paths: Paths;
  store: AccountStore;
  cache: SummaryCache;
  journal: Journal;
  lineage: LineageStore;
  inventory: Inventory;
  /** The app and the CLI as found at start-up, shown for information only. */
  processes: ProcessDetection[];
  /** Warnings about an app or CLI newer than the versions this tool was checked against (versions.ts), shown in the Environment box. */
  drift: string[];
  guard: Guard;
  /** Rehearsal mode (ccas --dry-run): every screen stops after showing its plan. */
  dryRun: boolean;
  reload(): Promise<void>;
}
