import type { Env, PipelineMessage, VideoRow } from './env.js';
import { LIMITS } from './env.js';
import { newId, now } from './ids.js';
import { logEvent } from './audit.js';
import { bumpFeedVersion, countSegments, isBlockedHash, releaseUsage } from './db.js';
import { playlistKey, rawKey, purgeR2Prefix } from './r2.js';
import { probe, scan, transcode } from '../container-media.js';

const SCAN_RETRIES = 2;
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A claimed job older than this is assumed dead and may be re-run. */
const WORK_LEASE_MS = 30 * 60 * 1000;

type Job = PipelineMessage;

export function buildMasterPlaylist(
  segments: readonly { n: number; durationS: number }[],
): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7'];
  // fMP4 segments carry no codec config; without this map the player has no
  // track to decode and playback fails outright.
  lines.push('#EXT-X-MAP:URI="init.mp4"');
  // TARGETDURATION must be >= the longest segment; taking it from the real
  // per-segment durations rather than from the plan is what keeps that true for
  // non-aligned or variable-frame-rate sources.
  const longest = segments.reduce((max, s) => Math.max(max, s.durationS), 0);
  lines.push(`#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(longest))}`);
  lines.push('#EXT-X-MEDIA-SEQUENCE:0');
  lines.push('#EXT-X-PLAYLIST-TYPE:VOD');
  for (const seg of [...segments].sort((a, b) => a.n - b.n)) {
    lines.push(`#EXTINF:${seg.durationS.toFixed(6)},`);
    lines.push(`seg_${String(seg.n).padStart(6, '0')}.m4s`);
  }
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

/** Fallback segment count when a probe result predates duration reporting. */
function segmentPlan(durationS: number, segmentSeconds: number): number {
  return Math.max(1, Math.ceil(durationS / segmentSeconds));
}

/**
 * Conditional state write.
 *
 * Every pipeline transition goes through this: the previous unconditional
 * `UPDATE … SET status` let a late job overwrite a newer verdict — a duplicate
 * transcode could downgrade `ready` back to `transcoded` and silently unpublish
 * a video, and a duplicate probe could mark a published video `rejected`.
 * Returns whether the row actually moved.
 */
async function transitionVideo(
  env: Env,
  videoId: string,
  allowFrom: readonly string[],
  fields: Record<string, string | number | null>,
): Promise<boolean> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return false;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const from = allowFrom.map(() => '?').join(', ');
  const res = await env.DB.prepare(
    `UPDATE videos SET ${sets}, updated_at = ? WHERE id = ? AND status IN (${from})`,
  )
    .bind(...keys.map((k) => fields[k] ?? null), now(), videoId, ...allowFrom)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Lease-based idempotency, reusing the `jobs` table.
 *
 * A duplicate queue delivery — or two concurrent batches, which Queues allows —
 * must never start a second ffmpeg pass over the same 2 GiB object. The row stays
 * `done` after success, because releasing it would let exactly the duplicate we
 * are guarding against run again.
 */
