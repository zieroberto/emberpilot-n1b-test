// SOURCE-LEVEL TRIPWIRES. These regex and import checks catch accidental changes to a small,
// reviewed code base. They are NOT a security boundary: aliasing, computed access, or a
// dependency's own behavior can evade them. Runtime tests and dependency review carry the weight.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers/run-step.mjs';

const DIR = path.join(ROOT, 'scripts');
const ALLOWED_IMPORTS = {
  'env.mjs': [],
  'env-guard.mjs': ['./env.mjs'],
  'summary.mjs': ['node:fs', './env.mjs'],
  'validator.mjs': [],
  'gate.mjs': ['./env-guard.mjs'],
  'run-gate.mjs': ['./env.mjs', './gate.mjs', './summary.mjs'],
  'step-g.mjs': ['./env.mjs', './env-guard.mjs', './validator.mjs', './summary.mjs'],
  'step-h.mjs': ['./env.mjs', './env-guard.mjs', './validator.mjs', './connect.mjs', './summary.mjs'],
  'finish.mjs': ['./env.mjs', './summary.mjs'],
  'connect.mjs': ['pg'],
};

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.mjs')).sort();
const read = (f) => strip(fs.readFileSync(path.join(DIR, f), 'utf8'));

function importsOf(src) {
  const out = [];
  for (const m of src.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) out.push(m[1]);
  for (const m of src.matchAll(/^\s*export\s+[^'"\n]*?\sfrom\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

test('the scripts directory holds exactly the reviewed files', () => {
  assert.deepEqual(files, Object.keys(ALLOWED_IMPORTS).sort());
  assert.deepEqual(fs.readdirSync(DIR).sort(), files);
});

test('each script imports only its reviewed modules', () => {
  for (const f of files) {
    assert.deepEqual(importsOf(read(f)).sort(), [...ALLOWED_IMPORTS[f]].sort(), f);
  }
});

test('only connect.mjs may import pg, and no script imports network or process modules', () => {
  for (const f of files) {
    for (const spec of importsOf(read(f))) {
      if (spec === 'pg') assert.equal(f, 'connect.mjs');
      assert.ok(!/^(node:)?(net|tls|http|https|http2|dns|dgram|child_process|cluster|worker_threads|vm|inspector|repl|readline|os|path|url|stream|zlib|crypto|v8|perf_hooks|module)(\/|$)/.test(spec), `${f} ${spec}`);
    }
  }
});

const FORBIDDEN = [
  [/\bchild_process\b/, 'child_process'],
  [/\bprocess\.argv\b/, 'argv'],
  [/\beval\s*\(/, 'eval'],
  [/\bnew\s+Function\b/, 'new Function'],
  [/\bimport\s*\(/, 'dynamic import'],
  [/\brequire\s*\(/, 'require'],
  [/\bfetch\s*\(/, 'fetch'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bXMLHttpRequest\b/, 'XHR'],
  [/\.query\s*\(/, '.query('],
  [/\.execute\s*\(/, '.execute('],
  [/\.exec\s*\(/, '.exec('],
  [/\.prepare\s*\(/, '.prepare('],
  [/\bcopyFrom\b|\bcopyTo\b/, 'copy'],
  [/\bPool\b/, 'Pool'],
  [/\bconsole\s*\./, 'console'],
  [/\bprocess\.stderr\b/, 'stderr'],
  [/JSON\.stringify/, 'JSON.stringify'],
  [/Object\.(values|assign)\s*\(/, 'Object.values/assign'],
  [/\.\.\.\s*process\b/, 'spread process'],
  [/\bprocess\.(binding|dlopen|kill|chdir|setuid|env)\b(?!\s*\[)/, 'process internals'],
  [/\bset\s+-x\b/, 'tracing'],
  [/\bfs\.|readFileSync|writeFileSync|createWriteStream|unlinkSync/, 'fs use other than append'],
];

test('forbidden constructs appear in no script (except the documented exceptions)', () => {
  for (const f of files) {
    const src = read(f);
    for (const [re, name] of FORBIDDEN) {
      let s = src;
      if (f === 'env.mjs' && name === 'process internals') s = s.replace(/process\.env\b/g, '');
      assert.ok(!re.test(s), `${f}: ${name}`);
    }
  }
});

test('Object.entries appears only in finish.mjs, over its own fixed outcome table', () => {
  for (const f of files) {
    const hits = [...read(f).matchAll(/Object\.entries\s*\(([^)]*)\)/g)].map((m) => m[1].trim());
    if (f === 'finish.mjs') assert.deepEqual(hits, ['o']);
    else assert.deepEqual(hits, [], f);
  }
});

test('process.env appears only in env.mjs, and only by allowlisted name or key listing', () => {
  for (const f of files) {
    const src = read(f);
    if (f !== 'env.mjs') assert.ok(!/process\.env/.test(src), f);
  }
  const env = read('env.mjs');
  const uses = [...env.matchAll(/process\.env[^;\n]*/g)].map((m) => m[0].trim());
  assert.deepEqual(uses.sort(), ['process.env)', 'process.env[name]'], 'unexpected process.env usage: ' + uses.join(' | '));
});

test('process.stdout, process exit handlers and fs append live only in summary.mjs', () => {
  for (const f of files) {
    const src = read(f);
    if (f !== 'summary.mjs') {
      assert.ok(!/process\.stdout/.test(src), f);
      assert.ok(!/appendFileSync/.test(src), f);
      assert.ok(!/process\.on\(\s*'exit'/.test(src), f);
    }
  }
  const s = read('summary.mjs');
  assert.equal([...s.matchAll(/appendFileSync\(/g)].length, 5);
  assert.equal([...s.matchAll(/process\.on\(\s*'exit'/g)].length, 1);
  assert.ok(!/writeFileSync|readFileSync|createWriteStream/.test(s));
});

test('getEnv is called with string literals only (outside its definition)', () => {
  for (const f of files) {
    if (f === 'env.mjs') continue;
    const src = read(f);
    for (const m of src.matchAll(/getEnv\(([^)]*)\)/g)) {
      assert.match(m[1].trim(), /^'[A-Z0-9_]+'$/, `${f}: getEnv(${m[1]})`);
    }
  }
});

test('the secret variable is read only in step G and step H', () => {
  for (const f of files) {
    const src = read(f);
    const reads = [...src.matchAll(/getEnv\('N1B_CONN'\)/g)].length;
    if (f === 'step-g.mjs' || f === 'step-h.mjs') assert.equal(reads, 1, f);
    else assert.equal(reads, 0, f);
    if (f !== 'env.mjs') assert.ok(!/N1B_CONN/.test(src.replace(/getEnv\('N1B_CONN'\)/g, '')), f);
  }
});

test('step H calls the connection boundary exactly once with exactly one argument', () => {
  const src = read('step-h.mjs');
  const calls = [...src.matchAll(/connectOnce\(([^)]*)\)/g)];
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].trim(), 'result.parts');
  assert.ok(!/resetConnectCallCount/.test(src));
  assert.ok(/registerExitOutputs\(connectMarkerCount\)/.test(src));
  assert.ok(/setConnectMarkerHook\(writeMarkerOutput\)/.test(src));
});

test('connect.mjs: reviewed export surface, one client construction, one counter increment, one connect, one end', () => {
  const src = read('connect.mjs');
  const exported = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|class|const)\s+(\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(exported, ['buildConfig', 'connectMarkerCount', 'connectOnce', 'reasonFor', 'runConnect', 'setConnectMarkerHook']);
  assert.equal([...src.matchAll(/markerHook\(markers \+ 1\)/g)].length, 1);
  assert.equal([...src.matchAll(/stream\.destroy\(\)/g)].length, 2);
  assert.equal([...src.matchAll(/new\s+ClientClass\(/g)].length, 1);
  assert.equal([...src.matchAll(/markers\s*\+=\s*1/g)].length, 1);
  assert.equal([...src.matchAll(/client\.connect\(/g)].length, 1);
  assert.equal([...src.matchAll(/client\.end\(/g)].length, 1);
  assert.ok(!/enableChannelBinding|extends\s+Client|_handleAuth/.test(src));
});

test('the TLS settings are literals in connect.mjs', () => {
  const src = read('connect.mjs');
  assert.match(src, /rejectUnauthorized:\s*true/);
  assert.ok(!/rejectUnauthorized:\s*(false|[a-z])/i.test(src.replace(/rejectUnauthorized:\s*true/g, '')));
  assert.ok(!/checkServerIdentity|ca:|cert:|key:/.test(src));
});

test('the environment allowlist is exactly the reviewed set of names', () => {
  const src = read('env.mjs');
  const block = src.slice(src.indexOf('new Set(['), src.indexOf(']);'));
  const names = [...block.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(names, [
    'GITHUB_OUTPUT',
    'GITHUB_REF',
    'GITHUB_RUN_ID',
    'GITHUB_SHA',
    'GITHUB_STEP_SUMMARY',
    'N1B_CONN',
    'N1B_DENYLIST',
    'N1B_DISPATCH_ID',
    'N1B_DONE_G',
    'N1B_DONE_H',
    'N1B_EXPECTED_DB',
    'N1B_EXPECTED_LABEL',
    'N1B_EXPECTED_ROLE',
    'N1B_MARKER',
    'N1B_STEP_CHECKOUT',
    'N1B_STEP_G',
    'N1B_STEP_GATE',
    'N1B_STEP_H',
    'N1B_STEP_INSTALL',
    'N1B_STEP_NODE',
    'N1B_STEP_REVIEWED',
    'N1B_SUMMARY_G',
    'N1B_SUMMARY_H',
    'REVIEWED_SHA',
  ]);
});
