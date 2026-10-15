import { AwsClient } from 'aws4fetch';
import type { Env } from './env.js';

/**
 * Delete every object under a video's prefix, paging until R2 says it is done.
 *
 * `keepSource` is the one behavioural switch, and the callers differ
 * deliberately:
 *  - quarantine (infected, scan-error, operator) passes `false` — this content
 *    must not remain retrievable by URL, and `visibility` has no effect on
 *    objects served straight from R2 through the CDN;
 *  - the orphan sweep passes `true` — an incomplete upload whose source is the
 *    agent's own bytes and worth nothing to anyone.
 *
 * The page limit is a runaway guard, not a budget: a video at the shipped
 * settings holds ~48 derived objects, so 20 pages of 1000 is three orders of
 * magnitude of headroom. `truncated` is checked rather than assumed, because a
 * silent 1000-object ceiling would leave infected segments fetchable — exactly
 * the failure this function exists to prevent.
 *
 * Lives here rather than in the pipeline so the operator route can reach it
 * without importing the container bindings.
 */
export async function purgeR2Prefix(
  env: Env,
  prefix: string,
  { keepSource = true }: { keepSource?: boolean } = {},
): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const listed = await env.MEDIA.list({ prefix: `${prefix}/`, cursor, limit: 1000 });
    const source = `${prefix}/source`;
    const keys = listed.objects.map((o) => o.key).filter((k) => (keepSource ? k !== source : true));
    if (keys.length > 0) await env.MEDIA.delete(keys);
    if (!listed.truncated || !listed.cursor) return;
    cursor = listed.cursor;
  }
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function r2Config(env: Env): R2Config {
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
  };
}

export function mediaPrefix(videoId: string): string {
  return `videos/${videoId}`;
}

export function rawKey(videoId: string): string {
  return `${mediaPrefix(videoId)}/source`;
}

export function playlistKey(videoId: string): string {
  return `${mediaPrefix(videoId)}/master.m3u8`;
}

/**
 * Presigned PUT so the agent uploads bytes straight to R2, bypassing the Worker.
 *
 * Two things are bound into the signature:
 *   - `content-type`, so the agent cannot swap it after the fact;
 *   - `if-none-match: *`, which makes the object **write-once**. Without this an
 *     agent can PUT a benign file, let the probe accept it, then PUT different
 *     bytes to the same key — and every later job re-downloads the key, so the
 *     bytes that get scanned and published are not the bytes that were checked
 *     (blocked-hash and duration/height limits are all defeated that way).
 */
export async function presignUpload(
  cfg: R2Config,
  key: string,
  opts: { contentType: string; expiresIn: number },
): Promise<string> {
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
  // aws4fetch defaults X-Amz-Expires to 86400 and only leaves it alone if the URL
  // already carries one, so the real TTL has to be set on the URL before signing.
  // Without this the advertised `expiresAt` was a lie by a factor of 24.
  const signedUrl = new URL(
    `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${key}`,
  );
  signedUrl.searchParams.set('X-Amz-Expires', String(opts.expiresIn));

  const signed = await client.sign(signedUrl.toString(), {
    method: 'PUT',
    headers: { 'content-type': opts.contentType, 'if-none-match': '*' },
    aws: { signQuery: true, allHeaders: true },
  });
  return signed.url;
}