async function claimWork(env: Env, key: string, kind: string): Promise<boolean> {
  const staleBefore = now() - WORK_LEASE_MS;
  const res = await env.DB.prepare(
    `INSERT INTO jobs (id, kind, payload, state, attempts, created_at, updated_at)
     VALUES (?, ?, '{}', 'running', 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET state = 'running', attempts = attempts + 1, updated_at = excluded.updated_at
       WHERE jobs.state = 'failed' OR (jobs.state = 'running' AND jobs.updated_at < ?)`,
  )
    .bind(key, kind, now(), now(), staleBefore)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

async function releaseWork(env: Env, key: string, state: 'done' | 'failed'): Promise<void> {
  await env.DB.prepare('UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?')
    .bind(state, now(), key)
    .run();
}

/* ----------------------------- probe ----------------------------- */

async function handleProbe(env: Env, videoId: string, sourceKey: string): Promise<void> {
  const video = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(videoId).first<VideoRow>();
  if (!video) return;
  if (video.status === 'rejected' || video.status === 'quarantined') return;
  if (video.status !== 'uploaded') return;

  const info = await probe(env, videoId, sourceKey);
  const sha256 = typeof info.sha256 === 'string' ? info.sha256.toLowerCase() : '';
  const durationS = Number(info.durationS) || 0;
  const width = Number(info.width) || 0;
  const height = Number(info.height) || 0;
  const bytes = Number(info.bytes) || 0;

  const reject = async (why: string) => {
    const moved = await transitionVideo(env, videoId, ['uploaded'], {
      status: 'rejected',
      sha256: sha256 || null,
    });
    if (moved) {
      // A rejected upload must not keep consuming the agent's quota forever.
      await releaseUsage(env, video.agent_id, video.bytes || bytes);
    }
    await logEvent(env, 'video.rejected', { videoId, why: `${why}:${info.reason ?? ''}` }, video.agent_id);
  };

  // A non-video object, or an ffprobe that could not read it at all.
  if (!info.ok) return reject('probe_failed');
  if (sha256 && (await isBlockedHash(env, sha256))) return reject('blocked_hash');
  if (durationS <= 0) return reject('no_duration');
  if (durationS > LIMITS.maxDurationS(env)) return reject('duration_exceeds_limit');
  if (height > LIMITS.maxHeight(env)) return reject('height_exceeds_limit');

  const segmentSeconds = LIMITS.segmentSeconds(env);
  const segCount = segmentPlan(durationS, segmentSeconds);

  // Conditional: if another delivery of this same probe already moved the row on,
  // do not enqueue a second transcode.
  const moved = await transitionVideo(env, videoId, ['uploaded'], {
    duration_s: Math.round(durationS),
    width,
    height,
    bytes,
    sha256: sha256 || null,
    seg_count: segCount,
    status: 'probed',
  });
  if (!moved) return;

  // A re-probe restarts the segment set from scratch.
  await env.DB.prepare('DELETE FROM video_segments WHERE video_id = ?').bind(videoId).run();

  // Transcode, then scan, chained by completion rather than by send order.
  // Sending both here let the two messages land in one batch and be processed in
  // order, so scan set `ready` first and transcode then returned early on
  // `status !== 'probed'`: a video could go public with zero segments and no
  // playlist. finalizeTranscode is now the only thing that enqueues the scan.
  await env.PIPELINE_QUEUE.send({ kind: 'transcode', videoId, segSeconds: segmentSeconds });

  await logEvent(env, 'video.probed', { videoId, segCount, durationS }, video.agent_id);
}

/* --------------------------- transcode --------------------------- */

/**
 * One job, one ffmpeg pass over the whole file.
 *
 * The per-segment fan-out this replaces was removed on measured evidence: each
 * independently encoded fragment restarted its timeline at zero and carried a
 * different init segment, so the assembled stream decoded only the first
 * segment. See container/media.sh for the numbers.
 */
/**
 * Gate on the state the pipeline actually needs, and only here.
 *
 * `ready` is set only after the segment count is validated against `seg_count`
 * (see handleScan), so scanning before the transcode cannot publish a video that
 * has no segments.
 */
async function handleTranscode(env: Env, videoId: string, segSeconds: number): Promise<void> {
  const lease = `${videoId}:transcode`;
  if (!(await claimWork(env, lease, 'transcode'))) return;

  const video = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(videoId).first<VideoRow>();
  if (!video) {
    await releaseWork(env, lease, 'done');
    return;
  }
  if (video.status !== 'probed') {
    await releaseWork(env, lease, 'done');
    return;
  }

  try {
    const result = await transcode(env, video.id, {
      r2Key: rawKey(video.id),
      r2Prefix: video.r2_prefix,
      segSeconds,
    });

    if (!result.ok) {
      // Guard the refund on the transition actually applying. Unguarded, a
      // duplicate delivery (the lease goes back to claimable on 'failed') or a
      // concurrent quarantine that already refunded would release the same
      // bytes twice and hand back another video's storage.
      const moved = await transitionVideo(env, video.id, ['probed'], { status: 'failed' });
      if (moved) {
        await releaseUsage(env, video.agent_id, video.bytes);
        await logEvent(env, 'video.transcode_failed', { videoId: video.id, reason: result.reason ?? '' }, video.agent_id);
      }
      // Container-side failures are not retryable by repeating the same input.
      await releaseWork(env, lease, 'failed');
      return;
    }

    const segments = Array.isArray(result.segments) ? result.segments : [];
    if (segments.length === 0) throw new Error(`container produced no segments for ${video.id}`);

    const durations = segments.map((s) => ({
      n: Number(s.n) || 0,
      // The container reports the real duration ffmpeg wrote; fall back to the
      // plan only if an older image omits it.
      durationS: Number(s.durationS) > 0 ? Number(s.durationS) : segSeconds,
      r2Key: s.r2Key,
      bytes: Number(s.bytes) || 0,
    }));

    await env.DB.prepare('DELETE FROM video_segments WHERE video_id = ?').bind(video.id).run();
    const insert = env.DB.prepare(
      `INSERT INTO video_segments (video_id, n, r2_key, bytes, duration_s) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(video_id, n) DO UPDATE SET r2_key = excluded.r2_key, bytes = excluded.bytes,
         duration_s = excluded.duration_s`,
    );
    await env.DB.batch(
      durations.map((s) => insert.bind(video.id, String(s.n), s.r2Key, s.bytes, s.durationS)),
    );

    await finalizeTranscode(env, video, durations);
    await releaseWork(env, lease, 'done');
  } catch (err) {
    await releaseWork(env, lease, 'failed');
    throw err;
  }
}

async function finalizeTranscode(
  env: Env,
  video: VideoRow,
  durations: readonly { n: number; durationS: number }[],
): Promise<void> {
  const done = await countSegments(env, video.id);
  if (done < video.seg_count) return;

  const playlist = buildMasterPlaylist(durations);
  await env.MEDIA.put(playlistKey(video.id), playlist, {
    httpMetadata: { contentType: 'application/vnd.apple.mpegurl' },
  });

  const moved = await transitionVideo(env, video.id, ['probed'], { status: 'transcoded' });
  if (!moved) return;
  await logEvent(env, 'video.transcoded', { videoId: video.id, segments: done }, video.agent_id);

  // Scan runs last, and only after the media it is blessing actually exists.
  await env.PIPELINE_QUEUE.send({ kind: 'scan', videoId: video.id });
}

/* ------------------------------ scan ----------------------------- */

async function handleScan(env: Env, videoId: string, attempt: number): Promise<void> {
  const video = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(videoId).first<VideoRow>();
  if (!video) return;
  if (video.status === 'ready' || video.status === 'quarantined') return;
  if (video.status === 'rejected' || video.status === 'failed') return;
  // Never bless media that was not fully produced: a `ready` video with missing
  // segments shows up in the feed and then fails to play.
  if (video.status !== 'transcoded') {
    throw new Error(`scan before transcode completed for ${videoId} (status=${video.status})`);
  }

  const segments = await countSegments(env, videoId);
  if (segments !== video.seg_count) {
    throw new Error(
      `refusing to publish ${videoId}: ${segments}/${video.seg_count} segments present`,
    );
  }

  const info = await scan(env, videoId, rawKey(videoId));

  if (info.ok && info.verdict === 'clean') {
    const promoted = await transitionVideo(env, videoId, ['transcoded'], {
      scan_state: 'clean',
      status: 'ready',
      visibility: 'public',
    });
    if (promoted) {
      await bumpFeedVersion(env);
      await logEvent(env, 'video.ready', { videoId }, video.agent_id);
    }
    return;
  }

  if (info.ok && info.verdict === 'infected') {
    const quarantined = await transitionVideo(env, videoId, ['transcoded'], {
      scan_state: 'infected',
      status: 'quarantined',
      visibility: 'private',
    });
    // Both the purge and the refund are inside the guard. Unguarded, losing this
    // compare-and-set to a concurrent operator quarantine still released the
    // bytes a second time — on top of the refund admin.ts already issued.
    if (quarantined) {
      // Delete every object, not just the segment rows: `visibility` has no
      // effect on objects served straight from R2 via the CDN, so leaving them
      // behind would keep infected media fetchable by URL.
      await purgeR2Prefix(env, video.r2_prefix, { keepSource: false });
      await releaseUsage(env, video.agent_id, video.bytes);
    }
    await logEvent(env, 'video.infected', { videoId, signature: info.signature ?? '' }, video.agent_id);
    return;
  }

  if (attempt >= SCAN_RETRIES) {
    const moved = await transitionVideo(env, videoId, ['transcoded'], {
      scan_state: 'error',
      status: 'quarantined',
    });
    if (moved) {
      // Same reasoning as the infected branch: a quarantined video's media must
      // not stay fetchable by URL just because `visibility` has no effect on
      // objects served straight from R2.
      await purgeR2Prefix(env, video.r2_prefix, { keepSource: false });
      await releaseUsage(env, video.agent_id, video.bytes);
    }
    await logEvent(env, 'video.scan_error', { videoId, attempt, reason: info.reason ?? '' }, video.agent_id);
    // Terminal: ack rather than retry into a DLQ with the state already recorded.
    return;
  }
  await transitionVideo(env, videoId, ['transcoded'], { scan_state: 'pending' });
  throw new Error(`scan inconclusive for ${videoId}: ${info.reason ?? 'unknown'}`);
}

/* --------------------------- entrypoints ------------------------- */

async function runJob(env: Env, job: Job, attempt: number): Promise<void> {
  switch (job.kind) {
    case 'probe':
      return handleProbe(env, job.videoId, job.r2Key);
    case 'transcode':
      return handleTranscode(env, job.videoId, job.segSeconds ?? LIMITS.segmentSeconds(env));
    case 'scan':
      return handleScan(env, job.videoId, attempt);
    case 'sweep':
      return sweepVideo(env, job.videoId);
    default:
      return undefined;
  }
}

export async function handlePipelineBatch(
  batch: MessageBatch<PipelineMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body as Job;
    try {
      await runJob(env, job, message.attempts ?? 1);
      message.ack();
    } catch (err) {
      const detail = String(err).replace(/[\r\n]+/g, ' ').slice(0, 300);
      await recordFailure(env, job, detail);
      message.retry();
    }
  }
}

