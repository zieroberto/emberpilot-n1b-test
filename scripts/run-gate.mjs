import { getEnv, envNames } from './env.mjs';
import { gateReason } from './gate.mjs';
import { emit, installFatalHandlers } from './summary.mjs';

installFatalHandlers('gate=fail reason=INTERNAL');

const reason = gateReason({
  nodeVersion: process.version,
  names: envNames(),
  ref: getEnv('GITHUB_REF'),
  sha: getEnv('GITHUB_SHA'),
  reviewed: getEnv('REVIEWED_SHA'),
  dispatchId: getEnv('N1B_DISPATCH_ID'),
});

if (reason === 'OK') {
  emit('gate=pass reason=OK');
} else {
  emit(`gate=fail reason=${reason}`);
  process.exit(1);
}
