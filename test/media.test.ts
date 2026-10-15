import { describe, expect, it } from 'vitest';
import type { Env, VideoRow } from '../src/worker/lib/env.js';

/**
 * `serveMedia` security tests.
 *
 * `/media/*` is the one anonymous path that streams raw bytes from R2, so its
 * only real defences are the allowlist (`SERVABLE_PREFIXES` + the strict
 * per-segment regex) and the database gate (`ready` + `clean` + `public`).
 * These tests pin both, plus the two properties a takedown depends on:
 * `videos/{id}/source` is never servable, and the Cache-Control is bounded
 * (`public, max-age=`, never `immutable`) so a hidden video actually leaves the
 * edge within an hour.
 */

const { serveMedia } = await import('../src/worker/routes/public.js');

interface StoredObject {
  content: Uint8Array;
}

function video(over: Partial<VideoRow> = {}): VideoRow {
  return {
    id: 'vid_1',
    agent_id: 'agt_1',
    status: 'ready',
    title: 't',
    description: '',
    tags: '[]',
    duration_s: 30,
    bytes: 1000,
    width: 640,
    height: 360,
    seg_count: 3,
    r2_prefix: 'videos/vid_1',
    sha256: null,
    scan_state: 'clean',
    visibility: 'public',
    hold_until: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  } as VideoRow;
}

function makeEnv(row: VideoRow | null, over: Record<string, unknown> = {}) {
  const objects = new Map<string, StoredObject>([
    ['videos/vid_1/seg_001.m4s', { content: new TextEncoder().encode('SEGMENT-BYTES') }],
    ['profiles/agt_1/avatar.jpg', { content: new TextEncoder().encode('AVATAR-BYTES') }],
  ]);

  const calls = {
    prepare: 0,
    head: [] as string[],
    get: [] as string[],
  };

  const db = {
    prepare(sql: string) {
      calls.prepare++;
      const norm = sql.replace(/\s+/g, ' ').trim();
      const stmt: {
        first: <T>() => Promise<T | null>;
        bind: (...args: unknown[]) => unknown;
      } = {
        bind() {
          return stmt;
        },
        async first<T>() {
          if (/^SELECT \* FROM videos WHERE id = \?$/.test(norm)) {
            return (row ?? null) as T | null;
          }
          throw new Error(`fake DB: unhandled first(): ${norm}`);
        },
      };
      return stmt;
    },
  };

  const MEDIA = {
    head: async (key: string) => {
      calls.head.push(key);
      if (!objects.has(key)) return null;
      return { size: objects.get(key)!.content.byteLength, httpEtag: `etag-${key}` };
    },
    get: async (key: string, opts?: { range?: { offset: number; length: number } }) => {
      calls.get.push(key);
      const stored = objects.get(key);
      if (!stored) return null;
      const slice = opts?.range
        ? stored.content.subarray(
            Math.min(opts.range.offset, stored.content.length),
            Math.min(opts.range.offset + opts.range.length, stored.content.length),
          )
        : stored.content;
      return {
        size: stored.content.byteLength,
        httpEtag: `etag-${key}`,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(slice);
            controller.close();
          },
        }),
      };
    },
  };

  const env = {
    DB: db,
    CACHE: { get: async () => null, put: async () => undefined },
    MEDIA,
    ...over,
  } as unknown as Env;

  return { env, objects, calls };
}

const media = (pathname: string, headers: Record<string, string> = {}) =>
  new Request(`https://x.test${pathname}`, { headers });

describe('serveMedia — the happy path', () => {
  it('serves a public, ready, clean video segment', async () => {
    const { env } = makeEnv(video());
    const res = await serveMedia(media('/media/videos/vid_1/seg_001.m4s'), env);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe('13');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('etag')).toBe('etag-videos/vid_1/seg_001.m4s');
    await expect(res.text()).resolves.toBe('SEGMENT-BYTES');
  });

  it('bounds the cache: max-age but never immutable', async () => {
    // public.ts: "Bounded, not immutable" — a year-long immutable entry would
    // let a taken-down video keep playing from edge caches.
    const { env } = makeEnv(video());
    const cc = (await serveMedia(media('/media/videos/vid_1/seg_001.m4s'), env)).headers.get(
      'cache-control',
    );
    expect(cc).toContain('public');
    expect(cc).toContain('max-age=');
    expect(cc).not.toContain('immutable');
  });

  it('serves a profile avatar without touching the videos table', async () => {
    // Profiles are public by contract §3: servable straight from the allowlist.
    const { env, calls } = makeEnv(video());
    const res = await serveMedia(media('/media/profiles/agt_1/avatar.jpg'), env);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(calls.prepare).toBe(0);
  });
});

