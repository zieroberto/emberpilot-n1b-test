import { appendFileSync } from 'node:fs';
import { getEnv } from './env.mjs';

const CODE = '[A-Z][A-Z0-9_]{1,31}';
export const ALLOWED_LINES = Object.freeze([
  /^run=[0-9]{1,20}$/,
  new RegExp(`^gate=(pass|fail) reason=${CODE}$`),
  new RegExp(`^check=(validate|connect) result=(pass|fail) reason=${CODE}$`),
  /^step=(reviewed|checkout|node|install|gate|g|h) outcome=(success|failure|skipped|cancelled|unknown)$/,
  /^connect_marker=([01]|unknown)$/,
  /^evidence=(complete|incomplete)$/,
]);

export function isAllowedLine(line) {
  return typeof line === 'string' && ALLOWED_LINES.some((re) => re.test(line));
}

// A failed summary-file write is remembered, never hidden.
let summaryWriteFailed = false;
export function summaryFailed() {
  return summaryWriteFailed;
}

export function emit(line) {
  if (!isAllowedLine(line)) throw new Error('SUMMARY_LINE');
  process.stdout.write(line + '\n');
  const file = getEnv('GITHUB_STEP_SUMMARY');
  if (file) {
    try {
      appendFileSync(file, line + '\n');
    } catch {
      summaryWriteFailed = true;
    }
  }
}

// Records marker=N in the step output (N is a single digit), skipping a repeat of the last value.
// It THROWS if the marker cannot be written, so a caller can refuse to proceed.
let lastMarkerWritten = null;
export function writeMarkerOutput(n) {
  if (!/^[0-9]$/.test(String(n))) throw new Error('MARKER_VALUE');
  if (lastMarkerWritten === String(n)) return;
  const file = getEnv('GITHUB_OUTPUT');
  if (!file) throw new Error('NO_OUTPUT');
  appendFileSync(file, `marker=${n}\n`);
  lastMarkerWritten = String(n);
}

// Runs on every exit path (normal, process.exit, fatal handler), but not after SIGKILL or a
// runner termination. Order matters: final marker, then the summary flag, then done=1 last.
// done=1 therefore exists only if every earlier write succeeded. A step that was killed, or whose
// output writes failed, has no done=1, and finish reports the run as incomplete.
export function registerExitOutputs(getMarker) {
  process.on('exit', () => {
    const file = getEnv('GITHUB_OUTPUT');
    if (!file) return;
    try {
      if (typeof getMarker === 'function') writeMarkerOutput(getMarker());
      if (summaryWriteFailed) appendFileSync(file, 'summary=incomplete\n');
      appendFileSync(file, 'done=1\n');
    } catch {
      // nothing else may be printed
    }
  });
}

// The final evidence line is appended to the summary file FIRST. If that append fails, or an
// earlier one failed, stdout says incomplete, so a complete-looking line is never printed
// for a summary that does not contain it. Returns true only for a published complete line.
export function emitEvidenceLine(complete) {
  const wanted = complete && !summaryWriteFailed;
  const line = `evidence=${wanted ? 'complete' : 'incomplete'}`;
  const file = getEnv('GITHUB_STEP_SUMMARY');
  if (file) {
    try {
      appendFileSync(file, line + '\n');
    } catch {
      summaryWriteFailed = true;
    }
  }
  const published = summaryWriteFailed ? 'evidence=incomplete' : line;
  process.stdout.write(published + '\n');
  return published === 'evidence=complete';
}

// Last-resort handlers: fixed line, no stack, no message.
export function installFatalHandlers(fixedLine) {
  const die = () => {
    try {
      emit(fixedLine);
    } catch {
      // nothing else may be printed
    }
    process.exit(1);
  };
  process.on('uncaughtException', die);
  process.on('unhandledRejection', die);
}
