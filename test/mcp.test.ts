import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, VideoRow } from '../src/worker/lib/env.js';

/**
 * MCP parity tests.
 *
 * The MCP surface advertises itself as delegating to the *exact functions* the
 * HTTP routes call (server.ts header comment). These tests pin the two halves
 * of that promise:
 *
 *  1. the `video.report` tool description states the moderation truth — one
 *     report files only, three DISTINCT reporters hide, the hide is a hold;
 *  2. calling the tool through the SDK returns exactly what `submitReport`
 *     returns, unfolded — `{ accepted: true }`.
 */

const container = vi.hoisted(() => ({
  probe: vi.fn(),
  transcode: vi.fn(),
  scan: vi.fn(),
}));
vi.mock('../src/worker/container-media.js', () => container);

const { buildMcpServer } = await import('../src/worker/mcp/server.js');

interface Row {
  video_id: string;
  reporter_key: string;
  created_at: unknown;
  resolved_at: unknown;
}

function video(over: Partial<VideoRow> = {}): VideoRow {
  return {
    id: 'vid_1',
    agent_id: 'agt_1',
    status: 'ready',
    title: 't',
    description: '',
    tags: '[]',
    duration_s: 30,
    bytes: 1000,
    width: 640,
    height: 360,
    seg_count: 3,
    r2_prefix: 'videos/vid_1',
    sha256: null,
    scan_state: 'clean',
    visibility: 'public',
    hold_until: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  } as VideoRow;
}

/** A DB fake that understands exactly the statements `submitReport` issues. */
function makeEnv(row: VideoRow | null, over: Partial<Env> = {}): Env {
  const reports: Row[] = [];
  let args: unknown[] = [];

  const env = {
    DB: {
      prepare(sql: string) {
        const norm = sql.replace(/\s+/g, ' ').trim();
        const stmt: {
          first: <T>() => Promise<T | null>;
          run: () => Promise<{ meta: { changes: number } }>;
          bind: (...next: unknown[]) => unknown;
        } = {
          bind(...next: unknown[]) {
            args = next;
            return stmt;
          },
          async first<T>() {
            if (/^SELECT \* FROM videos WHERE id = \?$/.test(norm)) {
              return (row ?? null) as T | null;
            }
            if (/COUNT\(DISTINCT reporter_key\)/.test(norm)) {
              const set = new Set(
                reports
                  .filter(
                    (r) =>
                      r.video_id === args[0] &&
                      Number(r.created_at) >= Number(args[1]) &&
                      r.resolved_at === null,
                  )
                  .map((r) => String(r.reporter_key)),
              );
              return { n: set.size } as T;
            }
            throw new Error(`fake DB: unhandled first(): ${norm}`);
          },
          async run() {
            if (/INSERT OR IGNORE INTO reports/.test(norm)) {
              const day = 86_400_000;
              const bucket = Math.floor(Number(args[5]) / day);
              const dup = reports.some(
                (r) =>
                  r.video_id === args[1] &&
                  r.reporter_key === args[4] &&
                  Math.floor(Number(r.created_at) / day) === bucket,
              );
              if (dup) return { meta: { changes: 0 } };
              reports.push({ video_id: String(args[1]), reporter_key: String(args[4]), created_at: args[5], resolved_at: null });
              return { meta: { changes: 1 } };
            }
            if (/^UPDATE videos SET visibility/.test(norm)) return { meta: { changes: 0 } };
            if (/INSERT INTO events/.test(norm)) return { meta: { changes: 1 } };
            throw new Error(`fake DB: unhandled run(): ${norm}`);
          },
        };
        return stmt;
      },
    },
    CACHE: { get: async () => null, put: async () => undefined },
    REPORTER_SALT: 'salt',
    TURNSTILE_SITE_KEY: '',
    ENVIRONMENT: 'local',
    ...over,
  } as unknown as Env;
  return env;
}

/** Drive `buildMcpServer` over an in-memory transport with a real SDK client —
 *  the same JSON-RPC surface an external MCP client would see. */
async function mcpClient(env: Env) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const server = buildMcpServer(env, null, null);
  const client = new Client({ name: 'test-client', version: '1.0.0' } as never);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => (await client.close(), void (await server.close())) };
}

interface ToolMeta {
  name: string;
  description?: string;
}

async function listTools(client: {
  listTools: () => Promise<{ tools: ToolMeta[] }>;
}): Promise<Map<string, ToolMeta>> {
  const { tools } = await client.listTools();
  return new Map(tools.map((t) => [t.name, t]));
}

describe('video.report — MCP parity (gap: description contract)', () => {
  it('describes the moderation truth: one report files only, quorum hides, hide is a hold', async () => {
    const { client, close } = await mcpClient(makeEnv(null));
    try {
      const tools = await listTools(client);
      const report = tools.get('video.report');
      const description = report?.description ?? '';
      expect(report, 'video.report tool is missing from tools/list').toBeDefined();
      expect(description).toContain('single report');
      expect(description).toContain('3 distinct reporters');
      // The words matter: the tool must not advertise one-report takedowns.
      expect(description.toLowerCase()).toContain('hold');
    } finally {
      await close();
    }
  });
});

describe('video.report — MCP parity (submitReport response shape)', () => {
  beforeEach(() => {
    container.probe.mockReset();
    container.transcode.mockReset();
    container.scan.mockReset();
  });

  it('returns the greeted-by-submitReport response, unfolded', async () => {
    const { client, close } = await mcpClient(makeEnv(video()));
    try {
      const result = (await client.callTool({
        name: 'video.report',
        arguments: { videoId: 'vid_1', reason: 'copyright' },
      } as never)) as { isError?: boolean; content?: { type: string; text: string }[] };

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);
      expect(result.content![0]!.type).toBe('text');
      expect(result.content![0]!.text).toBe(JSON.stringify({ accepted: true }, null, 2));
    } finally {
      await close();
    }
  });

  it('does not hide on a single MCP report (same dedup as the HTTP route)', async () => {
    const env = makeEnv(video());
    const { client, close } = await mcpClient(env);
    try {
      await client.callTool({
        name: 'video.report',
        arguments: { videoId: 'vid_1', reason: 'copyright' },
      } as never);
      await client.callTool({
        name: 'video.report',
        arguments: { videoId: 'vid_1', reason: 'copyright' },
      } as never);

      const row = await env.DB
        .prepare('SELECT * FROM videos WHERE id = ?')
        .bind('vid_1')
        .first<VideoRow>();
      expect(row!.visibility).toBe('public');
      expect(row!.hold_until).toBeNull();
    } finally {
      await close();
    }
  });

  it('surfaces submitReport rejections as a text error, not a crash', async () => {
    const { client, close } = await mcpClient(makeEnv(video()));
    try {
      const result = (await client.callTool({
        name: 'video.report',
        arguments: { videoId: 'vid_1', reason: 'because' },
      } as never)) as { isError?: boolean; content?: { type: string; text: string }[] };

      expect(result.isError).toBe(true);
      expect(result.content![0]!.text).toMatch(/must be one of/);
    } finally {
      await close();
    }
  });
});
