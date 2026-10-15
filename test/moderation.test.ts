import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, VideoRow } from '../src/worker/lib/env.js';

/**
 * Moderation tests: report dedup, the hold lifecycle, and the operator surface.
 *
 * The audit's central complaint was that `/api/report` could hide a video and
 * **nothing could ever bring it back** — the endpoint had no tests at all, and
 * `resolved_at` was never written. These tests pin the three properties that
 * make it safe, each of which failed before:
 *
 *  1. one reporter can only count once per video per day (UNIQUE index);
 *  2. hiding needs a quorum of DISTINCT reporters, not N requests;
 *  3. a hide is a hold that expires, and only an operator makes it permanent.
 */

const container = vi.hoisted(() => ({
  probe: vi.fn(),
  transcode: vi.fn(),
  scan: vi.fn(),
}));
// pipeline.ts imports container-media.ts, which imports @cloudflare/containers
// and therefore `cloudflare:workers` — a module Node cannot resolve. None of
// these tests exercise media, so stubbing it is the whole point of the mock.
vi.mock('../src/worker/container-media.js', () => container);

const { submitReport } = await import('../src/worker/routes/report.js');
const { resolveReport, listReports } = await import('../src/worker/routes/admin.js');
const { releaseExpiredHolds } = await import('../src/worker/lib/pipeline.js');
const { reporterKey, reportSaltMissing } = await import('../src/worker/lib/reporter.js');
const { verifyTurnstile } = await import('../src/worker/lib/turnstile.js');

