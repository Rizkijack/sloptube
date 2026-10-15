import type { Env, ProfileRow, VideoRow } from './env.js';

/** A video is only ever visible when all three columns line up (contract §1). */
export const PUBLIC_PREDICATE =
  "v.status = 'ready' AND v.scan_state = 'clean' AND v.visibility = 'public'";

interface FeedRow extends VideoRow {
  p_display_name: string | null;
  p_avatar_key: string | null;
}

export interface FeedItem {
  video: VideoRow;
  profile: ProfileRow | null;
}

const FEED_VERSION_KEY = 'feed:version';

export async function feedVersion(env: Env): Promise<number> {
  const raw = await env.CACHE.get(FEED_VERSION_KEY);
  const parsed = raw === null ? 1 : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export async function bumpFeedVersion(env: Env): Promise<void> {
  const next = (await feedVersion(env)) + 1;
  await env.CACHE.put(FEED_VERSION_KEY, String(next));
}

function toProfile(row: FeedRow): ProfileRow | null {
  if (row.p_display_name === null) return null;
  return {
    agent_id: row.agent_id,
    display_name: row.p_display_name,
    description: '',
    avatar_key: row.p_avatar_key,
    links: '{}',
    visibility: 'public',
    created_at: row.created_at,
  };
}

function stripProfile(row: FeedRow): VideoRow {
  const { p_display_name: _n, p_avatar_key: _a, ...video } = row;
  return video;
}

export async function getVideo(env: Env, videoId: string): Promise<VideoRow | null> {
  return env.DB.prepare('SELECT * FROM videos WHERE id = ?').bind(videoId).first<VideoRow>();
}

export async function getPublicVideo(env: Env, videoId: string): Promise<FeedItem | null> {
  const row = await env.DB.prepare(
    `SELECT v.*, p.display_name AS p_display_name, p.avatar_key AS p_avatar_key
     FROM videos v LEFT JOIN profiles p ON p.agent_id = v.agent_id
     WHERE v.id = ? AND ${PUBLIC_PREDICATE}`,
  )
    .bind(videoId)
    .first<FeedRow>();
  return row ? { video: stripProfile(row), profile: toProfile(row) } : null;
}

export async function listFeed(
  env: Env,
  limit: number,
  opts: { query?: string; tag?: string } = {},
): Promise<FeedItem[]> {
  const where: string[] = [PUBLIC_PREDICATE];
  const binds: string[] = [];
  const q = opts.query?.trim();
  if (q) {
    where.push('(v.title LIKE ? OR v.description LIKE ? OR v.tags LIKE ?)');
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (opts.tag) {
    where.push('v.tags LIKE ?');
    binds.push(`%"${opts.tag}"%`);
  }
  const res = await env.DB.prepare(
    `SELECT v.*, p.display_name AS p_display_name, p.avatar_key AS p_avatar_key
     FROM videos v LEFT JOIN profiles p ON p.agent_id = v.agent_id
     WHERE ${where.join(' AND ')}
     ORDER BY v.created_at DESC
     LIMIT ?`,
  )
    .bind(...binds, String(limit))
    .all<FeedRow>();
  return (res.results ?? []).map((row) => ({ video: stripProfile(row), profile: toProfile(row) }));
}

export async function listAgentFeed(env: Env, agentId: string, limit: number): Promise<FeedItem[]> {
  const res = await env.DB.prepare(
    `SELECT v.*, p.display_name AS p_display_name, p.avatar_key AS p_avatar_key
     FROM videos v LEFT JOIN profiles p ON p.agent_id = v.agent_id
     WHERE v.agent_id = ? AND ${PUBLIC_PREDICATE}
     ORDER BY v.created_at DESC
     LIMIT ?`,
  )
    .bind(agentId, String(limit))
    .all<FeedRow>();
  return (res.results ?? []).map((row) => ({ video: stripProfile(row), profile: toProfile(row) }));
}

export async function countSegments(env: Env, videoId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM video_segments WHERE video_id = ?',
  )
    .bind(videoId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function isBlockedHash(env: Env, sha256: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT sha256 FROM blocked_hashes WHERE sha256 = ?')
    .bind(sha256)
    .first();
  return row !== null;
}

export async function getProfile(env: Env, agentId: string): Promise<ProfileRow | null> {
  return env.DB.prepare('SELECT * FROM profiles WHERE agent_id = ?').bind(agentId).first<ProfileRow>();
}

export async function countAgentVideos(env: Env, agentId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM videos v WHERE v.agent_id = ? AND ${PUBLIC_PREDICATE}`)
    .bind(agentId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * Charge uploaded bytes against the agent quota, enforcing the ceiling in the
 * same statement.
 *
 * The quota check has to live in the WHERE clause, not in a prior read: a
 * read-then-write lets two concurrent publishes both pass the check and
 * together exceed the quota. Returns false when the charge was refused, which
 * the caller must treat as a rejection.
 */
export async function chargeUsage(env: Env, agentId: string, bytes: number): Promise<boolean> {
  const res = await env.DB.prepare(
    'UPDATE agents SET used_bytes = used_bytes + ? WHERE id = ? AND used_bytes + ? <= quota_bytes',
  )
    .bind(bytes, agentId, bytes)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Release previously charged bytes.
 *
 * The single refund implementation for the whole worker — pipeline failures and
 * operator quarantine both come through here, because a refund duplicated across
 * modules is a refund that can drift. Clamped at zero so a double release can
 * never go negative and hand an agent storage nobody charged.
 */
export async function releaseUsage(env: Env, agentId: string, bytes: number): Promise<boolean> {
  if (!Number.isFinite(bytes) || bytes <= 0) return true;
  const res = await env.DB.prepare(
    'UPDATE agents SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?',
  )
    .bind(Math.floor(bytes), agentId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}