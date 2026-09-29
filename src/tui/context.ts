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

export interface TuiContext {
  paths: Paths;
  store: AccountStore;
  cache: SummaryCache;
  journal: Journal;
  lineage: LineageStore;
  inventory: Inventory;
  /** The app and the CLI as found at start-up, shown for information only. */
  processes: ProcessDetection[];
  guard: Guard;
  /** Rehearsal mode (ccas --dry-run): every screen stops after showing its plan. */
  dryRun: boolean;
  reload(): Promise<void>;
}
