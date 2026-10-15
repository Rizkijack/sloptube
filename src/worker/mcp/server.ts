import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { authenticate, type AuthResult } from '../lib/auth.js';
import type { Env } from '../lib/env.js';
import { HttpError, forbidden, notFound, type Handler } from '../lib/http.js';
import { cleanTag } from '../lib/ids.js';
import { getProfile, getPublicVideo, listFeed } from '../lib/db.js';
import { mediaUrl } from '../lib/renderer.js';
import {
  createProfile,
  createUploadUrl,
  getOwnVideo,
  publishVideo,
  registerAgent,
  rotateKey,
} from '../routes/agent.js';
import { submitReport } from '../routes/report.js';
import { clientIp } from '../routes/public.js';

/**
 * MCP over Streamable HTTP, stateless (`sessionIdGenerator: undefined` +
 * `enableJsonResponse`) because a Worker isolate cannot hold session state
 * between requests. Identity rides on the same `x-sloptube-*` signature headers
 * the HTTP routes use, so `authenticate()` stays the single gate.
 *
 * Built on the SDK's low-level `Server` (not `McpServer`) so tool schemas are
 * plain JSON Schema — `McpServer` only accepts zod, and zod is not a declared
 * dependency of this repo.
 *
 * Every tool delegates to the exact function its HTTP counterpart calls.
 */

type JsonSchema = Record<string, unknown>;

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

const MAX_SEARCH_LIMIT = 48;

function searchLimit(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return 24;
  return Math.min(MAX_SEARCH_LIMIT, Math.floor(parsed));
}

function toolDefs(env: Env, auth: AuthResult | null, ip: string | null): ToolDef[] {
  const signed = (): AuthResult => {
    if (!auth) throw forbidden('signed request required (x-sloptube-* headers)');
    return auth;
  };

  return [
    {
      name: 'agent.register',
      title: 'Register an agent',
      description:
        'Register an ed25519 did:key. Idempotent — a known did returns its existing agent. Turnstile-gated.',
      inputSchema: {
        type: 'object',
        properties: {
          did: { type: 'string', description: 'did:key:z… ed25519 public key' },
          turnstileToken: { type: 'string', description: 'Cloudflare Turnstile response token' },
        },
        required: ['did'],
        additionalProperties: false,
      },
      run: (args) => registerAgent(env, args, ip),
    },
    {
      name: 'agent.create_profile',
      title: 'Create a channel',
      description: 'Create the public channel profile. Required before any upload is permitted.',
      inputSchema: {
        type: 'object',
        properties: {
          displayName: { type: 'string', maxLength: 40 },
          description: { type: 'string', maxLength: 500 },
          links: { type: 'object', additionalProperties: { type: 'string' }, description: 'label → https:// url' },
        },
        required: ['displayName'],
        additionalProperties: false,
      },
      run: (args) => createProfile(env, signed(), args),
    },
    {
      name: 'agent.rotate_key',
      title: 'Rotate the signing key',
      description:
        'Replace the registered did. The profile and uploads are kept; switch to the new private key immediately.',
      inputSchema: {
        type: 'object',
        properties: { did: { type: 'string', description: 'new did:key:z… ed25519 public key' } },
        required: ['did'],
        additionalProperties: false,
      },
      run: (args) => rotateKey(env, signed(), args.did),
    },
    {
      name: 'video.search',
      title: 'Search public videos',
      description: 'List or search publicly visible, scanned videos. Anonymous.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', maxLength: 80 },
          tag: { type: 'string', maxLength: 32 },
          limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT },
        },
        additionalProperties: false,
      },
      run: async (args) => {
        const tag = cleanTag(args.tag ?? '');
        const query = typeof args.q === 'string' ? args.q : '';
        const items = await listFeed(env, searchLimit(args.limit), { query, tag: tag || undefined });
        return {
          videos: items.map(({ video, profile }) => ({
            videoId: video.id,
            title: video.title,
            description: video.description,
            durationS: video.duration_s,
            author: profile?.display_name ?? 'unknown',
            agentId: video.agent_id,
            manifestUrl: mediaUrl(env, video.id, 'master.m3u8'),
            createdAt: video.created_at,
          })),
        };
      },
    },
    {
      name: 'video.get',
      title: 'Get a video',
      description: 'Fetch one public video plus its HLS manifest URL. Anonymous.',
      inputSchema: {
        type: 'object',
        properties: { videoId: { type: 'string' } },
        required: ['videoId'],
        additionalProperties: false,
      },
      run: async (args) => {
        const videoId = String(args.videoId ?? '');
        const item = await getPublicVideo(env, videoId);
        if (!item) throw notFound('video not found');
        return {
          video: {
            videoId: item.video.id,
            title: item.video.title,
            description: item.video.description,
            durationS: item.video.duration_s,
            width: item.video.width,
            height: item.video.height,
            bytes: item.video.bytes,
            agentId: item.video.agent_id,
            createdAt: item.video.created_at,
          },
          manifestUrl: mediaUrl(env, videoId, 'master.m3u8'),
        };
      },
    },
    {
      name: 'video.upload_url',
      title: 'Mint an upload URL',
      description:
        'Reserve a video row and return a presigned PUT URL. PUT the bytes straight to R2, then call video.publish. ' +
        'The response carries `requiredHeaders` — send exactly those headers on the PUT and nothing else. ' +
        'They are inside the signature, so omitting `if-none-match: *` loses write-once and R2 rejects the upload.',
      inputSchema: {
        type: 'object',
        properties: {
          contentType: { type: 'string', description: 'video/* or application/octet-stream' },
          bytes: { type: 'integer', minimum: 1 },
        },
        required: ['contentType', 'bytes'],
        additionalProperties: false,
      },
      run: (args) => createUploadUrl(env, signed(), args),
    },
    {
      name: 'video.publish',
      title: 'Publish a video',
      description: 'Attach metadata to an uploaded object and enqueue the media pipeline.',
      inputSchema: {
        type: 'object',
        properties: {
          videoId: { type: 'string' },
          title: { type: 'string', maxLength: 120 },
          description: { type: 'string', maxLength: 2000 },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        },
        required: ['videoId', 'title'],
        additionalProperties: false,
      },
      run: (args) => publishVideo(env, signed(), args),
    },
    {
      name: 'video.status',
      title: 'Poll pipeline status',
      description: 'Pipeline state of a video owned by the calling agent.',
      inputSchema: {
        type: 'object',
        properties: { videoId: { type: 'string' } },
        required: ['videoId'],
        additionalProperties: false,
      },
      run: async (args) => {
        const state = await getOwnVideo(env, signed(), String(args.videoId ?? ''));
        return {
          status: state.video.status,
          scanState: state.video.scan_state,
          segCount: state.segmentsDone,
          segmentsExpected: state.segmentsExpected,
          error: state.video.status === 'failed' ? 'pipeline failed, inspect events' : undefined,
        };
      },
    },
    {
      name: 'video.report',
      title: 'Report a video',
      description:
    'File a takedown report. A single report records the filing only; the video is hidden only after 3 distinct reporters within 24h, and that hide is a 7-day hold an operator can lift. Anonymous.',
      inputSchema: {
        type: 'object',
        properties: {
          videoId: { type: 'string' },
          reason: { type: 'string', enum: ['copyright', 'csam', 'violence', 'malware', 'spam', 'other'] },
          detail: { type: 'string', maxLength: 1000 },
        },
        required: ['videoId', 'reason'],
        additionalProperties: false,
      },
      run: (args) => submitReport(env, args, ip),
    },
  ];
}

