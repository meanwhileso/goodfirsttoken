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

/**
 * The pause someone made that a pause Good First Token made took over, or
 * null: the status change before the latest, from the status history, newest
 * first, when the latest is a pause that names no one and the one before it
 * is a pause that names someone, a maintainer or an admin. The policy
 * crawler's pause on a ban takes over any pause, and lifting it puts this
 * one back.
 */
export function pauseTakenOver(history: readonly ProjectStatusChange[]): ProjectStatusChange | null {
  const [latest, before] = history;
  if (latest?.status !== 'paused' || latest.changedBy !== null) return null;
  return before?.status === 'paused' && before.changedBy !== null ? before : null;
}

/**
 * The change an admin's resume makes, with admin_pause_project or by
 * approving a pause in the admin queue, from the status history, newest
 * first. When the pause took over one someone made, it puts that one back,
 * with its reason, named for whoever made it, so they lift it, and
 * `restored` is true. Otherwise it puts back the status before the pause,
 * named for the admin.
 */
export function adminResume(
  history: readonly ProjectStatusChange[],
  admin: number,
): { status: ProjectStatus; reason: string | null; changedBy: number | null; restored: boolean } {
  const taken = pauseTakenOver(history);
  if (taken !== null) return { status: 'paused', reason: taken.reason, changedBy: taken.changedBy, restored: true };
  return { ...statusBeforePause(history), changedBy: admin, restored: false };
}
