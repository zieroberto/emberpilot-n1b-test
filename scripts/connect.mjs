// The only module allowed to open a database connection. It holds the marker counter.
// Claim: a plain pg client connected once to the validated host with certificate
// verification on, and disconnected. No application query is issued by this code.
// Channel binding is NOT enforced (owner decision A).
//
// The "connect marker" is recorded immediately BEFORE client.connect() is called. It shows that
// this code reached that point. It is not proof that client.connect() ran, that a TCP or TLS
// connection was made, or that authentication or cleanup succeeded.
// A marker hook is REQUIRED by this module. Without an installed hook, or if the hook throws,
// client.connect() is never called (EVIDENCE_FAILED).
import pg from 'pg';

const { Client } = pg;
const END_TIMEOUT_MS = 10000;
let markers = 0;
let markerHook = null;

// Number of connect markers successfully recorded by this module instance.
export function connectMarkerCount() {
  return markers;
}

// The hook records the marker durably before the connect call. The call is awaited, so a hook that
// returns a promise must finish (or fail) before the connect. If no hook is installed, or the hook
// throws or rejects, the connect is NOT attempted and the result is EVIDENCE_FAILED.
export function setConnectMarkerHook(fn) {
  markerHook = typeof fn === 'function' ? fn : null;
}

class CodedError extends Error {
  constructor(code) {
    super(code);
    this.n1bCode = code;
  }
}

// Exact client configuration. Nothing else is passed: no options, no timeouts that
// send SQL, no pool, no application_name, no hooks, no channel binding switch.
export function buildConfig(parts) {
  return Object.freeze({
    host: parts.host,
    port: 5432,
    database: parts.database,
    user: parts.user,
    password: parts.password,
    ssl: Object.freeze({ rejectUnauthorized: true, servername: parts.host }),
    connectionTimeoutMillis: 10000,
  });
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
]);
const NET_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);

// Maps any error to a fixed code. The error message is never used.
export function reasonFor(err) {
  if (err && typeof err.n1bCode === 'string') return err.n1bCode;
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (TLS_CODES.has(code)) return 'TLS_VERIFY';
  if (NET_CODES.has(code)) return 'NETWORK';
  if (code === '28P01' || code === '28000') return 'AUTH';
  return 'CONNECT_FAILED';
}

function endWithTimeout(client, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CodedError('CLEANUP_FAILED')), ms);
    Promise.resolve()
      .then(() => client.end())
      .then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          reject(new CodedError('CLEANUP_FAILED'));
        },
      );
  });
}

// One connect, one end. No query of any kind.
// If the marker cannot be recorded, or no hook is installed to record it, nothing is connected
// (EVIDENCE_FAILED).
// If the connect failed, the socket is destroyed instead of ended, because ending a
// never-connected client can write to a closed socket. If the connect succeeded but the
// end failed or timed out, the result is a failure (CLEANUP_FAILED), never a pass, and the
// socket is destroyed so that a hung end cannot keep the process alive. A late end() result
// after the timeout has fired does not turn the failure into a pass.
export async function runConnect(client, endTimeoutMs = END_TIMEOUT_MS) {
  client.on('error', () => {});
  let connected = false;
  let failure = null;
  try {
    if (!markerHook) throw new CodedError('EVIDENCE_FAILED');
    try {
      await markerHook(markers + 1);
    } catch {
      throw new CodedError('EVIDENCE_FAILED');
    }
    markers += 1;
    await client.connect();
    connected = true;
  } catch (err) {
    failure = err;
  }
  if (connected) {
    try {
      await endWithTimeout(client, endTimeoutMs);
    } catch (err) {
      failure = err;
      try {
        client.connection.stream.destroy();
      } catch {
        // ignore
      }
    }
  } else {
    try {
      client.connection.stream.destroy();
    } catch {
      // ignore
    }
  }
  if (failure) throw failure;
}

export async function connectOnce(parts, ClientClass = Client) {
  const client = new ClientClass(buildConfig(parts));
  await runConnect(client);
}
