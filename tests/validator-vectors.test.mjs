import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, parseConfig, MAX_LEN } from '../scripts/validator.mjs';
import { CONFIG, conn, PASSWORD, LABEL, ROLE, DB, TAIL, QUERY_A, QUERY_B } from './helpers/fixtures.mjs';

test('valid: both accepted query forms, both schemes, explicit port', () => {
  for (const s of [
    conn(),
    conn({ query: QUERY_A }),
    conn({ scheme: 'postgres://' }),
    conn({ port: 5432 }),
  ]) {
    const r = validate(s, CONFIG);
    assert.equal(r.ok, true, s.slice(0, 20));
    assert.equal(r.parts.host, `${LABEL}.${TAIL}`);
    assert.equal(r.parts.port, 5432);
    assert.equal(r.parts.user, ROLE);
    assert.equal(r.parts.database, DB);
    assert.equal(r.parts.password, PASSWORD);
  }
});

test('accepted parts carry no channel-binding flag (binding is not enforced)', () => {
  for (const q of [QUERY_A, QUERY_B]) {
    const r = validate(conn({ query: q }), CONFIG);
    assert.deepEqual(Object.keys(r.parts).sort(), ['database', 'host', 'password', 'port', 'user']);
    assert.ok(Object.isFrozen(r.parts));
  }
});

