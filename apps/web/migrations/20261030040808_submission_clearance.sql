-- open_pr's word that pushed work may become a PR (docs/specs/agent-submits.md):
-- the head it cleared, the PR body it gave, and when. A PR counts only from
-- that head. A later submit clears all three. All three are null until then.
ALTER TABLE submissions ADD COLUMN cleared_commit TEXT;
ALTER TABLE submissions ADD COLUMN cleared_body TEXT;
ALTER TABLE submissions ADD COLUMN cleared_at INTEGER;