async function recordFailure(env: Env, job: Job, detail: string): Promise<void> {
  const id = jobIdFor(job);
  try {
    await env.DB.prepare(
      `INSERT INTO jobs (id, kind, payload, state, attempts, last_error, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET attempts = jobs.attempts + 1, last_error = excluded.last_error, updated_at = excluded.updated_at`,
    )
      .bind(id, job.kind, JSON.stringify({ videoId: 'videoId' in job ? job.videoId : null }), detail, now(), now())
      .run();
    await logEvent(env, 'pipeline.retry', { job: job.kind, id, detail });
  } catch (err) {
    console.error('failed to record pipeline failure', id, err);
  }
}

function jobIdFor(job: Job): string {
  if (!('videoId' in job)) return newId('job');
  return `${job.videoId}:${job.kind}`;
}

/** Cron: videos stuck before transcoding for >24h are dead weight — drop them. */
export async function sweepVideo(env: Env, videoId: string): Promise<void> {
  const video = await env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(videoId).first<VideoRow>();
  if (!video) return;
  if (video.status !== 'uploaded' && video.status !== 'probed') return;
  if (now() - video.updated_at < ORPHAN_MAX_AGE_MS) return;

  const moved = await transitionVideo(env, videoId, ['uploaded', 'probed'], { status: 'failed' });
  if (!moved) return;
  await purgeR2Prefix(env, video.r2_prefix);
  // Release the storage the sweep just reclaimed.
  await releaseUsage(env, video.agent_id, video.bytes);
  await logEvent(env, 'video.orphan_swept', { videoId }, video.agent_id);
}

