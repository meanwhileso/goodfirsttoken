-- A crawler find or a policy change the crawler held out of the admin queue,
-- since it failed a check for listing or applying it on its own
-- (docs/specs/held-items.md). held_at is when, and held_why why, both null
-- while it isn't held. A held one still waits, so an admin can decide it.
ALTER TABLE crawl_candidates ADD COLUMN held_at INTEGER;
ALTER TABLE crawl_candidates ADD COLUMN held_why TEXT;
ALTER TABLE policy_changes ADD COLUMN held_at INTEGER;
ALTER TABLE policy_changes ADD COLUMN held_why TEXT;