describe('serveMedia — the database gate', () => {
  const gatedRows: [string, VideoRow][] = [
    ['status probed', video({ status: 'probed' })],
    ['status quarantined', video({ status: 'quarantined' })],
    ['status uploaded', video({ status: 'uploaded' })],
    ['scan_state pending', video({ scan_state: 'pending' })],
    ['scan_state infected', video({ scan_state: 'infected' })],
    ['visibility private', video({ visibility: 'private' })],
    ['visibility hidden', video({ visibility: 'hidden' })],
  ];

  for (const [label, row] of gatedRows) {
    it(`refuses a video that is ${label}`, async () => {
      const { env } = makeEnv(row);
      await expect(serveMedia(media('/media/videos/vid_1/seg_001.m4s'), env)).rejects.toMatchObject({
        status: 404,
      });
    });
  }

  it('refuses a video whose row does not exist — no existence oracle', async () => {
    const { env } = makeEnv(null);
    await expect(serveMedia(media('/media/videos/vid_1/seg_001.m4s'), env)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses an allowlisted videos/* key that is not in R2', async () => {
    const { env, calls } = makeEnv(video());
    await expect(serveMedia(media('/media/videos/vid_1/seg_999.m4s'), env)).rejects.toMatchObject({
      status: 404,
    });
    expect(calls.get).toEqual([]);
  });
});

describe('serveMedia — path checks', () => {
  it('never serves the raw source object', async () => {
    const { env, calls } = makeEnv(video());
    await expect(serveMedia(media('/media/videos/vid_1/source'), env)).rejects.toMatchObject({
      status: 404,
    });
    // Rejected by the filename rule, before any DB read or R2 call.
    expect(calls.prepare).toBe(0);
    expect(calls.get).toEqual([]);
  });

  it('rejects a dot-segment traversal path', async () => {
    // `new URL` normalises `..` away before `isServableKey` sees anything, and
    // what is left is still not a servable key — the trivia matters only in
    // that no DB read and no R2 call ever happens for it.
    const { env, calls } = makeEnv(video());
    await expect(serveMedia(media('/media/videos/../../profiles/x'), env)).rejects.toMatchObject({
      status: 404,
    });
    expect(calls.prepare).toBe(0);
    expect(calls.head).toEqual([]);
    expect(calls.get).toEqual([]);
  });

  it('rejects percent-encoded traversal inside the key', async () => {
    const { env, calls } = makeEnv(video());
    await expect(
      serveMedia(media('/media/videos/vid_1/..%2F..%2Fprofiles%2Fagt_1%2Favatar.jpg'), env),
    ).rejects.toMatchObject({ status: 404 });
    expect(calls.prepare).toBe(0);
    expect(calls.head).toEqual([]);
    expect(calls.get).toEqual([]);
  });

  it('rejects keys longer than 200 characters', async () => {
    const { env, calls } = makeEnv(video());
    const long = `/media/videos/vid_1/${'a'.repeat(300)}`;
    await expect(serveMedia(media(long), env)).rejects.toMatchObject({ status: 404 });
    expect(calls.head).toEqual([]);
    expect(calls.get).toEqual([]);
  });

  it('rejects prefixes outside SERVABLE_PREFIXES, avatar-sounding or not', async () => {
    for (const path of ['/media/tmp/one.bin', '/media/avatars/agt_1/avatar.jpg', '/media/events/x']) {
      const { env, calls } = makeEnv(video());
      await expect(serveMedia(media(path), env)).rejects.toMatchObject({ status: 404 });
      expect(calls.head).toEqual([]);
      expect(calls.get).toEqual([]);
    }
  });
});

describe('serveMedia — byte ranges', () => {
  it('answers a satisfiable range with 206 and a content-range', async () => {
    const { env } = makeEnv(video());
    const res = await serveMedia(
      media('/media/videos/vid_1/seg_001.m4s', { range: 'bytes=0-9' }),
      env,
    );

    expect(res.status).toBe(206);
    expect(res.headers.get('content-length')).toBe('10');
    expect(res.headers.get('content-range')).toBe('bytes 0-9/13');
    await expect(res.text()).resolves.toBe('SEGMENT-BY');
  });

  it('answers a well-formed but out-of-range range with 416', async () => {
    const { env, calls } = makeEnv(video());
    const res = await serveMedia(
      media('/media/videos/vid_1/seg_001.m4s', { range: 'bytes=99999-' }),
      env,
    );

    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */13');
    // A 416 must not have streamed anything.
    expect(calls.get).toEqual([]);
  });
});
