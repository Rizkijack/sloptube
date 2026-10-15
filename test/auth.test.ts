import { describe, expect, it } from 'vitest';
import {
  authenticate,
  base58Decode,
  base64UrlDecode,
  base64UrlEncode,
  hasScope,
  publicKeyFromDid,
  requireUploadAccess,
  sha256Hex,
  signingPayload,
} from '../src/worker/lib/auth.js';
import type { AgentRow, Env } from '../src/worker/lib/env.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Inverse of the shipped decoder. Writing it here (rather than importing it)
 * keeps the round-trip honest: a bug shared by both sides would still show up,
 * but a bug in `base58Decode` alone would be caught.
 */
function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]!];
  return out;
}

async function generateIdentity() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
  const raw = new Uint8Array(exported);
  const multicodec = new Uint8Array([0xed, 0x01, ...raw]);
  return { pair, raw, did: `did:key:z${base58Encode(multicodec)}` };
}

const AGENT: AgentRow = {
  id: 'agt_test',
  did: '',
  scopes: '["read","upload"]',
  status: 'active',
  quota_bytes: 5_000_000_000,
  used_bytes: 0,
  reputation: 0,
  created_at: 1_700_000_000_000,
};

/** D1 + KV + everything else `authenticate` touches, backed by plain Maps. */
function makeEnv(agent: AgentRow | null, profileExists = true) {
  const kv = new Map<string, string>();
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM agents')) {
                  return args[0] === agent?.did ? agent : null;
                }
                if (sql.includes('FROM profiles')) {
                  return profileExists ? { agent_id: args[0] } : null;
                }
                return null;
              },
            };
          },
        };
      },
    },
    CACHE: {
      async get(key: string) {
        return kv.has(key) ? kv.get(key)! : null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
    },
    MAX_UPLOAD_BYTES: '2147483648',
    MAX_DURATION_S: '14400',
    MAX_HEIGHT: '1080',
    SIGNUP_QUOTA_BYTES: '5368709120',
    SEGMENT_SECONDS: '300',
    R2_PUBLIC_BASE: '',
  } as unknown as Env;
  return { env, kv };
}

/** Build a genuinely signed request the way an agent client would. */
async function signedRequest(opts: {
  pair: CryptoKeyPair;
  did: string;
  method?: string;
  path?: string;
  body?: string;
  ts?: string;
  nonce?: string;
  tamper?: (headers: Headers) => void;
}) {
  const method = opts.method ?? 'POST';
  const path = opts.path ?? '/api/agent/publish';
  const body = opts.body ?? '{}';
  const ts = opts.ts ?? String(Date.now());
  const nonce = opts.nonce ?? `n-${Math.random().toString(36).slice(2)}`;
  const bodyHash = await sha256Hex(new TextEncoder().encode(body));
  const message = new TextEncoder().encode(signingPayload(method, path, ts, nonce, bodyHash));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, opts.pair.privateKey, message);

  const headers = new Headers({
    'x-sloptube-did': opts.did,
    'x-sloptube-ts': ts,
    'x-sloptube-nonce': nonce,
    'x-sloptube-sig': base64UrlEncode(new Uint8Array(sig)),
  });
  opts.tamper?.(headers);

  // A GET Request cannot carry a body at all, so sign the empty-body hash and
  // omit the body rather than sending one.
  if (method === 'GET') {
    return new Request(`https://sloptube.test${path}`, { method, headers });
  }
  return new Request(`https://sloptube.test${path}`, { method, headers, body });
}

describe('base58Decode', () => {
  it('decodes single-digit values', () => {
    expect([...base58Decode('1')]).toEqual([0, 0]);
    expect([...base58Decode('2')]).toEqual([1]);
    expect([...base58Decode('z')]).toEqual([57]);
  });

  it('decodes a multi-digit value', () => {
    // Alphabet is 0-indexed: '2' is value 1, '1' is value 0, so '211' is
    // 1*58² + 0*58 + 0 = 3364.
    const value = B58.indexOf('2') * 58 * 58 + B58.indexOf('1') * 58 + B58.indexOf('1');
    expect(value).toBe(3364);
    expect([...base58Decode('211')]).toEqual([value >> 8, value & 0xff]);
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => base58Decode('abc0')).toThrow('bad base58 char');
    expect(() => base58Decode('O')).toThrow('bad base58 char');
    expect(() => base58Decode('l')).toThrow('bad base58 char');
  });

  it('is the inverse of a standard base58 encoder', () => {
    for (let i = 0; i < 64; i++) {
      const raw = new Uint8Array(32);
      crypto.getRandomValues(raw);
      const full = new Uint8Array([0xed, 0x01, ...raw]);
      expect([...base58Decode(base58Encode(full))]).toEqual([...full]);
    }
  });

  // Documented quirk, harmless here: the decoder seeds its accumulator with a
  // zero byte, so leading '1' characters produce one extra leading zero. A
  // did:key can never hit this because the 0xed01 prefix is always non-zero.
  it('adds one leading zero byte for leading "1" characters', () => {
    expect(base58Decode('11')).toHaveLength(3);
  });
});

