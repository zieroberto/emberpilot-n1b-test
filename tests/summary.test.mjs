import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAllowedLine } from '../scripts/summary.mjs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runScript, runScriptPreload, ROOT } from './helpers/run-step.mjs';

const good = [
  'run=12345',
  'gate=pass reason=OK',
  'gate=fail reason=SHA_MISMATCH',
  'gate=fail reason=ENV_PG',
  'check=validate result=pass reason=OK',
  'check=connect result=fail reason=CLEANUP_FAILED',
  'check=connect result=fail reason=EVIDENCE_FAILED',
  'step=g outcome=skipped',
  'step=install outcome=success',
  'step=checkout outcome=unknown',
  'connect_marker=0',
  'connect_marker=1',
  'connect_marker=unknown',
  'evidence=complete',
  'evidence=incomplete',
];
const bad = [
  '',
  'run=',
  'run=abc',
  'run=123456789012345678901',
  'gate=pass reason=ok',
  'gate=maybe reason=OK',
  'gate=fail reason=',
  'gate=fail reason=A',
  'gate=fail reason=' + 'A'.repeat(33),
  'check=connect result=pass reason=OK extra',
  'check=other result=pass reason=OK',
  'step=x outcome=success',
  'step=tests outcome=success',
  'step=g outcome=weird',
  'connect_marker=2',
  'connect_marker=9',
  'connect_marker=10',
  'connect_marker=-1',
  'connect_marker=Unknown',
  'db_connect_calls=1',
  'db_connect_attempts=1',
  'evidence=maybe',
  'host=ep-test-label-123456.c-8.us-east-2.aws.neon.tech',
  'error: password authentication failed',
  'gate=pass reason=OK\nextra',
  'gate=pass reason=OK\n',
  'postgresql://user:pass@host/db',
  undefined,
  null,
  5,
];

test('summary allowlist accepts only fixed formats', () => {
  for (const l of good) assert.equal(isAllowedLine(l), true, l);
  for (const l of bad) assert.equal(isAllowedLine(l), false, String(l));
});

const OK_ENV = {
  GITHUB_RUN_ID: '4242',
  N1B_STEP_REVIEWED: 'success',
  N1B_STEP_CHECKOUT: 'success',
  N1B_STEP_NODE: 'success',
  N1B_STEP_INSTALL: 'success',
  N1B_STEP_GATE: 'success',
  N1B_STEP_G: 'success',
  N1B_STEP_H: 'success',
  N1B_MARKER: '1',
  N1B_DONE_G: '1',
  N1B_DONE_H: '1',
};
const withEnv = (over) => {
  const env = { ...OK_ENV, ...over };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
};
const lines = (s) => s.split('\n').filter(Boolean);
const tail = (s) => lines(s).slice(-2).join('\n');

test('finish: a complete successful run', () => {
  const r = runScript('finish.mjs', withEnv({}));
  assert.equal(r.status, 0);
  assert.equal(
    r.stdout,
    'run=4242\nstep=reviewed outcome=success\nstep=checkout outcome=success\nstep=node outcome=success\nstep=install outcome=success\nstep=gate outcome=success\nstep=g outcome=success\nstep=h outcome=success\nconnect_marker=1\nevidence=complete\n',
  );
});

