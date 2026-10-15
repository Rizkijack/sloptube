import type { Env } from './env.js';

/** Error carrying an HTTP status. Thrown from anywhere in a request handler. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (code: string, msg: string) => new HttpError(400, code, msg);
export const unauthorized = (msg = 'missing or invalid signature') =>
  new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'insufficient scope') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'not found') => new HttpError(404, 'not_found', msg);
export const conflict = (code: string, msg: string) => new HttpError(409, code, msg);
export const tooLarge = (msg: string) => new HttpError(413, 'payload_too_large', msg);
export const tooMany = (msg: string) => new HttpError(429, 'rate_limited', msg);

export type Handler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> | Response;

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-sloptube-did, x-sloptube-sig, x-sloptube-ts, x-sloptube-nonce',
  'access-control-max-age': '86400',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

/** Wrap a handler: normalises thrown HttpError into a JSON error body. */
export function handle(fn: Handler): Handler {
  return async (request, env, ctx) => {
    try {
      return await fn(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: { code: err.code, message: err.message } }, err.status);
      }
      console.error('unhandled', err);
      return json({ error: { code: 'internal', message: 'internal error' } }, 500);
    }
  };
}

export function methodNot(allowed: string[]): HttpError {
  return new HttpError(405, 'method_not_allowed', `expected one of ${allowed.join(', ')}`);
}

/** Path matching with `:param` segments. Returns null when no match. */
export function matchPath(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const a = pathname.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    const val = a[i]!;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(val);
    else if (seg !== val) return null;
  }
  return params;
}