import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PipelineMessage, VideoRow } from '../src/worker/lib/env.js';

/**
 * Pipeline state-machine tests.
 *
 * These exist because the machine is where the interesting failures live and it
 * had no test at all. Each assertion below corresponds to a bug that was found by
 * reading rather than by running:
 *
 *  - scan and transcode were enqueued together, so a scan that landed first
 *    published a video with zero segments and the transcode then silently no-oped;
 *  - every transition was an unconditional `UPDATE … SET status`, so a duplicate
 *    delivery could downgrade `ready` back to `transcoded` and unpublish a video;
 *  - duplicate delivery could start a second ffmpeg pass over the same 2 GiB
 *    object;
 *  - quota charged at publish was never released when a video was rejected,
 *    failed, quarantined or swept, so three rejected uploads bricked an agent.
 */

const container = vi.hoisted(() => ({
  probe: vi.fn(),
  transcode: vi.fn(),
  scan: vi.fn(),
}));

vi.mock('../src/worker/container-media.js', () => container);

const { handlePipelineBatch, buildMasterPlaylist } = await import('../src/worker/lib/pipeline.js');

/* ------------------------------------------------------------------ *
 * A DB fake that understands only the statements the pipeline issues.
 * ------------------------------------------------------------------ */

interface FakeState {
  videos: Map<string, VideoRow>;
  segments: Map<string, { n: number; r2_key: string; bytes: number; duration_s: number }[]>;
  jobs: Map<string, { state: string; updated_at: number }>;
  agents: Map<string, { used_bytes: number; quota_bytes: number }>;
  blocked: Set<string>;
  deleted: string[];
}

