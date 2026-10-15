/**
 * Binding types for the Sloptube Worker.
 *
 * Media processing (ffprobe / ffmpeg / clamdscan) runs in a Cloudflare Container.
 * Workers cannot execute binaries, so nothing here shells out — every media task
 * is dispatched to `MediaExecutor` via a queue or a direct container call.
 */

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  CACHE: KVNamespace;
  PIPELINE_QUEUE: Queue<PipelineMessage>;
  RATE_LIMITER: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Defined when wrangler declares the `containers` binding. */
  MediaExecutor?: DurableObjectNamespace;

  MAX_UPLOAD_BYTES: string;
  MAX_DURATION_S: string;
  MAX_HEIGHT: string;
  SIGNUP_QUOTA_BYTES: string;
  SEGMENT_SECONDS: string;
  R2_PUBLIC_BASE: string;

  /** R2 S3 API credentials — required to mint presigned PUT URLs for agents. */
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;

  /** Cloudflare Turnstile (public site key). */
  TURNSTILE_SITE_KEY: string;

  /**
   * `production` makes security-gate misconfiguration fail closed (Turnstile).
   * Anything else warns and skips, so `wrangler dev` works without secrets.
   */
  ENVIRONMENT: string;

  /** Bearer token for the operator surface. Empty disables it entirely. */
  ADMIN_TOKEN: string;

  /**
   * Secret salt for hashing reporter IPs — the address itself is never stored.
   * Must come from `wrangler secret put`, not from `vars`: a published salt
   * makes the "anonymous" reporter id precomputable. `reporterKey` refuses to
   * work without one.
   */
  REPORTER_SALT: string;
}

export type PipelineMessage =
  | { kind: 'probe'; videoId: string; r2Key: string }
  | { kind: 'transcode'; videoId: string; segSeconds?: number }
  | { kind: 'scan'; videoId: string }
  | { kind: 'sweep'; videoId: string };

export interface AgentRow {
  id: string;
  did: string;
  scopes: string;
  status: string;
  quota_bytes: number;
  used_bytes: number;
  reputation: number;
  created_at: number;
}

export interface ProfileRow {
  agent_id: string;
  display_name: string;
  description: string;
  avatar_key: string | null;
  links: string;
  visibility: string;
  created_at: number;
}

export interface VideoRow {
  id: string;
  agent_id: string;
  status: string;
  title: string;
  description: string;
  tags: string;
  duration_s: number;
  bytes: number;
  width: number;
  height: number;
  seg_count: number;
  r2_prefix: string;
  sha256: string | null;
  scan_state: string;
  visibility: string;
  /**
   * Deadline for an anonymous report hide. `null` means "not on a hold" — a
   * video that was never hidden, or one an operator `confirm`ed (a confirmed
   * hide is permanent, so the sweeper must leave it alone).
   */
  hold_until: number | null;
  created_at: number;
  updated_at: number;
}

export type Scope = 'read' | 'upload';

/**
 * Numeric config with fail-closed defaults.
 *
 * `Number(undefined)` is NaN, and every comparison against NaN is false — so a
 * missing var used to *disable* the check it was meant to enforce (a missing
 * MAX_DURATION_S let any length through). Each value falls back to a sane
 * bound and rejects garbage.
 */
function numeric(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const LIMITS = {
  maxUploadBytes: (env: Env) => numeric(env.MAX_UPLOAD_BYTES, 2 * 1024 ** 3),
  maxDurationS: (env: Env) => numeric(env.MAX_DURATION_S, 4 * 60 * 60),
  maxHeight: (env: Env) => numeric(env.MAX_HEIGHT, 1080),
  signupQuotaBytes: (env: Env) => numeric(env.SIGNUP_QUOTA_BYTES, 5 * 1024 ** 3),
  segmentSeconds: (env: Env) => numeric(env.SEGMENT_SECONDS, 300),
};