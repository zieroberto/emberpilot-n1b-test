import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runScript, runScriptNoNet, runScriptPreloads, ROOT } from './helpers/run-step.mjs';
import { GOOD_ENV, conn, PASSWORD, LABEL, ROLE, DB, TAIL, QUERY_B } from './helpers/fixtures.mjs';
import { isAllowedLine } from '../scripts/summary.mjs';

// Every window of N characters of a value, so any substring leak of that length is caught.
const windows = (s, n) => {
  const out = [];
  for (let i = 0; i + n <= s.length; i += 1) out.push(s.slice(i, i + n));
  return out;
};

function corpus(secret, parts) {
  const out = new Set();
  const add = (x) => x && x.length >= 6 && out.add(x);
  for (const base of [secret, ...parts]) {
    add(base);
    add(base.toLowerCase());
    add(base.toUpperCase());
    add(base.split('').reverse().join(''));
    add(Buffer.from(base).toString('base64'));
    add(Buffer.from(base).toString('base64url'));
    add(Buffer.from(base).toString('hex'));
    add(encodeURIComponent(base));
    add(JSON.stringify(base));
    add(JSON.stringify(base).slice(1, -1));
    add(`"${base}"`);
    add(`'${base}'`);
    add(base.slice(0, Math.ceil(base.length / 2)));
    add(base.slice(Math.floor(base.length / 2)));
    add(base.slice(0, 8));
    add(base.slice(-8));
  }
  for (const w of windows(secret, 10)) add(w);
  for (const w of windows(PASSWORD, 8)) add(w);
  return [...out];
}
const FRAGMENTS = corpus(conn(), [PASSWORD, LABEL, ROLE + ':' + PASSWORD, `${LABEL}.${TAIL}`, `${DB}?${QUERY_B}`]);

