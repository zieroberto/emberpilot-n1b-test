// Structure checks on the two workflow files. They do not prove GitHub's effective runtime
// permissions, repository settings, secret policies, or the behavior of referenced actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ROOT } from './helpers/run-step.mjs';

const WF_DIR = path.join(ROOT, '.github', 'workflows');
const files = fs.readdirSync(WF_DIR).sort();
const rawMain = fs.readFileSync(path.join(WF_DIR, 'n1b.yml'), 'utf8');
const rawTests = fs.readFileSync(path.join(WF_DIR, 'n1b-tests.yml'), 'utf8');
const main = YAML.parse(rawMain);
const tests = YAML.parse(rawTests);
const steps = main.jobs.n1b.steps;
const tsteps = tests.jobs.tests.steps;
const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
const tById = Object.fromEntries(tsteps.map((s) => [s.id, s]));
const SECRET_ENV = ['N1B_CONN', 'N1B_DENYLIST', 'N1B_EXPECTED_DB', 'N1B_EXPECTED_LABEL', 'N1B_EXPECTED_ROLE'];
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE = 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1';

test('the repository has exactly the two reviewed workflow files', () => {
  assert.deepEqual(files, ['n1b-tests.yml', 'n1b.yml']);
});

for (const [label, wf, group] of [
  ['credentialed', main, 'n1b-single'],
  ['tests', tests, 'n1b-tests'],
]) {
  test(`${label} workflow: dispatch-only trigger with one required string input`, () => {
    assert.deepEqual(Object.keys(wf.on), ['workflow_dispatch']);
    assert.deepEqual(Object.keys(wf.on.workflow_dispatch), ['inputs']);
    assert.deepEqual(Object.keys(wf.on.workflow_dispatch.inputs), ['dispatch_id']);
    assert.equal(wf.on.workflow_dispatch.inputs.dispatch_id.required, true);
    assert.equal(wf.on.workflow_dispatch.inputs.dispatch_id.type, 'string');
  });

  test(`${label} workflow: read-only contents permission and a single non-cancelling concurrency group`, () => {
    assert.deepEqual(wf.permissions, { contents: 'read' });
    assert.deepEqual(wf.concurrency, { group, 'cancel-in-progress': false });
  });

  test(`${label} workflow: no workflow-level or job-level env, defaults, services, container, or reusable call`, () => {
    assert.deepEqual(Object.keys(wf).sort(), ['concurrency', 'jobs', 'name', 'on', 'permissions']);
    assert.equal(Object.keys(wf.jobs).length, 1);
    const job = Object.values(wf.jobs)[0];
    assert.deepEqual(Object.keys(job).sort(), ['runs-on', 'steps', 'timeout-minutes']);
    assert.equal(job['runs-on'], 'ubuntu-24.04');
    assert.equal(job['timeout-minutes'], 15);
  });
}

test('credentialed steps are exactly the reviewed ones, in order, with no test step', () => {
  assert.deepEqual(steps.map((s) => s.id), ['reviewed', 'checkout', 'node', 'install', 'gate', 'g', 'h', undefined]);
  assert.deepEqual(steps.map((s) => s.name), ['reviewed-sha', 'checkout', 'setup-node', 'install', 'gate', 'g-validate', 'h-connect', 'finish']);
  assert.ok(!/npm test|npm run|node --test/.test(rawMain));
});

test('tests workflow steps are exactly the reviewed ones, in order', () => {
  assert.deepEqual(tsteps.map((s) => s.id), ['reviewed', 'checkout', 'node', 'install', 'tests']);
  assert.deepEqual(tsteps.map((s) => s.name), ['reviewed-sha', 'checkout', 'setup-node', 'install', 'offline-tests']);
  assert.equal(tById.install.run, 'npm ci --ignore-scripts');
  assert.equal(tById.tests.run, 'npm test');
});

