// Offline validator. Pure functions. No network, no I/O, no logging.
// Reasons are fixed codes. The input string is never echoed.
// The accepted query forms may contain channel_binding=require. N1b does NOT enforce
// channel binding; the key is only accepted as part of the approved string shape.
export const TAIL = 'c-8.us-east-2.aws.neon.tech';
export const MAX_LEN = 512;

const RE_ROLE = /^[a-z0-9_]{1,63}$/;
const RE_DB = /^[a-z0-9_-]{1,63}$/;
const RE_PASSWORD = /^[A-Za-z0-9._~-]{1,128}$/;
const RE_LABEL = /^ep-[a-z0-9]+(-[a-z0-9]+)*$/;
const RE_DENY = /^[a-z0-9._-]{6,80}$/;
const FORM_A = 'sslmode=require';
const FORM_B = 'sslmode=require&channel_binding=require';

const fail = (reason) => ({ ok: false, reason });

// Config comes from repository variables typed by the owner. Fail closed on anything odd.
export function parseConfig({ role, label, db, denylist }) {
  if (typeof role !== 'string' || !RE_ROLE.test(role)) return fail('CONFIG');
  if (typeof label !== 'string' || !RE_LABEL.test(label) || label.endsWith('-pooler') || label.length > 63) {
    return fail('CONFIG');
  }
  if (typeof db !== 'string' || !RE_DB.test(db)) return fail('CONFIG');
  if (typeof denylist !== 'string' || denylist.length === 0 || denylist.length > 2000) return fail('CONFIG');
  const entries = denylist.split(',').map((e) => e.trim().toLowerCase());
  if (entries.length < 1 || entries.length > 50) return fail('CONFIG');
  for (const e of entries) {
    if (!RE_DENY.test(e)) return fail('CONFIG');
  }
  return { ok: true, config: Object.freeze({ role, label, db, denylist: Object.freeze(entries) }) };
}

export function validate(raw, config) {
  try {
    return validateInner(raw, config);
  } catch {
    return fail('INTERNAL');
  }
}

function validateInner(raw, config) {
  if (typeof raw !== 'string' || raw.length === 0) return fail('MISSING_SECRET');
  if (raw.length > MAX_LEN) return fail('LENGTH');
  if (!/^[\x21-\x7e]+$/.test(raw)) return fail('CHARSET');
  // Approved narrower rule: percent-encoding is rejected everywhere, never decoded.
  if (raw.includes('%')) return fail('ENCODING');
  if (raw.includes('#')) return fail('FRAGMENT');
  if (raw.includes('[') || raw.includes(']')) return fail('IPV6');

  // Raw grammar, checked on the unparsed string. No URL parser is used.
  let rest;
  if (raw.startsWith('postgresql://')) rest = raw.slice('postgresql://'.length);
  else if (raw.startsWith('postgres://')) rest = raw.slice('postgres://'.length);
  else return fail('SCHEME');

  const atParts = rest.split('@');
  if (atParts.length !== 2) return fail('STRUCTURE');
  const [userinfo, hostpart] = atParts;
  const uiParts = userinfo.split(':');
  if (uiParts.length !== 2 || uiParts[0] === '' || uiParts[1] === '') return fail('STRUCTURE');
  const [user, password] = uiParts;
  if (!RE_ROLE.test(user)) return fail('USER');
  if (!RE_PASSWORD.test(password)) return fail('PASSWORD');

  const slashParts = hostpart.split('/');
  if (slashParts.length !== 2) return fail('STRUCTURE');
  const [hostport, dbquery] = slashParts;
  const hpParts = hostport.split(':');
  if (hpParts.length > 2) return fail('STRUCTURE');
  const host = hpParts[0];
  const port = hpParts.length === 2 ? hpParts[1] : undefined;
  const qParts = dbquery.split('?');
  if (qParts.length !== 2) return fail('STRUCTURE');
  const [database, query] = qParts;
  if (host === '' || database === '' || query === '') return fail('STRUCTURE');

  // Host, label, tail.
  if (host.endsWith('.') || /[A-Z]/.test(host) || /^[0-9.]+$/.test(host) || !host.includes('.')) {
    return fail('HOST');
  }
  const dot = host.indexOf('.');
  const label = host.slice(0, dot);
  const tail = host.slice(dot + 1);
  if (label.endsWith('-pooler')) return fail('POOLED');
  if (!RE_LABEL.test(label) || label.length > 63) return fail('LABEL');
  if (tail !== TAIL) return fail('TAIL');

  if (port !== undefined && port !== '5432') return fail('PORT');
  if (!RE_DB.test(database)) return fail('DATABASE_FORMAT');
  if (query !== FORM_A && query !== FORM_B) return fail('QUERY');

  // Deny-list on the whole raw string, case-insensitive.
  const lower = raw.toLowerCase();
  for (const entry of config.denylist) {
    if (lower.includes(entry)) return fail('DENY');
  }

  // Expected identity.
  if (user !== config.role) return fail('ROLE_MISMATCH');
  if (label !== config.label) return fail('ENDPOINT_MISMATCH');
  if (database !== config.db) return fail('DATABASE_MISMATCH');

  return {
    ok: true,
    parts: Object.freeze({
      user,
      password,
      host,
      port: 5432,
      database,
    }),
  };
}
