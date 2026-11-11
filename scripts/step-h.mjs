// Step H: re-validates with the same validator, then connects once through the boundary.
// The connect marker is written to the step output BEFORE the connect call. If it cannot be
// written, the connect is not attempted.
import { getEnv, envNames } from './env.mjs';
import { checkEnv } from './env-guard.mjs';
import { parseConfig, validate } from './validator.mjs';
import { connectOnce, connectMarkerCount, reasonFor, setConnectMarkerHook } from './connect.mjs';
import { emit, registerExitOutputs, writeMarkerOutput, installFatalHandlers } from './summary.mjs';

installFatalHandlers('check=connect result=fail reason=INTERNAL');
registerExitOutputs(connectMarkerCount);
setConnectMarkerHook(writeMarkerOutput);

function failWith(reason) {
  emit(`check=connect result=fail reason=${reason}`);
  process.exit(1);
}

const envCategory = checkEnv(envNames());
if (envCategory !== null) failWith(envCategory);
const cfg = parseConfig({
  role: getEnv('N1B_EXPECTED_ROLE'),
  label: getEnv('N1B_EXPECTED_LABEL'),
  db: getEnv('N1B_EXPECTED_DB'),
  denylist: getEnv('N1B_DENYLIST'),
});
if (!cfg.ok) failWith(cfg.reason);
const result = validate(getEnv('N1B_CONN'), cfg.config);
if (!result.ok) failWith(result.reason);

try {
  await connectOnce(result.parts);
} catch (err) {
  failWith(reasonFor(err));
}
emit('check=connect result=pass reason=OK');
