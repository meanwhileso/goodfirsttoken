import type { ProjectRecord, ProjectStatus, ProjectStatusChange } from '@goodfirsttoken/core';
import { adminGithubIds } from '../auth/settings';

// The rules for who may change a project's status, in one place for the
// maintainer's tools and the admin's. docs/how-it-works.md has them under
// Managing a project.

/**
 * Who can lift the project's pause, or null when it isn't paused. A pause
 * Good First Token made on its own, like a delisting, names no one, and it
 * counts as an admin's. So does one made by someone who is an admin now,
 * read from ADMIN_GITHUB_IDS at the time.
 */
export function resumableBy(project: ProjectRecord): 'maintainers' | 'admins' | null {
  if (project.status !== 'paused') return null;
  const by = project.statusChangedBy;
  return by === null || adminGithubIds().has(by) ? 'admins' : 'maintainers';
}

/**
 * The status and reason a resume puts back: the change before the pause,
 * from the status history, newest first. A history with nothing before the
 * pause puts back `pending`, so a resume never approves a project an admin
 * hasn't.
 */
export function statusBeforePause(history: readonly ProjectStatusChange[]): {
  status: ProjectStatus;
  reason: string | null;
} {
  const before = history.find((change) => change.status !== 'paused');
  return { status: before?.status ?? 'pending', reason: before?.reason ?? null };
}