test('finish: an early failure with G and H skipped reports marker zero and complete evidence', () => {
  const r = runScript('finish.mjs', withEnv({ N1B_STEP_GATE: 'failure', N1B_STEP_G: 'skipped', N1B_STEP_H: 'skipped', N1B_MARKER: undefined, N1B_DONE_G: undefined, N1B_DONE_H: undefined }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /step=h outcome=skipped\nconnect_marker=0\nevidence=complete\n$/);
});

test('finish: G failure with H skipped is complete when G recorded its done flag', () => {
  const r = runScript('finish.mjs', withEnv({ N1B_STEP_G: 'failure', N1B_STEP_H: 'skipped', N1B_MARKER: undefined, N1B_DONE_H: undefined }));
  assert.equal(r.status, 0);
  assert.equal(tail(r.stdout), 'connect_marker=0\nevidence=complete');
});

test('finish: H failure with a marker and its done flag is complete accounting', () => {
  const r = runScript('finish.mjs', withEnv({ N1B_STEP_H: 'failure', N1B_MARKER: '1' }));
  assert.equal(r.status, 0);
  assert.equal(tail(r.stdout), 'connect_marker=1\nevidence=complete');
});

test('finish: H failure before any marker (marker zero, done flag present) is complete accounting', () => {
  const r = runScript('finish.mjs', withEnv({ N1B_STEP_H: 'failure', N1B_MARKER: '0' }));
  assert.equal(r.status, 0);
  assert.equal(tail(r.stdout), 'connect_marker=0\nevidence=complete');
});

test('finish: H killed after the marker (no done flag) is incomplete, and shows the marker it has', () => {
  const r = runScript('finish.mjs', withEnv({ N1B_STEP_H: 'failure', N1B_MARKER: '1', N1B_DONE_H: undefined }));
  assert.equal(r.status, 1);
  assert.equal(tail(r.stdout), 'connect_marker=1\nevidence=incomplete');
});

test('finish: H success without a done flag is incomplete', () => {
  const r = runScript('finish.mjs', withEnv({ N1B_DONE_H: undefined }));
  assert.equal(r.status, 1);
  assert.equal(tail(r.stdout), 'connect_marker=1\nevidence=incomplete');
});

test('finish: G without a done flag is incomplete', () => {
  const r = runScript('finish.mjs', withEnv({ N1B_DONE_G: undefined }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /evidence=incomplete\n$/);
});

test('finish: a malformed done flag is incomplete', () => {
  for (const bad of ['2', 'yes', '01', ' 1']) {
    for (const key of ['N1B_DONE_G', 'N1B_DONE_H']) {
      const r = runScript('finish.mjs', withEnv({ [key]: bad }));
      assert.equal(r.status, 1, key + bad);
      assert.match(r.stdout, /evidence=incomplete\n$/, key + bad);
    }
  }
});

test('finish: a done flag recorded for a skipped step is inconsistent', () => {
  const r = runScript('finish.mjs', withEnv({ N1B_STEP_H: 'skipped', N1B_MARKER: undefined, N1B_DONE_H: '1' }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /evidence=incomplete\n$/);
});

test('finish: H success with marker zero is inconsistent', () => {
  const r = runScript('finish.mjs', withEnv({ N1B_MARKER: '0' }));
  assert.equal(r.status, 1);
  assert.equal(tail(r.stdout), 'connect_marker=0\nevidence=incomplete');
});

test('finish: H success with no recorded marker is unknown and incomplete, never zero', () => {
  const r = runScript('finish.mjs', withEnv({ N1B_MARKER: '' }));
  assert.equal(r.status, 1);
  assert.equal(tail(r.stdout), 'connect_marker=unknown\nevidence=incomplete');
  assert.ok(!r.stdout.includes('connect_marker=0'));
});

test('finish: H failure with no recorded marker is unknown and incomplete, never zero', () => {
  const r = runScript('finish.mjs', withEnv({ N1B_STEP_H: 'failure', N1B_MARKER: '' }));
  assert.equal(r.status, 1);
  assert.equal(tail(r.stdout), 'connect_marker=unknown\nevidence=incomplete');
});

test('finish: a cancelled H with no marker is unknown and incomplete', () => {
  const r = runScript('finish.mjs', withEnv({ N1B_STEP_H: 'cancelled', N1B_MARKER: '', N1B_DONE_H: undefined }));
  assert.equal(r.status, 1);
  assert.equal(tail(r.stdout), 'connect_marker=unknown\nevidence=incomplete');
});

test('finish: a cancelled G is incomplete even when H was skipped, with or without a done flag', () => {
  for (const doneG of [undefined, '1']) {
    const r = runScript('finish.mjs', withEnv({ N1B_STEP_G: 'cancelled', N1B_STEP_H: 'skipped', N1B_MARKER: undefined, N1B_DONE_G: doneG, N1B_DONE_H: undefined }));
    assert.equal(r.status, 1, String(doneG));
    assert.equal(tail(r.stdout), 'connect_marker=0\nevidence=incomplete', String(doneG));
  }
});

test('finish: a cancelled H with a marker recorded is incomplete and shows the marker, with or without a done flag', () => {
  for (const doneH of [undefined, '1']) {
    const r = runScript('finish.mjs', withEnv({ N1B_STEP_H: 'cancelled', N1B_MARKER: '1', N1B_DONE_H: doneH }));
    assert.equal(r.status, 1, String(doneH));
    assert.equal(tail(r.stdout), 'connect_marker=1\nevidence=incomplete', String(doneH));
  }
});

test('finish: a marker other than 0 or 1 is impossible for one connection path, so it is unknown and incomplete', () => {
  for (const bad of ['2', '9']) {
    for (const h of ['failure', 'success', 'cancelled']) {
      const r = runScript('finish.mjs', withEnv({ N1B_STEP_H: h, N1B_MARKER: bad }));
      assert.equal(r.status, 1, h + bad);
      assert.equal(tail(r.stdout), 'connect_marker=unknown\nevidence=incomplete', h + bad);
    }
  }
});

test('finish: a marker recorded for a skipped H is inconsistent', () => {
  const r = runScript('finish.mjs', withEnv({ N1B_STEP_H: 'skipped', N1B_MARKER: '1', N1B_DONE_H: undefined }));
  assert.equal(r.status, 1);
  assert.equal(tail(r.stdout), 'connect_marker=unknown\nevidence=incomplete');
});

test('finish: a malformed marker is unknown and incomplete', () => {
  for (const bad of ['12', 'a', '-1', '01', ' 1']) {
    const r = runScript('finish.mjs', withEnv({ N1B_MARKER: bad }));
    assert.equal(r.status, 1, bad);
    assert.equal(tail(r.stdout), 'connect_marker=unknown\nevidence=incomplete', bad);
  }
});

test('finish: a missing or invalid step outcome is unknown and incomplete', () => {
  for (const over of [{ N1B_STEP_INSTALL: undefined }, { N1B_STEP_NODE: 'weird<script>' }, { N1B_STEP_CHECKOUT: '' }]) {
    const r = runScript('finish.mjs', withEnv(over));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /outcome=unknown\n/);
    assert.match(r.stdout, /evidence=incomplete\n$/);
    for (const l of lines(r.stdout)) assert.ok(isAllowedLine(l));
  }
});

test('finish: a missing run id is incomplete', () => {
  const r = runScript('finish.mjs', withEnv({ GITHUB_RUN_ID: undefined }));
  assert.equal(r.status, 1);
  assert.ok(!r.stdout.includes('run='));
  assert.match(r.stdout, /evidence=incomplete\n$/);
});

test('finish: a step that could not write its summary marks the evidence incomplete', () => {
  for (const key of ['N1B_SUMMARY_G', 'N1B_SUMMARY_H']) {
    const r = runScript('finish.mjs', withEnv({ [key]: 'incomplete' }));
    assert.equal(r.status, 1, key);
    assert.match(r.stdout, /evidence=incomplete\n$/, key);
  }
});

test('finish: its own failure to append to the summary file is reported as incomplete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1b-sumdir-'));
  const r = runScript('finish.mjs', withEnv({ GITHUB_STEP_SUMMARY: dir }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /evidence=incomplete\n$/);
  assert.equal(r.stderr, '');
  fs.rmSync(dir, { recursive: true });
});