describe('publicKeyFromDid', () => {
  it('recovers the raw 32-byte public key', async () => {
    const { did, raw } = await generateIdentity();
    expect(publicKeyFromDid(did)).toEqual(raw);
    expect(publicKeyFromDid(did)).toHaveLength(32);
  });

  it('rejects an unsupported did method', () => {
    expect(() => publicKeyFromDid('did:web:example.com')).toThrow('unsupported did method');
    expect(() => publicKeyFromDid('z6Mkabc')).toThrow('unsupported did method');
  });

  it('rejects a non-ed25519 multicodec prefix', () => {
    // 0xec 0x01 = secp256k1-pub, correctly refused.
    const wrong = `did:key:z${base58Encode(new Uint8Array([0xec, 0x01, ...new Uint8Array(32)]))}`;
    expect(() => publicKeyFromDid(wrong)).toThrow('not an ed25519 did:key');
  });

  it('rejects a wrong-length key', () => {
    const short = `did:key:z${base58Encode(new Uint8Array([0xed, 0x01, ...new Uint8Array(16)]))}`;
    expect(() => publicKeyFromDid(short)).toThrow('bad ed25519 key length');
  });
});

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    for (let i = 0; i < 32; i++) {
      const raw = new Uint8Array(i);
      crypto.getRandomValues(raw);
      expect([...base64UrlDecode(base64UrlEncode(raw))]).toEqual([...raw]);
    }
  });

  it('emits only url-safe characters and no padding', () => {
    const raw = new Uint8Array([0xfb, 0xff, 0xbe, 0x00, 0x3e, 0x3f]);
    const encoded = base64UrlEncode(raw);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain('=');
  });

  it('translates + and / in standard base64', () => {
    // 0xfb 0xff 0xbf encodes to "+/+/" in standard base64.
    const std = '+/+/';
    expect([...base64UrlDecode(std.replace(/\+/g, '-').replace(/\//g, '_'))]).toEqual([
      0xfb, 0xff, 0xbf,
    ]);
  });

  it('tolerates padding on decode', () => {
    expect([...base64UrlDecode('YQ==')]).toEqual([0x61]);
    expect([...base64UrlDecode('YWI=')]).toEqual([0x61, 0x62]);
  });
});