test('the tests workflow can never see a secret or an N1B variable', () => {
  assert.ok(!/secrets/.test(rawTests));
  assert.ok(!/N1B_/.test(rawTests));
  const varUses = [...rawTests.matchAll(/vars\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(varUses, ['REVIEWED_SHA']);
  for (const s of tsteps) {
    if (s.env) assert.deepEqual(Object.keys(s.env).sort(), s.id === 'reviewed' ? ['DISPATCH_ID', 'REVIEWED_SHA'] : []);
  }
});

test('the tests workflow checks the reviewed sha, the ref, and its own dispatch id prefix first', () => {
  const s = tsteps[0];
  assert.equal(s.env.REVIEWED_SHA, '${{ vars.REVIEWED_SHA }}');
  assert.equal(s.env.DISPATCH_ID, '${{ inputs.dispatch_id }}');
  assert.match(s.run, /GITHUB_REF" != "refs\/heads\/main"/);
  assert.match(s.run, /"\$GITHUB_SHA" != "\$REVIEWED_SHA"/);
  assert.match(s.run, /\^n1t-\[0-9a-f\]\{8\}/);
});

test('credentialed: the reviewed-sha comparison is the first step and fails before anything else', () => {
  const s = steps[0];
  assert.deepEqual(Object.keys(s.env), ['REVIEWED_SHA']);
  assert.equal(s.env.REVIEWED_SHA, '${{ vars.REVIEWED_SHA }}');
  assert.match(s.run, /GITHUB_REF" != "refs\/heads\/main"/);
  assert.match(s.run, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(s.run, /"\$GITHUB_SHA" != "\$REVIEWED_SHA"/);
});

test('credentialed: the secret appears only in steps G and H, mapped by exact expression', () => {
  const hits = rawMain.split('\n').filter((l) => /secrets/.test(l));
  assert.equal(hits.length, 2);
  for (const l of hits) assert.equal(l.trim(), 'N1B_CONN: ${{ secrets.NEON_N1B_TEST }}');
  for (const id of ['g', 'h']) assert.equal(byId[id].env.N1B_CONN, '${{ secrets.NEON_N1B_TEST }}');
  for (const s of steps) {
    if (s.id === 'g' || s.id === 'h') continue;
    assert.ok(!JSON.stringify(s).includes('secrets'), s.name);
  }
  assert.ok(!/toJSON|secrets\s*:\s*inherit|\bsecrets\[|\benv\s*:\s*\$\{\{/.test(rawMain));
});

test('credentialed: G and H have exactly the five reviewed env entries, no uses, no with', () => {
  for (const id of ['g', 'h']) {
    const s = byId[id];
    assert.deepEqual(Object.keys(s.env).sort(), SECRET_ENV);
    assert.equal(s.uses, undefined);
    assert.equal(s.with, undefined);
    assert.equal(s.if, undefined);
    assert.equal(s['continue-on-error'], undefined);
    assert.equal(s.shell, undefined);
    assert.equal(s.run, `node scripts/step-${id}.mjs`);
    for (const k of SECRET_ENV.slice(1)) assert.equal(s.env[k], `\${{ vars.${k} }}`);
  }
});

test('only checkout and setup-node use actions, both pinned to full commit SHAs, in both workflows', () => {
  for (const [list, ids] of [
    [steps, byId],
    [tsteps, tById],
  ]) {
    const used = list.filter((s) => s.uses);
    assert.deepEqual(used.map((s) => s.id), ['checkout', 'node']);
    assert.equal(ids.checkout.uses, CHECKOUT);
    assert.equal(ids.node.uses, SETUP_NODE);
    for (const s of used) assert.match(s.uses, /@[0-9a-f]{40}$/);
    assert.deepEqual(ids.checkout.with, { ref: '${{ github.sha }}', 'persist-credentials': false, 'fetch-depth': 1 });
    assert.deepEqual(ids.node.with, { 'node-version': '22.23.4', 'package-manager-cache': false });
  }
});

test('no run block in either workflow contains an expression, tracing, env dumps, or network tools', () => {
  for (const s of [...steps, ...tsteps]) {
    if (!s.run) continue;
    assert.ok(!s.run.includes('${{'), s.name);
    assert.ok(!/\bset\s+-[a-z]*x|\bprintenv\b|\benv\b\s*(\||$)|\bexport\b|\bcurl\b|\bwget\b|\bnc\b|\bdeclare\s+-p|\$N1B_|\$\{N1B_|\bcat\s+\/proc/m.test(s.run), s.name);
  }
});

test('credentialed: install is production-only with scripts disabled, before the gate and the secret steps', () => {
  const idx = (id) => steps.findIndex((s) => s.id === id);
  assert.equal(byId.install.run, 'npm ci --omit=dev --ignore-scripts');
  assert.ok(idx('install') < idx('gate') && idx('gate') < idx('g') && idx('g') < idx('h'));
  for (const s of steps.slice(idx('h') + 1)) assert.ok(!/npm|install/.test(s.run ?? ''));
});

test('credentialed: the gate step gets the dispatch id and reviewed sha only, through env', () => {
  assert.deepEqual(byId.gate.env, { N1B_DISPATCH_ID: '${{ inputs.dispatch_id }}', REVIEWED_SHA: '${{ vars.REVIEWED_SHA }}' });
  assert.equal(byId.gate.run, 'node scripts/run-gate.mjs');
});

test('credentialed: the finish step always runs and reads only step outcomes, the marker, the done flags, and summary flags', () => {
  const s = steps[steps.length - 1];
  assert.equal(s.if, 'always()');
  assert.deepEqual(s.env, {
    N1B_STEP_REVIEWED: '${{ steps.reviewed.outcome }}',
    N1B_STEP_CHECKOUT: '${{ steps.checkout.outcome }}',
    N1B_STEP_NODE: '${{ steps.node.outcome }}',
    N1B_STEP_INSTALL: '${{ steps.install.outcome }}',
    N1B_STEP_GATE: '${{ steps.gate.outcome }}',
    N1B_STEP_G: '${{ steps.g.outcome }}',
    N1B_STEP_H: '${{ steps.h.outcome }}',
    N1B_MARKER: '${{ steps.h.outputs.marker }}',
    N1B_DONE_G: '${{ steps.g.outputs.done }}',
    N1B_DONE_H: '${{ steps.h.outputs.done }}',
    N1B_SUMMARY_G: '${{ steps.g.outputs.summary }}',
    N1B_SUMMARY_H: '${{ steps.h.outputs.summary }}',
  });
  assert.equal(s.run, 'node scripts/finish.mjs');
});

test('credentialed: the finish step covers every earlier step id', () => {
  const ids = steps.filter((s) => s.id).map((s) => s.id);
  const finishEnv = JSON.stringify(steps[steps.length - 1].env);
  for (const id of ids) assert.ok(finishEnv.includes(`steps.${id}.outcome`), id);
});

test('credentialed: no step other than the named ones has an if, continue-on-error, or env', () => {
  for (const s of steps) {
    assert.equal(s['continue-on-error'], undefined, s.name);
    if (s.name !== 'finish') assert.equal(s.if, undefined, s.name);
    if (!['reviewed-sha', 'gate', 'g-validate', 'h-connect', 'finish'].includes(s.name)) assert.equal(s.env, undefined, s.name);
  }
  for (const s of tsteps) {
    assert.equal(s['continue-on-error'], undefined, s.name);
    assert.equal(s.if, undefined, s.name);
  }
});

test('neither workflow mentions artifacts, caches, uploads, or GITHUB_ENV', () => {
  for (const raw of [rawMain, rawTests]) {
    assert.ok(!/upload-artifact|actions\/cache|GITHUB_ENV|GITHUB_PATH|ACTIONS_STEP_DEBUG|ACTIONS_RUNNER_DEBUG|::add-mask|::set-output/.test(raw));
  }
});

test('the pinned node version in both workflows equals the gate and package engines', async () => {
  const { PINNED_NODE } = await import('../scripts/gate.mjs');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(`v${byId.node.with['node-version']}`, PINNED_NODE);
  assert.equal(`v${tById.node.with['node-version']}`, PINNED_NODE);
  assert.equal(pkg.engines.node, byId.node.with['node-version']);
});

test('package.json pins exact versions, with no install-time scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies), ['pg']);
  assert.deepEqual(Object.keys(pkg.devDependencies), ['yaml']);
  for (const v of [...Object.values(pkg.dependencies), ...Object.values(pkg.devDependencies)]) assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(pkg.scripts), ['test']);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  for (const [name, p] of Object.entries(lock.packages)) {
    if (!name) continue;
    assert.ok(p.integrity && p.resolved && p.resolved.startsWith('https://registry.npmjs.org/'), name);
    assert.ok(!p.hasInstallScript, name + ' has an install script');
  }
});
