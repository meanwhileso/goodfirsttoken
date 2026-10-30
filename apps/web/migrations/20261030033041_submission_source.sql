-- How each claim's work reached its branch (docs/specs/agent-submits.md):
-- 'files', which the server committed, or 'branch', which the donor's agent
-- pushed. Every submission before this one was files.
ALTER TABLE submissions ADD COLUMN source TEXT NOT NULL DEFAULT 'files'
  CHECK (source IN ('files', 'branch'));
