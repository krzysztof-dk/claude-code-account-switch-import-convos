import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { EMAIL_A, destroyWorld, makeWorld, writeRecord, writeTranscript, type World, type WrittenTranscript } from '../test/fixtures.ts';
import { AccountStore } from './accounts.ts';
import { buildInventory, type Inventory } from './inventory.ts';
import { VERIFIED_AGAINST, compareVersions, driftOf, driftWarnings, installedAppVersion, newestVersion, parseBundleVersion } from './versions.ts';

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>Claude</string>
	<key>CFBundleShortVersionString</key>
	<string>2.19675.0</string>
	<key>CFBundleVersion</key>
	<string>2.19675.0</string>
</dict>
</plist>
`;

describe('versions', () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ccas-versions-'));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('compares versions part by part as numbers, not as text', () => {
    // String order would put 2.9939.2 after 2.19675.0.
    assert.ok(compareVersions('2.19675.0', '2.9939.2') > 0);
    assert.ok(compareVersions('2.9939.2', '2.19675.0') < 0);
    assert.ok(compareVersions('2.1.286', '2.1.289') < 0);
    assert.equal(compareVersions('2.1', '2.1.0'), 0);
    assert.equal(compareVersions('2.1.286', '2.1.286'), 0);
    assert.ok(compareVersions('3', '2.99.99') > 0);
    // A part that is not a number counts as zero.
    assert.equal(compareVersions('2.x.1', '2.0.1'), 0);
  });

  it('reads the version from an Info.plist and answers null for a missing or versionless one', async () => {
    const plist = path.join(root, 'Info.plist');
    await writeFile(plist, PLIST);
    assert.equal(parseBundleVersion(PLIST), '2.19675.0');
    assert.equal(await installedAppVersion(plist), '2.19675.0');
    assert.equal(await installedAppVersion(path.join(root, 'none.plist')), null);
    assert.equal(parseBundleVersion('<plist><dict><key>CFBundleName</key><string>Claude</string></dict></plist>'), null);
  });

  it('picks the newest version seen and ignores unknown ones', () => {
    assert.equal(newestVersion(['2.1.270', null, '2.1.286', undefined, '', '2.1.9']), '2.1.286');
    assert.equal(newestVersion([null, undefined]), null);
    assert.equal(newestVersion([]), null);
  });

  it('warns only about versions newer than the ones this tool was checked against', () => {
    assert.deepEqual(driftWarnings({ app: VERIFIED_AGAINST.app, cli: VERIFIED_AGAINST.cli }), []);
    assert.deepEqual(driftWarnings({ app: null, cli: null }), []);
    assert.deepEqual(driftWarnings({ app: '2.9939.2', cli: '2.1.270' }), [], 'older versions are no drift');
    const both = driftWarnings({ app: '2.20000.0', cli: '2.1.300' });
    assert.equal(both.length, 2);
    assert.match(both[0] ?? '', /2\.20000\.0/);
    assert.match(both[0] ?? '', new RegExp(VERIFIED_AGAINST.app.replace(/\./g, '\\.')));
    assert.match(both[1] ?? '', /2\.1\.300/);
    assert.match(both[1] ?? '', new RegExp(VERIFIED_AGAINST.cli.replace(/\./g, '\\.')));
    assert.equal(driftWarnings({ app: '2.20000.0', cli: null }).length, 1);
  });
});

describe('versions: drift of an inventory', () => {
  let world: World;
  let listed: WrittenTranscript;
  let plist: string;
  const inventory = async (): Promise<Inventory> => buildInventory(world.paths, { store: await AccountStore.load(world.paths.dataDir) });
  const writePlist = (version: string): Promise<void> => writeFile(plist, PLIST.split('<string>2.19675.0</string>').join(`<string>${version}</string>`));

  before(async () => {
    world = await makeWorld();
    plist = path.join(world.root, 'Info.plist');
    // Every fixture line carries version 2.1.275, older than the checked CLI.
    listed = await writeTranscript(world, { prompts: 1, email: EMAIL_A, title: 'listed' });
    await writeRecord(world, world.a, { cliSessionId: listed.cliId, title: 'listed' });
    await writeTranscript(world, { prompts: 1, email: null, title: 'unlisted' });
  });
  after(async () => {
    await destroyWorld(world);
  });

  it('warns about nothing when the app and the transcripts are no newer than the checked versions', async () => {
    await writePlist(VERIFIED_AGAINST.app);
    assert.deepEqual(await driftOf(await inventory(), plist), []);
    assert.deepEqual(await driftOf(await inventory(), path.join(world.root, 'no-app.plist')), [], 'no app installed is no drift');
  });

  it('gives one warning for a newer app', async () => {
    await writePlist('2.20000.0');
    const warnings = await driftOf(await inventory(), plist);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /the Claude app is 2\.20000\.0/);
  });

  it('takes the CLI version from the transcripts: the newest of the version each one ends with', async () => {
    await writePlist(VERIFIED_AGAINST.app);
    // The CLI that resumed the conversation later wrote a newer version on its line.
    await appendFile(listed.path, `${JSON.stringify({ type: 'system', sessionId: listed.cliId, version: '2.1.300', timestamp: '2026-10-06T10:00:00.000Z' })}\n`);
    const warnings = await driftOf(await inventory(), plist);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /the CLI that wrote the newest transcript is 2\.1\.300/);
    await writePlist('2.20000.0');
    assert.equal((await driftOf(await inventory(), plist)).length, 2, 'the app and the CLI, one warning each');
  });
});
