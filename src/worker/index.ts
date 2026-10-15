import type { Env, PipelineMessage } from './lib/env.js';
import { handlePublicRoutes, serveMedia } from './routes/public.js';
import { handleAgentRoutes } from './routes/agent.js';
import { handleReportRoutes } from './routes/report.js';
import { handleAdminRoutes } from './routes/admin.js';
import { handleMcp } from './mcp/server.js';
import { handle, notFound } from './lib/http.js';
import { handlePipelineBatch, sweepOrphans, releaseExpiredHolds } from './lib/pipeline.js';

export { RateLimiter } from './do/rate-limiter.js';
export { MediaExecutor } from './container-media.js';

const MCP_PATHS = new Set(['/mcp', '/mcp/']);
/** Operator surface. Routed before the generic /api/ branch so it can stay closed. */
const ADMIN_PREFIX = '/api/admin';

function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith(ADMIN_PREFIX)) return Promise.resolve(handleAdminRoutes(request, env, ctx));
  if (pathname.startsWith('/api/agent/')) return Promise.resolve(handleAgentRoutes(request, env, ctx));
  if (pathname === '/api/report') return Promise.resolve(handleReportRoutes(request, env, ctx));
  if (pathname.startsWith('/api/')) return Promise.resolve(handlePublicRoutes(request, env, ctx));
  if (MCP_PATHS.has(pathname)) return Promise.resolve(handleMcp(request, env, ctx));
  if (pathname.startsWith('/media/')) return Promise.resolve(handle(serveMedia)(request, env, ctx));
  return Promise.reject(notFound('route not found'));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The wildcard preflight is for the public API and MCP. The operator surface
    // opts out of it: answering 204 with `allow-origin: *` there would be the one
    // path that advertises the endpoint as cross-origin callable while
    // `routes/admin.ts` goes to lengths not to do so. Such a request gets a real
    // 405 and, on a GET, a 401.
    const isOperatorPath = new URL(request.url).pathname.startsWith(ADMIN_PREFIX);
    if (request.method === 'OPTIONS' && !isOperatorPath) {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers':
            'content-type, x-sloptube-did, x-sloptube-sig, x-sloptube-ts, x-sloptube-nonce, mcp-protocol-version, mcp-session-id',
          'access-control-max-age': '86400',
          vary: 'Origin',
        },
      });
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/') || MCP_PATHS.has(url.pathname)) {
      return route(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },

  async queue(batch: MessageBatch<PipelineMessage>, env: Env): Promise<void> {
    await handlePipelineBatch(batch, env);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweepOrphans(env));
    ctx.waitUntil(releaseExpiredHolds(env));
  },
};
