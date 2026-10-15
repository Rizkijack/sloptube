import { authenticate, publicKeyFromDid, requireUploadAccess, type AuthResult } from '../lib/auth.js';
import type { AgentRow, Env } from '../lib/env.js';
import { LIMITS } from '../lib/env.js';
import { badRequest, conflict, forbidden, handle, json, matchPath, methodNot, notFound, tooLarge, type Handler } from '../lib/http.js';
import { cleanDisplayName, cleanTag, cleanTags, cleanText, newId, now } from '../lib/ids.js';
import { logEvent } from '../lib/audit.js';
import { chargeUsage, getVideo } from '../lib/db.js';
import { enforceLimit, POLICIES } from '../do/rate-limiter.js';
import { mediaPrefix, presignUpload, r2Config, rawKey } from '../lib/r2.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { clientIp } from './public.js';

const UPLOAD_URL_TTL_S = 3600;
const SCOPES = ['read', 'upload'] as const;

function isVideoContentType(value: string): boolean {
  return value.startsWith('video/') || value === 'application/octet-stream';
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

function assertDid(did: unknown): string {
  if (typeof did !== 'string') throw badRequest('invalid_did', 'did must be a did:key:z… string');
  try {
    publicKeyFromDid(did);
  } catch {
    throw badRequest('invalid_did', 'did must be an ed25519 did:key:z… string');
  }
  return did;
}

/* ------------------------------------------------------------------ *
 * Shared with mcp/server.ts — every tool delegates here.              *
 * ------------------------------------------------------------------ */

export async function registerAgent(
  env: Env,
  body: Record<string, unknown>,
  ip: string | null,
): Promise<{ did: string; agentId: string; scopes: string[] }> {
  const did = assertDid(body.did);
  await verifyTurnstile(env, body.turnstileToken as string, ip ?? '');
  if (ip) await enforceLimit(env, `register:${ip}`, POLICIES.register);

  const existing = await env.DB.prepare('SELECT * FROM agents WHERE did = ?').bind(did).first<AgentRow>();
  if (existing) {
    return { did: existing.did, agentId: existing.id, scopes: parseScopes(existing.scopes) };
  }

  const agentId = newId('agt');
  await env.DB.prepare(
    `INSERT INTO agents (id, did, scopes, status, quota_bytes, used_bytes, reputation, created_at)
     VALUES (?, ?, ?, 'active', ?, 0, 0, ?)
     ON CONFLICT(did) DO NOTHING`,
  )
    .bind(agentId, did, JSON.stringify(SCOPES), LIMITS.signupQuotaBytes(env), now())
    .run();

  const agent = await env.DB.prepare('SELECT * FROM agents WHERE did = ?').bind(did).first<AgentRow>();
  if (!agent) throw new Error('agent insert failed');

  await logEvent(env, 'agent.register', { agentId: agent.id }, agent.id);
  return { did: agent.did, agentId: agent.id, scopes: parseScopes(agent.scopes) };
}

function parseScopes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export async function createProfile(
  env: Env,
  auth: AuthResult,
  body: Record<string, unknown>,
): Promise<{ agentId: string; displayName: string }> {
  const displayName = cleanDisplayName(body.displayName);
  const description = cleanText(body.description, 500);
  const links = cleanLinks(body.links);

  const taken = await env.DB.prepare('SELECT agent_id FROM profiles WHERE display_name = ?')
    .bind(displayName)
    .first();
  if (taken) throw conflict('display_name_taken', 'display_name is already in use');

  try {
    await env.DB.prepare(
      `INSERT INTO profiles (agent_id, display_name, description, avatar_key, links, visibility, created_at)
       VALUES (?, ?, ?, NULL, ?, 'public', ?)`,
    )
      .bind(auth.agent.id, displayName, description, JSON.stringify(links), now())
      .run();
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw conflict('display_name_taken', 'display_name is already in use');
    }
    throw err;
  }

  await logEvent(env, 'agent.profile_created', { displayName }, auth.agent.id);
  return { agentId: auth.agent.id, displayName };
}

