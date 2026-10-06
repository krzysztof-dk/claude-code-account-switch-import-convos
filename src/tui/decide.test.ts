// decide() driven through streams instead of a terminal: a PassThrough plays
// the keyboard and a Writable collects what the prompts print. The same rule
// as in index.test.ts holds: a key is sent only once the prompt it is meant
// for has printed its message, because a prompt subscribes to key presses
// when it renders and a key sent earlier is lost between two prompts.
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { decide, indented, tally, type Answer } from './decide.ts';

const KEY = { enter: '\r', down: '\x1b[B', ctrlC: '\x03' } as const;

/** Control sequences clack writes for cursor movement and erasing, stripped before matching (as in index.test.ts). */
const CONTROL_SEQUENCE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_78]/g;

/** A keyboard and a screen for one decide() call. */
class Console {
  readonly input = new PassThrough();
  readonly output: Writable;
  private printed = '';
  private mark = 0;

  constructor() {
    this.output = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        this.printed += String(chunk);
        callback();
      },
    });
  }

  text(): string {
    return this.printed.replace(CONTROL_SEQUENCE, '');
  }

  /** Waits until `needle` appears past the previous match; fails with the output when it does not. */
  async waitFor(needle: string, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.text().indexOf(needle, this.mark);
      if (index !== -1) {
        this.mark = index + needle.length;
        return;
      }
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${JSON.stringify(needle)}; printed:\n${this.text()}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async type(afterPrompt: string, keys: string): Promise<void> {
    await this.waitFor(afterPrompt);
    this.input.write(keys);
  }

  /** How many times a text was printed so far (a prompt asked again prints its message again). */
  count(needle: string): number {
    return this.text().split(needle).length - 1;
  }
}

type Choice = 'one' | 'two' | 'all';

const ANSWERS: Answer<Choice>[] = [
  { value: 'one', label: 'Only this one', hint: 'taken at once' },
  { value: 'two', label: 'The other one' },
  {
    value: 'all',
    label: 'All of them',
    hint: 'asks to confirm first',
    confirm: { title: 'All of them', note: 'Every item is affected:\n  item a\n  item b', question: 'Really all of them?' },
  },
];

function ask(console: Console): Promise<Choice | null> {
  return decide('Which?', ANSWERS, { input: console.input, output: console.output });
}

describe('tui: decide', () => {
  it('takes an answer without a confirmation at once', async () => {
    const console = new Console();
    const answer = ask(console);
    await console.type('Which?', KEY.enter);
    assert.equal(await answer, 'one');
    assert.equal(console.count('Really all of them?'), 0, 'no second question');
    // clack prints the hint of the highlighted answer only, so the first one's.
    for (const label of ['Only this one', 'taken at once', 'The other one', 'All of them']) {
      assert.ok(console.text().includes(label), `${label} shown`);
    }
  });

  it('shows the note and asks again before taking an answer with a confirmation', async () => {
    const console = new Console();
    const answer = ask(console);
    await console.type('Which?', KEY.down + KEY.down + KEY.enter);
    await console.waitFor('Every item is affected:');
    assert.ok(console.text().includes('item b'), 'the note lists the items');
    await console.type('Really all of them?', 'y');
    assert.equal(await answer, 'all');
  });

  it('returns to the first question when the confirmation is declined, and Enter alone declines', async () => {
    const console = new Console();
    const answer = ask(console);
    await console.type('Which?', KEY.down + KEY.down + KEY.enter);
    // Enter takes the resting answer, which is No. The first question then
    // prints again past the confirmation, which is what the wait below proves
    // (a count would not: clack prints the message again on every key press).
    await console.type('Really all of them?', KEY.enter);
    await console.type('Which?', KEY.down + KEY.enter);
    assert.equal(await answer, 'two');
  });

  it('declines the confirmation on Ctrl+C there, and asks the first question again', async () => {
    const console = new Console();
    const answer = ask(console);
    await console.type('Which?', KEY.down + KEY.down + KEY.enter);
    await console.type('Really all of them?', KEY.ctrlC);
    await console.type('Which?', KEY.enter);
    assert.equal(await answer, 'one');
  });

  it('gives null when the first question is cancelled', async () => {
    const console = new Console();
    const answer = ask(console);
    await console.type('Which?', KEY.ctrlC);
    assert.equal(await answer, null);
  });

  it('indents note lines and tallies answers in first-seen order', () => {
    assert.equal(indented(['a', 'b']), '  a\n  b');
    assert.equal(indented([]), '');
    assert.equal(tally(['skip', 'overwrite', 'skip']), '2 skip, 1 overwrite');
    assert.equal(tally([]), '');
  });
});
