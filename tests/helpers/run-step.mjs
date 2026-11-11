import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Runs a script with ONLY the given environment. Used by tests, never by scripts.
export function runScript(script, env, { timeout = 20000 } = {}) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', script)], {
    env,
    cwd: root,
    encoding: 'utf8',
    timeout,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal };
}

export const ROOT = root;

// Same, with the no-network preload.
export function runScriptNoNet(script, env, { timeout = 20000 } = {}) {
  const r = spawnSync(
    process.execPath,
    ['--import', path.join(root, 'tests', 'helpers', 'block-net.mjs'), path.join(root, 'scripts', script)],
    { env, cwd: root, encoding: 'utf8', timeout },
  );
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal };
}

// Same, with a named extra preload from tests/helpers (and the no-network preload).
export function runScriptPreload(script, env, preloadFile, { timeout = 20000 } = {}) {
  const r = spawnSync(
    process.execPath,
    ['--import', path.join(root, 'tests', 'helpers', preloadFile), path.join(root, 'scripts', script)],
    { env, cwd: root, encoding: 'utf8', timeout },
  );
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal };
}

// Same, with several extra preloads from tests/helpers, in the given order.
export function runScriptPreloads(script, env, preloadFiles, { timeout = 20000 } = {}) {
  const args = [];
  for (const f of preloadFiles) args.push('--import', path.join(root, 'tests', 'helpers', f));
  args.push(path.join(root, 'scripts', script));
  const r = spawnSync(process.execPath, args, { env, cwd: root, encoding: 'utf8', timeout });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal };
}
