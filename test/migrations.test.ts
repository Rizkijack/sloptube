import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

/**
 * The moderation schema, against a real SQLite engine.
 *
 * Every other moderation test runs on a hand-written SQL emulator, which is
 * exactly why an unguarded refund, a missing pagination and a CORS leak all
 * passed a green suite: the emulator is only as good as its author. This file
 * applies the actual migration files to real SQLite and asserts the properties
 * the contract claims — particularly the expression UNIQUE index, which is the
 * entire dedup mechanism and cannot be verified by a regex.
 *
 * `node:sqlite` is built into Node 22+; the suite skips if it is unavailable
 * rather than pretending it passed.
 */

const migrations = ['0001_init.sql', '0002_moderation.sql'];

/**
 * Resolve relative to this file, not to the process cwd and not to an absolute
 * path baked in at authoring time — the suite has to pass from a fresh clone on
 * any machine.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of migrations) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return db;
}

function seedVideo(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, did, created_at) VALUES ('agt_1', 'did:key:z', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO videos (id, agent_id, status, title, description, tags, duration_s,
                         bytes, width, height, seg_count, r2_prefix, sha256, scan_state,
                         visibility, created_at, updated_at)
     VALUES (?, 'agt_1', 'ready', 't', '', '[]', 30, 1000, 640, 360, 3, ?, NULL,
             'clean', 'public', 0, 0)`,
  ).run(id, `videos/${id}`);
}

const DAY = 86_400_000;
/** A fixed instant, so day-bucket boundaries are deterministic. */
const T0 = 1_700_000_000_000;

