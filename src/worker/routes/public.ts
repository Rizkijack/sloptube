import type { Env, VideoRow } from '../lib/env.js';
import { badRequest, handle, json, matchPath, methodNot, notFound, type Handler } from '../lib/http.js';
import {
  countAgentVideos,
  feedVersion,
  getProfile,
  getPublicVideo,
  listAgentFeed,
  listFeed,
  type FeedItem,
} from '../lib/db.js';
import { enforceLimit, POLICIES } from '../do/rate-limiter.js';
import {
  avatarUrl,
  desktopTopbar,
  feedTabbedHeader,
  mediaUrl,
  richGrid,
  richItem,
  toView,
  twoColumn,
  videoPageView,
} from '../lib/renderer.js';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 48;
const FEED_TTL_S = 30;

/**
 * The caller's IP, or `null` when Cloudflare did not supply one.
 *
 * `cf-connecting-ip` is always present on a real request. Falling back to the
 * URL hostname (the old behaviour) is a constant for every caller, so all
 * anonymous readers would share a single rate-limit bucket and one client could
 * exhaust it and lock out everyone else. Callers skip the limiter when this is
 * `null` — failing open is correct here (availability over throttling).
 */
export function clientIp(request: Request): string | null {
  return request.headers.get('cf-connecting-ip');
}

/** Rate-limit keyed on the real client, or skipped entirely when there is none. */
async function enforcePublicRead(env: Env, request: Request): Promise<void> {
  const ip = clientIp(request);
  if (ip) await enforceLimit(env, `public:${ip}`, POLICIES.publicRead);
}

function limitFrom(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) throw badRequest('invalid_limit', 'limit must be a positive number');
  return Math.min(MAX_LIMIT, Math.floor(parsed));
}

function feedDocument(env: Env, items: FeedItem[], query: string): unknown {
  const grid = richGrid(items.map((item) => richItem(env, toView(env, item.video, item.profile ?? undefined))));
  return {
    contents: twoColumn([grid], desktopTopbar(env, { query })),
  };
}

async function cachedFeed(
  env: Env,
  cacheKey: string,
  build: () => Promise<unknown>,
): Promise<unknown> {
  const key = `feed:v${await feedVersion(env)}:${cacheKey}`;
  const hit = await env.CACHE.get(key, 'json');
  if (hit !== null) return hit;
  const doc = await build();
  ctxSafePut(env, key, JSON.stringify(doc));
  return doc;
}

// KV writes must not outlive the request; the cache is a pure optimisation so a
// failed write is never fatal.
function ctxSafePut(env: Env, key: string, value: string): void {
  env.CACHE.put(key, value, { expirationTtl: FEED_TTL_S }).catch(() => undefined);
}

async function browse(request: Request, env: Env): Promise<Response> {
  await enforcePublicRead(env, request);
  const limit = limitFrom(new URL(request.url));
  const doc = await cachedFeed(env, `browse:${limit}`, async () =>
    feedDocument(env, await listFeed(env, limit), ''),
  );
  return json(doc, 200, { 'cache-control': `public, max-age=${FEED_TTL_S}` });
}

async function search(request: Request, env: Env): Promise<Response> {
  const q = cleanQuery(new URL(request.url).searchParams.get('q'));
  if (!q) throw badRequest('missing_query', 'q is required');
  await enforcePublicRead(env, request);
  const limit = limitFrom(new URL(request.url));
  // Deliberately NOT cached. Search queries are unbounded — the key space is
  // however many strings a caller can invent — and an unauthenticated endpoint
  // that writes one KV key per distinct query is a free bill for anyone who
  // wants one. The limiter fails open, so it does not bound the key space either.
  const doc = await feedDocument(env, await listFeed(env, limit, { query: q }), q);
  return json(doc, 200, { 'cache-control': `public, max-age=${FEED_TTL_S}` });
}

function cleanQuery(input: string | null): string {
  if (typeof input !== 'string') return '';
  return input.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 80);
}

async function video(env: Env, id: string): Promise<Response> {
  const item = await getPublicVideo(env, id);
  if (!item) throw notFound('video not found');
  const view = toView(env, item.video, item.profile ?? undefined);
  return json({
    ...(videoPageView(env, view, mediaUrl(env, id, 'master.m3u8')) as Record<string, unknown>),
    reportUrl: '/api/report',
    videoId: id,
  });
}

