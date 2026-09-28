-- The donor's tools (src/mcp/donor.ts). docs/architecture.md describes each
-- change.

-- A session's queue: the donor's picks not claimed yet, as a JSON list of
-- issues in order. claim_issue with no issue claims the next.
ALTER TABLE donor_sessions ADD COLUMN queue TEXT NOT NULL DEFAULT '[]';

-- The code repo's main language, as GitHub named it when the sync last read
-- the repo, which suggestions are ranked by. Null when GitHub names none.
ALTER TABLE issue_syncs ADD COLUMN language TEXT;

-- A donor's word that they signed a project's CLA, at the link the project
-- had then. One row per donor and project, so the donor is asked once, and
-- again when the link changes. project has no reference to projects, like a
-- claim's, so a confirmation outlives a listing.
CREATE TABLE cla_confirmations (
  github_id INTEGER NOT NULL REFERENCES people (github_id),
  project TEXT NOT NULL COLLATE NOCASE,
  cla_url TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL,
  PRIMARY KEY (github_id, project)
) STRICT;
