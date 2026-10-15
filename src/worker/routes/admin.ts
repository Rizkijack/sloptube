import type { Env } from '../lib/env.js';
import {
  badRequest,
  HttpError,
  methodNot,
  notFound,
  unauthorized,
  type Handler,
} from '../lib/http.js';
import { cleanText, now } from '../lib/ids.js';
import { logEvent } from '../lib/audit.js';
import { bumpFeedVersion, getVideo, releaseUsage } from '../lib/db.js';
import { purgeR2Prefix } from '../lib/r2.js';

/**
 * Operator surface for reports.
 *
 * This is the piece the previous design lacked: `/api/report` could hide a video
 * and nothing could ever bring it back. These routes make a hold resolvable, and
 * they are the only place allowed to write `status`, purge media, or release a
 * hold permanently.
 *
 * There is no admin web UI — this is an HTTP API operated by whoever holds the
 * token. It is deliberately excluded from the wildcard CORS headers the public
 * routes use: a browser on another origin must not be able to call it.
 */

const ACTIONS = ['restore', 'unquarantine', 'confirm', 'quarantine'] as const;
type Action = (typeof ACTIONS)[number];

/**
 * Constant-time compare.
 *
 * Both sides are hashed to a fixed 32 bytes first, so the comparison never sees
 * the token length: an early `a.length !== b.length` return leaks length through
 * timing. That leak is not practically exploitable over HTTP, but the hashed
 * form costs one extra SHA-256 and removes the question entirely.
 */
async function tokensMatch(presented: string, configured: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(presented)), crypto.subtle.digest('SHA-256', enc.encode(configured))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

async function requireOperator(request: Request, env: Env): Promise<void> {
  const configured = env.ADMIN_TOKEN;
  if (!configured) {
    // Fail closed: an unset token must not mean "open". Reusing the shared
    // HttpError keeps `handle()` turning it into a real 503 instead of a 500.
    throw new HttpError(503, 'operator_disabled', 'ADMIN_TOKEN is not configured');
  }
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const presented = match?.[1]?.trim() ?? '';
  if (!presented || !(await tokensMatch(presented, configured))) {
    throw unauthorized('operator token required');
  }
}

export async function listReports(
  env: Env,
  query: string | null,
): Promise<{ reports: unknown[] }> {
  const videoId = cleanText(query, 64);
  // `reporter_key` is deliberately absent. It is salted per video, but handing
  // it to whoever holds ADMIN_TOKEN would still build a within-video identity
  // the platform never promised to keep — and an operator queue does not need
  // it to decide anything. The dedup works on the stored value, not on this one.
  const base = `SELECT id, video_id, reason, detail, created_at, resolved_at
                  FROM reports WHERE resolved_at IS NULL`;
  if (videoId) {
    const { results } = await env.DB.prepare(`${base} AND video_id = ? ORDER BY created_at DESC LIMIT 200`)
      .bind(videoId)
      .all<Record<string, unknown>>();
    return { reports: results ?? [] };
  }
  const { results } = await env.DB.prepare(`${base} ORDER BY created_at DESC LIMIT 200`)
    .all<Record<string, unknown>>();
  return { reports: results ?? [] };
}

export interface ResolveOutcome {
  videoId: string;
  action: Action;
  /** False when the requested transition matched no row — nothing changed. */
  applied: boolean;
  status: string;
  visibility: string;
  /** Present only when `applied` is false. */
  reason?: string;
}

