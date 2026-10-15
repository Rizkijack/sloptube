import type { Env } from './env.js';
import { badRequest } from './http.js';

/**
 * Cloudflare Turnstile verification.
 *
 * When the site key or secret is unset the check is skipped with a warning so a
 * local `wrangler dev` works without secrets. A configured deployment always
 * verifies — the skip is not reachable there.
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

type TurnstileEnv = Env & { TURNSTILE_SECRET_KEY?: string };

let warned = false;

export async function verifyTurnstile(
  env: Env,
  token: string,
  ip: string,
): Promise<void> {
  const secret = (env as TurnstileEnv).TURNSTILE_SECRET_KEY;
  const siteKey = env.TURNSTILE_SITE_KEY;

  // One check, both directions, fail closed on a real deployment. Previously
  // only "secret set, key missing" threw, so the default config — a site-key
  // placeholder and no secret — let `/api/agent/register` ship silently ungated.
  if (!siteKey || !secret) {
    if (env.ENVIRONMENT === 'production') {
      throw badRequest(
        'turnstile_misconfigured',
        'turnstile is not configured for a production deployment',
      );
    }
    if (!warned) {
      warned = true;
      console.warn('turnstile not configured — accepting token (non-production only)');
    }
    return;
  }

  if (typeof token !== 'string' || token.length === 0) {
    throw badRequest('turnstile_required', 'turnstileToken is required');
  }

  const form = new FormData();
  form.set('secret', secret);
  form.set('response', token);
  form.set('remoteip', ip);

  let result: { success?: boolean };
  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body: form });
    result = (await res.json()) as { success?: boolean };
  } catch {
    throw badRequest('turnstile_unavailable', 'turnstile verification failed');
  }
  if (result.success !== true) {
    throw badRequest('turnstile_failed', 'turnstile verification failed');
  }
}