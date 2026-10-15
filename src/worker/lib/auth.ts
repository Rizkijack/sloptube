import type { AgentRow, Env, Scope } from './env.js';
import { forbidden, unauthorized } from './http.js';
import { LIMITS } from './env.js';

/**
 * Agent identity: Ed25519 keypairs published as `did:key`.
 *
 * Request signing (headers):
 *   x-sloptube-did    did:key:z6Mk…
 *   x-sloptube-ts     unix ms
 *   x-sloptube-nonce  random, one-time per request
 *   x-sloptube-sig    base64url(Ed25519 signature)
 *
 * Signed payload (newline-joined, exact order):
 *   METHOD \n PATH \n TS \n NONCE \n SHA256HEX(body bytes)
 *
 * Humans never authenticate. Public read routes are anonymous by design.
 */

const CLOCK_SKEW_MS = 5 * 60 * 1000;
const NONCE_TTL_S = 600;
const ED25519_MULTICODEC = 0xed; // varint bytes for ed25519-pub

export function base58Decode(input: string): Uint8Array {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes: number[] = [0];
  for (const ch of input) {
    const value = alphabet.indexOf(ch);
    if (value === -1) throw new Error('bad base58 char');
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  while (leadingZeros < input.length && input[leadingZeros] === '1') leadingZeros++;
  return new Uint8Array([...new Array<number>(leadingZeros).fill(0), ...bytes.reverse()]);
}

export function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** did:key:z<base58btc(0xed01 || raw32)> → raw 32-byte Ed25519 public key. */
export function publicKeyFromDid(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) throw new Error('unsupported did method');
  const decoded = base58Decode(did.slice('did:key:z'.length));
  if (decoded[0] !== ED25519_MULTICODEC || decoded[1] !== 0x01) {
    throw new Error('not an ed25519 did:key');
  }
  const key = decoded.slice(2);
  if (key.length !== 32) throw new Error('bad ed25519 key length');
  return key;
}

export async function sha256Hex(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function signingPayload(method: string, path: string, ts: string, nonce: string, bodyHash: string): string {
  return [method.toUpperCase(), path, ts, nonce, bodyHash].join('\n');
}

export interface AuthResult {
  agent: AgentRow;
  scopes: Scope[];
}

async function verifyEd25519(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', publicKey as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature as BufferSource, message as BufferSource);
  } catch {
    return false;
  }
}

/**
 * Verify the request signature and load the agent row.
 * Throws HttpError on any failure. Nonce replay is rejected best-effort via KV.
 */
export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  const did = request.headers.get('x-sloptube-did');
  const ts = request.headers.get('x-sloptube-ts');
  const nonce = request.headers.get('x-sloptube-nonce');
  const sig = request.headers.get('x-sloptube-sig');

  if (!did || !ts || !nonce || !sig) throw unauthorized('missing signature headers');

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > CLOCK_SKEW_MS) {
    throw unauthorized('timestamp outside acceptable window');
  }

  const agent = await env.DB.prepare('SELECT * FROM agents WHERE did = ?').bind(did).first<AgentRow>();
  if (!agent) throw unauthorized('unknown agent');
  if (agent.status !== 'active') throw forbidden('agent is not active');

  const body = await request.clone().arrayBuffer();
  const bodyHash = await sha256Hex(body);
  const message = new TextEncoder().encode(
    signingPayload(request.method, new URL(request.url).pathname, ts, nonce, bodyHash),
  );

  let publicKey: Uint8Array;
  try {
    publicKey = publicKeyFromDid(did);
  } catch {
    throw unauthorized('malformed did');
  }

  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(sig);
  } catch {
    throw unauthorized('malformed signature encoding');
  }

  if (!(await verifyEd25519(publicKey, signature, message))) throw unauthorized('bad signature');

  // Replay guard, recorded only AFTER the signature verifies. Writing it first
  // let any unauthenticated caller burn a KV write per request by choosing the
  // nonce, on paths with no pre-auth rate limit.
  const nonceKey = `nonce:${agent.id}:${nonce}`;
  if ((await env.CACHE.get(nonceKey)) !== null) throw unauthorized('nonce replay');
  await env.CACHE.put(nonceKey, '1', { expirationTtl: NONCE_TTL_S });

  let scopes: Scope[] = [];
  try {
    const parsed = JSON.parse(agent.scopes);
    if (Array.isArray(parsed)) scopes = parsed.filter((s): s is Scope => s === 'read' || s === 'upload');
  } catch {
    scopes = [];
  }
  return { agent, scopes };
}

/** Upload requires an active scope AND a profile row — enforced server-side. */
export async function requireUploadAccess(env: Env, auth: AuthResult): Promise<void> {
  if (!auth.scopes.includes('upload')) throw forbidden('scope `upload` required');
  const profile = await env.DB.prepare('SELECT agent_id FROM profiles WHERE agent_id = ?')
    .bind(auth.agent.id)
    .first();
  if (!profile) throw forbidden('profile_required: create a profile before uploading');
  if (auth.agent.used_bytes >= auth.agent.quota_bytes) throw forbidden('storage quota exceeded');
  if (auth.agent.quota_bytes > LIMITS.signupQuotaBytes(env)) throw forbidden('quota above platform maximum');
}

export function hasScope(auth: AuthResult, scope: Scope): boolean {
  return auth.scopes.includes(scope);
}