export async function resolveReport(
  env: Env,
  body: Record<string, unknown>,
): Promise<ResolveOutcome> {
  const videoId = cleanText(body.videoId, 64);
  if (!videoId) throw badRequest('missing_video_id', 'videoId is required');

  const action = cleanText(body.action, 32) as Action;
  if (!(ACTIONS as readonly string[]).includes(action)) {
    throw badRequest('invalid_action', `action must be one of ${ACTIONS.join(', ')}`);
  }

  const video = await getVideo(env, videoId);
  if (!video) throw notFound('video not found');

  const resolvedAt = now();

  // Every branch reports what the database actually did, never what it intended.
  // `changes = 0` means the compare-and-set did not apply — a concurrent sweep
  // already restored the video, or the row was never in the state this action
  // requires. Reporting intent instead would tell an operator a takedown landed
  // on a video that is still public.
  let applied = 0;

  if (action === 'unquarantine') {
    // The media is gone — quarantine purged every object under the prefix — so
    // this cannot make the video playable again and does not pretend to. It
    // clears the moderation verdict and returns the row to a state the agent can
    // retry from, without refunding twice (quarantine already released the
    // bytes). This is the path back out of the one-way door.
    const res = await env.DB.prepare(
      `UPDATE videos SET status = 'failed', visibility = 'private', hold_until = NULL,
              bytes = 0, updated_at = ?
        WHERE id = ? AND status = 'quarantined'`,
    )
      .bind(resolvedAt, videoId)
      .run();
    applied = res.meta.changes ?? 0;
  } else if (action === 'restore') {
    // Only a video that is genuinely fit to be public comes back: a hold can be
    // lifted, but a quarantined or unscanned video stays down.
    const restorable = video.status === 'ready' && video.scan_state === 'clean';
    if (!restorable) {
      return {
        videoId,
        action,
        applied: false,
        status: video.status,
        visibility: video.visibility,
        reason: 'only_ready_and_clean_videos_can_be_restored',
      };
    }
    applied = await liftHold(env, videoId, resolvedAt);
    if (applied > 0) await bumpFeedVersion(env);
  } else if (action === 'confirm') {
    // Make the hide durable: clear the deadline so the sweeper leaves it alone.
    // Guarded on already being hidden — `confirm` sharpens an existing hide, it
    // does not create one from a public video.
    const res = await env.DB.prepare(
      `UPDATE videos SET hold_until = NULL, updated_at = ?
        WHERE id = ? AND visibility = 'hidden'`,
    )
      .bind(resolvedAt, videoId)
      .run();
    applied = res.meta.changes ?? 0;
  } else {
    const res = await env.DB.prepare(
      `UPDATE videos SET status = 'quarantined', visibility = 'private', hold_until = NULL,
              updated_at = ? WHERE id = ? AND status != 'quarantined'`,
    )
      .bind(resolvedAt, videoId)
      .run();
    applied = res.meta.changes ?? 0;
    if (applied > 0) {
      await purgeR2Prefix(env, video.r2_prefix, { keepSource: false });
      await releaseUsage(env, video.agent_id, video.bytes);
      await env.DB.prepare('DELETE FROM video_segments WHERE video_id = ?').bind(videoId).run();
    }
  }

  // Reports are resolved only when the transition actually applied. Resolving
  // them on a no-op would empty the operator queue while leaving the video down
  // with no remaining signal — the exact silent-failure this route must not have.
  if (applied > 0) {
    await env.DB.prepare(
      'UPDATE reports SET resolved_at = ? WHERE video_id = ? AND resolved_at IS NULL',
    )
      .bind(resolvedAt, videoId)
      .run();
  }

  const after = (await getVideo(env, videoId)) ?? video;
  await logEvent(env, 'report.resolved', { videoId, action, applied: applied > 0 });
  return {
    videoId,
    action,
    applied: applied > 0,
    status: after.status,
    visibility: after.visibility,
  };
}

/**
 * Lift a hold. The `status='ready' AND scan_state='clean'` guard is repeated
 * here even though the caller already checked it in JavaScript, because this is
 * the statement that decides and the read above it can be stale by the time it
 * runs. Returns the number of rows actually moved.
 */
async function liftHold(env: Env, videoId: string, at: number): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE videos SET visibility = 'public', hold_until = NULL, updated_at = ?
      WHERE id = ? AND visibility = 'hidden' AND status = 'ready' AND scan_state = 'clean'`,
  )
    .bind(at, videoId)
    .run();
  return res.meta.changes ?? 0;
}

const adminRoutes: Handler = async (request, env) => {
  const url = new URL(request.url);

  // Authenticate before anything else, including the method check. Answering
  // 405 first would confirm to an unauthenticated prober that this path exists
  // and which methods it accepts.
  await requireOperator(request, env);

  // Deliberately NOT the shared `json()` helper: that one stamps
  // `access-control-allow-origin: *` for the public routes, and an operator
  // endpoint must not advertise itself as cross-origin readable.
  const operatorJson = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });

  if (url.pathname === '/api/admin/reports' && request.method === 'GET') {
    return operatorJson(await listReports(env, url.searchParams.get('videoId')));
  }

  if (url.pathname === '/api/admin/reports' && request.method === 'POST') {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      throw badRequest('invalid_json', 'body must be valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw badRequest('invalid_body', 'body must be a JSON object');
    }
    return operatorJson(await resolveReport(env, parsed as Record<string, unknown>));
  }

  throw methodNot(['GET', 'POST']);
};

/**
 * Wrap the admin handler so **errors** are rendered without CORS too.
 *
 * The shared `handle()` renders failures through the public `json()` helper,
 * which unconditionally stamps `access-control-allow-origin: *`. That is right
 * for `/api/*` and wrong here: a 401 from the operator surface should not be
 * readable cross-origin any more than its 200 is. No token can cross origins in
 * practice — `authorization` is absent from `access-control-allow-headers` — so
 * this is about the contract being true, not about closing a live hole.
 */
export const handleAdminRoutes: Handler = async (request, env, ctx) => {
  try {
    return await adminRoutes(request, env, ctx);
  } catch (err) {
    if (err instanceof HttpError) {
      return new Response(JSON.stringify({ error: err.code, message: err.message }), {
        status: err.status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    throw err;
  }
};
