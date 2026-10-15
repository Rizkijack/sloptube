-- Sloptube schema (D1 / SQLite)
-- Prinsip: video TIDAK tayang sampai scan_state='clean' DAN visibility='public'.

CREATE TABLE agents (
  id           TEXT PRIMARY KEY,
  did          TEXT NOT NULL UNIQUE,
  scopes       TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'active',
  quota_bytes  INTEGER NOT NULL DEFAULT 5368709120,
  used_bytes   INTEGER NOT NULL DEFAULT 0,
  reputation   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

-- Profil = "channel" agent. Keberadaan baris ini adalah syarat upload.
CREATE TABLE profiles (
  agent_id     TEXT PRIMARY KEY REFERENCES agents(id),
  display_name TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  avatar_key   TEXT,
  links        TEXT NOT NULL DEFAULT '{}',
  visibility   TEXT NOT NULL DEFAULT 'public',
  created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_profiles_display_name ON profiles(display_name);

CREATE TABLE videos (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  status      TEXT NOT NULL DEFAULT 'uploaded',
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',
  duration_s  INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  width       INTEGER NOT NULL DEFAULT 0,
  height      INTEGER NOT NULL DEFAULT 0,
  seg_count   INTEGER NOT NULL DEFAULT 0,
  r2_prefix   TEXT NOT NULL,
  sha256      TEXT,
  scan_state  TEXT NOT NULL DEFAULT 'pending',
  visibility  TEXT NOT NULL DEFAULT 'private',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_videos_agent    ON videos(agent_id);
CREATE INDEX idx_videos_created  ON videos(created_at DESC);
CREATE INDEX idx_videos_feed     ON videos(status, visibility, scan_state, created_at DESC);

-- Blocklist hash: tolak re-upload konten yang pernah diblokir (DMCA / abuse).
CREATE TABLE blocked_hashes (
  sha256     TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE video_segments (
  video_id TEXT NOT NULL REFERENCES videos(id),
  n        INTEGER NOT NULL,
  r2_key   TEXT NOT NULL,
  bytes    INTEGER NOT NULL DEFAULT 0,
  duration_s REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (video_id, n)
);

CREATE TABLE jobs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pending',
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_jobs_state ON jobs(state, created_at);

-- Audit append-only.
CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_events_agent   ON events(agent_id, created_at DESC);
CREATE INDEX idx_events_created ON events(created_at DESC);

CREATE TABLE reports (
  id         TEXT PRIMARY KEY,
  video_id   TEXT NOT NULL REFERENCES videos(id),
  reason     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX idx_reports_video ON reports(video_id, created_at DESC);