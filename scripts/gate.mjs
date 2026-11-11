// Pre-secret gate logic. Pure. Has no access to the secret.
import { checkEnv } from './env-guard.mjs';

export const PINNED_NODE = 'v22.23.4';
const RE_DISPATCH = /^n1b-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RE_OTHER_STEP = /^n1[a-z]-/;
const RE_SHA = /^[0-9a-f]{40}$/;

export function gateReason({ nodeVersion, names, ref, sha, reviewed, dispatchId }) {
  if (nodeVersion !== PINNED_NODE) return 'NODE_VERSION';
  const envCategory = checkEnv(names);
  if (envCategory !== null) return envCategory;
  if (ref !== 'refs/heads/main') return 'REF_MISMATCH';
  if (!RE_SHA.test(sha ?? '') || !RE_SHA.test(reviewed ?? '') || sha !== reviewed) return 'SHA_MISMATCH';
  if (typeof dispatchId !== 'string' || dispatchId === '') return 'DISPATCH_FORMAT';
  if (!RE_DISPATCH.test(dispatchId)) {
    return RE_OTHER_STEP.test(dispatchId) && !dispatchId.startsWith('n1b-') ? 'DISPATCH_PREFIX' : 'DISPATCH_FORMAT';
  }
  return 'OK';
}
