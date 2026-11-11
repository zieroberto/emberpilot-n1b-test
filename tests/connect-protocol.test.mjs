import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import pg from 'pg';
import { buildConfig, reasonFor } from '../scripts/connect.mjs';
import { validate } from '../scripts/validator.mjs';
import { startFakePg } from './helpers/fake-pg.mjs';
import { CONFIG, conn, LABEL, DB, ROLE, PASSWORD, TAIL } from './helpers/fixtures.mjs';

const parts = validate(conn(), CONFIG).parts;

// Every test gets its own module instance, so counters and hooks never leak between tests
// and production code needs no test-only reset function.
let instance = 0;
const rawModule = () => import(`../scripts/connect.mjs?instance=${++instance}`);
// The module refuses to connect without a marker hook, so a no-op hook is installed by default.
// Tests of the hook itself replace it, and tests of the missing hook use rawModule().
const fresh = async () => {
  const c = await rawModule();
  c.setConnectMarkerHook(() => {});
  return c;
};

// The same client class and config shape as production, pointed at loopback without TLS.
function loopbackClient(port) {
  return new pg.Client({ ...buildConfig(parts), host: '127.0.0.1', port, ssl: false });
}

test('buildConfig has exactly the reviewed keys and safe values', () => {
  const cfg = buildConfig(parts);
  assert.deepEqual(Object.keys(cfg).sort(), ['connectionTimeoutMillis', 'database', 'host', 'password', 'port', 'ssl', 'user']);
  assert.equal(cfg.host, `${LABEL}.${TAIL}`);
  assert.equal(cfg.port, 5432);
  assert.equal(cfg.database, DB);
  assert.equal(cfg.user, ROLE);
  assert.equal(cfg.password, PASSWORD);
  assert.deepEqual({ ...cfg.ssl }, { rejectUnauthorized: true, servername: `${LABEL}.${TAIL}` });
  assert.ok(Object.isFrozen(cfg) && Object.isFrozen(cfg.ssl));
  for (const forbidden of ['enableChannelBinding', 'options', 'statement_timeout', 'query_timeout', 'idle_in_transaction_session_timeout', 'lock_timeout', 'application_name', 'connectionString', 'replication', 'max', 'min']) {
    assert.ok(!(forbidden in cfg), forbidden);
  }
});

test('connection timeout is the reviewed value', () => {
  assert.equal(buildConfig(parts).connectionTimeoutMillis, 10000);
});

test('the production module exports no test-only reset function', async () => {
  const c = await fresh();
  assert.deepEqual(Object.keys(c).sort(), ['buildConfig', 'connectMarkerCount', 'connectOnce', 'reasonFor', 'runConnect', 'setConnectMarkerHook']);
});

test('protocol evidence: connect then end sends only startup and Terminate, on one connection', { timeout: 10000 }, async () => {
  const srv = await startFakePg({ mode: 'trust' });
  try {
    const c = await fresh();
    await c.runConnect(loopbackClient(srv.port));
    await new Promise((r) => setTimeout(r, 100));
    const kinds = srv.log.filter((e) => e.t !== 'close').map((e) => (e.t === 'msg' ? 'msg:' + e.type : e.t));
    assert.deepEqual(kinds, ['startup', 'msg:X']);
    assert.equal(srv.log.filter((e) => e.t === 'startup').length, 1);
    const startup = srv.log[0].params;
    assert.deepEqual(Object.keys(startup).sort(), ['client_encoding', 'database', 'user']);
    assert.equal(startup.user, ROLE);
    assert.equal(startup.database, DB);
    const frontendTypes = srv.log.filter((e) => e.t === 'msg').map((e) => e.type);
    assert.deepEqual(frontendTypes, ['X']);
    assert.equal(c.connectMarkerCount(), 1);
  } finally {
    await srv.close();
  }
});

test('TLS: certificate verification rejects an untrusted server certificate', { timeout: 10000 }, async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1b-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const srv = await startFakePg({ mode: 'trust', tlsOptions: { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) } });
  try {
    const c = await fresh();
    const client = new pg.Client({ ...buildConfig(parts), host: '127.0.0.1', port: srv.port });
    let caught;
    try {
      await c.runConnect(client);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'connection must fail');
    assert.equal(reasonFor(caught), 'TLS_VERIFY');
    assert.ok(!srv.log.some((e) => e.t === 'startup'), 'no startup message may be sent after a failed TLS verification');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true });
  }
});

