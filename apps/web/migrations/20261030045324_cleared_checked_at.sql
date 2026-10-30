-- When the job that records cleared PRs (src/sync/cleared.ts) last looked
-- up the claim's branch on GitHub, so each run reads the claims read
-- longest ago first. Null until the job first reads it.
ALTER TABLE submissions ADD COLUMN cleared_checked_at INTEGER;