// Runs a step with a real summary file and output file, and checks every channel.
function runChannels(runner, script, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1b-ch-'));
  const summary = path.join(dir, 'summary.md');
  const output = path.join(dir, 'output.txt');
  const r = runner(script, { ...env, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  const res = { ...r, summary: read(summary), output: read(output) };
  fs.rmSync(dir, { recursive: true });
  return res;
}

function assertClean(r, label) {
  const all = [r.stdout, r.stderr, r.summary ?? '', r.output ?? ''].join('\n');
  for (const f of FRAGMENTS) assert.ok(!all.includes(f), `${label}: leaked fragment of length ${f.length}`);
  assert.equal(r.stderr, '', `${label}: stderr must be empty`);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.ok(lines.length >= 1, label);
  for (const l of lines) assert.ok(isAllowedLine(l), `${label}: line not allowed`);
  for (const l of (r.summary ?? '').split('\n').filter(Boolean)) assert.ok(isAllowedLine(l), `${label}: summary line not allowed`);
  for (const l of (r.output ?? '').split('\n').filter(Boolean)) assert.match(l, /^(marker=[0-9]|summary=incomplete|done=1)$/, `${label}: output line not allowed`);
}

const failures = [
  ['missing secret', { N1B_CONN: undefined }, 'MISSING_SECRET'],
  ['empty secret', { N1B_CONN: '' }, 'MISSING_SECRET'],
  ['wrong endpoint', { N1B_CONN: conn({ label: 'ep-other-label-111111' }) }, 'ENDPOINT_MISMATCH'],
  ['deny-list hit', { N1B_CONN: conn({ label: 'ep-prod-label-999999' }) }, 'DENY'],
  ['pooled', { N1B_CONN: conn({ label: LABEL + '-pooler' }) }, 'POOLED'],
  ['wrong tail', { N1B_CONN: conn({ tail: 'c-7.us-east-2.aws.neon.tech' }) }, 'TAIL'],
  ['wrong role', { N1B_CONN: conn({ user: 'otherrole' }) }, 'ROLE_MISMATCH'],
  ['bad query', { N1B_CONN: conn({ query: 'sslmode=disable' }) }, 'QUERY'],
  ['percent-encoded', { N1B_CONN: conn({ password: 'ab%41cd' }) }, 'ENCODING'],
  ['bad config', { N1B_EXPECTED_ROLE: 'BAD' }, 'CONFIG'],
  ['missing denylist', { N1B_DENYLIST: undefined }, 'CONFIG'],
];

function withEnv(over) {
  const env = { ...GOOD_ENV, ...over };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

for (const [name, over, reason] of failures) {
  test(`G rejects (${name}) with a fixed line and no leak`, () => {
    const r = runChannels(runScript, 'step-g.mjs', withEnv(over));
    assert.equal(r.status, 1);
    assert.equal(r.stdout, `check=validate result=fail reason=${reason}\n`);
    assert.equal(r.summary, r.stdout);
    assert.equal(r.output, 'done=1\n');
    assertClean(r, name);
  });
  test(`H rejects (${name}) before any connection call`, () => {
    const r = runChannels(runScriptNoNet, 'step-h.mjs', withEnv(over));
    assert.equal(r.status, 1);
    assert.equal(r.stdout, `check=connect result=fail reason=${reason}\n`);
    assert.equal(r.summary, r.stdout);
    assert.equal(r.output, 'marker=0\ndone=1\n');
    assertClean(r, name);
  });
}

test('G passes on a valid synthetic string and prints only the fixed line', () => {
  const r = runChannels(runScript, 'step-g.mjs', withEnv({}));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'check=validate result=pass reason=OK\n');
  assert.equal(r.output, 'done=1\n');
  assertClean(r, 'G pass');
});

test('G never imports or loads the database client', () => {
  const src = fs.readFileSync(new URL('../scripts/step-g.mjs', import.meta.url), 'utf8');
  assert.ok(!/connect\.mjs|from 'pg'/.test(src));
});

test('H with the network blocked: one call, fixed reason, error message never printed', () => {
  const r = runChannels(runScriptNoNet, 'step-h.mjs', withEnv({}));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, 'check=connect result=fail reason=CONNECT_FAILED\n');
  assert.equal(r.output, 'marker=1\ndone=1\n');
  assertClean(r, 'H blocked');
});

for (const mode of ['throw', 'reject']) {
  test(`an uncaught ${mode} containing the secret prints one fixed line, no stack, and still records the marker and the done flag`, () => {
    for (const script of ['step-g.mjs', 'step-h.mjs']) {
      const r = runChannels(runScriptNoNet, script, { ...withEnv({}), N1B_TEST_CRASH: mode });
      assert.equal(r.status, 1, script);
      const lines = r.stdout.split('\n').filter(Boolean);
      assert.match(lines[lines.length - 1], /^check=(validate|connect) result=fail reason=(INTERNAL|CONNECT_FAILED)$/);
      assert.ok(lines.length <= 2);
      if (script === 'step-h.mjs') assert.match(r.output, /^marker=[01]\ndone=1\n$/, 'H must record a marker and done even when it crashes');
      else assert.equal(r.output, 'done=1\n');
      assertClean(r, `${script} ${mode}`);
    }
  });
}

test('a failed summary-file write is flagged in the step output, never hidden', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1b-sd-'));
  const out = path.join(dir, 'o.txt');
  for (const [runner, script, expected] of [
    [runScript, 'step-g.mjs', 'summary=incomplete\ndone=1\n'],
    [runScriptNoNet, 'step-h.mjs', 'marker=1\nsummary=incomplete\ndone=1\n'],
  ]) {
    fs.writeFileSync(out, '');
    const r = runner(script, { ...withEnv({}), GITHUB_STEP_SUMMARY: dir, GITHUB_OUTPUT: out });
    assert.equal(r.stderr, '');
    assert.equal(fs.readFileSync(out, 'utf8'), expected, script);
    for (const l of r.stdout.split('\n').filter(Boolean)) assert.ok(isAllowedLine(l));
  }
  fs.rmSync(dir, { recursive: true });
});

test('summary file never receives anything outside the allowlist', () => {
  const r = runChannels(runScriptNoNet, 'step-h.mjs', withEnv({}));
  assert.equal(r.summary, r.stdout);
  for (const l of r.summary.split('\n').filter(Boolean)) assert.ok(isAllowedLine(l));
  for (const f of FRAGMENTS) assert.ok(!r.summary.includes(f));
});

