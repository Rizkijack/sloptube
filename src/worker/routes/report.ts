import type { Env } from '../lib/env.js';
import { badRequest, handle, json, methodNot, type Handler } from '../lib/http.js';
import { cleanText, newId, now } from '../lib/ids.js';
import { logEvent } from '../lib/audit.js';
import { bumpFeedVersion, getVideo } from '../lib/db.js';
import { enforceLimit, POLICIES } from '../do/rate-limiter.js';
import { clientIp } from './public.js';
import { reporterKey, reportSaltMissing } from '../lib/reporter.js';

const REASONS = ['copyright', 'csam', 'violence', 'malware', 'spam', 'other'] as const;
type Reason = (typeof REASONS)[number];

/**
 * Reports are a **hold**, not a verdict.
 *
 * The endpoint is anonymous, CSRF-reachable (the Worker permits the JSON
 * preflight) and stores no reporter identity, so it must never be able to
 * destroy anything on one request. Three properties make it safe:
 *
 *  1. **Per-reporter dedup.** One reporter key can contribute at most one row per
 *     video per day — enforced by a UNIQUE index, not by application logic, so
 *     concurrent requests cannot race past it.
 *  2. **Quorum on DISTINCT reporters**, so N requests from one actor are worth one
 *     report, not N.
 *  3. **A hold, not a permanent removal.** Hiding stamps `hold_until`; the cron
 *     sweeper restores the video when the hold expires. Only an operator
 *     (`routes/admin.ts`) can make a hide permanent or quarantine.
 *
 * Nothing here may write `status`, delete rows, or purge media.
 */
const HIDE_THRESHOLD = 3;
const HOLD_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function submitReport(
  env: Env,
  body: Record<string, unknown>,
  ip: string | null,
): Promise<{ accepted: true; counted: boolean }> {
  if (ip) await enforceLimit(env, `report:${ip}`, POLICIES.report);

  const videoId = cleanText(body.videoId, 64);
  if (!videoId) throw badRequest('missing_video_id', 'videoId is required');

  const reason = cleanText(body.reason, 32);
  if (!(REASONS as readonly string[]).includes(reason)) {
    throw badRequest('invalid_reason', `reason must be one of ${REASONS.join(', ')}`);
  }
  const detail = cleanText(body.detail, 1000);

  // Answer 202 whatever the video is, including one that does not exist. A 400
  // here confirms to a prober whether a given id is a real video — and right
  // now it confirms it for never-published drafts too, which is more than the
  // reporter needs to know. The report row is only written for a real video.
  const video = await getVideo(env, videoId);
  if (!video) {
    await logEvent(env, 'report.filed', { videoId, unknown: true, saltMissing: reportSaltMissing(env) });
    return { accepted: true, counted: false };
  }

  const createdAt = now();
  // Hashing the IP per-video keeps it out of the database while still making one
  // address a single reporter for this video. With no address at all, or no
  // configured salt, the bucket collapses to one shared key, so an unattributable
  // caller can never reach the quorum alone.
  const reporter = await reporterKey(env, ip, videoId);

  // The UNIQUE index on (video_id, reporter_key, day) is the dedup. A duplicate
  // makes changes = 0 and the report is recorded as already-counted.
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO reports (id, video_id, reason, detail, reporter_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId('rep'), videoId, reason, detail, reporter, createdAt)
    .run();
  const counted = (inserted.meta.changes ?? 0) > 0;

  const since = createdAt - WINDOW_MS;
  const tally = await env.DB.prepare(
    `SELECT COUNT(DISTINCT reporter_key) AS n FROM reports
      WHERE video_id = ? AND created_at >= ? AND resolved_at IS NULL`,
  )
    .bind(videoId, since)
    .first<{ n: number }>();
  const distinct = Number(tally?.n ?? 0);

  // Compare-and-set: only a video that is still publicly visible takes a hold,
  // and only while the quorum is met. `hold_until` is what the sweeper reads.
  const hide =
    counted && distinct >= HIDE_THRESHOLD && video.visibility === 'public' && video.status === 'ready';

  if (hide) {
    // Only a video that is *currently public* takes a hold. That guard is also
    // what makes a hold non-renewable: while the hold stands the row is already
    // hidden, so a fourth report cannot push `hold_until` further out. A hold
    // expires once and, with its reports resolved by the sweeper, the quorum
    // cannot immediately re-hide the video — otherwise one actor with a few IPs
    // could keep any video dark in 7-day slices forever.
    const applied = await env.DB.prepare(
      `UPDATE videos SET visibility = 'hidden', hold_until = ?, updated_at = ?
        WHERE id = ? AND visibility = 'public' AND status = 'ready'`,
    )
      .bind(createdAt + HOLD_MS, createdAt, videoId)
      .run();
    if ((applied.meta.changes ?? 0) > 0) await bumpFeedVersion(env);
  }

  await logEvent(env, 'report.filed', {
    videoId,
    reason,
    hidVideo: hide,
    distinctReporters: distinct,
    duplicate: !counted,
    // Surfaces a missing REPORTER_SALT to the operator through the audit trail
    // rather than through a 5xx on the public report endpoint.
    saltMissing: reportSaltMissing(env),
  });

  return { accepted: true, counted };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw badRequest('invalid_json', 'body must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('invalid_body', 'body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

const reportRoutes: Handler = async (request, env) => {
  if (new URL(request.url).pathname !== '/api/report') throw methodNot(['POST']);
  if (request.method !== 'POST') throw methodNot(['POST']);

  // Require a JSON content type: a `text/plain` simple request is fireable from
  // any third-party page without a preflight. Note this raises the bar, it does
  // not close CSRF — the Worker allows the JSON preflight, so an operator action
  // is what actually makes a hide durable.
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw badRequest('invalid_content_type', 'content-type must be application/json');
  }

  // 202 + no body detail: a reporter must never learn who reported, nor confirm
  // anything beyond "accepted".
  return json(await submitReport(env, await readJson(request), clientIp(request)), 202);
};

export const handleReportRoutes = handle(reportRoutes);