const long = 'postgresql://' + 'a'.repeat(MAX_LEN);
const cases = [
  ['undefined', undefined, 'MISSING_SECRET'],
  ['empty', '', 'MISSING_SECRET'],
  ['number', 5, 'MISSING_SECRET'],
  ['over cap', long, 'LENGTH'],
  ['space', conn({ password: 'ab cd' }), 'CHARSET'],
  ['newline', conn() + '\n', 'CHARSET'],
  ['tab', conn({ password: 'ab\tcd' }), 'CHARSET'],
  ['non-ascii', conn({ password: 'abcd\u00e9' }), 'CHARSET'],
  ['control char', conn({ password: 'ab\u0001cd' }), 'CHARSET'],
  ['percent in password', conn({ password: 'ab%41cd' }), 'ENCODING'],
  ['percent in host', conn({ label: 'ep-test%2dlabel-123456' }), 'ENCODING'],
  ['percent in user', conn({ user: 'test%72ole' }), 'ENCODING'],
  ['percent in db', conn({ db: 'test%64b' }), 'ENCODING'],
  ['percent in query', conn({ query: 'sslmode=requ%69re' }), 'ENCODING'],
  ['percent-encoded at sign', conn({ password: 'ab%40cd' }), 'ENCODING'],
  ['lone percent', conn() + '%', 'ENCODING'],
  ['fragment', conn() + '#x', 'FRAGMENT'],
  ['ipv6', conn({ host: '[::1]' }), 'IPV6'],
  ['wrong scheme', conn({ scheme: 'mysql://' }), 'SCHEME'],
  ['upper scheme', conn({ scheme: 'POSTGRESQL://' }), 'SCHEME'],
  ['http scheme', conn({ scheme: 'http://' }), 'SCHEME'],
  ['two at', conn({ password: 'ab@cd' }), 'STRUCTURE'],
  ['no at', 'postgresql://user-password-host/db?' + QUERY_A, 'STRUCTURE'],
  ['no password', `postgresql://${ROLE}@${LABEL}.${TAIL}/${DB}?${QUERY_A}`, 'STRUCTURE'],
  ['empty user', conn({ user: '' }), 'STRUCTURE'],
  ['empty password', conn({ password: '' }), 'STRUCTURE'],
  ['colon in password', conn({ password: 'ab:cd' }), 'STRUCTURE'],
  ['two slashes', conn() + '/x', 'STRUCTURE'],
  ['no query', `postgresql://${ROLE}:${PASSWORD}@${LABEL}.${TAIL}/${DB}`, 'STRUCTURE'],
  ['empty db', `postgresql://${ROLE}:${PASSWORD}@${LABEL}.${TAIL}/?${QUERY_A}`, 'STRUCTURE'],
  ['empty query', `postgresql://${ROLE}:${PASSWORD}@${LABEL}.${TAIL}/${DB}?`, 'STRUCTURE'],
  ['two ports', conn({ port: '5432:5432' }), 'STRUCTURE'],
  ['uppercase user', conn({ user: 'TestRole' }), 'USER'],
  ['hyphen user', conn({ user: 'test-role' }), 'USER'],
  ['slash in password', conn({ password: 'ab/cd' }), 'PASSWORD'],
  ['question in password', conn({ password: 'ab?cd' }), 'PASSWORD'],
  ['bang in password', conn({ password: 'ab!cd' }), 'PASSWORD'],
  ['129 char password', conn({ password: 'a'.repeat(129) }), 'PASSWORD'],
  ['trailing dot', conn({ host: `${LABEL}.${TAIL}.` }), 'HOST'],
  ['uppercase host', conn({ host: `${LABEL}.${TAIL}`.toUpperCase() }), 'HOST'],
  ['ipv4', conn({ host: '10.0.0.1' }), 'HOST'],
  ['no dot host', conn({ host: 'localhost' }), 'HOST'],
  ['pooled label', conn({ label: LABEL + '-pooler' }), 'POOLED'],
  ['underscore label', conn({ label: 'ep-test_label-123456' }), 'LABEL'],
  ['no ep prefix', conn({ label: 'test-label-123456' }), 'LABEL'],
  ['double hyphen label', conn({ label: 'ep--test-123456' }), 'LABEL'],
  ['trailing hyphen label', conn({ label: 'ep-test-' }), 'LABEL'],
  ['lookalike tail suffix', conn({ tail: TAIL + '.evil.com' }), 'TAIL'],
  ['old cluster tail', conn({ tail: 'c-7.us-east-2.aws.neon.tech' }), 'TAIL'],
  ['tail extra char', conn({ tail: TAIL + 'x' }), 'TAIL'],
  ['extra subdomain', conn({ host: `${LABEL}.sub.${TAIL}` }), 'TAIL'],
  ['bare neon.tech', conn({ tail: 'neon.tech' }), 'TAIL'],
  ['other region', conn({ tail: 'c-8.us-east-1.aws.neon.tech' }), 'TAIL'],
  ['port 5433', conn({ port: 5433 }), 'PORT'],
  ['empty port', conn({ port: '' }), 'PORT'],
  ['alpha port', conn({ port: 'abc' }), 'PORT'],
  ['uppercase db', conn({ db: 'TestDb' }), 'DATABASE_FORMAT'],
  ['dot db', conn({ db: 'test.db' }), 'DATABASE_FORMAT'],
  ['64 char db', conn({ db: 'd'.repeat(64) }), 'DATABASE_FORMAT'],
  ['sslmode disable', conn({ query: 'sslmode=disable' }), 'QUERY'],
  ['binding disable', conn({ query: 'sslmode=require&channel_binding=disable' }), 'QUERY'],
  ['reordered', conn({ query: 'channel_binding=require&sslmode=require' }), 'QUERY'],
  ['duplicate sslmode', conn({ query: 'sslmode=require&sslmode=require' }), 'QUERY'],
  ['extra key', conn({ query: 'sslmode=require&foo=bar' }), 'QUERY'],
  ['upper key', conn({ query: 'SSLMODE=require' }), 'QUERY'],
  ['upper value', conn({ query: 'sslmode=Require' }), 'QUERY'],
  ['trailing amp', conn({ query: 'sslmode=require&' }), 'QUERY'],
  ['trailing amp 2', conn({ query: QUERY_B + '&' }), 'QUERY'],
  ['empty value', conn({ query: 'sslmode=' }), 'QUERY'],
  ['binding only', conn({ query: 'channel_binding=require' }), 'QUERY'],
  ['deny label', conn({ label: 'ep-prod-label-999999' }), 'DENY'],
  ['deny db', conn({ db: 'prod_database_name' }), 'DENY'],
  ['deny case-insensitive', conn({ password: 'xPROD_DATABASE_NAMEx' }), 'DENY'],
  ['role mismatch', conn({ user: 'otherrole' }), 'ROLE_MISMATCH'],
  ['label mismatch', conn({ label: 'ep-other-label-111111' }), 'ENDPOINT_MISMATCH'],
  ['db mismatch', conn({ db: 'otherdb' }), 'DATABASE_MISMATCH'],
];

for (const [name, input, reason] of cases) {
  test(`reject: ${name} -> ${reason}`, () => {
    const r = validate(input, CONFIG);
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason);
    assert.deepEqual(Object.keys(r).sort(), ['ok', 'reason']);
    const out = JSON.stringify(r);
    assert.ok(!out.includes(PASSWORD));
    assert.ok(!out.includes(LABEL));
  });
}

test('validate fails closed on internal error', () => {
  assert.equal(validate(conn(), null).reason, 'INTERNAL');
  assert.equal(validate(conn(), {}).reason, 'INTERNAL');
});