/**
 * Cron: lift anonymous holds whose deadline has passed.
 *
 * A report-based hide is deliberately temporary — the quorum of anonymous
 * reporters can still be gamed, so the hold expires and the video returns unless
 * an operator confirmed it (`hold_until IS NULL`) or quarantined it. Only videos
 * that are still `ready` + `clean` are restored; anything else stays down.
 */
export async function releaseExpiredHolds(env: Env): Promise<number> {
  const at = now();
  const expired = await env.DB.prepare(
    `SELECT id FROM videos
      WHERE visibility = 'hidden' AND hold_until IS NOT NULL AND hold_until < ?`,
  )
    .bind(at)
    .all<{ id: string }>();

  const ids = (expired.results ?? []).map((r) => r.id);
  if (ids.length === 0) return 0;

  const restored = await env.DB.prepare(
    `UPDATE videos
        SET visibility = 'public', hold_until = NULL, updated_at = ?
      WHERE visibility = 'hidden'
        AND hold_until IS NOT NULL
        AND hold_until < ?
        AND status = 'ready'
        AND scan_state = 'clean'`,
  )
    .bind(at, at)
    .run();

  const count = restored.meta.changes ?? 0;
  if (count > 0) {
    await bumpFeedVersion(env);
    await logEvent(env, 'hold.released', { count });
  }

  // Close the loop on the reports too. By the time a hold expires its reports
  // are well past the 24 h window and can no longer re-trigger the quorum, but
  // leaving them unresolved makes them permanent dead entries in the operator
  // queue — a queue that stops being trustworthy stops being read.
  for (const id of ids) {
    await env.DB.prepare(
      'UPDATE reports SET resolved_at = ? WHERE video_id = ? AND resolved_at IS NULL',
    )
      .bind(at, id)
      .run();
  }
  return count;
}

export async function sweepOrphans(env: Env): Promise<number> {
  const cutoff = now() - ORPHAN_MAX_AGE_MS;
  const stale = await env.DB.prepare(
    "SELECT id FROM videos WHERE status IN ('uploaded', 'probed') AND updated_at < ? LIMIT 500",
  )
    .bind(cutoff)
    .all<{ id: string }>();
  const ids = (stale.results ?? []).map((r: { id: string }) => r.id);
  for (const id of ids) {
    try {
      await sweepVideo(env, id);
    } catch (err) {
      console.error('orphan sweep failed', id, err);
    }
  }
  if (ids.length > 0) {
    await logEvent(env, 'sweep.completed', { count: ids.length });
  }
  return ids.length;
}