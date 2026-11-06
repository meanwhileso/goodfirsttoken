-- The policy crawler stopped searching GitHub (docs/specs/model-policy-reader.md,
-- under Where new repos come from). Its cron job queues the seeds and the
-- listed projects that are due, so the search's records go: the record of
-- repos queued in a pass, the popular sample's checkpoint, and the pass
-- checkpoints. crawl_queued_repos names crawl_passes, so it goes first.
-- A seed keeps its handled_at, and is due again 30 days after it.
DROP TABLE crawl_queued_repos;
DROP TABLE popular_crawl_passes;
DROP TABLE crawl_passes;
