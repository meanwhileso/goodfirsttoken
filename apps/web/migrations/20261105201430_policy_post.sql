-- For a project an admin listed from a maintainer's post on X, the evidence
-- for the post, as JSON: who posted it, their role for the repo, and where
-- each fact comes from (src/db/projects.ts). The policy's quote and link are
-- the post's. Null for a policy from the repo's own docs, and for a
-- registered project.
ALTER TABLE projects ADD COLUMN policy_post TEXT
  CHECK (policy_post IS NULL OR json_valid(policy_post));