test('summary file receives the same lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1b-sum-'));
  const file = path.join(dir, 'summary.md');
  const r = runScript('finish.mjs', withEnv({ GITHUB_STEP_SUMMARY: file }));
  assert.equal(fs.readFileSync(file, 'utf8'), r.stdout);
  fs.rmSync(dir, { recursive: true });
});

test('emit refuses anything outside the allowlist', async () => {
  const { emit } = await import('../scripts/summary.mjs');
  for (const l of ['host=ep-x', 'error: boom', 'gate=pass reason=ok', '', 'connect_marker=12']) {
    assert.throws(() => emit(l), /SUMMARY_LINE/, l);
  }
});

test('finish: a failure on the last summary line only is never published as complete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1b-late-'));
  const file = path.join(dir, 'summary.md');
  const r = runScriptPreload('finish.mjs', withEnv({ GITHUB_STEP_SUMMARY: file }), 'fail-final-append.mjs');
  assert.equal(r.status, 1);
  assert.ok(!r.stdout.includes('evidence=complete'));
  assert.match(r.stdout, /connect_marker=1\nevidence=incomplete\n$/);
  const body = fs.readFileSync(file, 'utf8');
  assert.ok(body.includes('connect_marker=1\n'), 'earlier lines were written');
  assert.ok(!body.includes('evidence='), 'the failed last line is absent from the file');
  assert.equal(r.stderr, '');
  fs.rmSync(dir, { recursive: true });
});

