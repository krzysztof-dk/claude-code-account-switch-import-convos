import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  ACCOUNT_B,
  BOUNDARY_BYTE,
  CWD_BETA,
  EMAIL_A,
  EMAIL_B,
  destroyWorld,
  makeWorld,
  readLines,
  readTree,
  replaceInBytes,
  writeSshTranscript,
  writeTranscript,
  type World,
} from '../test/fixtures.ts';
import {
  SessionIdRewriter,
  appendBridgeTombstones,
  bridgeTombstone,
  copyRewritingSessionId,
  copySidecar,
  extractEmail,
  isSshMirror,
  listTranscripts,
  liveBridges,
  locateTranscript,
  sshMirrorDir,
  summarizeTranscript,
} from './transcripts.ts';

/** Feeds bytes to a rewriter one chunk at a time and collects every byte it puts out. */
async function rewriteInChunks(bytes: Buffer, chunkSize: number, from: string, to: string): Promise<Buffer> {
  const rewriter = new SessionIdRewriter(from, to);
  const output: Buffer[] = [];
  rewriter.on('data', (chunk: string | Buffer) => output.push(Buffer.from(chunk)));
  for (let offset = 0; offset < bytes.length; offset += chunkSize) rewriter.write(bytes.subarray(offset, offset + chunkSize));
  await new Promise<void>((resolve) => rewriter.end(resolve));
  return Buffer.concat(output);
}

