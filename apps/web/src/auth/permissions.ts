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
  /** Register a repo as a project, change its settings, pause it, or have its tagged issues read now. */
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

/**
 * A repo as GitHub described it to the caller, from the read behind
 * `manage_project`. The fields are the ones a tool uses.
 * https://docs.github.com/en/rest/repos/repos#get-a-repository
 */
export interface ManagedRepo {
  /** The repo as GitHub names it, which can differ in case from what was asked. */
  full_name: string;
  private: boolean;
  visibility?: string;
  archived: boolean;
  has_pull_requests?: boolean;
  pull_request_creation_policy?: string;
  permissions?: { admin?: boolean; maintain?: boolean };
}

/** What a check hands back when it passes: the repo it read, for `manage_project`. */
type Granted<P extends Permission> = P extends 'manage_project' ? ManagedRepo : undefined;

/**
 * Throws PermissionRefused unless `caller` holds `permission` on `resource`.
 *
 * - Admin permissions go to the numeric GitHub IDs in ADMIN_GITHUB_IDS.
 * - `manage_project` asks GitHub, with the caller's own token, for their
 *   permission on the repo, and needs admin or maintain. It asks every time
 *   and keeps nothing. It hands back the repo as GitHub described it, so a
 *   tool reads it once.
 * - `work_claim` goes to the person who made the claim.
 */
export async function requirePermission<P extends Permission>(
  caller: Caller,
  permission: P,
  ...[resource]: Resources[P] extends undefined ? [] : [Resources[P]]
): Promise<Granted<P>> {
  if (ADMIN_PERMISSIONS.has(permission)) {
    if (isAdmin(caller.githubId)) return undefined as Granted<P>;
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
    let found: ManagedRepo;
    try {
      found = await gitHubRest<ManagedRepo>(token, 'GET', `/repos/${name}`);
    } catch (error) {
      // GitHub answers 404 for a repo the caller can't see. A token with only
      // public_repo, like every token Good First Token holds, can't see a
      // private repo, even its owner's.
      if (error instanceof GitHubError && error.status === 404) {
        throw new PermissionRefused(
          'not_maintainer',
          permission,
          `GitHub shows you no public repo named ${name}. Only an admin or maintainer of a public repo can do this.`,
        );
      }
      throw error;
    }
    if (found.permissions?.admin === true || found.permissions?.maintain === true) return found as Granted<P>;
    throw refused;
  }
  if (permission === 'work_claim') {
    const { claimantGithubId } = resource as Resources['work_claim'];
    if (caller.githubId === claimantGithubId) return undefined as Granted<P>;
    throw new PermissionRefused('not_claim_owner', permission, 'Only the person who made the claim can do this.');
  }
  throw new Error(`There is no permission named ${permission}.`);
}
