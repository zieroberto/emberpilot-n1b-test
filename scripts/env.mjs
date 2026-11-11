// The only module allowed to touch process.env. Reads by allowlisted name only.
const ALLOWED = new Set([
  'N1B_CONN',
  'N1B_EXPECTED_ROLE',
  'N1B_EXPECTED_LABEL',
  'N1B_EXPECTED_DB',
  'N1B_DENYLIST',
  'N1B_DISPATCH_ID',
  'N1B_STEP_REVIEWED',
  'N1B_STEP_CHECKOUT',
  'N1B_STEP_NODE',
  'N1B_STEP_INSTALL',
  'N1B_STEP_GATE',
  'N1B_STEP_G',
  'N1B_STEP_H',
  'N1B_MARKER',
  'N1B_DONE_G',
  'N1B_DONE_H',
  'N1B_SUMMARY_G',
  'N1B_SUMMARY_H',
  'REVIEWED_SHA',
  'GITHUB_REF',
  'GITHUB_SHA',
  'GITHUB_RUN_ID',
  'GITHUB_OUTPUT',
  'GITHUB_STEP_SUMMARY',
]);

export function getEnv(name) {
  if (!ALLOWED.has(name)) throw new Error('ENV_NAME');
  const value = process.env[name];
  return typeof value === 'string' ? value : undefined;
}

// Names only, never values. Used by the TLS and client override guard.
export function envNames() {
  return Object.keys(process.env);
}