/* ------------------------------------------------------------------ *
 * Minimal SQL evaluator over the statements these three modules issue.
 * ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

interface Store {
  videos: Map<string, VideoRow>;
  reports: Row[];
  agents: Map<string, Row>;
  deleted: string[];
  put: string[];
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

function makeEnv(v: VideoRow, over: Partial<Env> = {}): { env: Env; store: Store } {
  const store: Store = {
    videos: new Map([[v.id, v]]),
    reports: [],
    agents: new Map([[v.agent_id, { id: v.agent_id, used_bytes: v.bytes, quota_bytes: 10_000_000 }]]),
    deleted: [],
    put: [],
  };

  const day = 86_400_000;

  function evalTerm(term: string, row: Row, params: unknown[]): boolean {
    let m = /^(\w+)\s*=\s*\?$/.exec(term);
    if (m) return String(row[m[1]!] ?? '') === String(params.shift());
    m = /^(\w+)\s*=\s*'([^']*)'$/.exec(term);
    if (m) return String(row[m[1]!] ?? '') === m[2];
    m = /^(\w+)\s*!=\s*\?$/.exec(term);
    if (m) return String(row[m[1]!] ?? '') !== String(params.shift());
    m = /^(\w+)\s*!=\s*'([^']*)'$/.exec(term);
    if (m) return String(row[m[1]!] ?? '') !== m[2];
    m = /^(\w+)\s*<\s*\?$/.exec(term);
    // SQLite: NULL < x evaluates to NULL, so the row is EXCLUDED. Treating NULL
    // as 0 here would make the fake include rows production excludes — the
    // sweeper's `hold_until < ?` would then "restore" videos with no deadline.
    if (m) {
      const v = row[m[1]!];
      return v !== null && v !== undefined && Number(v) < Number(params.shift());
    }
    m = /^(\w+)\s*>=\s*\?$/.exec(term);
    if (m) {
      const v = row[m[1]!];
      return v !== null && v !== undefined && Number(v) >= Number(params.shift());
    }
    m = /^(\w+)\s+IS NOT NULL$/.exec(term);
    if (m) return row[m[1]!] !== null && row[m[1]!] !== undefined;
    m = /^(\w+)\s+IS NULL$/.exec(term);
    if (m) return row[m[1]!] === null || row[m[1]!] === undefined;
    throw new Error(`fake DB: unsupported term "${term}"`);
  }

  function updateVideos(sql: string, args: unknown[]): number {
    const [, setPart, wherePart] = /^UPDATE videos SET (.*?) WHERE (.*)$/i.exec(sql) as unknown as [string, string, string];
    // SET carries parameterised and literal assignments. A literal
    // (`visibility = 'hidden'`, `hold_until = NULL`, `bytes = 0`) consumes no
    // parameter, so the two kinds have to be parsed together or every later
    // binding shifts. Every literal form SQLite accepts here is matched: a
    // missing one silently leaves that column unchanged and the test passes
    // against a statement that does not do what it says.
    const assignments = [...setPart.matchAll(/(\w+)\s*=\s*(\?|'[^']*'|NULL|-?\d+(?:\.\d+)?)/gi)].map((m) => {
      const raw = m[2]!;
      const literal = raw === '?' ? undefined : raw === 'NULL' ? null : raw.startsWith("'") ? raw.slice(1, -1) : Number(raw);
      return { col: m[1]!, param: raw === '?', value: literal ?? null };
    });
    if (assignments.length === 0) throw new Error(`fake DB: parsed no SET assignments from: ${setPart}`);
    const paramCount = assignments.filter((a) => a.param).length;
    const setValues = args.slice(0, paramCount);
    const terms = wherePart.split(/\s+AND\s+/);
    let changed = 0;
    for (const row of store.videos.values()) {
      const whereParams = args.slice(paramCount);
      if (!terms.every((t) => evalTerm(t.trim(), row as unknown as Row, whereParams))) continue;
      let i = 0;
      for (const a of assignments) {
        (row as unknown as Row)[a.col] = a.param ? setValues[i++] : a.value;
      }
      changed++;
    }
    return changed;
  }

  function makeStatement(norm: string, args: unknown[]): any {
    return {
      bind(...next: unknown[]) {
        return makeStatement(norm, next);
      },
      async first<T>() {
        const a = args;
        if (/^SELECT \* FROM videos WHERE id = \?/.test(norm)) {
          return (store.videos.get(String(a[0])) ?? null) as T | null;
        }
        if (/COUNT\(DISTINCT reporter_key\)/.test(norm)) {
          const [videoId, since] = a;
          const set = new Set(
            store.reports
              .filter(
                (r) =>
                  r.video_id === videoId &&
                  Number(r.created_at) >= Number(since) &&
                  r.resolved_at === null,
              )
              .map((r) => String(r.reporter_key)),
          );
          return { n: set.size } as T;
        }
        throw new Error(`fake DB: unhandled first(): ${norm}`);
      },
      async all<T>() {
        if (/FROM reports WHERE resolved_at IS NULL/.test(norm)) {
          const videoId = norm.includes('video_id = ?') ? String(args[0]) : null;
          const rows = store.reports.filter(
            (r) => r.resolved_at === null && (videoId === null || r.video_id === videoId),
          );
          // Project the requested columns, not the whole stored row. Without
          // this the fake would hand back `reporter_key` even when the query
          // deliberately leaves it out — the test would assert against a value
          // production never sends.
          const cols = ((/SELECT (.+?) FROM reports/i.exec(norm) ?? ['', ''])[1] ?? '')
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean);
          const projected = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
          return { results: projected as T[] };
        }
        if (/SELECT id FROM videos/.test(norm)) {
          const rows = [...store.videos.values()].filter((v) => {
            const whereParams = args.slice();
            return /visibility = 'hidden'/.test(norm)
              && v.visibility === 'hidden'
              && v.hold_until !== null
              && v.hold_until !== undefined
              && v.hold_until < Number(whereParams[0]);
          });
          return { results: rows.map((v) => ({ id: v.id })) as T[] };
        }
        throw new Error(`fake DB: unhandled all(): ${norm}`);
      },
      async run() {
        const a = args;
        if (/^UPDATE videos/.test(norm)) return { meta: { changes: updateVideos(norm, a) } };
        if (/^UPDATE reports SET resolved_at/.test(norm)) {
          const [at, videoId] = a;
          let n = 0;
          for (const r of store.reports) {
            if (r.video_id === videoId && r.resolved_at === null) {
              r.resolved_at = at;
              n++;
            }
          }
          return { meta: { changes: n } };
        }
        if (/^UPDATE agents SET used_bytes = MAX/.test(norm)) {
          const [bytes, agentId] = a;
          const agent = store.agents.get(String(agentId));
          if (agent) agent.used_bytes = Math.max(0, Number(agent.used_bytes) - Number(bytes));
          return { meta: { changes: agent ? 1 : 0 } };
        }
        if (/INSERT OR IGNORE INTO reports/.test(norm)) {
          // Bind by **column name**, parsed out of the SQL. A positional destructure
          // would keep working after someone drops a column from the column list,
          // hiding the fact that the statement no longer matches the row it builds.
          const cols = ((/INSERT OR IGNORE INTO reports \(([^)]*)\)/.exec(norm) ?? ['', ''])[1] ?? '')
            .split(',')
            .map((c) => c.trim());
          const placeholders = ((/\bVALUES\s*\(([^)]*)\)/.exec(norm) ?? ['', ''])[1] ?? '')
            .split(',')
            .length;
          if (cols.length !== placeholders || cols.length === 0) {
            throw new Error(`fake DB: ${cols.length} columns but ${placeholders} placeholders`);
          }
          const row = Object.fromEntries(cols.map((c, i) => [c, a[i]])) as Row;
          const { video_id: videoId, reporter_key: reporterKey, created_at: createdAt } = row;
          const bucket = Math.floor(Number(createdAt) / day);
          const dup = store.reports.some(
            (r) =>
              r.video_id === videoId &&
              r.reporter_key === reporterKey &&
              Math.floor(Number(r.created_at) / day) === bucket,
          );
          if (dup) return { meta: { changes: 0 } };
          store.reports.push({ ...row, resolved_at: null });
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO (events)/.test(norm)) return { meta: { changes: 1 } };
        if (/DELETE FROM video_segments/.test(norm)) return { meta: { changes: 0 } };
        // Throw, like `first()` and `all()` do. A catch-all here turns a renamed
        // column or a reworded clause into a silently green test that reads as
        // "the row legitimately did not change".
        throw new Error(`fake DB: unhandled run(): ${norm}`);
      },
    };
  }

  const env = {
    DB: {
      prepare(sql: string) {
        return makeStatement(sql.replace(/\s+/g, ' ').trim(), []);
      },
    },
    CACHE: { get: async () => null, put: async () => undefined },
    MEDIA: {
      list: async () => ({ objects: [{ key: `${v.r2_prefix}/init.mp4` }, { key: `${v.r2_prefix}/source` }] }),
      delete: async (keys: string | string[]) => {
        const list = typeof keys === 'string' ? [keys] : keys;
        for (const k of list) store.deleted.push(k);
      },
      put: async (key: string) => void store.put.push(key),
      head: async () => ({ size: v.bytes }),
    },
    PIPELINE_QUEUE: { send: async () => undefined },
    // A permissive limiter stub: these tests are about moderation, and the
    // fail-open path already has its own coverage in rate-limiter.test.ts.
    RATE_LIMITER: {
      idFromName: () => 'rl',
      get: () => ({ fetch: async () => Response.json({ allowed: true, remaining: 9, limit: 10, resetAt: 0, retryAfterS: 0 }) }),
    },
    ENVIRONMENT: 'local',
    ADMIN_TOKEN: 'test-operator-token',
    REPORTER_SALT: 'salt',
    TURNSTILE_SITE_KEY: '',
    ...over,
  } as unknown as Env;

  return { env, store };
}

const report = (videoId = 'vid_1', reason = 'copyright') => ({ videoId, reason });

/** Minimal ExecutionContext — same shape the http tests use. */
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
  tracing: { enabled: false },
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.useRealTimers();
});

