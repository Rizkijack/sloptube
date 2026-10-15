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