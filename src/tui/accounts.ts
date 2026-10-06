// The accounts screen: shows every account directory with the e-mail found
// for it and lets the person attach a display name. A manual e-mail is only
// offered when no source knows the address, because detected addresses
// (CLI login, transcripts) are re-derived on every scan and would win anyway.
import * as p from '@clack/prompts';
import { accountKey, accountLabel } from '../accounts.ts';
import { ACCOUNT_HEADER, accountRow, renderTable } from '../format.ts';
import { extractEmail } from '../transcripts.ts';
import type { TuiContext } from './context.ts';

/**
 * The "Accounts" screen: the table of accounts, then a loop of picking one
 * and giving it a name, clearing the name or (only when no source knows
 * it) typing its e-mail. Every change is saved to accounts.json at once and
 * the inventory is rebuilt, so the lists elsewhere show the new label.
 * Returns when the person chooses Back or cancels.
 */
export async function accountsFlow(context: TuiContext): Promise<void> {
  for (;;) {
    const accounts = context.inventory.accounts;
    if (accounts.length === 0) {
      p.log.warn(`No account directories under ${context.paths.sessionsRoot}.`);
      return;
    }
    p.note(renderTable([ACCOUNT_HEADER, ...accounts.map(accountRow)]), 'Accounts');
    const choice = await p.select({
      message: 'Edit an account?',
      options: [
        ...accounts.map((account) => ({
          value: accountKey(account.accountId, account.orgId),
          label: accountLabel(account),
          hint: `${account.email ?? 'e-mail unknown'}${account.name ? '' : ' | no name yet'}`,
        })),
        { value: 'back', label: 'Back' },
      ],
    });
    if (p.isCancel(choice) || choice === 'back') return;
    const account = accounts.find((candidate) => accountKey(candidate.accountId, candidate.orgId) === choice);
    if (!account) return;

    const actions = [
      { value: 'name', label: account.name ? `Change the name (${account.name})` : 'Set a name', hint: 'shown instead of the e-mail in lists' },
      ...(account.name ? [{ value: 'clear-name', label: 'Clear the name' }] : []),
      ...(account.email
        ? []
        : [{ value: 'email', label: 'Enter the e-mail manually', hint: 'no local source knows this address' }]),
      { value: 'back', label: 'Back' },
    ];
    const action = await p.select({ message: `${accountLabel(account)} (${account.accountId})`, options: actions });
    if (p.isCancel(action) || action === 'back') continue;

    if (action === 'name') {
      const name = await p.text({
        message: 'Name',
        placeholder: 'e.g. work, private',
        initialValue: account.name ?? '',
        validate: (value) => (value === undefined || value.trim().length === 0 ? 'A name cannot be empty' : undefined),
      });
      if (p.isCancel(name)) continue;
      context.store.setName(account.accountId, account.orgId, name);
      await context.store.save();
      p.log.success(`Name set to "${name.trim()}".`);
    } else if (action === 'clear-name') {
      context.store.setName(account.accountId, account.orgId, null);
      await context.store.save();
      p.log.success('Name cleared.');
    } else if (action === 'email') {
      const email = await p.text({
        message: 'E-mail',
        placeholder: 'name@example.com',
        validate: (value) => (extractEmail(value) === null ? 'That does not look like an e-mail address' : undefined),
      });
      if (p.isCancel(email)) continue;
      const accepted = context.store.setEmail(account.accountId, account.orgId, email.trim(), 'manual');
      await context.store.save();
      if (accepted) p.log.success(`E-mail set to ${email.trim()}.`);
      else p.log.warn('A detected e-mail already exists for this account; the manual one was not applied.');
    }
    await context.reload();
  }
}