describe('reporterKey', () => {
  it('is stable per address on the same video and never contains it', async () => {
    const { env } = makeEnv(video());
    const a = await reporterKey(env, '203.0.113.7', 'vid_1');
    const b = await reporterKey(env, '203.0.113.7', 'vid_1');
    const c = await reporterKey(env, '198.51.100.9', 'vid_1');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain('203.0.113.7');
  });

  it('produces unrelated keys for the same address on different videos', async () => {
    // Without the video in the hashed input this key is a stable per-person
    // correlator across the whole catalogue, and §7.8's "no reporter identity
    // is stored" is false.
    const { env } = makeEnv(video());
    const onA = await reporterKey(env, '203.0.113.7', 'vid_1');
    const onB = await reporterKey(env, '203.0.113.7', 'vid_2');
    expect(onA).not.toBe(onB);
  });

  it('collapses every unattributed caller into one bucket', async () => {
    const { env } = makeEnv(video());
    expect(await reporterKey(env, null, 'vid_1')).toBe('unattributed');
  });

  it('changes when the salt changes, so hashes are not portable', async () => {
    const { env } = makeEnv(video());
    const other = makeEnv(video(), { REPORTER_SALT: 'other-salt' }).env;
    expect(await reporterKey(env, '203.0.113.7', 'vid_1')).not.toBe(
      await reporterKey(other, '203.0.113.7', 'vid_1'),
    );
  });

  it('keeps reporting usable when the salt is unset, but collapses everyone', async () => {
    // Failing closed by throwing would 500 the public report endpoint and
    // silently disable CSAM reporting. Collapsing to one bucket is the safe
    // direction instead: reports still reach the operator queue, and an
    // anonymous quorum hide becomes impossible.
    for (const salt of ['', 'REPLACE_WITH_RANDOM_SALT']) {
      const bad = makeEnv(video(), { REPORTER_SALT: salt }).env;
      expect(reportSaltMissing(bad)).toBe(true);
      expect(await reporterKey(bad, '203.0.113.7', 'vid_1')).toBe('unattributed');
      expect(await reporterKey(bad, '198.51.100.9', 'vid_1')).toBe('unattributed');
    }
    expect(reportSaltMissing(makeEnv(video()).env)).toBe(false);
  });
});