test('the corpus is non-trivial and includes sliding windows of the secret', () => {
  assert.ok(FRAGMENTS.length >= 150);
  for (const w of windows(conn(), 10).slice(0, 5)) assert.ok(FRAGMENTS.includes(w));
});

test('no script writes to stderr by itself, even on failure paths', () => {
  const r = spawnSync(process.execPath, ['scripts/step-g.mjs'], { cwd: ROOT, env: {}, encoding: 'utf8' });
  assert.equal(r.stderr, '');
});

test('a hard kill during connect leaves the marker but no done flag in the step output', () => {
  const r = runChannels(runScriptNoNet, 'step-h.mjs', { ...withEnv({}), N1B_TEST_CRASH: 'kill-on-connect' });
  assert.equal(r.signal, 'SIGKILL');
  assert.equal(r.output, 'marker=1\n');
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.equal(r.summary, '');
  for (const f of FRAGMENTS) assert.ok(!r.output.includes(f));
});

test('a hard kill before the marker leaves no marker, so the run is unknown, never zero', () => {
  const r = runChannels(runScriptNoNet, 'step-h.mjs', { ...withEnv({}), N1B_TEST_CRASH: 'kill-early' });
  assert.equal(r.signal, 'SIGKILL');
  assert.equal(r.output, '');
  assert.equal(r.stdout, '');
  const fin = runScript('finish.mjs', { GITHUB_RUN_ID: '1', N1B_STEP_REVIEWED: 'success', N1B_STEP_CHECKOUT: 'success', N1B_STEP_NODE: 'success', N1B_STEP_INSTALL: 'success', N1B_STEP_GATE: 'success', N1B_STEP_G: 'success', N1B_STEP_H: 'failure', N1B_MARKER: '', N1B_DONE_H: '', N1B_DONE_G: '1' });
  assert.equal(fin.status, 1);
  assert.match(fin.stdout, /connect_marker=unknown\nevidence=incomplete\n$/);
});

test('the marker and the exit handler together write the marker exactly once', () => {
  const r = runChannels(runScriptNoNet, 'step-h.mjs', withEnv({}));
  assert.equal(r.output, 'marker=1\ndone=1\n');
});

function finishEnv(over) {
  return { GITHUB_RUN_ID: '1', N1B_STEP_REVIEWED: 'success', N1B_STEP_CHECKOUT: 'success', N1B_STEP_NODE: 'success', N1B_STEP_INSTALL: 'success', N1B_STEP_GATE: 'success', N1B_STEP_G: 'success', N1B_STEP_H: 'failure', N1B_DONE_G: '1', ...over };
}

// Parses a step output file into the variables finish receives.
function outputsOf(text) {
  const out = {};
  for (const l of text.split('\n').filter(Boolean)) {
    const i = l.indexOf('=');
    out[l.slice(0, i)] = l.slice(i + 1);
  }
  return out;
}

function runChannelsWith(script, env, preloads) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1b-pre-'));
  const summary = path.join(dir, 'summary.md');
  const output = path.join(dir, 'output.txt');
  const r = runScriptPreloads(script, { ...env, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output }, preloads);
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  const res = { ...r, summary: read(summary), output: read(output) };
  fs.rmSync(dir, { recursive: true });
  return res;
}

test('end to end: H killed during connect, passed through finish, is incomplete and shows the marker', () => {
  const r = runChannels(runScriptNoNet, 'step-h.mjs', { ...withEnv({}), N1B_TEST_CRASH: 'kill-on-connect' });
  assert.equal(r.signal, 'SIGKILL');
  const o = outputsOf(r.output);
  const fin = runScript('finish.mjs', finishEnv({ N1B_MARKER: o.marker ?? '', N1B_DONE_H: o.done ?? '', N1B_SUMMARY_H: o.summary ?? '' }));
  assert.equal(fin.status, 1);
  assert.match(fin.stdout, /step=h outcome=failure\nconnect_marker=1\nevidence=incomplete\n$/);
});

