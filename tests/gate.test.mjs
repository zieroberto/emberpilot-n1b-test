import test from 'node:test';
import assert from 'node:assert/strict';
import { gateReason, PINNED_NODE } from '../scripts/gate.mjs';
import { runScript } from './helpers/run-step.mjs';

const SHA = 'a'.repeat(40);
const ID = 'n1b-3d16ebf2-ab89-4754-9289-2d7170f97bdd';
const base = { nodeVersion: PINNED_NODE, names: ['PATH'], ref: 'refs/heads/main', sha: SHA, reviewed: SHA, dispatchId: ID };

test('pinned node version is exactly v22.23.4', () => {
  assert.equal(PINNED_NODE, 'v22.23.4');
});

test('all good passes', () => {
  assert.equal(gateReason(base), 'OK');
});

const bad = [
  ['wrong node', { nodeVersion: 'v22.23.5' }, 'NODE_VERSION'],
  ['node undefined', { nodeVersion: undefined }, 'NODE_VERSION'],
  ['override', { names: ['PATH', 'NODE_TLS_REJECT_UNAUTHORIZED'] }, 'ENV_TLS'],
  ['pg override', { names: ['PGHOST'] }, 'ENV_PG'],
  ['proxy override', { names: ['HTTPS_PROXY'] }, 'ENV_PROXY'],
  ['node override', { names: ['NODE_OPTIONS'] }, 'ENV_NODE'],
  ['other ref', { ref: 'refs/heads/dev' }, 'REF_MISMATCH'],
  ['tag ref', { ref: 'refs/tags/v1' }, 'REF_MISMATCH'],
  ['pr ref', { ref: 'refs/pull/1/merge' }, 'REF_MISMATCH'],
  ['sha mismatch', { reviewed: 'b'.repeat(40) }, 'SHA_MISMATCH'],
  ['reviewed missing', { reviewed: undefined }, 'SHA_MISMATCH'],
  ['reviewed short', { reviewed: 'abc', sha: 'abc' }, 'SHA_MISMATCH'],
  ['reviewed uppercase', { reviewed: 'A'.repeat(40), sha: 'A'.repeat(40) }, 'SHA_MISMATCH'],
  ['sha missing', { sha: undefined }, 'SHA_MISMATCH'],
  ['zero input style', { reviewed: '0'.repeat(64) }, 'SHA_MISMATCH'],
  ['n1a prefix', { dispatchId: 'n1a-4ad824dc-1dec-41e3-b68b-31d938af88d0' }, 'DISPATCH_PREFIX'],
  ['n1c prefix', { dispatchId: 'n1c-4ad824dc-1dec-41e3-b68b-31d938af88d0' }, 'DISPATCH_PREFIX'],
  ['no prefix', { dispatchId: '4ad824dc-1dec-41e3-b68b-31d938af88d0' }, 'DISPATCH_FORMAT'],
  ['empty id', { dispatchId: '' }, 'DISPATCH_FORMAT'],
  ['missing id', { dispatchId: undefined }, 'DISPATCH_FORMAT'],
  ['uppercase id', { dispatchId: ID.toUpperCase() }, 'DISPATCH_FORMAT'],
  ['not v4', { dispatchId: 'n1b-3d16ebf2-ab89-1754-9289-2d7170f97bdd' }, 'DISPATCH_FORMAT'],
  ['trailing char', { dispatchId: ID + 'x' }, 'DISPATCH_FORMAT'],
  ['n1b malformed', { dispatchId: 'n1b-zzzz' }, 'DISPATCH_FORMAT'],
  ['tests-workflow id', { dispatchId: 'n1t-3d16ebf2-ab89-4754-9289-2d7170f97bdd' }, 'DISPATCH_PREFIX'],
];
for (const [name, over, reason] of bad) {
  test(`gate rejects: ${name}`, () => {
    assert.equal(gateReason({ ...base, ...over }), reason);
  });
}

test('gate order: node, env, ref, sha, dispatch', () => {
  const all = { nodeVersion: 'x', names: ['PGHOST'], ref: 'r', sha: 'a', reviewed: 'b', dispatchId: 'n1a-x' };
  assert.equal(gateReason(all), 'NODE_VERSION');
  assert.equal(gateReason({ ...all, nodeVersion: PINNED_NODE }), 'ENV_PG');
  assert.equal(gateReason({ ...all, nodeVersion: PINNED_NODE, names: [] }), 'REF_MISMATCH');
  assert.equal(gateReason({ ...all, nodeVersion: PINNED_NODE, names: [], ref: 'refs/heads/main' }), 'SHA_MISMATCH');
  assert.equal(
    gateReason({ ...all, nodeVersion: PINNED_NODE, names: [], ref: 'refs/heads/main', sha: SHA, reviewed: SHA }),
    'DISPATCH_PREFIX',
  );
});

test('run-gate script passes and fails with fixed lines', () => {
  const env = { GITHUB_REF: 'refs/heads/main', GITHUB_SHA: SHA, REVIEWED_SHA: SHA, N1B_DISPATCH_ID: ID };
  const ok = runScript('run-gate.mjs', env);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, 'gate=pass reason=OK\n');
  const nc4 = runScript('run-gate.mjs', { ...env, N1B_DISPATCH_ID: 'n1a-4ad824dc-1dec-41e3-b68b-31d938af88d0' });
  assert.equal(nc4.status, 1);
  assert.equal(nc4.stdout, 'gate=fail reason=DISPATCH_PREFIX\n');
  const sha = runScript('run-gate.mjs', { ...env, REVIEWED_SHA: '0'.repeat(40) });
  assert.equal(sha.stdout, 'gate=fail reason=SHA_MISMATCH\n');
  assert.equal(sha.stderr, '');
  const pg = runScript('run-gate.mjs', { ...env, PGHOST: 'x' });
  assert.equal(pg.stdout, 'gate=fail reason=ENV_PG\n');
});

test('a 39-character sha pair is not accepted', () => {
  assert.equal(gateReason({ ...base, sha: 'a'.repeat(39), reviewed: 'a'.repeat(39) }), 'SHA_MISMATCH');
  assert.equal(gateReason({ ...base, sha: 'a'.repeat(41), reviewed: 'a'.repeat(41) }), 'SHA_MISMATCH');
});
