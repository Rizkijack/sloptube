-- Moderation: per-reporter dedup and a time-boxed hide hold.
--
-- 0001 made `reports` a plain log, so one actor could file three reports and
-- hide any video permanently. Two changes close that:
--   * a reporter_key (hashed IP, never the address) plus a UNIQUE index that
--     caps one report per video per reporter per day — enforced by the database,
--     so concurrent requests cannot race past it;
--   * a hold_until deadline on videos, so an anonymous hide is a hold that the
--     sweeper restores. Only an operator (routes/admin.ts) can make it stick.

ALTER TABLE reports ADD COLUMN reporter_key TEXT NOT NULL DEFAULT 'unattributed';

CREATE UNIQUE INDEX idx_reports_dedup
  ON reports (video_id, reporter_key, created_at / 86400000);

CREATE INDEX idx_reports_unresolved
  ON reports (video_id, resolved_at, created_at DESC);

ALTER TABLE videos ADD COLUMN hold_until INTEGER;

CREATE INDEX idx_videos_hold ON videos (visibility, hold_until);