describe('sha256Hex', () => {
  it('matches the published digest of the empty string', async () => {
    await expect(sha256Hex(new Uint8Array())).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the published digest of "abc"', async () => {
    await expect(sha256Hex(new TextEncoder().encode('abc'))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('signingPayload', () => {
  it('is newline-joined in the exact contract order', () => {
    expect(signingPayload('post', '/api/agent/publish', '1700000000000', 'abc', 'deadbeef')).toBe(
      'POST\n/api/agent/publish\n1700000000000\nabc\ndeadbeef',
    );
  });

  it('uppercases the method and preserves the path verbatim', () => {
    expect(signingPayload('get', '/api/video/a%2Fb?x=1', '1', 'n', 'h')).toBe(
      'GET\n/api/video/a%2Fb?x=1\n1\nn\nh',
    );
  });

  it('has exactly five lines and no trailing newline', () => {
    const payload = signingPayload('POST', '/p', '1', 'n', 'h');
    expect(payload.split('\n')).toHaveLength(5);
    expect(payload.endsWith('\n')).toBe(false);
  });
});

describe('authenticate — real Ed25519 round trip', () => {
  it('accepts a signature produced by the matching private key', async () => {
    const { pair, did } = await generateIdentity();
    const { env } = makeEnv({ ...AGENT, did });

    const request = await signedRequest({
      pair,
      did,
      path: '/api/agent/publish',
      body: '{"videoId":"vid_1"}',
    });

    const auth = await authenticate(request, env);
    expect(auth.agent.did).toBe(did);
    expect(auth.scopes).toEqual(['read', 'upload']);
    expect(hasScope(auth, 'upload')).toBe(true);
  });

  it('accepts a GET with an empty body', async () => {
    const { pair, did } = await generateIdentity();
    const { env } = makeEnv({ ...AGENT, did });

    const request = await signedRequest({
      pair,
      did,
      method: 'GET',
      path: '/api/agent/video/vid_1',
      body: '',
    });

    await expect(authenticate(request, env)).resolves.toMatchObject({
      agent: { id: 'agt_test' },
    });
  });

  it('rejects a signature made by a different key', async () => {
    const owner = await generateIdentity();
    const attacker = await generateIdentity();
    const { env } = makeEnv({ ...AGENT, did: owner.did });

    const request = await signedRequest({ pair: attacker.pair, did: owner.did });

    await expect(authenticate(request, env)).rejects.toMatchObject({
      status: 401,
      message: 'bad signature',
    });
  });

  it('rejects a signature over a different body', async () => {
    const { pair, did } = await generateIdentity();
    const { env } = makeEnv({ ...AGENT, did });

    const request = await signedRequest({ pair, did, body: '{"title":"original"}' });
    // Swap the body after signing — the body hash is part of the payload.
    const tampered = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: '{"title":"tampered"}',
    });

    await expect(authenticate(tampered, env)).rejects.toMatchObject({
      status: 401,
      message: 'bad signature',
    });
  });

  it('rejects a replayed nonce', async () => {
    const { pair, did } = await generateIdentity();
    const { env } = makeEnv({ ...AGENT, did });
    const nonce = 'fixed-nonce';

    await authenticate(await signedRequest({ pair, did, nonce }), env);
    const replay = await signedRequest({ pair, did, nonce });

    await expect(authenticate(replay, env)).rejects.toMatchObject({
      status: 401,
      message: 'nonce replay',
    });
  });

  it('rejects a timestamp outside the clock-skew window', async () => {
    const { pair, did } = await generateIdentity();
    const { env } = makeEnv({ ...AGENT, did });
    const stale = String(Date.now() - 10 * 60 * 1000);

    await expect(authenticate(await signedRequest({ pair, did, ts: stale }), env)).rejects
      .toMatchObject({ status: 401, message: 'timestamp outside acceptable window' });
  });

  it('rejects a non-numeric timestamp', async () => {
    const { pair, did } = await generateIdentity();
    const { env } = makeEnv({ ...AGENT, did });

    await expect(authenticate(await signedRequest({ pair, did, ts: 'soon' }), env)).rejects
      .toMatchObject({ status: 401 });
  });

  it('rejects missing signature headers', async () => {
    const { env } = makeEnv(AGENT);
    const request = new Request('https://sloptube.test/api/agent/publish', { method: 'POST' });

    await expect(authenticate(request, env)).rejects.toMatchObject({
      status: 401,
      message: 'missing signature headers',
    });
  });

  it('rejects a malformed did', async () => {
    const { pair } = await generateIdentity();
    const { env } = makeEnv({ ...AGENT, did: 'did:key:zNOTBASE58!' });

    await expect(authenticate(await signedRequest({ pair, did: 'did:key:zNOTBASE58!' }), env))
      .rejects.toMatchObject({ status: 401 });
  });

  it('rejects an unknown agent', async () => {
    const { pair, did } = await generateIdentity();
    const { env } = makeEnv(null);

    await expect(authenticate(await signedRequest({ pair, did }), env)).rejects.toMatchObject({
      status: 401,
      message: 'unknown agent',
    });
  });

  it('rejects a non-active agent with 403, not 401', async () => {
    const { pair, did } = await generateIdentity();
    const { env } = makeEnv({ ...AGENT, did, status: 'suspended' });

    await expect(authenticate(await signedRequest({ pair, did }), env)).rejects.toMatchObject({
      status: 403,
      message: 'agent is not active',
    });
  });

  it('drops unknown scopes from the parsed scope list', async () => {
    const { pair, did } = await generateIdentity();
    const { env } = makeEnv({ ...AGENT, did, scopes: '["read","admin","upload","root"]' });

    const auth = await authenticate(await signedRequest({ pair, did }), env);
    expect(auth.scopes).toEqual(['read', 'upload']);
  });

  it('treats an unparseable scopes column as no scopes', async () => {
    const { pair, did } = await generateIdentity();
    const { env } = makeEnv({ ...AGENT, did, scopes: 'not json' });

    const auth = await authenticate(await signedRequest({ pair, did }), env);
    expect(auth.scopes).toEqual([]);
  });
});

describe('requireUploadAccess', () => {
  const authFor = (agent: AgentRow, scopes: string[]) => ({
    agent,
    scopes: scopes as ('read' | 'upload')[],
  });

  it('allows an active upload scope when a profile exists', async () => {
    const { pair, did } = await generateIdentity();
    const agent = { ...AGENT, did };
    const { env } = makeEnv(agent);
    const auth = await authenticate(await signedRequest({ pair, did }), env);

    await expect(requireUploadAccess(env, auth)).resolves.toBeUndefined();
  });

  it('denies without the upload scope', async () => {
    const { env } = makeEnv(AGENT);
    await expect(
      requireUploadAccess(env, authFor(AGENT, ['read'])),
    ).rejects.toMatchObject({ status: 403, message: 'scope `upload` required' });
  });

  it('denies when no profile row exists', async () => {
    const { env } = makeEnv(AGENT, false);
    await expect(requireUploadAccess(env, authFor(AGENT, ['upload']))).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('profile_required'),
    });
  });

  it('denies once the quota is exhausted', async () => {
    const spent = { ...AGENT, used_bytes: 5_000_000_000, quota_bytes: 5_000_000_000 };
    const { env } = makeEnv(spent);
    await expect(requireUploadAccess(env, authFor(spent, ['upload']))).rejects.toMatchObject({
      status: 403,
      message: 'storage quota exceeded',
    });
  });

  it('denies a quota above the platform maximum', async () => {
    const greedy = { ...AGENT, quota_bytes: 9_000_000_000 };
    const { env } = makeEnv(greedy);
    await expect(requireUploadAccess(env, authFor(greedy, ['upload']))).rejects.toMatchObject({
      status: 403,
      message: 'quota above platform maximum',
    });
  });
});