test('a refused loopback connection maps to NETWORK, records one marker, and leaves no uncaught error', { timeout: 10000 }, async () => {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  const c = await fresh();
  await assert.rejects(c.runConnect(loopbackClient(port)), (e) => reasonFor(e) === 'NETWORK');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(c.connectMarkerCount(), 1);
});

test('connectOnce binds the validated host and port, and uses no network here', async () => {
  const c = await fresh();
  assert.equal(c.connectMarkerCount(), 0);
  const calls = [];
  const orig = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    calls.push(args);
    throw Object.assign(new Error('blocked by test'), { code: 'EBLOCKED' });
  };
  try {
    await assert.rejects(c.connectOnce(parts), (e) => reasonFor(e) === 'CONNECT_FAILED');
  } finally {
    net.Socket.prototype.connect = orig;
  }
  assert.equal(c.connectMarkerCount(), 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), [5432, `${LABEL}.${TAIL}`]);
});

function stubClass({ ctorThrows = false, connect = async () => {}, end = async () => {}, seen = [], atCtor, atConnect } = {}) {
  return class Stub {
    constructor(cfg) {
      if (atCtor) atCtor();
      if (ctorThrows) throw new Error('ctor failed ' + PASSWORD);
      this.cfg = cfg;
      this.connection = { stream: { destroy: () => seen.push('destroy') } };
      for (const m of ['query', 'execute', 'copyFrom', 'copyTo', 'prepare', 'exec']) {
        this[m] = () => {
          seen.push('FORBIDDEN:' + m);
        };
      }
    }
    on() {}
    async connect() {
      if (atConnect) atConnect();
      seen.push('connect');
      return connect();
    }
    async end() {
      seen.push('end');
      return end();
    }
  };
}

test('marker semantics: zero at construction, one at the connect call', async () => {
  const c = await fresh();
  let atCtor;
  let atConnect;
  const Stub = stubClass({ atCtor: () => (atCtor = c.connectMarkerCount()), atConnect: () => (atConnect = c.connectMarkerCount()) });
  await c.connectOnce(parts, Stub);
  assert.equal(atCtor, 0);
  assert.equal(atConnect, 1);
  assert.equal(c.connectMarkerCount(), 1);
});

test('a client that cannot be constructed records no marker', async () => {
  const c = await fresh();
  await assert.rejects(c.connectOnce(parts, stubClass({ ctorThrows: true })), (e) => reasonFor(e) === 'CONNECT_FAILED');
  assert.equal(c.connectMarkerCount(), 0);
});

test('a failed connect records one marker, destroys the socket, and never calls end', async () => {
  const c = await fresh();
  const seen = [];
  const Stub = stubClass({ seen, connect: async () => Promise.reject(Object.assign(new Error(PASSWORD), { code: 'ECONNREFUSED' })) });
  await assert.rejects(c.connectOnce(parts, Stub), (e) => reasonFor(e) === 'NETWORK');
  assert.deepEqual(seen, ['connect', 'destroy']);
  assert.equal(c.connectMarkerCount(), 1);
});

test('success: one connect, one end, no query-like method, and the marker counts attempts', async () => {
  const c = await fresh();
  const seen = [];
  const Stub = stubClass({ seen });
  await c.connectOnce(parts, Stub);
  await c.connectOnce(parts, Stub);
  assert.deepEqual(seen, ['connect', 'end', 'connect', 'end']);
  assert.equal(c.connectMarkerCount(), 2);
});

test('a failed end after a successful connect is CLEANUP_FAILED, not a pass', async () => {
  const c = await fresh();
  const Stub = stubClass({ end: async () => Promise.reject(new Error(PASSWORD)) });
  await assert.rejects(c.connectOnce(parts, Stub), (e) => reasonFor(e) === 'CLEANUP_FAILED');
  assert.equal(c.connectMarkerCount(), 1);
});

test('an end that never completes is CLEANUP_FAILED after the timeout', { timeout: 5000 }, async () => {
  const c = await fresh();
  const Stub = stubClass({ end: () => new Promise(() => {}) });
  const client = new Stub(buildConfig(parts));
  await assert.rejects(c.runConnect(client, 50), (e) => reasonFor(e) === 'CLEANUP_FAILED');
});

test('an end that throws synchronously is CLEANUP_FAILED', async () => {
  const c = await fresh();
  const seen = [];
  const Stub = stubClass({ seen });
  const client = new Stub(buildConfig(parts));
  client.end = () => {
    throw new Error(PASSWORD);
  };
  await assert.rejects(c.runConnect(client, 50), (e) => reasonFor(e) === 'CLEANUP_FAILED');
});