describe('transcripts', () => {
  let world: World;
  before(async () => {
    world = await makeWorld();
  });
  after(async () => {
    await destroyWorld(world);
  });

  it('finds the live Remote Control links: the last bridge-session line per session id, when it names a claude.ai session', async () => {
    const file = path.join(world.root, 'bridges.jsonl');
    const bridge = (sessionId: string, bridgeSessionId: string): string => JSON.stringify({ type: 'bridge-session', sessionId, bridgeSessionId, lastSequenceNum: 3 });
    await writeFile(
      file,
      [
        bridge('s-1', 'cse_old'),
        '{"type":"user","message":{"content":"mentions \\"bridge-session\\" in text"}}',
        bridge('s-2', 'cse_two'),
        bridge('s-1', 'cse_new'),
        bridge('s-3', 'cse_three'),
        bridgeTombstone('s-3'),
        'not json with "bridge-session"',
      ].join('\n') + '\n',
    );
    assert.deepEqual(await liveBridges(file), [
      { sessionId: 's-1', bridgeSessionId: 'cse_new' },
      { sessionId: 's-2', bridgeSessionId: 'cse_two' },
    ]);
    // A tombstone names no claude.ai session, so the summary does not list one.
    assert.deepEqual((await summarizeTranscript(file)).bridge?.bridgeSessionIds, ['cse_old', 'cse_two', 'cse_new', 'cse_three']);
  });

  it('ends live links with tombstones, only once, and only those asked for', async () => {
    const file = path.join(world.root, 'tombstones.jsonl');
    const live = (sessionId: string, bridgeSessionId: string): string => JSON.stringify({ type: 'bridge-session', sessionId, bridgeSessionId, lastSequenceNum: 1 });
    // No newline at the end, as a file cut short leaves it: the tombstones start on a line of their own.
    await writeFile(file, `${live('s-1', 'cse_a')}\n${live('s-2', 'cse_b')}`);
    assert.deepEqual(await appendBridgeTombstones(file, (link) => link.bridgeSessionId === 'cse_b'), ['s-2']);
    assert.equal(await readFile(file, 'utf8'), `${live('s-1', 'cse_a')}\n${live('s-2', 'cse_b')}\n${bridgeTombstone('s-2')}\n`);
    assert.deepEqual(await appendBridgeTombstones(file), ['s-1']);
    const ended = await readFile(file, 'utf8');
    assert.ok(ended.endsWith(`${bridgeTombstone('s-2')}\n${bridgeTombstone('s-1')}\n`));
    assert.deepEqual(await appendBridgeTombstones(file), [], 'nothing live is left');
    assert.equal(await readFile(file, 'utf8'), ended);
    assert.equal(bridgeTombstone('s-1'), '{"type":"bridge-session","sessionId":"s-1","bridgeSessionId":"","lastSequenceNum":0}');
  });

  it('extracts an address from the session_context sentence', () => {
    assert.equal(extractEmail("The user's email address is kr.x+y@icloud.com. Use it only"), 'kr.x+y@icloud.com');
    assert.equal(extractEmail('nothing here'), null);
    assert.equal(extractEmail(42), null);
  });

  it('summarises a transcript: first uuid, chain, counts, e-mails, bridge owner, title', async () => {
    const written = await writeTranscript(world, {
      prompts: 3,
      email: [EMAIL_A, EMAIL_B],
      bridgeOwner: ACCOUNT_B,
      title: 'Custom title',
      firstPrompt: '<system-reminder>injected</system-reminder>',
    });
    const summary = await summarizeTranscript(written.path);
    assert.equal(summary.rootUuid, written.uuids[0]);
    assert.deepEqual(summary.uuidChain, written.uuids);
    assert.equal(summary.lineCount, written.lines.length);
    assert.equal(summary.unparsableLines, 0);
    assert.equal(summary.promptCount, 3);
    assert.equal(summary.messageCount, 3 * 4);
    assert.equal(summary.cwd, written.cwd);
    assert.equal(summary.version, '2.1.275');
    assert.deepEqual(summary.entrypoints, ['claude-desktop']);
    assert.deepEqual(summary.emails, [EMAIL_A, EMAIL_B]);
    assert.deepEqual(summary.bridge, { ownerAccountId: ACCOUNT_B.accountId, ownerOrgId: ACCOUNT_B.orgId, bridgeSessionIds: [`cse_${written.cliId.slice(0, 8)}`] });
    assert.equal(summary.customTitle, 'Custom title');
    // The injected first prompt is skipped; the next real prompt wins.
    assert.equal(summary.firstUserText, 'prompt 2');
    assert.equal(summary.lastModel, 'claude-opus-5');
    assert.deepEqual(summary.sessionIds, [written.cliId]);
    assert.ok(summary.firstTimestamp && summary.lastTimestamp && summary.firstTimestamp < summary.lastTimestamp);
  });

  it('tolerates unparsable and blank lines', async () => {
    const file = path.join(world.root, 'odd.jsonl');
    await writeFile(file, '\n{"type":"user","uuid":"11111111-1111-4111-8111-111111111111","message":{"content":"hi"}}\nnot json\n\n');
    const summary = await summarizeTranscript(file);
    assert.equal(summary.lineCount, 2);
    assert.equal(summary.unparsableLines, 1);
    assert.equal(summary.rootUuid, '11111111-1111-4111-8111-111111111111');
    assert.equal(summary.firstUserText, 'hi');
  });

  it('locates transcripts across project directories and lists top-level ones only', async () => {
    const alpha = await writeTranscript(world, { prompts: 1 });
    const beta = await writeTranscript(world, { prompts: 1, cwd: CWD_BETA });
    await mkdir(path.join(world.paths.projectsRoot, 'stray'), { recursive: true });
    await writeFile(path.join(world.paths.projectsRoot, 'stray', 'notes.jsonl'), '{}\n');
    const found = await locateTranscript(world.paths.projectsRoot, beta.cliId);
    assert.equal(found?.path, beta.path);
    assert.equal(found?.sidecarDir, beta.sidecarDir);
    assert.equal(await locateTranscript(world.paths.projectsRoot, '99999999-9999-4999-8999-999999999999'), null);
    assert.equal(await locateTranscript(world.paths.projectsRoot, 'not-a-uuid'), null);
    const all = await listTranscripts(world.paths.projectsRoot);
    const ids = all.map((location) => location.cliSessionId);
    assert.ok(ids.includes(alpha.cliId) && ids.includes(beta.cliId));
    assert.ok(all.every((location) => !location.path.includes('notes.jsonl') && !location.path.includes('subagents')));
  });

  it('rewrites an id even when chunks split it', async () => {
    const from = '11111111-1111-4111-8111-111111111111';
    const to = '22222222-2222-4222-8222-222222222222';
    const text = `{"sessionId":"${from}"}\n{"path":"/x/${from}/tool-results/a.txt"}\ntail without newline ${from}`;
    const output = await rewriteInChunks(Buffer.from(text), 7, from, to);
    assert.equal(output.toString('utf8'), text.split(from).join(to));
  });

  it('keeps multi-byte characters whole when fed one byte at a time', async () => {
    const from = '11111111-1111-4111-8111-111111111111';
    const to = '22222222-2222-4222-8222-222222222222';
    const plain = Buffer.from('🙂€ zażółć', 'utf8');
    assert.ok((await rewriteInChunks(plain, 1, from, to)).equals(plain));
    const text = `{"sessionId":"${from}","text":"🙂€ zażółć"}\n🙂€ zażółć ${from}`;
    const rewritten = await rewriteInChunks(Buffer.from(text, 'utf8'), 1, from, to);
    assert.ok(rewritten.equals(Buffer.from(text.split(from).join(to), 'utf8')));
  });

  it('copies a character that straddles the 64 KiB read boundary byte for byte, apart from the id', async () => {
    const ssh = await writeSshTranscript(world, { straddle64k: true, agents: 1 });
    const to = '44444444-4444-4444-8444-444444444444';
    for (const [source, expectedLead] of [
      [ssh.path, 0xf0],
      [ssh.agentPaths[0]!, 0xc5],
    ] as const) {
      const original = await readFile(source);
      // The first byte of the character is the last byte of the first 64 KiB chunk.
      assert.equal(original[BOUNDARY_BYTE], expectedLead);
      const destination = path.join(world.root, `straddle-${path.basename(source)}`);
      await copyRewritingSessionId(source, destination, ssh.cliId, to);
      const copied = await readFile(destination);
      assert.ok(copied.includes(to) && !copied.includes(ssh.cliId));
      assert.ok(!copied.includes('�'), 'no replacement characters');
      assert.ok(replaceInBytes(copied, to, ssh.cliId).equals(original));
    }
  });

  it('names SSH mirror directories after their session and recognises only those', () => {
    const id = '55555555-5555-4555-8555-555555555555';
    assert.equal(sshMirrorDir('/claude/projects', id), `/claude/projects/ssh-${id}`);
    assert.equal(isSshMirror({ projectDir: `/claude/projects/ssh-${id}`, cliSessionId: id }), true);
    assert.equal(isSshMirror({ projectDir: '/claude/projects/ssh-66666666-6666-4666-8666-666666666666', cliSessionId: id }), false);
    assert.equal(isSshMirror({ projectDir: '/claude/projects/-Volumes-Store-Dev-alpha', cliSessionId: id }), false);
  });

  it('gives copies the permission bits of their sources', async () => {
    const ssh = await writeSshTranscript(world, { agents: 2 });
    const to = '77777777-7777-4777-8777-777777777777';
    const mirror = sshMirrorDir(world.paths.projectsRoot, to);
    await copySidecar(ssh.mirrorDir, mirror, ssh.cliId, to);
    assert.equal((await stat(mirror)).mode & 0o777, 0o700);
    const source = await readTree(ssh.mirrorDir);
    const copied = await readTree(mirror);
    assert.deepEqual([...copied.keys()].sort(), [...source.keys()].map((name) => name.split(ssh.cliId).join(to)).sort());
    for (const file of copied.values()) assert.equal(file.mode, 0o600);
    const single = path.join(world.root, 'single-copy.jsonl');
    await copyRewritingSessionId(ssh.path, single, ssh.cliId, to);
    assert.equal((await stat(single)).mode & 0o777, 0o600);
  });

  it('copies a transcript and its sidecar with the id rewritten everywhere', async () => {
    const written = await writeTranscript(world, { prompts: 2, title: 'T' });
    const to = '33333333-3333-4333-8333-333333333333';
    const destination = path.join(written.projectDir, `${to}.jsonl`);
    await copyRewritingSessionId(written.path, destination, written.cliId, to);
    const lines = await readLines(destination);
    assert.equal(lines.length, written.lines.length);
    assert.ok(lines.every((line) => line['sessionId'] === undefined || line['sessionId'] === to));
    assert.deepEqual(lines.filter((line) => typeof line['uuid'] === 'string').map((line) => line['uuid']), written.uuids);
    const sidecar = path.join(written.projectDir, to);
    await copySidecar(written.sidecarDir, sidecar, written.cliId, to);
    // Sub-agent files are named after a hash, not the session id, so the name stays and only the content changes.
    const subagent = await readFile(path.join(sidecar, 'subagents', `agent-${written.cliId.slice(0, 8)}.jsonl`), 'utf8');
    assert.ok(subagent.includes(to) && !subagent.includes(written.cliId));
    // Plain text files are copied as they are, only json/jsonl are rewritten.
    const result = await readFile(path.join(sidecar, 'tool-results', 'result1.txt'), 'utf8');
    assert.ok(result.includes(written.cliId));
    assert.equal(JSON.parse(await readFile(path.join(sidecar, 'custom-title.json'), 'utf8')).customTitle, 'T');
  });

  it('leaves the desktop harness write-tracking directory out of a side folder copy', async () => {
    // .cc-writes is kept by the Claude Code desktop harness next to files it
    // edits; seen inside side folders on 2026-10-05, it is not part of the
    // conversation and never reaches a copy.
    const written = await writeTranscript(world, { prompts: 1 });
    await mkdir(path.join(written.sidecarDir, '.cc-writes'), { recursive: true });
    await writeFile(path.join(written.sidecarDir, '.cc-writes', 'lease'), 'x');
    const to = '44444444-4444-4444-8444-444444444444';
    const sidecar = path.join(written.projectDir, to);
    await copySidecar(written.sidecarDir, sidecar, written.cliId, to);
    const copied = await readTree(sidecar);
    assert.ok([...copied.keys()].every((name) => !name.includes('.cc-writes')), [...copied.keys()].join(', '));
    assert.ok(copied.has(path.join('tool-results', 'result1.txt')));
  });
});