test('parseConfig vectors', () => {
  const ok = { role: ROLE, label: LABEL, db: DB, denylist: ' EP-prod-label-999999 , prod_database_name ' };
  const r = parseConfig(ok);
  assert.equal(r.ok, true);
  assert.deepEqual([...r.config.denylist], ['ep-prod-label-999999', 'prod_database_name']);
  const bad = [
    { ...ok, role: undefined },
    { ...ok, role: 'TestRole' },
    { ...ok, label: LABEL + '-pooler' },
    { ...ok, label: 'x' + LABEL },
    { ...ok, label: 'ep-' + 'a'.repeat(70) },
    { ...ok, db: 'Test' },
    { ...ok, denylist: '' },
    { ...ok, denylist: undefined },
    { ...ok, denylist: 'short' },
    { ...ok, denylist: 'valid-entry-1,bad entry' },
    { ...ok, denylist: 'valid-entry-1,' },
    { ...ok, denylist: Array.from({ length: 51 }, (_, i) => `entry-${String(i).padStart(3, '0')}`).join(',') },
    { ...ok, denylist: 'a'.repeat(2001) },
  ];
  for (const b of bad) {
    const x = parseConfig(b);
    assert.equal(x.ok, false);
    assert.equal(x.reason, 'CONFIG');
  }
});

test('reason precedence follows the documented order', () => {
  const v = (o) => validate(conn(o), CONFIG).reason;
  assert.equal(v({ tail: 'x.neon.tech', port: 5433 }), 'TAIL');
  assert.equal(v({ port: 5433, db: 'Bad' }), 'PORT');
  assert.equal(v({ db: 'Bad', query: 'x=y' }), 'DATABASE_FORMAT');
  assert.equal(v({ query: 'x=y', label: 'ep-prod-label-999999' }), 'QUERY');
  assert.equal(v({ label: 'ep-prod-label-999999', user: 'otherrole' }), 'DENY');
  assert.equal(v({ user: 'otherrole', label: 'ep-other-label-111111' }), 'ROLE_MISMATCH');
  assert.equal(v({ label: 'ep-other-label-111111', db: 'otherdb' }), 'ENDPOINT_MISMATCH');
  assert.equal(v({ label: 'ep-bad_label-1', tail: 'x.neon.tech' }), 'LABEL');
  assert.equal(v({ label: LABEL + '-pooler', tail: 'x.neon.tech' }), 'POOLED');
  assert.equal(validate('postgresql://' + 'a b'.repeat(200), CONFIG).reason, 'LENGTH');
  assert.equal(validate('postgresql://a b%', CONFIG).reason, 'CHARSET');
  assert.equal(validate('postgresql://ab%#', CONFIG).reason, 'ENCODING');
  assert.equal(validate('postgresql://ab#[', CONFIG).reason, 'FRAGMENT');
});

test('length boundary: 512 characters is not a length failure, 513 is', () => {
  assert.equal(validate('x'.repeat(MAX_LEN), CONFIG).reason, 'SCHEME');
  assert.equal(validate('x'.repeat(MAX_LEN + 1), CONFIG).reason, 'LENGTH');
  assert.equal(MAX_LEN, 512);
});

test('the approved tail is exactly the one Robbert confirmed', async () => {
  const { TAIL } = await import('../scripts/validator.mjs');
  assert.equal(TAIL, 'c-8.us-east-2.aws.neon.tech');
});

test('trailing garbage after a third at-sign is rejected', () => {
  assert.equal(validate(conn() + '@x', CONFIG).reason, 'STRUCTURE');
  assert.equal(validate(conn({ query: QUERY_A }) + '@' + conn(), CONFIG).reason, 'STRUCTURE');
  assert.equal(validate(conn({ password: 'ab' }).replace('ab@', 'ab@ab@'), CONFIG).reason, 'STRUCTURE');
});

test('a deny-list longer than 2000 characters in total is rejected even when every entry is valid', () => {
  const entries = Array.from({ length: 30 }, (_, i) => `entry-${String(i).padStart(2, '0')}-` + 'x'.repeat(60));
  const joined = entries.join(',');
  assert.ok(joined.length > 2000);
  assert.equal(parseConfig({ role: ROLE, label: LABEL, db: DB, denylist: joined }).reason, 'CONFIG');
  assert.equal(parseConfig({ role: ROLE, label: LABEL, db: DB, denylist: entries.slice(0, 20).join(',') }).ok, true);
});

test('the password character set is exactly letters, digits and . _ ~ -', () => {
  for (const ch of ['.', '_', '~', '-', 'a', 'Z', '0']) {
    assert.equal(validate(conn({ password: 'ab' + ch + 'cd' }), CONFIG).ok, true, ch);
  }
  for (const ch of ['!', '$', '&', '*', '(', ')', '+', ',', ';', '=', '<', '>', '"', "'", '\\', '^', '`', '{', '}', '|']) {
    assert.equal(validate(conn({ password: 'ab' + ch + 'cd' }), CONFIG).reason, 'PASSWORD', ch);
  }
});