describe('submitReport — one reporter is one report', () => {
  it('does not hide on a single report', async () => {
    const { env, store } = makeEnv(video());
    const res = await submitReport(env, report(), '203.0.113.7');
    expect(res.counted).toBe(true);
    expect(store.videos.get('vid_1')!.visibility).toBe('public');
    expect(store.videos.get('vid_1')!.hold_until).toBeNull();
  });

  it('counts repeat reports from the same address only once', async () => {
    const { env, store } = makeEnv(video());
    await submitReport(env, report(), '203.0.113.7');
    const second = await submitReport(env, report(), '203.0.113.7');
    const third = await submitReport(env, report(), '203.0.113.7');
    expect(second.counted).toBe(false);
    expect(third.counted).toBe(false);
    expect(store.reports).toHaveLength(1);
    // The bug: three requests from one actor used to reach the quorum.
    expect(store.videos.get('vid_1')!.visibility).toBe('public');
  });

  it('hides after three DISTINCT reporters, and only as a hold', async () => {
    const { env, store } = makeEnv(video());
    await submitReport(env, report(), '203.0.113.1');
    await submitReport(env, report(), '203.0.113.2');
    await submitReport(env, report(), '203.0.113.3');

    const v = store.videos.get('vid_1')!;
    expect(v.visibility).toBe('hidden');
    // A deadline, not a permanent removal: the sweeper restores it.
    expect(v.hold_until).toBeGreaterThan(Date.now());
    // Still `ready` — an anonymous path may never write status.
    expect(v.status).toBe('ready');
  });

  it('refuses to hide a video that is not publicly ready', async () => {
    const { env, store } = makeEnv(video({ status: 'probed' }));
    await submitReport(env, report(), '203.0.113.1');
    await submitReport(env, report(), '203.0.113.2');
    await submitReport(env, report(), '203.0.113.3');
    expect(store.videos.get('vid_1')!.visibility).toBe('public');
  });

  it('rejects an invalid reason', async () => {
    const { env } = makeEnv(video());
    await expect(submitReport(env, report('vid_1', 'because'), '1.1.1.1')).rejects.toThrow(/must be one of/);
  });

  it('answers 202 for an unknown video, so the endpoint is not an existence oracle', async () => {
    // A 400 here told a prober that `vid_x` is a real video — including a
    // never-published draft. The reporter learns nothing either way.
    const { env, store } = makeEnv(video());
    const res = await submitReport(env, report('vid_nope'), '1.1.1.1');
    expect(res).toEqual({ accepted: true, counted: false });
    expect(store.reports).toHaveLength(0);
  });
});