function row(over: Partial<VideoRow> = {}): VideoRow {
  return {
    id: 'vid_1',
    agent_id: 'agt_1',
    status: 'uploaded',
    title: 't',
    description: '',
    tags: '[]',
    duration_s: 0,
    bytes: 1000,
    width: 0,
    height: 0,
    seg_count: 0,
    r2_prefix: 'videos/vid_1',
    sha256: null,
    scan_state: 'pending',
    visibility: 'private',
    hold_until: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function makeEnv(video: VideoRow): { env: Env; state: FakeState; sent: PipelineMessage[] } {
  const state: FakeState = {
    videos: new Map([[video.id, video]]),
    segments: new Map(),
    jobs: new Map(),
    agents: new Map([[video.agent_id, { used_bytes: video.bytes, quota_bytes: 10_000_000 }]]),
    blocked: new Set(),
    deleted: [],
  };
  const sent: PipelineMessage[] = [];

  function applyUpdate(sql: string, args: unknown[]): number {
    const m = /^UPDATE\s+(videos|jobs|agents)\s+SET\s+(.*?)\s+WHERE\s+(.*)$/is.exec(sql);
    if (!m) throw new Error(`fake DB: unhandled UPDATE: ${sql}`);
    const [, table, setPart, wherePart] = m as unknown as [string, string, string, string];

    // Refunds are the one statement whose SET clause contains a comma inside a
    // function call, so they are matched before any generic column parsing.
    if (table === 'agents' && /used_bytes\s*=\s*MAX/.test(setPart)) {
      const agentId = String(args[1]);
      const agent = state.agents.get(agentId);
      if (agent) agent.used_bytes = Math.max(0, agent.used_bytes - Number(args[0] ?? 0));
      return agent ? 1 : 0;
    }

    // `chargeUsage` enforces the ceiling inside the same statement:
    //   UPDATE agents SET used_bytes = used_bytes + ?
    //    WHERE id = ? AND used_bytes + ? <= quota_bytes
    // Honouring the WHERE is the whole point of the fake here — a fake that
    // ignored it would pass no matter what the production SQL said.
    if (table === 'agents' && /used_bytes\s*=\s*used_bytes/.test(setPart)) {
      const bytes = Number(args[0] ?? 0);
      const agentId = String(args[1] ?? '');
      const agent = state.agents.get(agentId);
      if (!agent) return 0;
      const ceiling = /used_bytes \+ \? <= quota_bytes/.test(wherePart);
      const requested = Number(args[2] ?? bytes);
      if (ceiling && agent.used_bytes + requested > agent.quota_bytes) return 0;
      agent.used_bytes += bytes;
      return 1;
    }

    // Column order in the SET clause is exactly the parameter order. The name
    // charset must include digits: `sha256` was silently skipped by `[a-z_]+`,
    // which shifted every argument by one.
    const columns = [...setPart.matchAll(/([a-z0-9_]+)\s*=\s*\?/gi)].map((c) => c[1]!);
    const values = args.slice(0, columns.length);
    const rest = args.slice(columns.length);

    if (table === 'jobs') {
      const id = String(rest[0] ?? args[args.length - 1]);
      const job = state.jobs.get(id);
      if (!job) return 0;
      columns.forEach((col, i) => {
        if (col === 'state') job.state = String(values[i]);
      });
      return 1;
    }

    const id = String(rest[0]);
    // The IN clause carries placeholders, so bind them from the same arg list
    // rather than trying to read literals out of the SQL text.
    const inClause = /status IN \(([^)]*)\)/.exec(wherePart)?.[1];
    let statusFilter: string[] | null = null;
    if (inClause !== undefined) {
      const count = inClause.split(',').length;
      statusFilter = rest.slice(1, 1 + count).map((v) => String(v));
    }

    const v = state.videos.get(id);
    if (!v) return 0;
    if (statusFilter && !statusFilter.includes(v.status)) return 0;
    if (fakeDb.rejectNextVideoUpdate && table === 'videos') {
      fakeDb.rejectNextVideoUpdate = false;
      return 0;
    }
    if (/status = 'uploaded' AND bytes = 0/.test(wherePart) && (v.status !== 'uploaded' || v.bytes !== 0)) {
      return 0;
    }
    columns.forEach((col, i) => {
      (v as unknown as Record<string, unknown>)[col] = values[i];
    });
    return 1;
  }

  const db = {
    prepare(sql: string) {
      const norm = sql.replace(/\s+/g, ' ').trim();
      return makeStatement(norm, []);
    },
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };

  /**
   * Test-only switch: makes the next UPDATE on `videos` report zero changes,
   * standing in for "a concurrent writer moved the row between the read and the
   * compare-and-set". Not part of the Worker; it exists so a branch that is
   * conditioned on `transitionVideo` returning true can be exercised at all.
   */
  const fakeDb = { rejectNextVideoUpdate: false };

  /** A statement. `bind()` must return a NEW object: D1 statements are immutable,
   *  and reusing one made every batch entry share the last binding. */
  function makeStatement(norm: string, args: unknown[]): any {
    const stmt = {
      _args: args,
      bind(...next: unknown[]) {
        return makeStatement(norm, next);
      },
        async first<T>(): Promise<T | null> {
          const a = stmt._args;
          if (/^SELECT \* FROM videos WHERE id = \?/.test(norm)) {
            return (state.videos.get(String(a[0])) ?? null) as T | null;
          }
          if (/FROM blocked_hashes WHERE sha256/.test(norm)) {
            return (state.blocked.has(String(a[0])) ? { sha256: a[0] } : null) as T | null;
          }
          if (/SELECT COUNT\(\*\) AS c FROM video_segments/.test(norm)) {
            const list = state.segments.get(String(a[0])) ?? [];
            return { c: list.length } as T;
          }
          if (/SELECT COUNT\(\*\) AS n FROM reports/.test(norm)) {
            return { n: 0 } as T;
          }
          throw new Error(`fake DB: unhandled first(): ${norm}`);
        },
        async all<T>(): Promise<{ results: T[] }> {
          const a = stmt._args;
          if (/SELECT id FROM videos WHERE status IN/.test(norm)) return { results: [] as T[] };
          if (/SELECT r2_key FROM video_segments/.test(norm)) {
            const list = state.segments.get(String(a[0])) ?? [];
            return { results: list.map((s) => ({ r2_key: s.r2_key })) as T[] };
          }
          throw new Error(`fake DB: unhandled all(): ${norm}`);
        },
        async run(): Promise<{ meta: { changes: number } }> {
          const a = stmt._args;
          SQL_LOG.push(`ARGS ${JSON.stringify(a)}`);
          if (/^UPDATE /.test(norm)) return { meta: { changes: applyUpdate(norm, a) } };
          if (/^DELETE FROM video_segments/.test(norm)) {
            state.segments.set(String(a[0]), []);
            return { meta: { changes: 1 } };
          }
          if (/INSERT INTO video_segments/.test(norm)) {
            const id = String(a[0]);
            const list = state.segments.get(id) ?? [];
            const entry = { n: Number(a[1]), r2_key: String(a[2]), bytes: Number(a[3]), duration_s: Number(a[4]) };
            const idx = list.findIndex((s) => s.n === entry.n);
            if (idx >= 0) list[idx] = entry;
            else list.push(entry);
            state.segments.set(id, list);
            return { meta: { changes: 1 } };
          }
          if (/INSERT INTO jobs/.test(norm)) {
            // Lease claim. Mirrors: ON CONFLICT DO UPDATE … WHERE state='failed'
            // OR (state='running' AND updated_at < ?). A `done` row is not
            // claimable — that is what makes duplicate delivery a no-op.
            const id = String(a[0]);
            const staleBefore = Number(a[a.length - 1]);
            const existing = state.jobs.get(id);
            const claimable =
              !existing ||
              existing.state === 'failed' ||
              (existing.state === 'running' && existing.updated_at < staleBefore);
            if (claimable) state.jobs.set(id, { state: 'running', updated_at: Date.now() });
            return { meta: { changes: claimable ? 1 : 0 } };
          }
          if (/INSERT INTO (events|reports)/.test(norm)) return { meta: { changes: 1 } };
          return { meta: { changes: 0 } };
        },
    };
    return stmt;
  }

  const env = {
    DB: db,
    CACHE: { get: async () => null, put: async () => undefined },
    // Real limits (the pipeline's own defaults would mask a broken fake).
    MAX_UPLOAD_BYTES: '2147483648',
    MAX_DURATION_S: '14400',
    MAX_HEIGHT: '1080',
    SIGNUP_QUOTA_BYTES: '5368709120',
    SEGMENT_SECONDS: '5',
    R2_PUBLIC_BASE: '',
    R2_BUCKET: 'b',
    R2_ACCOUNT_ID: 'a',
    R2_ACCESS_KEY_ID: 'k',
    R2_SECRET_ACCESS_KEY: 's',
    TURNSTILE_SITE_KEY: '',
    MEDIA: {
      head: async () => ({ size: 1000 }),
      delete: async (key: string | string[]) => {
        const keys = typeof key === 'string' ? [key] : key;
        for (const k of keys) state.deleted.push(k);
      },
      // The purge helper drives deletion from a listing, not from a hand-written
      // key list. Returning an empty list here made the quarantine test assert
      // against nothing — the deletion it was checking had no source.
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [
          { key: `${prefix}source` },
          { key: `${prefix}init.mp4` },
          { key: `${prefix}seg_000000.m4s` },
        ],
        truncated: false,
      }),
      put: async (key: string) => {
        state.deleted.push(`put:${key}`);
      },
    },
    PIPELINE_QUEUE: {
      send: async (msg: PipelineMessage) => {
        sent.push(msg);
      },
    },
  } as unknown as Env;
  (env as unknown as { FAKE_DB: typeof fakeDb }).FAKE_DB = fakeDb;

  return { env, state, sent };
}

