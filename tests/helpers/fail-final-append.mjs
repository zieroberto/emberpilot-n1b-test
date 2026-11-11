// Preload for tests only: appending a line that starts with one of the given prefixes throws,
// while every other append succeeds. The prefixes are N1B_FAIL_APPEND_PREFIX, comma separated,
// default "evidence=" (the last summary line). Simulates a write that fails on specific lines only.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const prefixes = (process.env.N1B_FAIL_APPEND_PREFIX ?? 'evidence=').split(',');
const original = fs.appendFileSync;
fs.appendFileSync = function (file, data, ...rest) {
  if (typeof data === 'string' && prefixes.some((p) => data.startsWith(p))) {
    throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
  }
  return original.call(this, file, data, ...rest);
};
syncBuiltinESMExports();