test('end to end: a kill between the marker write and the connect call leaves marker one and no done flag', () => {
  const r = runChannelsWith('step-h.mjs', withEnv({}), ['block-net.mjs', 'kill-after-marker.mjs']);
  assert.equal(r.signal, 'SIGKILL');
  assert.equal(r.output, 'marker=1\n');
  assert.equal(r.stdout, '');
  const o = outputsOf(r.output);
  const fin = runScript('finish.mjs', finishEnv({ N1B_MARKER: o.marker ?? '', N1B_DONE_H: o.done ?? '' }));
  assert.equal(fin.status, 1);
  assert.match(fin.stdout, /connect_marker=1\nevidence=incomplete\n$/);
});

test('a marker write failure prevents the connect: EVIDENCE_FAILED, nothing recorded, finish is incomplete', () => {
  const r = runChannelsWith('step-h.mjs', { ...withEnv({}), N1B_FAIL_APPEND_PREFIX: 'marker=' }, ['block-net.mjs', 'fail-final-append.mjs']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, 'check=connect result=fail reason=EVIDENCE_FAILED\n');
  assert.equal(r.output, '', 'no marker and no done flag could be written');
  assertClean(r, 'marker write failure');
  const o = outputsOf(r.output);
  const fin = runScript('finish.mjs', finishEnv({ N1B_MARKER: o.marker ?? '', N1B_DONE_H: o.done ?? '' }));
  assert.equal(fin.status, 1);
  assert.match(fin.stdout, /connect_marker=unknown\nevidence=incomplete\n$/);
});

test('combined failure: summary writes and the later output writes all fail, so finish is incomplete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1b-comb-'));
  const out = path.join(dir, 'o.txt');
  const r = runScriptPreloads('step-h.mjs', { ...withEnv({}), GITHUB_STEP_SUMMARY: dir, GITHUB_OUTPUT: out, N1B_FAIL_APPEND_PREFIX: 'summary=,done=' }, ['block-net.mjs', 'fail-final-append.mjs']);
  assert.equal(r.status, 1);
  const text = fs.readFileSync(out, 'utf8');
  assert.equal(text, 'marker=1\n', 'the marker survived, the summary flag and the done flag could not be written');
  const o = outputsOf(text);
  const fin = runScript('finish.mjs', finishEnv({ N1B_MARKER: o.marker ?? '', N1B_DONE_H: o.done ?? '', N1B_SUMMARY_H: o.summary ?? '' }));
  assert.equal(fin.status, 1);
  assert.match(fin.stdout, /evidence=incomplete\n$/);
  fs.rmSync(dir, { recursive: true });
});

test('G with its done write failing is incomplete in finish', () => {
  const r = runChannelsWith('step-g.mjs', { ...withEnv({}), N1B_FAIL_APPEND_PREFIX: 'done=' }, ['fail-final-append.mjs']);
  assert.equal(r.status, 0);
  assert.equal(r.output, '');
  const fin = runScript('finish.mjs', finishEnv({ N1B_STEP_H: 'skipped', N1B_DONE_G: '' }));
  assert.equal(fin.status, 1);
  assert.match(fin.stdout, /evidence=incomplete\n$/);
});

test('a lost summary flag also loses the done flag, so finish cannot report complete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1b-lost-'));
  const out = path.join(dir, 'o.txt');
  const r = runScriptPreloads('step-h.mjs', { ...withEnv({}), GITHUB_STEP_SUMMARY: dir, GITHUB_OUTPUT: out, N1B_FAIL_APPEND_PREFIX: 'summary=' }, ['block-net.mjs', 'fail-final-append.mjs']);
  assert.equal(r.status, 1);
  const text = fs.readFileSync(out, 'utf8');
  assert.equal(text, 'marker=1\n', 'neither the summary flag nor the done flag may be written');
  const o = outputsOf(text);
  const fin = runScript('finish.mjs', finishEnv({ N1B_MARKER: o.marker ?? '', N1B_DONE_H: o.done ?? '', N1B_SUMMARY_H: o.summary ?? '' }));
  assert.equal(fin.status, 1);
  assert.match(fin.stdout, /evidence=incomplete\n$/);
  fs.rmSync(dir, { recursive: true });
});
