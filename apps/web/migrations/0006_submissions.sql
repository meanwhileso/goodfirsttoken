-- The work each claim submitted (src/mcp/submit.ts). docs/architecture.md
-- describes the table.

-- One row per claim: its branch, and what its latest submit sent. repo is
-- where the branch is, the project's code repo or the donor's fork, as
-- GitHub named it. paths is a JSON list of the paths the latest submit sent,
-- so the next submit can put back a file it leaves out. summary and checks
-- are the agent's, with keys and tokens replaced. review_reason is why the
-- work waits for the donor, or null when its PR was to open by itself.
CREATE TABLE submissions (
  claim_id TEXT PRIMARY KEY REFERENCES claims (id),
  repo TEXT NOT NULL COLLATE NOCASE,
  branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  paths TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  checks TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  additions INTEGER,
  deletions INTEGER,
  review_reason TEXT,
  submitted_at INTEGER NOT NULL
) STRICT;