test('an end that resolves just after the timeout fired is still CLEANUP_FAILED and the socket is destroyed', { timeout: 5000 }, async () => {
  const c = await fresh();
  const seen = [];
  const Stub = stubClass({ seen, end: () => new Promise((resolve) => setTimeout(resolve, 120)) });
  const client = new Stub(buildConfig(parts));
  await assert.rejects(c.runConnect(client, 40), (e) => reasonFor(e) === 'CLEANUP_FAILED');
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(seen, ['connect', 'end', 'destroy']);
});

test('reasonFor maps errors to fixed codes and ignores messages', () => {
  assert.equal(reasonFor({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: PASSWORD }), 'TLS_VERIFY');
  assert.equal(reasonFor({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'TLS_VERIFY');
  assert.equal(reasonFor({ code: 'ENOTFOUND' }), 'NETWORK');
  assert.equal(reasonFor({ code: 'ETIMEDOUT' }), 'NETWORK');
  assert.equal(reasonFor({ code: '28P01', message: PASSWORD }), 'AUTH');
  assert.equal(reasonFor({ n1bCode: 'CLEANUP_FAILED' }), 'CLEANUP_FAILED');
  assert.equal(reasonFor({ n1bCode: 'EVIDENCE_FAILED' }), 'EVIDENCE_FAILED');
  assert.equal(reasonFor(new Error(PASSWORD)), 'CONNECT_FAILED');
  assert.equal(reasonFor(null), 'CONNECT_FAILED');
  assert.equal(reasonFor(undefined), 'CONNECT_FAILED');
});

test('a cleanup timeout destroys the socket (stub)', async () => {
  const c = await fresh();
  const seen = [];
  const Stub = stubClass({ seen, end: () => new Promise(() => {}) });
  const client = new Stub(buildConfig(parts));
  await assert.rejects(c.runConnect(client, 50), (e) => reasonFor(e) === 'CLEANUP_FAILED');
  assert.deepEqual(seen, ['connect', 'end', 'destroy']);
});

test('a cleanup timeout destroys a real loopback socket that the server keeps open', { timeout: 10000 }, async () => {
  const srv = await startFakePg({ mode: 'trust', ignoreTerminate: true });
  try {
    const c = await fresh();
    const client = loopbackClient(srv.port);
    await assert.rejects(c.runConnect(client, 150), (e) => reasonFor(e) === 'CLEANUP_FAILED');
    assert.equal(client.connection.stream.destroyed, true, 'the client socket must be destroyed, not left half-open');
    assert.deepEqual(srv.log.filter((e) => e.t === 'msg').map((e) => e.type), ['X']);
  } finally {
    await srv.close();
  }
});

test('the marker hook runs once, before connect, with the next marker number', async () => {
  const c = await fresh();
  const seen = [];
  c.setConnectMarkerHook((n) => seen.push('hook:' + n));
  await c.connectOnce(parts, stubClass({ seen }));
  assert.deepEqual(seen, ['hook:1', 'connect', 'end']);
  assert.equal(c.connectMarkerCount(), 1);
});

test('a throwing marker hook prevents the connect: EVIDENCE_FAILED, no connect call, no marker counted', async () => {
  const c = await fresh();
  const seen = [];
  c.setConnectMarkerHook(() => {
    throw new Error(PASSWORD);
  });
  await assert.rejects(c.connectOnce(parts, stubClass({ seen })), (e) => reasonFor(e) === 'EVIDENCE_FAILED');
  assert.ok(!seen.includes('connect'), 'client.connect must not be called');
  assert.ok(!seen.includes('end'));
  assert.deepEqual(seen, ['destroy']);
  assert.equal(c.connectMarkerCount(), 0);
});

test('a throwing marker hook opens no connection at all (real loopback server)', { timeout: 10000 }, async () => {
  const srv = await startFakePg({ mode: 'trust' });
  try {
    const c = await fresh();
    c.setConnectMarkerHook(() => {
      throw new Error('cannot write');
    });
    await assert.rejects(c.runConnect(loopbackClient(srv.port)), (e) => reasonFor(e) === 'EVIDENCE_FAILED');
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(srv.log, [], 'the server must see no connection and no message');
  } finally {
    await srv.close();
  }
});

test('no marker hook installed: EVIDENCE_FAILED, no connect call, no marker counted', async () => {
  const c = await rawModule();
  const seen = [];
  await assert.rejects(c.connectOnce(parts, stubClass({ seen })), (e) => reasonFor(e) === 'EVIDENCE_FAILED');
  assert.ok(!seen.includes('connect'), 'client.connect must not be called');
  assert.ok(!seen.includes('end'));
  assert.deepEqual(seen, ['destroy']);
  assert.equal(c.connectMarkerCount(), 0);
});

test('no marker hook installed: no connection is opened at all (real loopback server)', { timeout: 10000 }, async () => {
  const srv = await startFakePg({ mode: 'trust' });
  try {
    const c = await rawModule();
    await assert.rejects(c.runConnect(loopbackClient(srv.port)), (e) => reasonFor(e) === 'EVIDENCE_FAILED');
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(srv.log, [], 'the server must see no connection and no message');
    assert.equal(c.connectMarkerCount(), 0);
  } finally {
    await srv.close();
  }
});

test('a marker hook removed again (set to null) is refused like a missing hook', async () => {
  const c = await rawModule();
  const seen = [];
  c.setConnectMarkerHook((n) => seen.push('hook:' + n));
  c.setConnectMarkerHook(null);
  await assert.rejects(c.connectOnce(parts, stubClass({ seen })), (e) => reasonFor(e) === 'EVIDENCE_FAILED');
  assert.deepEqual(seen, ['destroy']);
});

test('an asynchronous marker hook is awaited: the connect starts only after the hook has finished', async () => {
  const c = await rawModule();
  const seen = [];
  c.setConnectMarkerHook(async (n) => {
    seen.push('hook-start:' + n);
    await new Promise((r) => setTimeout(r, 80));
    seen.push('hook-done');
  });
  await c.connectOnce(parts, stubClass({ seen }));
  assert.deepEqual(seen, ['hook-start:1', 'hook-done', 'connect', 'end']);
  assert.equal(c.connectMarkerCount(), 1);
});

test('a rejecting asynchronous marker hook prevents the connect: EVIDENCE_FAILED, no connect call, no marker counted', async () => {
  const c = await rawModule();
  const seen = [];
  c.setConnectMarkerHook(async () => {
    await new Promise((r) => setTimeout(r, 30));
    throw new Error(PASSWORD);
  });
  await assert.rejects(c.connectOnce(parts, stubClass({ seen })), (e) => reasonFor(e) === 'EVIDENCE_FAILED');
  assert.ok(!seen.includes('connect'), 'client.connect must not be called');
  assert.deepEqual(seen, ['destroy']);
  assert.equal(c.connectMarkerCount(), 0);
});

test('a slow asynchronous marker hook opens no connection before it finishes (real loopback server)', { timeout: 10000 }, async () => {
  const srv = await startFakePg({ mode: 'trust' });
  try {
    const c = await rawModule();
    let logLengthWhenHookFinished = -1;
    c.setConnectMarkerHook(async () => {
      await new Promise((r) => setTimeout(r, 150));
      logLengthWhenHookFinished = srv.log.length;
    });
    await c.runConnect(loopbackClient(srv.port));
    assert.equal(logLengthWhenHookFinished, 0, 'the server must see nothing before the hook has finished');
    assert.equal(c.connectMarkerCount(), 1);
  } finally {
    await srv.close();
  }
});

test('a failed connect still runs the marker hook once', async () => {
  const c = await fresh();
  const seen = [];
  c.setConnectMarkerHook((n) => seen.push('hook:' + n));
  await assert.rejects(c.connectOnce(parts, stubClass({ seen, connect: async () => Promise.reject(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })) })), (e) => reasonFor(e) === 'NETWORK');
  assert.deepEqual(seen, ['hook:1', 'connect', 'destroy']);
});

test('authentication failure: AUTH reason, one marker, and no application query message', { timeout: 10000 }, async () => {
  const srv = await startFakePg({ mode: 'auth-error' });
  try {
    const c = await fresh();
    await assert.rejects(c.runConnect(loopbackClient(srv.port)), (e) => reasonFor(e) === 'AUTH');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(c.connectMarkerCount(), 1);
    assert.equal(srv.log.filter((e) => e.t === 'startup').length, 1);
    for (const e of srv.log) {
      if (e.t === 'msg') assert.equal(e.type, 'X', 'only Terminate may follow startup');
    }
  } finally {
    await srv.close();
  }
});
