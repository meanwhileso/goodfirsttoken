import { mustParse, repoName, type RefusalCode } from '@goodfirsttoken/core';
import { GitHubError, gitHubRest } from '../github';
import { adminGithubIds } from './settings';

// Every action goes through one named permission check, requirePermission.
// docs/how-it-works.md lists the permissions and who holds each.

/** The person asking, from their web session or their agent's grant. */
export interface Caller {
  githubId: number;
  login: string;
  /** The caller's own GitHub token. Only a check that asks GitHub reads it. */
  gitHubToken: () => Promise<string | null>;
}

/** Each permission, and what it applies to. */
interface Resources {
  /** See the admin queue, and approve or reject what waits in it. */
  review_projects: undefined;
  /** List a project from its written policy, or edit such a listing. */
  list_from_policy: undefined;
  /** Block a donor, or lift a block. */
  block_donors: undefined;
  /** Pause any project. */
  pause_any_project: undefined;
  /** Register a repo as a project, change its settings, or pause it. */
  manage_project: { repo: string };
  /** Post to a claim, submit its work, release it, or open its PR. */
  work_claim: { claimantGithubId: number };
}

export type Permission = keyof Resources;

const ADMIN_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'review_projects',
  'list_from_policy',
  'block_donors',
  'pause_any_project',
]);

type PermissionRefusalCode = Extract<RefusalCode, 'not_admin' | 'not_maintainer' | 'not_claim_owner'>;

/** A permission check said no. `code` is the refusal code the caller sees. */
export class PermissionRefused extends Error {
  readonly code: PermissionRefusalCode;
  readonly permission: Permission;

  constructor(code: PermissionRefusalCode, permission: Permission, message: string) {
    super(message);
    this.name = 'PermissionRefused';
    this.code = code;
    this.permission = permission;
  }
}

/** True when the person is one of Good First Token's admins, by numeric GitHub ID. */
function isAdmin(githubId: number): boolean {
  return adminGithubIds().has(githubId);
}

interface RepoPermissions {
  permissions?: { admin?: boolean; maintain?: boolean };
}

/**
 * Throws PermissionRefused unless `caller` holds `permission` on `resource`.
 *
 * - Admin permissions go to the numeric GitHub IDs in ADMIN_GITHUB_IDS.
 * - `manage_project` asks GitHub, with the caller's own token, for their
 *   permission on the repo, and needs admin or maintain. It asks every time
 *   and keeps nothing.
 * - `work_claim` goes to the person who made the claim.
 */
export async function requirePermission<P extends Permission>(
  caller: Caller,
  permission: P,
  ...[resource]: Resources[P] extends undefined ? [] : [Resources[P]]
): Promise<void> {
  if (ADMIN_PERMISSIONS.has(permission)) {
    if (isAdmin(caller.githubId)) return;
    throw new PermissionRefused('not_admin', permission, "Only Good First Token's admins can do this.");
  }
  if (permission === 'manage_project') {
    const { repo } = resource as Resources['manage_project'];
    const name = mustParse(repoName, repo, 'repo');
    const refused = new PermissionRefused(
      'not_maintainer',
      permission,
      `Only an admin or maintainer of ${name} on GitHub can do this.`,
    );
    const token = await caller.gitHubToken();
    if (!token) throw refused;
    let found: RepoPermissions;
    try {
      found = await gitHubRest<RepoPermissions>(token, 'GET', `/repos/${name}`);
    } catch (error) {
      // GitHub answers 404 for a repo the caller can't see.
      if (error instanceof GitHubError && error.status === 404) throw refused;
      throw error;
    }
    if (found.permissions?.admin === true || found.permissions?.maintain === true) return;
    throw refused;
  }
  if (permission === 'work_claim') {
    const { claimantGithubId } = resource as Resources['work_claim'];
    if (caller.githubId === claimantGithubId) return;
    throw new PermissionRefused('not_claim_owner', permission, 'Only the person who made the claim can do this.');
  }
  throw new Error(`There is no permission named ${permission}.`);
}
