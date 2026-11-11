// Runs last, always. Prints only fixed-format lines.
//
// evidence=complete means ONLY this: each of the steps G and H that ran recorded its own final
// accounting (done=1), every step outcome is known, the connect marker is consistent with the
// outcome of step H (only 0 or 1 is possible when H ran), and every summary write succeeded.
// The other steps are accounted for by their GitHub outcome values only, not by done flags. It does NOT mean the connection succeeded
// or that the connect call ran. The marker is recorded just before the connect call and is not
// proof of the call. Missing or inconsistent evidence is reported as unknown or incomplete and
// fails this step. It is never reported as zero.
import { getEnv } from './env.mjs';
import { emit, emitEvidenceLine, summaryFailed, installFatalHandlers } from './summary.mjs';

installFatalHandlers('gate=fail reason=INTERNAL');

const OUTCOMES = new Set(['success', 'failure', 'skipped', 'cancelled']);
let complete = true;
const outcome = (v) => {
  if (OUTCOMES.has(v)) return v;
  complete = false;
  return 'unknown';
};

const run = getEnv('GITHUB_RUN_ID') ?? '';
if (/^[0-9]{1,20}$/.test(run)) emit(`run=${run}`);
else complete = false;

const o = {
  reviewed: outcome(getEnv('N1B_STEP_REVIEWED')),
  checkout: outcome(getEnv('N1B_STEP_CHECKOUT')),
  node: outcome(getEnv('N1B_STEP_NODE')),
  install: outcome(getEnv('N1B_STEP_INSTALL')),
  gate: outcome(getEnv('N1B_STEP_GATE')),
  g: outcome(getEnv('N1B_STEP_G')),
  h: outcome(getEnv('N1B_STEP_H')),
};
for (const [name, value] of Object.entries(o)) emit(`step=${name} outcome=${value}`);

// A step that ran (success or failure) must have written done=1. A skipped step must not have.
const checkDone = (stepOutcome, done) => {
  if (stepOutcome === 'success' || stepOutcome === 'failure') {
    if (done !== '1') complete = false;
  } else if (stepOutcome === 'skipped') {
    if (done !== '') complete = false;
  } else {
    complete = false;
  }
};
checkDone(o.g, getEnv('N1B_DONE_G') ?? '');
checkDone(o.h, getEnv('N1B_DONE_H') ?? '');

const raw = getEnv('N1B_MARKER') ?? '';
let marker;
if (/^[01]$/.test(raw) && o.h !== 'skipped') marker = raw;
else if (raw === '' && o.h === 'skipped') marker = '0';
else {
  marker = 'unknown';
  complete = false;
}
if (o.h === 'success' && marker !== '1') complete = false;
emit(`connect_marker=${marker}`);

if ((getEnv('N1B_SUMMARY_G') ?? '') !== '' || (getEnv('N1B_SUMMARY_H') ?? '') !== '') complete = false;
if (summaryFailed()) complete = false;
if (!emitEvidenceLine(complete)) process.exit(1);