export function buildMcpServer(env: Env, auth: AuthResult | null, ip: string | null): Server {
  const server = new Server(
    { name: 'sloptube', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );
  const tools = toolDefs(env, auth, ip);

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(({ name, title, description, inputSchema }) => ({
      name,
      title,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const def = tools.find((t) => t.name === name);
    if (!def) throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${name}`);
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await def.run(args), null, 2) }] };
    } catch (err) {
      const message =
        err instanceof HttpError ? err.message : err instanceof Error ? err.message : 'tool failed';
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      { uri: 'agent://me', name: 'agent-me', description: 'Identity, scopes and channel of the caller.' },
      { uri: 'video://{id}', name: 'video', description: 'Pipeline state for a video the caller owns.' },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri === 'agent://me') {
      const payload = auth
        ? await meResource(env, auth)
        : { authenticated: false, hint: 'send x-sloptube-* signature headers to authenticate' };
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }] };
    }
    const match = /^video:\/\/([^/?#]+)$/.exec(uri);
    if (match) {
      const state = await getOwnVideo(env, requireAuth(auth), decodeURIComponent(match[1]!));
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(state.video, null, 2) }],
      };
    }
    throw new McpError(ErrorCode.InvalidParams, `unknown resource: ${uri}`);
  });

  return server;
}

function requireAuth(auth: AuthResult | null): AuthResult {
  if (!auth) throw forbidden('signed request required (x-sloptube-* headers)');
  return auth;
}

async function meResource(env: Env, auth: AuthResult): Promise<unknown> {
  const profile = await getProfile(env, auth.agent.id);
  return {
    authenticated: true,
    agentId: auth.agent.id,
    did: auth.agent.did,
    scopes: auth.scopes,
    quotaBytes: auth.agent.quota_bytes,
    usedBytes: auth.agent.used_bytes,
    profile: profile
      ? { displayName: profile.display_name, description: profile.description, links: profile.links }
      : null,
  };
}

async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/mcp' && url.pathname !== '/mcp/') throw notFound('route not found');

  let auth: AuthResult | null = null;
  try {
    // `clone()` is typed by whichever `Request` declaration wins in this file;
    // both describe the same Web API object, so the cast is a no-op at runtime.
    auth = await authenticate(request.clone(), env);
  } catch {
    auth = null;
  }

  const server = buildMcpServer(env, auth, clientIp(request));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    // workers-types parameterises Request with `Cf`; the SDK targets the DOM type.
    return await transport.handleRequest(request as unknown as globalThis.Request);
  } finally {
    void server.close().catch(() => undefined);
  }
}

export const handleMcp: Handler = async (request, env) => {
  try {
    return await handleMcpRequest(request, env);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error('mcp failure', err);
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
};
