// Preload for tests only: right after a line starting with "marker=" has been appended, the process
// kills itself with SIGKILL. Simulates a kill between the marker write and the connect call.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const original = fs.appendFileSync;
fs.appendFileSync = function (file, data, ...rest) {
  const r = original.call(this, file, data, ...rest);
  if (typeof data === 'string' && data.startsWith('marker=')) process.kill(process.pid, 'SIGKILL');
  return r;
};
syncBuiltinESMExports();