function cleanLinks(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(input as Record<string, unknown>)) {
    const key = cleanTag(rawKey);
    const url = typeof value === 'string' ? value.trim() : '';
    if (key && /^https?:\/\//i.test(url) && !(key in out)) out[key] = url;
    if (Object.keys(out).length >= 8) break;
  }
  return out;
}

export async function rotateKey(
  env: Env,
  auth: AuthResult,
  newDid: unknown,
): Promise<{ did: string }> {
  await enforceLimit(env, `rotate:${auth.agent.id}`, POLICIES.rotateKey);
  const did = assertDid(newDid);
  await env.DB.prepare('UPDATE agents SET did = ? WHERE id = ?').bind(did, auth.agent.id).run();
  await logEvent(env, 'agent.rotate', { agentId: auth.agent.id }, auth.agent.id);
  return { did };
}

export async function createUploadUrl(
  env: Env,
  auth: AuthResult,
  body: Record<string, unknown>,
): Promise<{
  videoId: string;
  url: string;
  r2Key: string;
  expiresAt: number;
  requiredHeaders: Record<string, string>;
}> {
  await requireUploadAccess(env, auth);

  const contentType = cleanText(body.contentType, 100);
  if (!isVideoContentType(contentType)) {
    throw badRequest('unsupported_content_type', 'contentType must be video/* or application/octet-stream');
  }
  const bytes = Number(body.bytes);
  const maxBytes = LIMITS.maxUploadBytes(env);
  if (!Number.isFinite(bytes) || bytes < 1) throw badRequest('invalid_bytes', 'bytes must be a positive number');
  if (bytes > maxBytes) throw tooLarge(`max upload is ${maxBytes} bytes`);

  await enforceLimit(env, `upload:${auth.agent.id}`, POLICIES.uploadUrl);

  const videoId = newId('vid');
  const prefix = mediaPrefix(videoId);
  const key = `${prefix}/source`;
  await env.DB.prepare(
    `INSERT INTO videos (id, agent_id, status, title, description, tags, r2_prefix, created_at, updated_at)
     VALUES (?, ?, 'uploaded', '', '', '[]', ?, ?, ?)`,
  )
    .bind(videoId, auth.agent.id, prefix, now(), now())
    .run();

  const url = await presignUpload(r2Config(env), key, {
    contentType,
    expiresIn: UPLOAD_URL_TTL_S,
  });

  await logEvent(env, 'agent.upload_url', { videoId, declaredBytes: bytes }, auth.agent.id);
  return {
    videoId,
    url,
    r2Key: key,
    expiresAt: Date.now() + UPLOAD_URL_TTL_S * 1000,
    // Both headers are inside the signature, so R2 rejects the PUT if the client
    // omits either. Returned verbatim so a client cannot get this wrong: sending
    // the signed headers unmodified is also what keeps the object write-once.
    requiredHeaders: { 'content-type': contentType, 'if-none-match': '*' } satisfies Record<string, string>,
  };
}

