-- GitHub's numeric ID for each project's code repo and issue repo
-- (src/projects/repo-id.ts). docs/architecture.md describes the change.

-- A repo's name can pass to another repo after a rename or a delete. Its ID
-- never does. repo_id is the ID of the repo in repo, and issue_repo_id of
-- the repo in issue_repo, the same as repo_id when the issues live in the
-- code repo. A project stored before this has neither, and the next read of
-- each repo fills it in, once, when GitHub made the repo before Good First
-- Token stored its name.
ALTER TABLE projects ADD COLUMN repo_id INTEGER;
ALTER TABLE projects ADD COLUMN issue_repo_id INTEGER;