async function profile(request: Request, env: Env, agentId: string): Promise<Response> {
  await enforcePublicRead(env, request);
  const row = await getProfile(env, agentId);
  if (!row) throw notFound('channel not found');
  const items = await listAgentFeed(env, agentId, MAX_LIMIT);
  const videoCount = await countAgentVideos(env, agentId);
  const avatar = avatarUrl(env, row.avatar_key);
  // The UI hydrates `videos` as `richItemRenderer` entries and reads `avatar`
  // as a plain URL, so both are part of the response shape (not just `contents`).
  const videos = items.map((i) => richItem(env, toView(env, i.video, i.profile ?? undefined)));
  return json({
    contents: {
      ...(twoColumn(
        [richGrid(videos)],
        feedTabbedHeader(row.display_name),
      ) as Record<string, unknown>),
      metadata: {
        channelMetadataRenderer: {
          title: row.display_name,
          description: row.description,
          avatar: avatar
            ? { thumbnails: [{ url: avatar, width: 176, height: 176 }] }
            : undefined,
          videoCountText: { simpleText: String(videoCount) },
          externalId: agentId,
        },
      },
    },
    agentId,
    displayName: row.display_name,
    description: row.description,
    avatarUrl: avatar,
    avatar,
    videos,
    videoCount: videoCount,
  });
}

const CONTENT_TYPES: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  mp4: 'video/mp4',
  m4s: 'video/mp4',
  ts: 'video/mp2t',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

function contentTypeFor(key: string): string {
  const dot = key.lastIndexOf('.');
  const ext = dot === -1 ? '' : key.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Prefixes that may be served from R2. Anything else 404s, so a future key
 * prefix is private until it is added here on purpose. `videos/*` is *also*
 * gated on the video row being publicly visible (below); `profiles/*` (avatars)
 * is public by contract §3. `videos/{id}/source` is rejected by the filename
 * check.
 */
const SERVABLE_PREFIXES = ['videos/', 'profiles/'];

function isServableKey(key: string): boolean {
  if (key.length > 200) return false;
  if (!SERVABLE_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
  if (!/^[a-z]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(key)) return false;
  const filename = key.slice(key.indexOf('/') + 1);
  return !filename.startsWith('/') && !filename.endsWith('/source');
}

/** A byte range, `'unsatisfiable'` for a well-formed but out-of-range spec, or
 * `null` for a malformed header (which the RFC says to ignore). */
type RangeSpec = { start: number; end: number } | 'unsatisfiable' | null;

function parseRange(header: string | null, size: number): RangeSpec {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return null; // "bytes=-" is malformed
  let start: number;
  let end: number;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix)) return null;
    if (suffix <= 0) return 'unsatisfiable'; // "bytes=-0"
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  }
  // Syntactically valid but beyond the object: 416, not the full 200 body.
  // Checked before `end < start`, because "bytes=99999-" also implies end<start.
  if (start < 0 || start >= size) return 'unsatisfiable';
  if (end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

export async function serveMedia(request: Request, env: Env): Promise<Response> {
  const key = new URL(request.url).pathname.replace(/^\/media\//, '');
  if (!isServableKey(key)) throw notFound('media not found');

  if (key.startsWith('videos/')) {
    const videoId = key.split('/')[1]!;
    const row = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(videoId).first<VideoRow>();
    if (!row || row.status !== 'ready' || row.scan_state !== 'clean' || row.visibility !== 'public') {
      throw notFound('media not found');
    }
  }

  const head = await env.MEDIA.head(key);
  if (!head) throw notFound('media not found');

  const contentType = contentTypeFor(key);
  const base: Record<string, string> = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    // Bounded, not `immutable`: a video hidden after a takedown must stop being
    // replayable from edge caches within a bounded time, so a year-long
    // `immutable` entry is unacceptable here.
    'cache-control': 'public, max-age=3600',
    etag: head.httpEtag,
  };

  const range = parseRange(request.headers.get('range'), head.size);
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...base, 'content-range': `bytes */${head.size}` },
    });
  }
  if (range) {
    const object = await env.MEDIA.get(key, {
      range: { offset: range.start, length: range.end - range.start + 1 },
    });
    if (!object) throw notFound('media not found');
    return new Response(object.body, {
      status: 206,
      headers: {
        ...base,
        'content-length': String(range.end - range.start + 1),
        'content-range': `bytes ${range.start}-${range.end}/${head.size}`,
      },
    });
  }

  const object = await env.MEDIA.get(key);
  if (!object) throw notFound('media not found');
  return new Response(object.body, {
    status: 200,
    headers: { ...base, 'content-length': String(head.size) },
  });
}

const publicRoutes: Handler = async (request, env) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw methodNot(['GET']);
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === '/api/browse') return browse(request, env);
  if (pathname === '/api/search') return search(request, env);
  const videoMatch = matchPath('/api/video/:id', pathname);
  if (videoMatch) return video(env, videoMatch.id!);
  const profileMatch = matchPath('/api/profile/:agentId', pathname);
  if (profileMatch) return profile(request, env, profileMatch.agentId!);

  throw notFound('route not found');
};

export const handlePublicRoutes = handle(publicRoutes);