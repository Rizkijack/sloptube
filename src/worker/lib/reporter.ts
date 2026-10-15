import type { Env } from './env.js';
import { sha256Hex } from './auth.js';

/**
 * An anonymous reporter bucket, salted **per video**.
 *
 * The salt is load-bearing for two different properties:
 *
 *  - Per-deployment. Every deployment must use a different salt, or the stored
 *    keys are identical across installations and correlate.
 *  - Per-video. Including `videoId` means the same person filing on two videos
 *    produces two unrelated keys, so the key cannot be used to build a map of
 *    who reported what. Without it, a stable per-IP key is a cross-video
 *    correlator — and §7.8's "no reporter identity is stored" would be false.
 *
 * The salt is still not a privacy guarantee against anyone who already has both
 * the database and the secret: the input space is IPv4, so a stored key is
 * offline-checkable in seconds. What the salt buys is that the key is useless
 * without the secret, useless across videos, and useless across deployments.
 *
 * When no address is available (only outside the edge, e.g. local dev) every
 * caller collapses into one bucket — the safe direction: it can contribute one
 * report per video per day and never reach the quorum on its own.
 *
 * `reportSaltMissing` is surfaced on the audit event rather than thrown. A
 * dead CSAM-reporting path is worse than the dedup weakening it causes: with no
 * salt every caller lands in one bucket, so anonymous hides become impossible
 * (safe) while reports still reach the operator queue (useful). It is a
 * deployment mistake, and `console.error` says so loudly and once.
 */
const UNCONFIGURED = /^REPLACE_WITH|^$/;

let warned = false;

export async function reporterKey(env: Env, ip: string | null, videoId: string): Promise<string> {
  if (!ip) return 'unattributed';
  const salt = env.REPORTER_SALT ?? '';
  if (UNCONFIGURED.test(salt)) {
    if (!warned) {
      warned = true;
      console.error(
        'REPORTER_SALT is not configured — every reporter collapses into one bucket, ' +
          'so anonymous quorum hides are impossible until it is set. ' +
          'Run: wrangler secret put REPORTER_SALT',
      );
    }
    return 'unattributed';
  }
  // videoId is inside the hashed input, not merely a prefix, so two reports by
  // the same person on different videos share nothing.
  const digest = await sha256Hex(new TextEncoder().encode(`${salt}|${videoId}|${ip}`));
  return `r_${digest.slice(0, 24)}`;
}

/** True when the salt is missing — recorded on the report audit event. */
export function reportSaltMissing(env: Env): boolean {
  return UNCONFIGURED.test(env.REPORTER_SALT ?? '');
}