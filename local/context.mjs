import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';

const reservedDirectories = new Set([
  '.git', '.agents', '.claude', '.github', '.copilot', '.opencode', '.vscode', '.work', 'node_modules',
]);
const reservedFiles = new Set([
  'skill.md', 'agents.md', 'agents.override.md', 'claude.md', 'claude.local.md', 'gemini.md', 'copilot-instructions.md',
  '.mcp.json', 'opencode.json', 'opencode.jsonc',
]);

function contextPath(value) {
  if (typeof value !== 'string' || !value || win32.isAbsolute(value)) {
    throw new Error('context paths must be non-empty relative paths');
  }
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some((part) => !part || ['.', '..'].includes(part)
    || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`invalid context path: ${value}`);
  }
  if (parts[0].toLowerCase() === 'fixtures'
    || parts.some((part) => reservedDirectories.has(part.toLowerCase()) || reservedFiles.has(part.toLowerCase()))) {
    throw new Error(`reserved context path (client configuration, skills or runner inputs): ${value}`);
  }
  return parts.join('/');
}

export function resolveContext(value, base = process.cwd()) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['root', 'paths'].includes(key))
    || typeof value.root !== 'string' || !value.root.trim()
    || !Array.isArray(value.paths) || !value.paths.length) {
    throw new Error('context must be { root: directory, paths: non-empty relative path[] } or null');
  }
  const paths = value.paths.map(contextPath);
  const selected = paths.map((path) => path.toLowerCase()).sort();
  for (let i = 1; i < selected.length; i++) {
    if (selected[i] === selected[i - 1] || selected.some((path, j) => j < i && selected[i].startsWith(`${path}/`))) {
      throw new Error('context paths must not overlap');
    }
  }
  return { root: resolve(base, value.root), paths };
}

// Context is data, not another channel for loading client settings or skills.
export function validateContext(value) {
  const context = resolveContext(value);
  if (!context) return [];
  const rootStat = lstatSync(context.root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('context root must be a directory, not a symlink');
  const root = realpathSync(context.root);
  const files = [];
  const seen = new Set();
  const casing = new Map();
  const inspect = (path) => {
    contextPath(path);
    const key = path.toLowerCase();
    if (casing.has(key) && casing.get(key) !== path) throw new Error(`context has case-colliding paths: ${path}`);
    casing.set(key, path);
    const stat = lstatSync(join(root, ...path.split('/')));
    if (stat.isSymbolicLink()) throw new Error(`context contains a symlink: ${path}`);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`context is not a regular file or directory: ${path}`);
    return stat;
  };
  const walk = (path) => {
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(`context has duplicate or case-colliding paths: ${path}`);
    seen.add(key);
    const stat = inspect(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(join(root, ...path.split('/'))).sort()) walk(`${path}/${name}`);
    } else files.push(path);
  };
  for (const path of context.paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) inspect(parts.slice(0, i).join('/'));
    walk(path);
  }
  return files.sort();
}

export function snapshotContext(value, outDir) {
  const context = resolveContext(value);
  if (!context) return { contextSnapshot: null, contextHash: null };
  const files = validateContext(context);
  const contextSnapshot = join(outDir, 'context-source');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(contextSnapshot);
  const manifest = files.map((path) => {
    const target = join(contextSnapshot, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(context.root, ...path.split('/')), target);
    return { path, sha256: createHash('sha256').update(readFileSync(target)).digest('hex') };
  });
  const contextHash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  writeFileSync(join(outDir, 'context.json'), JSON.stringify({ schemaVersion: 1, sha256: contextHash, files: manifest }, null, 2), { flag: 'wx' });
  return { contextSnapshot, contextHash };
}