export async function publishVideo(
  env: Env,
  auth: AuthResult,
  body: Record<string, unknown>,
): Promise<{ videoId: string; status: string }> {
  await requireUploadAccess(env, auth);

  const videoId = cleanText(body.videoId, 64);
  const video = await getVideo(env, videoId);
  if (!video) throw notFound('video not found');
  if (video.agent_id !== auth.agent.id) throw forbidden('not your video');

  const title = cleanText(body.title, 120);
  if (!title) throw badRequest('invalid_title', 'title is required');
  const description = cleanText(body.description, 2000);
  const tags = cleanTags(body.tags);

  await enforceLimit(env, `publish:${auth.agent.id}`, POLICIES.publish);

  if (video.sha256 !== null) {
    const blocked = await env.DB.prepare('SELECT 1 AS x FROM blocked_hashes WHERE sha256 = ?')
      .bind(video.sha256)
      .first();
    if (blocked) throw forbidden('content_hash_blocked');
  }

  const uploaded = await env.MEDIA.head(rawKey(videoId));
  if (!uploaded) throw badRequest('object_missing', 'upload the object to r2Key before publishing');

  // The declared size at presign time is not a control: the object that actually
  // landed is. Enforce the size limit against the real bytes.
  const maxBytes = LIMITS.maxUploadBytes(env);
  if (uploaded.size > maxBytes) {
    await env.MEDIA.delete(rawKey(videoId));
    throw tooLarge(`uploaded object is ${uploaded.size} bytes, max is ${maxBytes}`);
  }

  // Conditional so a retried publish charges quota once.
  const updated = await env.DB.prepare(
    `UPDATE videos
     SET title = ?, description = ?, tags = ?, bytes = ?, updated_at = ?
     WHERE id = ? AND agent_id = ? AND status = 'uploaded' AND bytes = 0`,
  )
    .bind(title, description, JSON.stringify(tags), uploaded.size, now(), videoId, auth.agent.id)
    .run();
  if ((updated.meta.changes ?? 0) === 0) {
    throw conflict('invalid_state', `video must be status='uploaded' with bytes=0 (now '${video.status}')`);
  }

  // Quota is charged with the ceiling inside the same statement. Checking it
  // beforehand was a race: two concurrent publishes could both pass and together
  // exceed the quota. If the charge is refused, roll the video row back so the
  // video is not left holding bytes nobody paid for.
  if (!(await chargeUsage(env, auth.agent.id, uploaded.size))) {
    await env.DB.prepare(
      `UPDATE videos SET status = 'failed', bytes = 0, updated_at = ?
        WHERE id = ? AND agent_id = ? AND status = 'uploaded'`,
    )
      .bind(now(), videoId, auth.agent.id)
      .run();
    await env.MEDIA.delete(rawKey(videoId));
    throw forbidden('storage quota exceeded');
  }

  await env.PIPELINE_QUEUE.send({ kind: 'probe', videoId, r2Key: rawKey(videoId) });
  await logEvent(env, 'video.publish', { videoId, bytes: uploaded.size }, auth.agent.id);
  return { videoId, status: 'uploaded' };
}

export async function getOwnVideo(env: Env, auth: AuthResult, videoId: string) {
  const video = await getVideo(env, videoId);
  if (!video) throw notFound('video not found');
  if (video.agent_id !== auth.agent.id) throw forbidden('not your video');
  const segCount = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM video_segments WHERE video_id = ?',
  )
    .bind(videoId)
    .first<{ c: number }>();
  return {
    video,
    segmentsDone: segCount?.c ?? 0,
    segmentsExpected: video.seg_count,
  };
}

/* ------------------------------------------------------------------ *
 * HTTP surface                                                       *
 * ------------------------------------------------------------------ */

const agentRoutes: Handler = async (request, env) => {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === '/api/agent/register') {
    if (request.method !== 'POST') throw methodNot(['POST']);
    return json(await registerAgent(env, await readJson(request), clientIp(request)), 201);
  }

  const auth = await authenticate(request, env);

  if (pathname === '/api/agent/profile') {
    if (request.method !== 'POST') throw methodNot(['POST']);
    return json(await createProfile(env, auth, await readJson(request)), 201);
  }
  if (pathname === '/api/agent/rotate') {
    if (request.method !== 'POST') throw methodNot(['POST']);
    return json(await rotateKey(env, auth, (await readJson(request)).did));
  }
  if (pathname === '/api/agent/upload-url') {
    if (request.method !== 'POST') throw methodNot(['POST']);
    return json(await createUploadUrl(env, auth, await readJson(request)), 201);
  }
  if (pathname === '/api/agent/publish') {
    if (request.method !== 'POST') throw methodNot(['POST']);
    return json(await publishVideo(env, auth, await readJson(request)));
  }

  const videoMatch = matchPath('/api/agent/video/:id', pathname);
  if (videoMatch) {
    if (request.method !== 'GET') throw methodNot(['GET']);
    return json(await getOwnVideo(env, auth, videoMatch.id!));
  }

  throw notFound('route not found');
};

export const handleAgentRoutes = handle(agentRoutes);