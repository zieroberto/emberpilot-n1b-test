import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEnv, forbiddenName, categoryOf, FORBIDDEN_NAMES } from '../scripts/env-guard.mjs';
import { runScript } from './helpers/run-step.mjs';
import { GOOD_ENV } from './helpers/fixtures.mjs';

test('clean environment passes', () => {
  assert.equal(checkEnv(['PATH', 'HOME', 'GITHUB_SHA', 'N1B_CONN', 'CI']), null);
  assert.equal(checkEnv([]), null);
});

test('every listed override name maps to a fixed category', () => {
  assert.ok(FORBIDDEN_NAMES.length >= 10);
  for (const name of FORBIDDEN_NAMES) {
    assert.match(checkEnv(['PATH', name]), /^ENV_(TLS|NODE|PROXY)$/, name);
  }
});

test('categories are fixed and value-free', () => {
  const expected = {
    NODE_TLS_REJECT_UNAUTHORIZED: 'ENV_TLS',
    NODE_EXTRA_CA_CERTS: 'ENV_TLS',
    SSL_CERT_FILE: 'ENV_TLS',
    SSL_CERT_DIR: 'ENV_TLS',
    OPENSSL_CONF: 'ENV_TLS',
    NODE_OPTIONS: 'ENV_NODE',
    NODE_DEBUG: 'ENV_NODE',
    HTTPS_PROXY: 'ENV_PROXY',
    HTTP_PROXY: 'ENV_PROXY',
    PGHOST: 'ENV_PG',
    PGSSLMODE: 'ENV_PG',
  };
  for (const [name, cat] of Object.entries(expected)) {
    assert.equal(categoryOf(name), cat, name);
    assert.equal(checkEnv([name]), cat, name);
  }
});

test('when several categories are present the highest priority is reported', () => {
  assert.equal(checkEnv(['HTTPS_PROXY', 'NODE_OPTIONS', 'SSL_CERT_FILE', 'PGHOST']), 'ENV_PG');
  assert.equal(checkEnv(['HTTPS_PROXY', 'NODE_OPTIONS', 'SSL_CERT_FILE']), 'ENV_TLS');
  assert.equal(checkEnv(['HTTPS_PROXY', 'NODE_OPTIONS']), 'ENV_NODE');
  assert.equal(checkEnv(['HTTPS_PROXY']), 'ENV_PROXY');
});

test('any PG-prefixed name is rejected', () => {
  for (const name of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGOPTIONS', 'PGX']) {
    assert.equal(checkEnv([name]), 'ENV_PG', name);
    assert.equal(forbiddenName(name), true);
  }
  assert.equal(forbiddenName('pgsomething'), false);
  assert.equal(forbiddenName('MYPGVAR'), false);
});

for (const [name, cat] of [
  ['NODE_TLS_REJECT_UNAUTHORIZED', 'ENV_TLS'],
  ['NODE_EXTRA_CA_CERTS', 'ENV_TLS'],
  ['PGSSLMODE', 'ENV_PG'],
  ['PGHOST', 'ENV_PG'],
  ['NODE_OPTIONS', 'ENV_NODE'],
  ['HTTPS_PROXY', 'ENV_PROXY'],
]) {
  test(`step G and H stop on override ${name} with category ${cat}`, () => {
    for (const [script, check] of [['step-g.mjs', 'validate'], ['step-h.mjs', 'connect']]) {
      const r = runScript(script, { ...GOOD_ENV, [name]: '0' });
      assert.equal(r.status, 1, script);
      assert.equal(r.stdout, `check=${check} result=fail reason=${cat}\n`);
      assert.ok(!r.stdout.includes(name));
    }
  });
}

test('the required override names are rejected by name, independent of the exported list', () => {
  for (const name of [
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_EXTRA_CA_CERTS',
    'NODE_OPTIONS',
    'NODE_USE_SYSTEM_CA',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'OPENSSL_CONF',
    'HTTPS_PROXY',
    'PGSSLMODE',
  ]) {
    assert.notEqual(checkEnv([name]), null, name);
  }
  assert.equal(checkEnv(['PATH', 'HOME', 'CI', 'GITHUB_SHA']), null);
});
