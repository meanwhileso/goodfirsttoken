-- When the read that last saved a PR's review counts was made, by the PR
-- job or by a check a donor asked for (src/sync/pr-checker.ts). The two
-- can read the same PR at once, so a read made before the one stored
-- changes nothing, and no review is counted twice. Null until a read
-- saves the PR's counts.
ALTER TABLE prs ADD COLUMN reviews_read_at INTEGER;