describe('operator surface', () => {
  const authed = (token: string) => new Request('https://x/api/admin/reports', { headers: { authorization: `Bearer ${token}` } });

  it('is disabled entirely when ADMIN_TOKEN is unset — never open', async () => {
    const { env } = makeEnv(video(), { ADMIN_TOKEN: '' });
    const { handleAdminRoutes } = await import('../src/worker/routes/admin.js');
    // Not a 401 and not a 200: the surface is off, and it says so.
    const res = await handleAdminRoutes(authed('anything'), env, ctx);
    expect(res.status).toBe(503);
  });

  it('rejects a missing or wrong token on the real handler', async () => {
    const { env } = makeEnv(video());
    const { handleAdminRoutes } = await import('../src/worker/routes/admin.js');

    const none = await handleAdminRoutes(new Request('https://x/api/admin/reports'), env, ctx);
    expect(none.status).toBe(401);

    const wrong = await handleAdminRoutes(authed('nope'), env, ctx);
    expect(wrong.status).toBe(401);

    const good = await handleAdminRoutes(authed('test-operator-token'), env, ctx);
    expect(good.status).toBe(200);
    expect(((await good.json()) as { reports: unknown[] }).reports).toEqual([]);
  });

  it('never sends CORS headers on the operator surface', async () => {
    const { env } = makeEnv(video());
    const { handleAdminRoutes } = await import('../src/worker/routes/admin.js');
    const res = await handleAdminRoutes(authed('test-operator-token'), env, ctx);
    // The public routes answer with `access-control-allow-origin: *`; an
    // operator endpoint must not, or any page could drive it with the token.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('returns 401 for an unauthenticated POST, not 405', async () => {
    // Authenticating after the method check turns the endpoint into an oracle:
    // 405 confirms to anyone that the path exists and which methods it takes.
    const { env } = makeEnv(video());
    const { handleAdminRoutes } = await import('../src/worker/routes/admin.js');
    const res = await handleAdminRoutes(
      new Request('https://x/api/admin/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId: 'vid_1', action: 'quarantine' }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
    // And a wrong token on POST is 401 too, not 405.
    const wrong = await handleAdminRoutes(
      new Request('https://x/api/admin/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
        body: JSON.stringify({ videoId: 'vid_1', action: 'quarantine' }),
      }),
      env,
      ctx,
    );
    expect(wrong.status).toBe(401);
  });

  it('never hands reporter_key to the operator', async () => {
    // The key is salted per video, but returning it would still give whoever
    // holds ADMIN_TOKEN a within-video identity the platform never keeps, and
    // the queue does not need it to decide anything.
    const { env } = makeEnv(video());
    await submitReport(env, report(), '203.0.113.1');
    const { handleAdminRoutes } = await import('../src/worker/routes/admin.js');
    const res = await handleAdminRoutes(authed('test-operator-token'), env, ctx);
    const body = (await res.json()) as { reports: Record<string, unknown>[] };
    expect(body.reports).toHaveLength(1);
    expect(Object.keys(body.reports[0]!)).not.toContain('reporter_key');
  });

  it('lists only unresolved reports', async () => {
    const { env, store } = makeEnv(video());
    await submitReport(env, report(), '203.0.113.1');
    const before = await listReports(env, 'vid_1');
    expect(before.reports).toHaveLength(1);
    // Confirm sharpens an existing hide, so the video has to be hidden first.
    await resolveReport(env, { videoId: 'vid_1', action: 'quarantine' });
    const after = await listReports(env, 'vid_1');
    expect(after.reports).toHaveLength(0);
    expect(store.reports[0]!.resolved_at).not.toBeNull();
  });

  it('confirm on a video that is not hidden changes nothing and says so', async () => {
    // The bug this pins: `confirm` used to report `visibility: 'hidden'` from
    // intent while its WHERE matched zero rows, so an operator script was told
    // a takedown landed on a video that was still public.
    const { env, store } = makeEnv(video());
    await submitReport(env, report(), '203.0.113.1');

    const res = await resolveReport(env, { videoId: 'vid_1', action: 'confirm' });

    expect(res.applied).toBe(false);
    expect(res.visibility).toBe('public');
    expect(store.videos.get('vid_1')!.visibility).toBe('public');
    // And the report stays in the queue: nothing was decided.
    expect(store.reports[0]!.resolved_at).toBeNull();
  });

  it('restore lifts the hold and resolves the reports', async () => {
    const { env, store } = makeEnv(video());
    await submitReport(env, report(), '203.0.113.1');
    await submitReport(env, report(), '203.0.113.2');
    await submitReport(env, report(), '203.0.113.3');
    expect(store.videos.get('vid_1')!.visibility).toBe('hidden');

    const res = await resolveReport(env, { videoId: 'vid_1', action: 'restore' });
    expect(res.visibility).toBe('public');
    expect(store.videos.get('vid_1')!.visibility).toBe('public');
    expect(store.videos.get('vid_1')!.hold_until).toBeNull();
  });

  it('restore will not resurrect a quarantined video', async () => {
    const { env, store } = makeEnv(video({ status: 'quarantined', visibility: 'hidden', hold_until: null }));
    const res = await resolveReport(env, { videoId: 'vid_1', action: 'restore' });
    expect(res.visibility).toBe('hidden');
    expect(store.videos.get('vid_1')!.visibility).toBe('hidden');
  });

  it('restore will not resurrect a video that was never scanned clean', async () => {
    // Isolates `scan_state` from `status`. Today `ready` implies `clean` —
    // `handleScan` sets both in one transition — so this row is not reachable
    // through the pipeline. The check stays because `restore` is an operator
    // surface: it reads whatever is in the row, and the two columns are allowed
    // to drift if a future transition ever sets only one.
    const { env, store } = makeEnv(
      video({ status: 'ready', scan_state: 'pending', visibility: 'hidden', hold_until: null }),
    );
    const res = await resolveReport(env, { videoId: 'vid_1', action: 'restore' });
    expect(res.visibility).toBe('hidden');
    expect(store.videos.get('vid_1')!.visibility).toBe('hidden');
  });

  it('confirm makes the hide permanent by clearing the deadline', async () => {
    const { env, store } = makeEnv(video());
    await submitReport(env, report(), '203.0.113.1');
    await submitReport(env, report(), '203.0.113.2');
    await submitReport(env, report(), '203.0.113.3');

    await resolveReport(env, { videoId: 'vid_1', action: 'confirm' });
    expect(store.videos.get('vid_1')!.visibility).toBe('hidden');
    // hold_until NULL is what tells the sweeper to leave it alone.
    expect(store.videos.get('vid_1')!.hold_until).toBeNull();
  });

  it('quarantine purges every object including the source, and refunds quota', async () => {
    const { env, store } = makeEnv(video());
    const res = await resolveReport(env, { videoId: 'vid_1', action: 'quarantine' });

    const v = store.videos.get('vid_1')!;
    expect(res.applied).toBe(true);
    expect(v.status).toBe('quarantined');
    expect(v.visibility).toBe('private');
    expect(store.deleted).toContain('videos/vid_1/init.mp4');
    // The raw source goes too. Keeping it "as evidence" would leave confirmed
    // malware fetchable by URL, which is the whole reason a quarantine purges.
    expect(store.deleted).toContain('videos/vid_1/source');
    expect(store.agents.get('agt_1')!.used_bytes).toBe(0);
  });

  it('unquarantine clears the verdict without pretending the media came back', async () => {
    // Without this the action set had a one-way door: `restore` refuses anything
    // that is not ready+clean, so a wrong quarantine could never be undone.
    const { env, store } = makeEnv(video());
    await resolveReport(env, { videoId: 'vid_1', action: 'quarantine' });
    expect(store.videos.get('vid_1')!.status).toBe('quarantined');

    const res = await resolveReport(env, { videoId: 'vid_1', action: 'unquarantine' });

    expect(res.applied).toBe(true);
    const v = store.videos.get('vid_1')!;
    // Not public: quarantine deleted every object, so there is nothing to serve.
    expect(v.status).toBe('failed');
    expect(v.visibility).toBe('private');
    expect(v.bytes).toBe(0);
    // Quota was already released by the quarantine; a second refund would be
    // storage nobody was ever charged for.
    expect(store.agents.get('agt_1')!.used_bytes).toBe(0);
  });

  it('unquarantine on a video that is not quarantined changes nothing', async () => {
    const { env, store } = makeEnv(video());
    const res = await resolveReport(env, { videoId: 'vid_1', action: 'unquarantine' });
    expect(res.applied).toBe(false);
    expect(store.videos.get('vid_1')!.status).toBe('ready');
  });

  it('rejects an unknown action', async () => {
    const { env } = makeEnv(video());
    await expect(resolveReport(env, { videoId: 'vid_1', action: 'delete' })).rejects.toThrow(/must be one of/);
  });
});

describe('releaseExpiredHolds', () => {
  it('restores an expired hold', async () => {
    const { env, store } = makeEnv(video({ visibility: 'hidden', hold_until: Date.now() - 1000 }));
    const n = await releaseExpiredHolds(env);
    expect(n).toBe(1);
    expect(store.videos.get('vid_1')!.visibility).toBe('public');
  });

  it('leaves a confirmed hide alone (no deadline)', async () => {
    const { env, store } = makeEnv(video({ visibility: 'hidden', hold_until: null }));
    expect(await releaseExpiredHolds(env)).toBe(0);
    expect(store.videos.get('vid_1')!.visibility).toBe('hidden');
  });

  it('leaves a hold that has not expired', async () => {
    const { env, store } = makeEnv(video({ visibility: 'hidden', hold_until: Date.now() + 60_000 }));
    expect(await releaseExpiredHolds(env)).toBe(0);
    expect(store.videos.get('vid_1')!.visibility).toBe('hidden');
  });

  it('never restores something that is not ready and clean', async () => {
    const { env, store } = makeEnv(
      video({ visibility: 'hidden', hold_until: Date.now() - 1000, status: 'quarantined' }),
    );
    expect(await releaseExpiredHolds(env)).toBe(0);
    expect(store.videos.get('vid_1')!.visibility).toBe('hidden');
  });
});

describe('turnstile gate', () => {
  it('rejects registration on a production deploy with no configuration', async () => {
    const { env } = makeEnv(video(), { ENVIRONMENT: 'production' });
    await expect(verifyTurnstile(env, 'token', '1.1.1.1')).rejects.toThrow(/not configured for a production/);
  });

  it('still allows local dev without secrets', async () => {
    const { env } = makeEnv(video(), { ENVIRONMENT: 'local' });
    await expect(verifyTurnstile(env, 'token', '1.1.1.1')).resolves.toBeUndefined();
  });
});
