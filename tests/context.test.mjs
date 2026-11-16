import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveContext, snapshotContext, validateContext } from '../local/context.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'eval-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'Read docs/guide.md.');
  writeFileSync(join(repo, 'docs', 'guide.md'), 'Read-only guidance.');
  writeFileSync(join(repo, 'private.txt'), 'Not selected.');
  return { root, repo, context: { root: repo, paths: ['README.md', 'docs'] } };
}

test('context snapshots preserve relative paths and bytes without copying unselected files', (t) => {
  const { root, repo, context } = setup(t);
  const prepared = snapshotContext(context, join(root, 'out'));
  writeFileSync(join(repo, 'README.md'), 'Changed after preparation.');
  assert.equal(readFileSync(join(prepared.contextSnapshot, 'README.md'), 'utf8'), 'Read docs/guide.md.');
  assert.equal(readFileSync(join(prepared.contextSnapshot, 'docs', 'guide.md'), 'utf8'), 'Read-only guidance.');
  assert.equal(existsSync(join(prepared.contextSnapshot, 'private.txt')), false);
  const manifest = JSON.parse(readFileSync(join(root, 'out', 'context.json'), 'utf8'));
  assert.equal(manifest.sha256, prepared.contextHash);
  assert.deepEqual(manifest.files.map((file) => file.path), ['README.md', 'docs/guide.md']);
  assert.throws(() => snapshotContext(context, join(root, 'out')), /EEXIST/);
});

test('context hashes bind relative paths and bytes, not selection order or source location', (t) => {
  const { root, repo, context } = setup(t);
  const first = snapshotContext(context, join(root, 'first'));
  const second = snapshotContext({ ...context, paths: [...context.paths].reverse() }, join(root, 'second'));
  assert.equal(second.contextHash, first.contextHash);
  const relocated = snapshotContext({ root: first.contextSnapshot, paths: context.paths }, join(root, 'relocated'));
  assert.equal(relocated.contextHash, first.contextHash);
  renameSync(join(repo, 'docs', 'guide.md'), join(repo, 'docs', 'renamed.md'));
  const renamed = snapshotContext(context, join(root, 'renamed'));
  assert.notEqual(renamed.contextHash, first.contextHash);
  writeFileSync(join(repo, 'docs', 'renamed.md'), 'Changed guidance.');
  assert.notEqual(snapshotContext(context, join(root, 'changed')).contextHash, renamed.contextHash);
});

test('context rejects escapes, ambiguous paths, overlapping selections and configuration payloads', (t) => {
  const { context } = setup(t);
  for (const path of ['.', '..', '../private.txt', 'docs/../README.md', '/tmp/readme', 'C:\\readme',
    'C:readme', '\\\\server\\share', 'docs//guide.md', 'docs/*.md', 'README.md:stream', 'docs/CON.txt',
    'docs/guide.md.', '.git', '.github/skills/demo', '.claude/settings.json', '.agents/skills',
    'fixtures/input.txt', 'docs/SKILL.md', 'docs/AGENTS.md', '.mcp.json', 'opencode.jsonc',
    'docs/node_modules', '.work', 'CLAUDE.local.md']) {
    assert.throws(() => resolveContext({ ...context, paths: [path] }), /context path/, path);
  }
  for (const paths of [['docs', 'docs/guide.md'], ['README.md', 'readme.md']]) {
    assert.throws(() => resolveContext({ ...context, paths }), /overlap/);
  }
  for (const value of [{}, [], 'docs', { root: '.', paths: [] }, { ...context, extra: true }]) {
    assert.throws(() => resolveContext(value), /context must/);
  }
  assert.deepEqual(snapshotContext(null, 'unused'), { contextSnapshot: null, contextHash: null });
});

test('context validates complete directory contents before creating a snapshot', (t) => {
  const { root, repo, context } = setup(t);
  writeFileSync(join(repo, 'docs', 'SKILL.md'), 'Must not leak into either arm.');
  assert.throws(() => snapshotContext(context, join(root, 'invalid')), /reserved context path/);
  assert.equal(existsSync(join(root, 'invalid')), false);
  assert.throws(() => validateContext({ ...context, paths: ['missing.md'] }), /ENOENT/);
});

test('context rejects junctions at the root, in selected parents and within selected directories', (t) => {
  const { root, repo, context } = setup(t);
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(repo, join(root, 'linked-root'), type);
  assert.throws(() => validateContext({ ...context, root: join(root, 'linked-root') }), /symlink/);
  symlinkSync(join(repo, 'docs'), join(repo, 'linked-docs'), type);
  assert.throws(() => validateContext({ ...context, paths: ['linked-docs/guide.md'] }), /symlink/);
  symlinkSync(join(repo, 'docs'), join(repo, 'docs', 'cycle'), type);
  assert.throws(() => validateContext(context), /symlink/);
});
