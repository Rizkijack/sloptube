import type { Env } from '../lib/env.js';
import { tooMany } from '../lib/http.js';

/**
 * Fixed-window counter kept in a Durable Object.
 *
 * D1 is single-writer; every rate-limit check would serialise on it. The DO is
 * the one place where concurrent writes are expected, so that is where the
 * counter lives. Reads are always by-fail-open: an unavailable limiter must not
 * turn into an outage.
 */
export class RateLimiter {
  constructor(
    private readonly state: DurableObjectState,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get('key') ?? 'global';
    const limit = Number(url.searchParams.get('limit') ?? '60');
    const windowS = Number(url.searchParams.get('window') ?? '60');
    const cost = Number(url.searchParams.get('cost') ?? '1');

    const now = Date.now();
    const windowStart = now - windowS * 1000;

    let count = (await this.state.storage.get<number>('count')) ?? 0;
    let resetAt = (await this.state.storage.get<number>('resetAt')) ?? 0;

    if (resetAt < now) {
      count = 0;
      resetAt = now + windowS * 1000;
    }

    const remaining = Math.max(0, limit - count);
    const allowed = count + cost <= limit;
    if (allowed) {
      count += cost;
      await this.state.storage.put('count', count);
      await this.state.storage.put('resetAt', resetAt);
    }

    return Response.json({
      allowed,
      remaining,
      limit,
      resetAt,
      retryAfterS: allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000)),
    });
  }
}

export interface RateLimitPolicy {
  limit: number;
  window: number;
  cost?: number;
}

export async function enforceLimit(
  env: Env,
  key: string,
  policy: RateLimitPolicy,
): Promise<void> {
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
    const url = new URL('https://rl.internal/');
    url.searchParams.set('key', key);
    url.searchParams.set('limit', String(policy.limit));
    url.searchParams.set('window', String(policy.window));
    url.searchParams.set('cost', String(policy.cost ?? 1));
    const res = await stub.fetch(url);
    const body = (await res.json()) as { allowed: boolean; retryAfterS: number };
    if (!body.allowed) {
      throw tooMany(`rate limit exceeded, retry in ${body.retryAfterS}s`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'HttpError') throw err;
    // Fail open: never let limiter availability become an availability bug.
    console.warn('rate limiter unavailable, failing open', err);
  }
}

export const POLICIES = {
  register: { limit: 3, window: 3600 },
  rotateKey: { limit: 5, window: 3600 },
  uploadUrl: { limit: 60, window: 3600 },
  publish: { limit: 120, window: 3600 },
  report: { limit: 10, window: 3600 },
  publicRead: { limit: 600, window: 60 },
} satisfies Record<string, RateLimitPolicy>;