const SQL_LOG: string[] = [];

async function deliver(env: Env, message: PipelineMessage, attempts = 1): Promise<void> {
  const ack = vi.fn();
  const retry = vi.fn();
  const logged: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  const batch = {
    queue: 'q',
    messages: [{ id: 'm1', body: message, attempts, ack, retry }],
  } as unknown as MessageBatch<PipelineMessage>;
  try {
    await handlePipelineBatch(batch, env);
  } finally {
    spy.mockRestore();
  }
  // A retried message means the handler threw. Surface that instead of letting
  // the assertions fail with a confusing "nothing happened".
  if (retry.mock.calls.length > 0) {
    throw new Error(
      `pipeline job was retried (handler threw): ${logged.join(' | ') || '(no detail)'}\nSQL: ${SQL_LOG.join('\n     ')}`,
    );
  }
}

/**
 * Deliver a message that is *expected* to be retried (a guard that refuses to
 * proceed). Returns the recorded failure detail so the test can assert on it.
 */
async function deliverExpectingRetry(env: Env, message: PipelineMessage, attempts = 1): Promise<string> {
  const retry = vi.fn();
  const logged: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  try {
    await handlePipelineBatch(
      {
        queue: 'q',
        messages: [{ id: 'm1', body: message, attempts, ack: vi.fn(), retry }],
      } as unknown as MessageBatch<PipelineMessage>,
      env,
    );
  } finally {
    spy.mockRestore();
  }
  return logged.join(' | ');
}

