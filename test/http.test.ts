import { describe, expect, it } from 'vitest';
import {
  HttpError,
  forbidden,
  handle,
  json,
  matchPath,
  methodNot,
  notFound,
  tooLarge,
  tooMany,
  unauthorized,
  badRequest,
} from '../src/worker/lib/http.js';
import { clientIp } from '../src/worker/routes/public.js';

describe('matchPath', () => {
  it('matches a literal path and returns an empty object', () => {
    expect(matchPath('/api/browse', '/api/browse')).toEqual({});
    expect(matchPath('/api/browse', '//api//browse')).toEqual({});
  });

  it('extracts a single param', () => {
    expect(matchPath('/api/video/:id', '/api/video/vid_abc')).toEqual({ id: 'vid_abc' });
  });

  it('extracts multiple params', () => {
    expect(matchPath('/a/:x/b/:y/c', '/a/1/b/2/c')).toEqual({ x: '1', y: '2' });
  });

  it('percent-decodes params', () => {
    expect(matchPath('/api/video/:id', '/api/video/a%2Fb')).toEqual({ id: 'a/b' });
    expect(matchPath('/api/video/:id', '/api/video/%E2%9C%93')).toEqual({ id: '✓' });
  });

  it('returns null on a segment-count mismatch', () => {
    expect(matchPath('/api/video/:id', '/api/video')).toBeNull();
    expect(matchPath('/api/video/:id', '/api/video/a/b')).toBeNull();
    expect(matchPath('/api', '/api/browse')).toBeNull();
  });

  it('returns null when a literal segment differs', () => {
    expect(matchPath('/api/video/:id', '/api/audio/vid_1')).toBeNull();
    expect(matchPath('/api/browse', '/api/search')).toBeNull();
  });

  it('is case-sensitive', () => {
    expect(matchPath('/api/video/:id', '/API/video/1')).toBeNull();
  });

  it('does not treat a param pattern in the request as a param', () => {
    // Only the pattern side is scanned for ':'.
    expect(matchPath('/api/video/:id', '/api/video/:id')).toEqual({ id: ':id' });
  });

  it('keeps a slash inside a percent-encoded param value', () => {
    expect(matchPath('/x/:v', '/x/a%2Fb%2Fc')).toEqual({ v: 'a/b/c' });
  });

  it('matches the empty path against the empty pattern', () => {
    expect(matchPath('/', '/')).toEqual({});
    expect(matchPath('/', '/a')).toBeNull();
  });
});

describe('error constructors', () => {
  it('each carry the documented status and code', () => {
    expect(badRequest('c', 'm')).toMatchObject({ status: 400, code: 'c', message: 'm' });
    expect(unauthorized()).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(forbidden()).toMatchObject({ status: 403, code: 'forbidden' });
    expect(notFound()).toMatchObject({ status: 404, code: 'not_found' });
    expect(methodNot(['GET'])).toMatchObject({ status: 405, code: 'method_not_allowed' });
    expect(tooLarge('too big')).toMatchObject({ status: 413, code: 'payload_too_large' });
    expect(tooMany('slow down')).toMatchObject({ status: 429, code: 'rate_limited' });
  });

  it('are all instances of HttpError and Error', () => {
    const err = notFound('missing');
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('HttpError');
  });
});

describe('json', () => {
  it('serialises the body and sets content-type plus CORS', async () => {
    const res = json({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    await expect(res.json()).resolves.toEqual({ a: 1 });
  });

  it('accepts a custom status and headers', () => {
    const res = json({ error: 1 }, 404, { 'cache-control': 'no-store' });
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('handle', () => {
  const ctx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
    tracing: { enabled: false },
  } as unknown as ExecutionContext;
  const env = {} as never;

  it('passes a successful response through untouched', async () => {
    const wrapped = handle(async () => json({ ok: true }));
    const res = await wrapped(new Request('https://a.test/'), env, ctx);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('maps a thrown HttpError to its status and code', async () => {
    const wrapped = handle(async () => {
      throw badRequest('invalid_display_name', 'too short');
    });
    const res = await wrapped(new Request('https://a.test/'), env, ctx);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: 'invalid_display_name', message: 'too short' },
    });
  });

  it('hides an unexpected error behind a generic 500', async () => {
    const wrapped = handle(async () => {
      throw new Error('secret internal detail');
    });
    const res = await wrapped(new Request('https://a.test/'), env, ctx);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: { code: 'internal', message: 'internal error' },
    });
  });

  it('does not leak the internal message', async () => {
    const wrapped = handle(async () => {
      throw new Error('database password is hunter2');
    });
    const res = await wrapped(new Request('https://a.test/'), env, ctx);
    expect(await res.text()).not.toContain('hunter2');
  });
});

describe('clientIp', () => {
  it('treats an empty cf-connecting-ip as unattributed, not as a bucket key', () => {
    // `''` would otherwise become a stable limiter key: every header-less (or
    // hostile) caller would share one `public:/report:` bucket.
    const req = new Request('https://a.test/', { headers: { 'cf-connecting-ip': '' } });
    expect(clientIp(req)).toBeNull();
  });

  it('returns the attribute when present', () => {
    const req = new Request('https://a.test/', { headers: { 'cf-connecting-ip': '203.0.113.7' } });
    expect(clientIp(req)).toBe('203.0.113.7');
  });

  it('returns null when the header is absent', () => {
    expect(clientIp(new Request('https://a.test/'))).toBeNull();
  });
});