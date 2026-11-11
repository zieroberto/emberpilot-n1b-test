// Synthetic placeholder values only. None of these is a real identifier or credential.
import { parseConfig, TAIL } from '../../scripts/validator.mjs';

export const ROLE = 'testrole';
export const LABEL = 'ep-test-label-123456';
export const DB = 'testdb';
export const PASSWORD = 'synth-PASS.0123456789_abcdefXYZ';
export const DENY = 'ep-prod-label-999999,prod_database_name';
export const QUERY_B = 'sslmode=require&channel_binding=require';
export const QUERY_A = 'sslmode=require';
export { TAIL };

export const CONFIG = parseConfig({ role: ROLE, label: LABEL, db: DB, denylist: DENY }).config;

export function conn(o = {}) {
  const scheme = o.scheme ?? 'postgresql://';
  const user = o.user ?? ROLE;
  const password = o.password ?? PASSWORD;
  const label = o.label ?? LABEL;
  const tail = o.tail ?? TAIL;
  const host = o.host ?? `${label}.${tail}`;
  const port = o.port === undefined ? '' : `:${o.port}`;
  const db = o.db ?? DB;
  const query = o.query ?? QUERY_B;
  return `${scheme}${user}:${password}@${host}${port}/${db}?${query}`;
}

export const GOOD_ENV = Object.freeze({
  N1B_CONN: conn(),
  N1B_EXPECTED_ROLE: ROLE,
  N1B_EXPECTED_LABEL: LABEL,
  N1B_EXPECTED_DB: DB,
  N1B_DENYLIST: DENY,
});