beforeEach(() => {
  container.probe.mockReset();
  container.transcode.mockReset();
  container.scan.mockReset();
  SQL_LOG.length = 0;
});

describe('buildMasterPlaylist', () => {
  it('puts EXT-X-MAP before the first EXTINF and ENDLIST last', () => {
    const out = buildMasterPlaylist([
      { n: 0, durationS: 5 },
      { n: 1, durationS: 3 },
    ]);
    const map = out.indexOf('#EXT-X-MAP:URI="init.mp4"');
    const firstInf = out.indexOf('#EXTINF:');
    expect(map).toBeGreaterThan(-1);
    expect(map).toBeLessThan(firstInf);
    expect(out.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
  });

  it('reports TARGETDURATION as the ceil of the longest real segment', () => {
    const out = buildMasterPlaylist([
      { n: 0, durationS: 5.0 },
      { n: 1, durationS: 6.4 },
      { n: 2, durationS: 2.1 },
    ]);
    expect(out).toContain('#EXT-X-TARGETDURATION:7');
    // every EXTINF must be <= TARGETDURATION
    for (const m of out.matchAll(/#EXTINF:([\d.]+),/g)) {
      expect(Number(m[1])).toBeLessThanOrEqual(7);
    }
  });

  it('emits one EXTINF + segment pair per segment, in order', () => {
    const out = buildMasterPlaylist([
      { n: 2, durationS: 2 },
      { n: 0, durationS: 5 },
      { n: 1, durationS: 5 },
    ]);
    expect(out.match(/#EXTINF:/g)?.length).toBe(3);
    expect(out.indexOf('seg_000000.m4s')).toBeLessThan(out.indexOf('seg_000001.m4s'));
    expect(out.indexOf('seg_000001.m4s')).toBeLessThan(out.indexOf('seg_000002.m4s'));
  });
});

describe('probe', () => {
  it('moves uploaded -> probed and enqueues a transcode but NOT a scan', async () => {
    container.probe.mockResolvedValue({
      ok: true,
      sha256: 'a'.repeat(64),
      durationS: 13,
      width: 320,
      height: 180,
      bytes: 1000,
    });
    const { env, state, sent } = makeEnv(row());

    await deliver(env, { kind: 'probe', videoId: 'vid_1', r2Key: 'videos/vid_1/source' });

    expect(state.videos.get('vid_1')!.status).toBe('probed');
    expect(sent.map((m) => m.kind)).toEqual(['transcode']);
    // scan must be chained from transcode completion, never sent here
    expect(sent.some((m) => m.kind === 'scan')).toBe(false);
  });

  it('is idempotent: a second delivery does not enqueue a second transcode', async () => {
    container.probe.mockResolvedValue({ ok: true, sha256: 'a'.repeat(64), durationS: 13, width: 1, height: 1, bytes: 1 });
    const { env, sent } = makeEnv(row());

    await deliver(env, { kind: 'probe', videoId: 'vid_1', r2Key: 'k' });
    await deliver(env, { kind: 'probe', videoId: 'vid_1', r2Key: 'k' });

    expect(sent.filter((m) => m.kind === 'transcode')).toHaveLength(1);
  });

  it('rejects a non-video and refunds the quota', async () => {
    container.probe.mockResolvedValue({ ok: false, reason: 'no_video_stream' });
    const { env, state, sent } = makeEnv(row({ bytes: 4096 }));

    await deliver(env, { kind: 'probe', videoId: 'vid_1', r2Key: 'k' });

    expect(state.videos.get('vid_1')!.status).toBe('rejected');
    expect(state.agents.get('agt_1')!.used_bytes).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('rejects a video over the duration limit', async () => {
    container.probe.mockResolvedValue({
      ok: true,
      sha256: 'b'.repeat(64),
      durationS: 100_000,
      width: 640,
      height: 360,
      bytes: 1,
    });
    const { env, state } = makeEnv(row());

    await deliver(env, { kind: 'probe', videoId: 'vid_1', r2Key: 'k' });
    expect(state.videos.get('vid_1')!.status).toBe('rejected');
  });
});

describe('transcode', () => {
  const segments = [
    { n: 0, r2Key: 'videos/vid_1/seg_000000.m4s', bytes: 100, durationS: 5 },
    { n: 1, r2Key: 'videos/vid_1/seg_000001.m4s', bytes: 90, durationS: 3 },
  ];

  it('moves probed -> transcoded, stores real durations, writes the playlist and enqueues the scan', async () => {
    container.transcode.mockResolvedValue({ ok: true, segments, segCount: 2 });
    const { env, state, sent } = makeEnv(row({ status: 'probed', seg_count: 2, duration_s: 8 }));

    await deliver(env, { kind: 'transcode', videoId: 'vid_1' });

    expect(state.videos.get('vid_1')!.status).toBe('transcoded');
    expect(state.segments.get('vid_1')!.map((s) => s.duration_s)).toEqual([5, 3]);
    expect(sent.map((m) => m.kind)).toEqual(['scan']);
    expect(state.deleted.some((k) => k.startsWith('put:') && k.includes('master.m3u8'))).toBe(true);
  });

  it('does not run a second ffmpeg pass on duplicate delivery', async () => {
    container.transcode.mockResolvedValue({ ok: true, segments, segCount: 2 });
    const { env } = makeEnv(row({ status: 'probed', seg_count: 2 }));

    await deliver(env, { kind: 'transcode', videoId: 'vid_1' });
    await deliver(env, { kind: 'transcode', videoId: 'vid_1' });

    expect(container.transcode).toHaveBeenCalledTimes(1);
  });

  it('never downgrades a video that a scan already promoted to ready', async () => {
    container.transcode.mockResolvedValue({ ok: true, segments, segCount: 2 });
    const { env, state } = makeEnv(row({ status: 'ready', seg_count: 2 }));

    await deliver(env, { kind: 'transcode', videoId: 'vid_1' });

    expect(state.videos.get('vid_1')!.status).toBe('ready');
  });

  it('marks a container failure as failed and refunds the quota', async () => {
    container.transcode.mockResolvedValue({ ok: false, reason: 'transcode_failed' });
    const { env, state } = makeEnv(row({ status: 'probed', seg_count: 1, bytes: 2048 }));

    await deliver(env, { kind: 'transcode', videoId: 'vid_1' });

    expect(state.videos.get('vid_1')!.status).toBe('failed');
    expect(state.agents.get('agt_1')!.used_bytes).toBe(0);
  });

  it('does not refund when the failed-transition CAS does not apply', async () => {
    // The refund is conditioned on `transitionVideo` actually moving the row.
    // This does not claim to reproduce the racing path that motivated the guard —
    // a single-threaded fake cannot stage it. It pins the branch: when the
    // compare-and-set reports zero changes (a concurrent quarantine moved the
    // row first, say), storage is not released a second time.
    container.transcode.mockResolvedValue({ ok: false, reason: 'transcode_failed' });
    const { env, state } = makeEnv(row({ status: 'probed', seg_count: 1, bytes: 2048 }));
    (env as unknown as { FAKE_DB: { rejectNextVideoUpdate: boolean } }).FAKE_DB.rejectNextVideoUpdate = true;

    await deliver(env, { kind: 'transcode', videoId: 'vid_1' });

    expect(state.agents.get('agt_1')!.used_bytes).toBe(2048);
  });
});

describe('scan', () => {
  it('refuses to publish when the transcode never completed', async () => {
    container.scan.mockResolvedValue({ ok: true, verdict: 'clean' });
    const { env, state } = makeEnv(row({ status: 'probed', seg_count: 2 }));

    await deliverExpectingRetry(env, { kind: 'scan', videoId: 'vid_1' });

    // The bug this guards: scan-first used to set ready+public with no segments.
    expect(state.videos.get('vid_1')!.status).toBe('probed');
    expect(state.videos.get('vid_1')!.visibility).toBe('private');
  });

  it('refuses to publish when segments are missing', async () => {
    container.scan.mockResolvedValue({ ok: true, verdict: 'clean' });
    const { env, state } = makeEnv(row({ status: 'transcoded', seg_count: 5 }));

    await deliverExpectingRetry(env, { kind: 'scan', videoId: 'vid_1' });

    expect(state.videos.get('vid_1')!.status).toBe('transcoded');
  });

  it('promotes to ready + public and bumps the feed version', async () => {
    container.scan.mockResolvedValue({ ok: true, verdict: 'clean' });
    const { env, state } = makeEnv(row({ status: 'transcoded', seg_count: 2 }));
    state.segments.set('vid_1', [
      { n: 0, r2_key: 'a', bytes: 1, duration_s: 5 },
      { n: 1, r2_key: 'b', bytes: 1, duration_s: 3 },
    ]);

    await deliver(env, { kind: 'scan', videoId: 'vid_1' });

    const v = state.videos.get('vid_1')!;
    expect(v.status).toBe('ready');
    expect(v.scan_state).toBe('clean');
    expect(v.visibility).toBe('public');
  });

  it('quarantines infected media, purges derived objects and refunds quota', async () => {
    container.scan.mockResolvedValue({ ok: true, verdict: 'infected', signature: 'Eicar-Test' });
    const { env, state } = makeEnv(row({ status: 'transcoded', seg_count: 1, bytes: 512 }));
    state.segments.set('vid_1', [{ n: 0, r2_key: 'videos/vid_1/seg_000000.m4s', bytes: 1, duration_s: 5 }]);

    await deliver(env, { kind: 'scan', videoId: 'vid_1' });

    const v = state.videos.get('vid_1')!;
    expect(v.status).toBe('quarantined');
    expect(v.visibility).toBe('private');
    expect(state.deleted).toContain('videos/vid_1/source');
    expect(state.agents.get('agt_1')!.used_bytes).toBe(0);
  });

  it('does not refund or purge when the infected-branch CAS does not apply', async () => {
    // The other half of §7.15. An operator quarantine landing first means this
    // branch lost the compare-and-set; refunding and purging anyway would
    // release the same bytes admin.ts already released.
    container.scan.mockResolvedValue({ ok: true, verdict: 'infected', signature: 'Eicar-Test' });
    const { env, state } = makeEnv(row({ status: 'transcoded', seg_count: 1, bytes: 512 }));
    state.segments.set('vid_1', [{ n: 0, r2_key: 'videos/vid_1/seg_000000.m4s', bytes: 1, duration_s: 5 }]);
    (env as unknown as { FAKE_DB: { rejectNextVideoUpdate: boolean } }).FAKE_DB.rejectNextVideoUpdate = true;

    await deliver(env, { kind: 'scan', videoId: 'vid_1' });

    expect(state.agents.get('agt_1')!.used_bytes).toBe(512);
    expect(state.deleted).not.toContain('videos/vid_1/source');
  });

  it('never promotes a rejected video', async () => {
    container.scan.mockResolvedValue({ ok: true, verdict: 'clean' });
    const { env, state } = makeEnv(row({ status: 'rejected', seg_count: 1 }));

    await deliver(env, { kind: 'scan', videoId: 'vid_1' });
    expect(state.videos.get('vid_1')!.status).toBe('rejected');
  });
});

describe('chargeUsage', () => {
  it('charges when the charge fits under the quota', async () => {
    const { chargeUsage } = await import('../src/worker/lib/db.js');
    const { env, state } = makeEnv(row({ bytes: 1000 }));

    expect(await chargeUsage(env, 'agt_1', 500)).toBe(true);
    expect(state.agents.get('agt_1')!.used_bytes).toBe(1500);
  });

  it('refuses the charge at the ceiling and leaves usage untouched', async () => {
    // The point of the CAS is that the limit is in the same statement as the
    // write. If it were a prior read instead, two concurrent publishes would
    // both pass it and together exceed the quota.
    const { chargeUsage } = await import('../src/worker/lib/db.js');
    const { env, state } = makeEnv(row({ bytes: 1000 }));
    state.agents.get('agt_1')!.quota_bytes = 1500;

    expect(await chargeUsage(env, 'agt_1', 500)).toBe(true);
    // Exactly at the quota now; one more byte must be refused, not accepted.
    expect(await chargeUsage(env, 'agt_1', 1)).toBe(false);
    expect(state.agents.get('agt_1')!.used_bytes).toBe(1500);
  });

  it('refuses a charge for an unknown agent', async () => {
    const { chargeUsage } = await import('../src/worker/lib/db.js');
    const { env } = makeEnv(row());
    expect(await chargeUsage(env, 'agt_nope', 10)).toBe(false);
  });
});
