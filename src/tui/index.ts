// Interactive mode: a main menu over the transfer, accounts and restore
// screens, built with @clack/prompts. Every prompt can be cancelled with
// Ctrl+C or Escape, which returns to the previous step instead of exiting.
// Reading and planning always work; whether Claude Code (the app or any CLI
// session) is running is asked immediately before each write (see
// app-guard.ts), so the TUI can be opened next to a running app to look
// around and rehearse. Operations an earlier run left interrupted are dealt
// with first (see ../interrupted.ts).
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { AccountStore } from '../accounts.ts';
import { APP_PROCESS_NAME, detectClaudeProcesses, makeGuard, type ProcessDetection } from '../app-guard.ts';
import { EXIT_INTERRUPTED } from '../cli.ts';
import { buildInventory } from '../inventory.ts';
import type { Journal } from '../journal.ts';
import type { LineageStore } from '../lineage.ts';
import type { Paths } from '../paths.ts';
import type { SummaryCache } from '../summary-cache.ts';
import { accountsFlow } from './accounts.ts';
import type { TuiContext } from './context.ts';
import { settleInterruptedInTui } from './interrupted.ts';
import { restoreFlow } from './restore.ts';
import { transferFlow } from './transfer.ts';

export interface TuiSession {
  paths: Paths;
  store: AccountStore;
  cache: SummaryCache;
  journal: Journal;
  lineage: LineageStore;
}

export interface TuiOptions {
  /** Show plans only, never write; useful for a rehearsal. */
  dryRun?: boolean | undefined;
}

async function scan(context: Omit<TuiContext, 'inventory' | 'reload'>): Promise<TuiContext['inventory']> {
  const spinner = p.spinner();
  spinner.start('Scanning');
  const inventory = await buildInventory(context.paths, {
    store: context.store,
    cache: context.cache,
    lineage: context.lineage,
    onProgress: (message) => spinner.message(message),
  });
  const listed = [...inventory.byAccount.values()].reduce((sum, list) => sum + list.length, 0);
  spinner.stop(`${inventory.accounts.length} account(s), ${listed} listed conversation(s), ${inventory.unlisted.length} unlisted transcript(s)`);
  for (const problem of inventory.problems) p.log.warn(problem);
  return inventory;
}

/** One environment line per detection: the app ("Claude") or the CLI ("claude"). */
function describeDetection(detection: ProcessDetection, live: boolean): string {
  const what = detection.label === APP_PROCESS_NAME ? 'Claude app' : 'claude CLI';
  switch (detection.status) {
    case 'running': {
      const pids = detection.processes.map((match) => match.pid).join(', ');
      return live
        ? pc.yellow(`${what} is running (PID ${pids}): browse and plan freely, writes are refused until it is closed (checked before every write)`)
        : pc.yellow(`${what} is running (PID ${pids}; irrelevant for a copied data directory)`);
    }
    case 'not-running':
      return pc.green(`${what} is not running (checked again before every write)`);
    default:
      return live
        ? pc.yellow(`Could not tell whether the ${what} is running (${detection.error ?? 'pgrep failed'}); writes to the live directory are refused`)
        : pc.yellow(`Could not tell whether the ${what} is running (irrelevant for a copied data directory)`);
  }
}

function describeEnvironment(context: TuiContext): string {
  const lines = [
    `desktop data  ${context.paths.userData}${context.paths.liveUserData ? '' : pc.yellow('  (copy, not the live directory)')}`,
    `CLI data      ${context.paths.claudeDir}`,
    `tool data     ${context.paths.dataDir}`,
  ];
  if (context.dryRun) lines.push(pc.yellow('dry run: plans are shown, nothing is written'));
  for (const detection of context.processes) lines.push(describeDetection(detection, context.paths.liveUserData));
  return lines.join('\n');
}

export async function runTui(session: TuiSession, options: TuiOptions = {}): Promise<number> {
  const dryRun = options.dryRun === true;
  p.intro(`${pc.bgCyan(pc.black(' ccas '))} Claude Code conversations between accounts${dryRun ? pc.yellow('  (dry run)') : ''}`);
  const processes = await detectClaudeProcesses();
  const base = { ...session, processes, guard: makeGuard(session.paths), dryRun };
  const context: TuiContext = {
    ...base,
    inventory: await scan(base),
    async reload() {
      context.inventory = await scan(base);
    },
  };
  p.note(describeEnvironment(context), 'Environment');
  if ((await settleInterruptedInTui(context)) === 'exit') {
    p.outro('Nothing more was changed.');
    return EXIT_INTERRUPTED;
  }

  for (;;) {
    const choice = await p.select({
      message: 'What next?',
      options: [
        { value: 'transfer', label: 'Transfer conversations', hint: 'copy (sync) or move between accounts, import unlisted transcripts' },
        { value: 'accounts', label: 'Accounts', hint: 'names and e-mails' },
        { value: 'restore', label: 'Restore from journal', hint: 'undo a previous operation' },
        { value: 'rescan', label: 'Rescan', hint: 'read the directories again' },
        { value: 'quit', label: 'Quit' },
      ],
    });
    if (p.isCancel(choice) || choice === 'quit') break;
    switch (choice) {
      case 'transfer':
        await transferFlow(context);
        break;
      case 'accounts':
        await accountsFlow(context);
        break;
      case 'restore':
        await restoreFlow(context);
        break;
      case 'rescan':
        await context.reload();
        break;
      default:
        break;
    }
  }
  p.outro('Bye.');
  return 0;
}
