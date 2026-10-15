import { describe, expect, it, vi } from 'vitest';
import { POLICIES, RateLimiter, enforceLimit } from '../src/worker/do/rate-limiter.js';
import type { Env } from '../src/worker/lib/env.js';

/**
 * Minimal Durable Object state stub: a Map behind the two methods the rate
 * limiter actually uses. No Cloudflare runtime needed.
 */
function stubState(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const state = {
    storage: {
      async get<T>(key: string) {
        return store.get(key) as T | undefined;
      },
      async put(key: string, value: unknown) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
      store,
    },
  };
  return state as unknown as DurableObjectState & { storage: { store: Map<string, unknown> } };
}

function hit(
  limiter: RateLimiter,
  params: { key?: string; limit?: number; window?: number; cost?: number } = {},
) {
  const url = new URL('https://rl.internal/');
  url.searchParams.set('key', params.key ?? 'k');
  url.searchParams.set('limit', String(params.limit ?? 3));
  url.searchParams.set('window', String(params.window ?? 60));
  url.searchParams.set('cost', String(params.cost ?? 1));
  return limiter.fetch(new Request(url));
}

/** `hit` returns a Response; assertions are about the decoded body. */
async function hitJson(
  limiter: RateLimiter,
  params?: Parameters<typeof hit>[1],
) {
  return (await (await hit(limiter, params)).json()) as Record<string, number | boolean>;
}

describe('RateLimiter', () => {
  it('allows exactly `limit` requests then denies', async () => {
    const limiter = new RateLimiter(stubState());

    for (let i = 0; i < 3; i++) {
      expect(await hitJson(limiter)).toMatchObject({ allowed: true });
    }
    expect(await hitJson(limiter)).toMatchObject({ allowed: false });
    expect(await hitJson(limiter)).toMatchObject({ allowed: false });
  });

  it('reports remaining budget and never goes negative', async () => {
    const limiter = new RateLimiter(stubState());
    expect(await hitJson(limiter, { limit: 2 })).toMatchObject({ remaining: 2 });
    expect(await hitJson(limiter, { limit: 2 })).toMatchObject({ remaining: 1 });
    expect(await hitJson(limiter, { limit: 2 })).toMatchObject({ remaining: 0 });
  });

  it('charges a cost greater than one', async () => {
    const limiter = new RateLimiter(stubState());
    expect(await hitJson(limiter, { limit: 10, cost: 4 })).toMatchObject({ remaining: 10 });
    expect(await hitJson(limiter, { limit: 10, cost: 4 })).toMatchObject({
      allowed: true,
      remaining: 6,
    });
  });

  it('denies immediately when the cost alone exceeds the limit', async () => {
    const limiter = new RateLimiter(stubState());
    expect(await hitJson(limiter, { limit: 3, cost: 5 })).toMatchObject({ allowed: false });
  });

  it('does not consume budget when it denies', async () => {
    const limiter = new RateLimiter(stubState());
    await hitJson(limiter, { limit: 1 });
    await hitJson(limiter, { limit: 1 }); // denied
    expect(await hitJson(limiter, { limit: 1 })).toMatchObject({ allowed: false });
  });

  it('resets the counter once the window has elapsed', async () => {
    const now = Date.now();
    // A window that expired a minute ago must start from zero.
    const state = stubState({ count: 3, resetAt: now - 60_000 });
    const limiter = new RateLimiter(state);

    expect(await hitJson(limiter, { limit: 3, window: 60 })).toMatchObject({
      allowed: true,
      remaining: 3,
    });
    expect(state.storage.store.get('count')).toBe(1);
    expect(state.storage.store.get('resetAt')).toBeGreaterThan(now);
  });

  it('does not reset while the window is still open', async () => {
    const now = Date.now();
    const state = stubState({ count: 2, resetAt: now + 30_000 });
    const limiter = new RateLimiter(state);

    expect(await hitJson(limiter, { limit: 3, window: 60 })).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(state.storage.store.get('resetAt')).toBe(now + 30_000);
  });

  it('reports a positive retryAfterS when denied', async () => {
    const limiter = new RateLimiter(stubState({ count: 5, resetAt: Date.now() + 45_000 }));
    const body = await hitJson(limiter, { limit: 1, window: 60 });
    expect(body.retryAfterS).toBeGreaterThanOrEqual(1);
    expect(body.retryAfterS).toBeLessThanOrEqual(45);
  });

  it('reports retryAfterS 0 when allowed', async () => {
    const limiter = new RateLimiter(stubState());
    expect(await hitJson(limiter)).toMatchObject({ allowed: true, retryAfterS: 0 });
  });

  it('counts a fresh instance from zero', async () => {
    expect(await hitJson(new RateLimiter(stubState()), { limit: 1 })).toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });
});

