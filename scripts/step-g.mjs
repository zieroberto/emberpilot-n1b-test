// Step G: offline validation. No network, no pg import.
import { getEnv, envNames } from './env.mjs';
import { checkEnv } from './env-guard.mjs';
import { parseConfig, validate } from './validator.mjs';
import { emit, registerExitOutputs, installFatalHandlers } from './summary.mjs';

installFatalHandlers('check=validate result=fail reason=INTERNAL');
registerExitOutputs();

function failWith(reason) {
  emit(`check=validate result=fail reason=${reason}`);
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
emit('check=validate result=pass reason=OK');
