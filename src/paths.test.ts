import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolvePaths } from './paths.ts';

describe('resolvePaths', () => {
  it('uses the desktop app and CLI defaults under the home directory', () => {
    const paths = resolvePaths({ home: '/Users/me', env: {} });
    assert.equal(paths.userData, '/Users/me/Library/Application Support/Claude');
    assert.equal(paths.sessionsRoot, '/Users/me/Library/Application Support/Claude/claude-code-sessions');
    assert.equal(paths.claudeDir, '/Users/me/.claude');
    assert.equal(paths.projectsRoot, '/Users/me/.claude/projects');
    assert.equal(paths.cliConfigFile, '/Users/me/.claude.json');
    assert.equal(paths.liveUserData, true);
    assert.equal(path.basename(paths.dataDir), 'data');
    assert.equal(paths.backupsDir, path.join(paths.dataDir, 'backups'));
  });

  it('follows CLAUDE_CONFIG_DIR for the CLI state, including .claude.json', () => {
    const paths = resolvePaths({ home: '/Users/me', env: { CLAUDE_CONFIG_DIR: '/custom/claude' } });
    assert.equal(paths.claudeDir, '/custom/claude');
    assert.equal(paths.cliConfigFile, '/custom/claude/.claude.json');
  });

  it('treats an explicit path to the real userData as live', () => {
    const paths = resolvePaths({ home: '/Users/me', env: {}, userData: '/Users/me/Library/Application Support/Claude/' });
    assert.equal(paths.liveUserData, true);
  });

  it('marks an overridden userData as not live', () => {
    const paths = resolvePaths({ home: '/Users/me', env: {}, userData: '/tmp/copy', claudeDir: '/tmp/cli', data: '/tmp/data' });
    assert.equal(paths.liveUserData, false);
    assert.equal(paths.userData, '/tmp/copy');
    assert.equal(paths.cliConfigFile, '/tmp/cli/.claude.json');
    assert.equal(paths.dataDir, '/tmp/data');
  });
});
