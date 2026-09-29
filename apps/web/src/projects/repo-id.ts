import { githubRepoId } from '@goodfirsttoken/core';
import { fillRepoId, type StoredRepoId } from '../db';

// A project is kept under its repo's name, and GitHub can give that name to
// another repo after a rename or a delete. So each project also keeps
// GitHub's numeric ID for its code repo and its issue repo, which a repo
// keeps through a rename or a transfer and never passes on. Every read that
// decides something about a project's repo compares the ID GitHub gives now
// with the one stored: the maintainer check, an admin's listing, and the
// sync. The rules are in docs/how-it-works.md, under Permissions.

/** Who a repo is, from GitHub's read of it: its ID, and when GitHub made it. */
export interface RepoIdentity {
  id: number;
  /** In milliseconds since the epoch, or null when GitHub didn't say. */
  createdAt: number | null;
}

/**
 * GitHub's ID for a repo and when it made it, from a REST read of the repo,
 * or null when the answer has no ID in GitHub's form.
 * https://docs.github.com/en/rest/repos/repos#get-a-repository
 */
export function identityOf(found: { id?: unknown; created_at?: unknown }): RepoIdentity | null {
  const id = githubRepoId.safeParse(found.id);
  if (!id.success) return null;
  const createdAt = typeof found.created_at === 'string' ? Date.parse(found.created_at) : Number.NaN;
  return { id: id.data, createdAt: Number.isFinite(createdAt) ? createdAt : null };
}

/**
 * Whether the repo GitHub gave under a stored name is the one stored there.
 *
 * - `same`: the stored ID is GitHub's.
 * - `fill`: nothing is stored, from a project kept before IDs were, and
 *   GitHub made the repo no later than the project took the name. The name
 *   is trusted this once, and the ID is stored.
 * - `other`: GitHub's ID differs from the stored one, or nothing is stored
 *   and GitHub made the repo after the project took the name, or didn't say
 *   when. Either way it is a different repo under the name.
 */
export function compareRepo(stored: StoredRepoId, found: RepoIdentity): 'same' | 'fill' | 'other' {
  if (stored.id !== null) return stored.id === found.id ? 'same' : 'other';
  return found.createdAt !== null && found.createdAt <= stored.since ? 'fill' : 'other';
}

/**
 * Whether the repo GitHub gave is the one every stored ID names. It stores
 * GitHub's ID where a project stored none, as compareRepo allows, but only
 * when no stored ID names a different repo. True when nothing is stored.
 */
export async function isStoredRepo(db: D1Database, stored: readonly StoredRepoId[], found: RepoIdentity): Promise<boolean> {
  const verdicts = stored.map((entry) => ({ entry, verdict: compareRepo(entry, found) }));
  if (verdicts.some(({ verdict }) => verdict === 'other')) return false;
  for (const { entry, verdict } of verdicts) {
    if (verdict === 'fill') await fillRepoId(db, entry, found.id);
  }
  return true;
}