test('finish: the evidence line in the summary file matches what stdout publishes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1b-match-'));
  for (const [over, expected] of [
    [{}, 'evidence=complete'],
    [{ N1B_MARKER: '' }, 'evidence=incomplete'],
  ]) {
    const file = path.join(dir, 's-' + expected.slice(9) + '.md');
    const r = runScript('finish.mjs', withEnv({ ...over, GITHUB_STEP_SUMMARY: file }));
    assert.equal(lines(r.stdout).at(-1), expected);
    assert.equal(lines(fs.readFileSync(file, 'utf8')).at(-1), expected);
  }
  fs.rmSync(dir, { recursive: true });
});

test('finish: after an earlier failed write, the evidence line is incomplete in stdout and in the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1b-early-'));
  const file = path.join(dir, 'summary.md');
  const r = runScriptPreload('finish.mjs', withEnv({ GITHUB_STEP_SUMMARY: file, N1B_FAIL_APPEND_PREFIX: 'step=checkout' }), 'fail-final-append.mjs');
  assert.equal(r.status, 1);
  assert.equal(lines(r.stdout).at(-1), 'evidence=incomplete');
  const body = fs.readFileSync(file, 'utf8');
  assert.ok(!body.includes('step=checkout'), 'the failed line is absent from the file');
  assert.equal(lines(body).at(-1), 'evidence=incomplete');
  assert.ok(!body.includes('evidence=complete'));
  fs.rmSync(dir, { recursive: true });
});

test('emitEvidenceLine on its own: after an earlier failed append it writes and publishes incomplete, never complete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1b-unit-'));
  const file = path.join(dir, 'summary.md');
  const mod = pathToFileURL(path.join(ROOT, 'scripts', 'summary.mjs')).href;
  const code = `import { emit, emitEvidenceLine } from '${mod}'; emit('run=1'); const ok = emitEvidenceLine(true); process.exitCode = ok ? 0 : 3;`;
  const r = spawnSync(process.execPath, ['--import', path.join(ROOT, 'tests', 'helpers', 'fail-final-append.mjs'), '--input-type=module', '-e', code], {
    cwd: ROOT,
    env: { GITHUB_STEP_SUMMARY: file, N1B_FAIL_APPEND_PREFIX: 'run=' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 3);
  assert.equal(lines(r.stdout).at(-1), 'evidence=incomplete');
  assert.equal(lines(fs.readFileSync(file, 'utf8')).at(-1), 'evidence=incomplete');
  assert.ok(!r.stdout.includes('evidence=complete'));
  fs.rmSync(dir, { recursive: true });
});

test('emitEvidenceLine on its own: with no failed append a complete request is published as complete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1b-unit2-'));
  const file = path.join(dir, 'summary.md');
  const mod = pathToFileURL(path.join(ROOT, 'scripts', 'summary.mjs')).href;
  const code = `import { emitEvidenceLine } from '${mod}'; process.exitCode = emitEvidenceLine(true) ? 0 : 3;`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: { GITHUB_STEP_SUMMARY: file }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'evidence=complete\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'evidence=complete\n');
  fs.rmSync(dir, { recursive: true });
});

test('writeMarkerOutput throws when it cannot write, and only accepts one digit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1b-wm-'));
  const mod = pathToFileURL(path.join(ROOT, 'scripts', 'summary.mjs')).href;
  const run = (env, body) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', `import { writeMarkerOutput as w } from '${mod}'; try { ${body}; console.log('ok'); } catch (e) { console.log('threw:' + e.message); }`], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(run({}, 'w(1)').stdout, 'threw:NO_OUTPUT\n');
  assert.equal(run({ GITHUB_OUTPUT: dir }, 'w(1)').stdout.startsWith('threw:'), true);
  const ok = path.join(dir, 'o.txt');
  assert.equal(run({ GITHUB_OUTPUT: ok }, 'w(1); w(1)').stdout, 'ok\n');
  assert.equal(fs.readFileSync(ok, 'utf8'), 'marker=1\n');
  for (const bad of ['10', "'a'", '-1', 'undefined']) assert.equal(run({ GITHUB_OUTPUT: ok }, `w(${bad})`).stdout, 'threw:MARKER_VALUE\n', bad);
  fs.rmSync(dir, { recursive: true });
});