describe('enforceLimit', () => {
  const limiterEnv = (impl: (url: URL) => Promise<Response>): Env =>
    ({
      RATE_LIMITER: {
        idFromName: () => 'id',
        get: () => ({ fetch: (url: URL) => impl(new URL(String(url))) }),
      },
    }) as unknown as Env;

  it('resolves when the limiter allows', async () => {
    const env = limiterEnv(async () => Response.json({ allowed: true, retryAfterS: 0 }));
    await expect(enforceLimit(env, 'k', { limit: 1, window: 1 })).resolves.toBeUndefined();
  });

  it('throws 429 when the limiter denies', async () => {
    const env = limiterEnv(async () => Response.json({ allowed: false, retryAfterS: 42 }));
    await expect(enforceLimit(env, 'k', { limit: 1, window: 1 })).rejects.toMatchObject({
      status: 429,
      message: 'rate limit exceeded, retry in 42s',
    });
  });

  it('fails open when the Durable Object is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = limiterEnv(async () => {
      throw new Error('DO unavailable');
    });
    await expect(enforceLimit(env, 'k', { limit: 1, window: 1 })).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('fails open on a malformed limiter response', async () => {
    // The limiter's own console.warn is expected here; keep the run readable.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = limiterEnv(async () => new Response('<html>gateway error</html>'));
    await expect(enforceLimit(env, 'k', { limit: 1, window: 1 })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never fails open on an explicit denial, even when wrapped in try', async () => {
    const env = limiterEnv(async () => Response.json({ allowed: false, retryAfterS: 7 }));
    await expect(enforceLimit(env, 'k', { limit: 1, window: 1 })).rejects.toMatchObject({
      status: 429,
    });
  });

  it('passes the policy through to the Durable Object', async () => {
    let seen = '';
    const env = limiterEnv(async (url) => {
      seen = url.toString();
      return Response.json({ allowed: true, retryAfterS: 0 });
    });
    await enforceLimit(env, 'agent:agt_1', { limit: 5, window: 60, cost: 2 });
    expect(seen).toContain('key=agent%3Aagt_1');
    expect(seen).toContain('limit=5');
    expect(seen).toContain('window=60');
    expect(seen).toContain('cost=2');
  });

  it('defaults cost to 1', async () => {
    let seen = '';
    const env = limiterEnv(async (url) => {
      seen = url.toString();
      return Response.json({ allowed: true, retryAfterS: 0 });
    });
    await enforceLimit(env, 'k', { limit: 5, window: 60 });
    expect(seen).toContain('cost=1');
  });
});

describe('POLICIES', () => {
  it('matches the contract limits', () => {
    expect(POLICIES.register).toEqual({ limit: 3, window: 3600 });
    expect(POLICIES.publish).toEqual({ limit: 120, window: 3600 });
    expect(POLICIES.publicRead).toEqual({ limit: 600, window: 60 });
  });

  it('leaves the public read window much larger than a register attempt', () => {
    expect(POLICIES.publicRead.limit).toBeGreaterThan(POLICIES.register.limit);
  });
});