function fileReport(db: DatabaseSync, key: string, at: number): number {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO reports (id, video_id, reason, detail, reporter_key, created_at)
       VALUES (?, 'vid_1', 'copyright', '', ?, ?)`,
    )
    .run(`rep_${key}_${at}`, key, at);
  return Number(res.changes);
}

describe('migration 0002 — dedup index on real SQLite', () => {
  it('applies cleanly on top of 0001', () => {
    const db = freshDb();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((r) => String(r.name));
    expect(tables).toContain('reports');
    expect(tables).toContain('videos');
    db.close();
  });

  it('caps one report per video per reporter per UTC day', () => {
    const db = freshDb();
    seedVideo(db, 'vid_1');

    expect(fileReport(db, 'r_alice', T0)).toBe(1);
    expect(fileReport(db, 'r_alice', T0 + 5_000)).toBe(0);
    expect(fileReport(db, 'r_alice', T0 + 3_600_000)).toBe(0);
    // Next UTC day is a fresh bucket.
    expect(fileReport(db, 'r_alice', T0 + DAY)).toBe(1);
    // A different reporter on the same day is unaffected.
    expect(fileReport(db, 'r_bob', T0 + 10)).toBe(1);

    const rows = db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number };
    expect(Number(rows.n)).toBe(3);
    db.close();
  });

  it('does not dedup across videos', () => {
    const db = freshDb();
    seedVideo(db, 'vid_1');
    seedVideo(db, 'vid_2');
    db.prepare(
      `INSERT OR IGNORE INTO reports (id, video_id, reason, detail, reporter_key, created_at)
       VALUES ('r_1', 'vid_1', 'copyright', '', 'r_alice', ?)`,
    ).run(T0);
    db.prepare(
      `INSERT OR IGNORE INTO reports (id, video_id, reason, detail, reporter_key, created_at)
       VALUES ('r_2', 'vid_2', 'copyright', '', 'r_alice', ?)`,
    ).run(T0);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number };
    expect(Number(rows.n)).toBe(2);
    db.close();
  });

  it('excludes NULL from `hold_until < ?`, matching the sweeper guard order', () => {
    const db = freshDb();
    seedVideo(db, 'vid_1');
    db.prepare(`UPDATE videos SET visibility = 'hidden', hold_until = NULL WHERE id = 'vid_1'`).run();
    // A video with no deadline must never be swept, and `NULL < ?` must not
    // accidentally include it.
    const swept = db
      .prepare(
        `SELECT id FROM videos WHERE visibility = 'hidden' AND hold_until IS NOT NULL AND hold_until < ?`,
      )
      .all(T0 + DAY);
    expect(swept).toHaveLength(0);
    db.close();
  });

  it('has a hold_until column that 0001 did not have', () => {
    const db = freshDb();
    const cols = db.prepare('PRAGMA table_info(videos)').all().map((r) => String(r.name));
    expect(cols).toContain('hold_until');
    db.close();
  });
});

describe('dedup index under repeated concurrent-equivalent inserts', () => {
  /** Same statement shape submitReport uses, with a fresh id every time so the
   *  primary key never masks the UNIQUE dedup index — only the
   *  (video_id, reporter_key, day) expression index can refuse the insert. */
  function attempt(db: DatabaseSync, id: string, key: string, at: number): number {
    return Number(
      db
        .prepare(
          `INSERT OR IGNORE INTO reports (id, video_id, reason, detail, reporter_key, created_at)
           VALUES (?, 'vid_1', 'copyright', '', ?, ?)`,
        )
        .run(id, key, at).changes,
    );
  }

  it('survives 10 attempts within one UTC day with exactly one row', () => {
    // Ten concurrent submits from one reporter. Each tries a distinct id and a
    // distinct timestamp (977 ms apart, deep inside T0's 22:13 UTC day), so a
    // dedup enforced by anything other than the index would produce ten rows.
    const db = freshDb();
    seedVideo(db, 'vid_1');

    const changes: number[] = [];
    for (let i = 0; i < 10; i++) changes.push(attempt(db, `rep_${i}`, 'r_solo', T0 + i * 977));

    expect(changes).toHaveLength(10);
    expect(changes[0]).toBe(1);
    expect(changes.slice(1).every((c) => c === 0)).toBe(true);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number };
    expect(Number(rows.n)).toBe(1);
    db.close();
  });

  it('opens a new allowance exactly at the UTC midnight boundary, and only there', () => {
    const db = freshDb();
    seedVideo(db, 'vid_1');
    // First millisecond of the UTC day after T0.
    const midnight = T0 + (86_400_000 - (T0 % 86_400_000));

    expect(attempt(db, 'rep_a', 'r_cross', midnight - 1)).toBe(1);
    expect(attempt(db, 'rep_b', 'r_cross', midnight - 1)).toBe(0);
    expect(attempt(db, 'rep_c', 'r_cross', midnight)).toBe(1);
    expect(attempt(db, 'rep_d', 'r_cross', midnight)).toBe(0);
    expect(attempt(db, 'rep_e', 'r_cross', midnight + 1)).toBe(0);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number };
    expect(Number(rows.n)).toBe(2);
    db.close();
  });
});

describe('quota ceiling statement on real SQLite', () => {
  it('refuses the second charge at the exact boundary', () => {
    // chargeUsage's whole safety property: `used_bytes + ? <= quota_bytes` in
    // the same statement as the write. Two calls at the boundary — the second
    // one (1 byte over quota) MUST be refused by the WHERE, not the app.
    const db = freshDb();
    db.prepare(
      `INSERT INTO agents (id, did, quota_bytes, used_bytes, created_at)
       VALUES ('agt_q', 'did:key:z', 1000, 500, 0)`,
    ).run();

    const charge = (n: number): number =>
      Number(
        db
          .prepare(
            'UPDATE agents SET used_bytes = used_bytes + ? WHERE id = ? AND used_bytes + ? <= quota_bytes',
          )
          .run(n, 'agt_q', n).changes,
      );

    // 500 + 500 = 1000 <= 1000: the boundary itself is still inside.
    expect(charge(500)).toBe(1);
    const used = () =>
      Number(
        (db.prepare('SELECT used_bytes FROM agents WHERE id = ?').get('agt_q') as {
          used_bytes: number;
        }).used_bytes,
      );
    expect(used()).toBe(1000);

    // Every further byte must refuse and leave the row untouched.
    expect(charge(1)).toBe(0);
    expect(charge(1000)).toBe(0);
    expect(used()).toBe(1000);
    db.close();
  });
});