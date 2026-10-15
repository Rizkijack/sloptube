import { Container } from '@cloudflare/containers';
import type { Env } from './lib/env.js';

/**
 * MediaExecutor — the only place ffmpeg / ffprobe / clamscan ever run.
 *
 * `probe()` / `transcode()` / `scan()` resolve a deterministic DO name per unit of
 * work and post one JSON job. The DO relays it into the container, where
 * `server.py` dispatches to `media.sh`.
 *
 * The container reads R2 credentials from the request body on every call and
 * never persists them; they are never logged here either.
 *
 * Response shapes mirror `container/server.py` + `container/media.sh` exactly.
 */

const CONTAINER_PORT = 8080;

/** Container `reason` codes that mean "try again later", not "this job is bad". */
const RETRYABLE_REASONS = new Set([
  'download_failed',
  'upload_failed',
  'sign_failed',
  'scan_failed',
  'scan_timeout',
  'container_timeout',
  'worker_unavailable',
  'worker_crashed',
]);

interface Credentials {
  account: string;
  bucket: string;
  accessKeyId: string;
  secret: string;
  region: string;
}

export interface MediaResult {
  ok: boolean;
  reason?: string;
  detail?: string;
}

export interface ProbeResult extends MediaResult {
  sha256?: string;
  bytes?: number;
  durationS?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
}

export interface TranscodeResult extends MediaResult {
  /** Segment list as the container produced and uploaded it. */
  segments?: Array<{ n: number; r2Key: string; bytes: number; durationS?: number }>;
  segCount?: number;
  initBytes?: number;
  thumbBytes?: number;
  /** Set when a retryable transport/container failure occurred, as opposed to a bad input. */
  error?: string;
}

export interface ScanResult extends MediaResult {
  verdict?: 'clean' | 'infected';
  signature?: string;
}

function credentials(env: Env): Credentials {
  return {
    account: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secret: env.R2_SECRET_ACCESS_KEY,
    region: 'auto',
  };
}

function requireNamespace(env: Env): DurableObjectNamespace {
  if (!env.MediaExecutor) throw new Error('MediaExecutor container binding is not configured');
  return env.MediaExecutor;
}

async function call<T extends MediaResult>(
  env: Env,
  doName: string,
  op: 'probe' | 'transcode' | 'scan',
  payload: Record<string, unknown>,
): Promise<T> {
  const ns = requireNamespace(env);
  const stub = ns.get(ns.idFromName(doName));
  const res = await stub.fetch(`http://container/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, ...credentials(env) }),
  });

  const parsed = (await res.json().catch(() => null)) as T | null;
  if (parsed && typeof parsed.ok === 'boolean') {
    if (!parsed.ok && RETRYABLE_REASONS.has(parsed.reason ?? '')) {
      // Infrastructure failure: throw so the queue message is retried.
      throw new Error(`media container ${op}: ${parsed.reason} ${parsed.detail ?? ''}`.trim());
    }
    return parsed;
  }
  if (!res.ok) throw new Error(`media container ${op} unreachable (HTTP ${res.status})`);
  throw new Error(`media container ${op} returned a malformed result`);
}

export function probe(env: Env, videoId: string, r2Key: string): Promise<ProbeResult> {
  return call<ProbeResult>(env, `probe:${videoId}`, 'probe', { r2Key });
}

/**
 * One job transcodes the WHOLE file in a single ffmpeg pass.
 *
 * Per-segment jobs were measured and rejected: independently encoded fragments
 * restart timestamps at zero and carry different init segments, so concatenating
 * them decodes only the first segment. See container/media.sh for the evidence.
 * The container returns the segment list; the Worker turns it into master.m3u8.
 */
export function transcode(
  env: Env,
  videoId: string,
  args: { r2Key: string; r2Prefix: string; segSeconds: number },
): Promise<TranscodeResult> {
  return call<TranscodeResult>(env, `transcode:${videoId}`, 'transcode', { ...args });
}

export function scan(env: Env, videoId: string, r2Key: string): Promise<ScanResult> {
  return call<ScanResult>(env, `scan:${videoId}`, 'scan', { r2Key });
}

/**
 * The container-backed Durable Object.
 *
 * Extending `Container` is what actually starts a container: the base class owns
 * `defaultPort`, `sleepAfter`, lifecycle and the port relay, and provides
 * `containerFetch()`. A bare class with the same field names does not start
 * anything and every job fails with `worker_unavailable`.
 *
 * The base `fetch()` already forwards to `defaultPort`, so `call()` can post
 * straight at this object — no hand-rolled relay.
 */
export class MediaExecutor extends Container<Env> {
  defaultPort = CONTAINER_PORT;
  sleepAfter = '10m';

  async onStart(): Promise<void> {
    console.log('media container started');
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const op = pathname.replace(/^\//, '');
    if (op !== 'probe' && op !== 'transcode' && op !== 'scan') {
      return new Response(JSON.stringify({ ok: false, reason: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    try {
      return await this.containerFetch(request, CONTAINER_PORT);
    } catch (err) {
      const reason = `worker_unavailable: ${String(err).replace(/[\r\n]+/g, ' ').slice(0, 200)}`;
      return new Response(JSON.stringify({ ok: false, reason }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  }
}
