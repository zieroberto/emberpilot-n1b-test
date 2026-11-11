import { envNames } from './env.mjs';

// Names that could weaken TLS verification, change trust roots, or change client behavior.
// A failure reports only a fixed category, never a name or a value.
const TLS = [
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_SYSTEM_CA',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
  'SSLKEYLOGFILE',
];
const NODE = ['NODE_OPTIONS', 'NODE_NO_WARNINGS', 'NODE_DEBUG', 'NODE_PENDING_DEPRECATION'];
const PROXY = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];

export const FORBIDDEN_NAMES = Object.freeze([...TLS, ...NODE, ...PROXY]);
export const CATEGORY_ORDER = Object.freeze(['ENV_PG', 'ENV_TLS', 'ENV_NODE', 'ENV_PROXY']);

// Any variable whose name starts with PG is rejected (the client reads PG* defaults).
export function categoryOf(name) {
  if (name.startsWith('PG')) return 'ENV_PG';
  if (TLS.includes(name)) return 'ENV_TLS';
  if (NODE.includes(name)) return 'ENV_NODE';
  if (PROXY.includes(name)) return 'ENV_PROXY';
  return null;
}

export function forbiddenName(name) {
  return categoryOf(name) !== null;
}

// Returns null, or the highest-priority category present.
export function checkEnv(names = envNames()) {
  const found = new Set();
  for (const name of names) {
    const c = categoryOf(name);
    if (c !== null) found.add(c);
  }
  for (const c of CATEGORY_ORDER) {
    if (found.has(c)) return c;
  }
  return null;
}
