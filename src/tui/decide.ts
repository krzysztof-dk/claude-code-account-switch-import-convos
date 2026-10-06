// One question about one item of a batch, with the answers that reach past
// that item: the same answer for every item left, or cancelling the whole
// batch. Those answers change more than the one conversation in front of
// the person, so each of them is confirmed a second time, after a note that
// says exactly what will happen; "No" at that confirmation returns to the
// first question with every answer still open. Asked for by the operator on
// 2026-10-06, when a sync of 632 conversations stopped at its first "target
// is newer" question with no way to answer once for all of them and no way
// to call the whole transfer off. Used by the conflict and the failure
// question of the transfer screen (./transfer.ts) and by the question about
// interrupted operations (./interrupted.ts), so the three look the same.
//
// The prompts come from @clack/prompts. They read the terminal unless
// `streams` names other ones, which is how decide.test.ts drives them
// without a terminal (clack takes key presses from any readable stream).
import * as p from '@clack/prompts';
import type { Readable, Writable } from 'node:stream';

/**
 * The second question behind an answer that reaches past the current item:
 * the note (what exactly will happen, one line per item where items are
 * involved), its title, and the yes/no question under it.
 */
export interface Confirmation {
  title: string;
  note: string;
  question: string;
}

/**
 * One answer the person can pick. An answer with a `confirm` part is taken
 * only after the second question is answered Yes; the others are taken at
 * once, like any menu entry.
 */
export interface Answer<T extends string> {
  value: T;
  label: string;
  hint?: string | undefined;
  confirm?: Confirmation | undefined;
}

/** Where the prompts read and write; the terminal when left out. Tests pass a pipe. */
export interface PromptStreams {
  input?: Readable | undefined;
  output?: Writable | undefined;
}

/** The stream options in the shape clack takes: a key only for a stream given (exactOptionalPropertyTypes forbids an explicit undefined). */
function streamOptions(streams: PromptStreams | undefined): { input?: Readable; output?: Writable } {
  return { ...(streams?.input ? { input: streams.input } : {}), ...(streams?.output ? { output: streams.output } : {}) };
}

/**
 * Asks `message` with the answers given and returns the value picked, or
 * null when the person cancelled the question (Ctrl+C or Escape), which
 * every screen treats as "leave this step". An answer with a confirmation
 * shows its note and asks its question first: Yes returns the answer, No
 * (or a cancel at the second question) asks the first question again.
 */
export async function decide<T extends string>(message: string, answers: readonly Answer<T>[], streams?: PromptStreams): Promise<T | null> {
  const common = streamOptions(streams);
  // The select is typed over string, not T: clack's Option<Value> is a
  // conditional type that TypeScript cannot resolve for a type parameter,
  // and the answer picked is looked up by its value anyway.
  const options = answers.map(({ value, label, hint }): { value: string; label: string; hint?: string } => ({ value, label, ...(hint ? { hint } : {}) }));
  for (;;) {
    const choice = await p.select<string>({ message, options, ...common });
    if (p.isCancel(choice)) return null;
    const answer = answers.find((candidate) => candidate.value === choice);
    if (!answer) throw new Error(`the prompt returned "${choice}", which is none of the answers offered`);
    if (!answer.confirm) return answer.value;
    p.note(answer.confirm.note, answer.confirm.title, common);
    // No is the resting position: Enter alone never takes an answer that
    // reaches past the current item.
    const confirmed = await p.confirm({ message: answer.confirm.question, initialValue: false, ...common });
    if (confirmed === true) return answer.value;
  }
}

/** The lines of a note, one item per line, indented under the sentence above them. */
export function indented(lines: readonly string[]): string {
  return lines.map((line) => `  ${line}`).join('\n');
}

/** "2 skip, 1 overwrite": how many times each answer was given, in first-seen order, for the notes that recap the answers so far. */
export function tally<T extends string>(answers: readonly T[]): string {
  const counts = new Map<T, number>();
  for (const answer of answers) counts.set(answer, (counts.get(answer) ?? 0) + 1);
  return [...counts].map(([answer, count]) => `${count} ${answer}`).join(', ');
}
