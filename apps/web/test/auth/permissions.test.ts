import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionRefused, requirePermission, type Caller, type Permission } from '../../src/auth/permissions';
import { startGitHub } from './helpers';

// Every person and repo here is sample data from the GitHub fake:
// octo-maintainer is an admin of meanwhileso/goodfirsttoken, and kenji can
// write to it.
let github: GitHubFake;
const configured = env.ADMIN_GITHUB_IDS;

beforeEach(() => {
  github = startGitHub();
});

afterEach(() => {
  env.ADMIN_GITHUB_IDS = configured;
  vi.unstubAllGlobals();
});

function caller(githubId: number, login: string, token: string | null = null): Caller {
  return { githubId, login, gitHubToken: () => Promise.resolve(token) };
}

/** The refusal code, or null when the check passes. */
async function refusal(check: Promise<void>): Promise<string | null> {
  try {
    await check;
    return null;
  } catch (error) {
    if (error instanceof PermissionRefused) return error.code;
    throw error;
  }
}

const adminPermissions: Permission[] = ['review_projects', 'list_from_policy', 'block_donors', 'pause_any_project'];

test.each(adminPermissions)('a non-admin is refused the admin permission %s', async (permission) => {
  env.ADMIN_GITHUB_IDS = '9001';

  const code = await refusal(requirePermission(caller(1001, 'priya'), permission as 'review_projects'));

  expect(code).toBe('not_admin');
});

test.each(adminPermissions)('an admin named in ADMIN_GITHUB_IDS holds %s', async (permission) => {
  env.ADMIN_GITHUB_IDS = '42, 9001';

  expect(await refusal(requirePermission(caller(9001, 'sample-admin'), permission as 'review_projects'))).toBeNull();
});

test("admins are named by numeric GitHub ID, so taking an admin's login makes no one an admin", async () => {
  env.ADMIN_GITHUB_IDS = '9001';

  expect(await refusal(requirePermission(caller(1001, 'sample-admin'), 'block_donors'))).toBe('not_admin');
  expect(await refusal(requirePermission(caller(9001, 'renamed-admin'), 'block_donors'))).toBeNull();
});

test('with ADMIN_GITHUB_IDS empty or malformed, nobody is an admin', async () => {
  for (const ids of ['', ' , ', 'sample-admin', '9001x', '-9001', '0']) {
    env.ADMIN_GITHUB_IDS = ids;
    expect(await refusal(requirePermission(caller(9001, 'sample-admin'), 'review_projects')), ids).toBe('not_admin');
  }
});

test("managing a project needs admin or maintain on the repo, asked of GitHub with the caller's own token every time", async () => {
  const maintainer = caller(1008, 'octo-maintainer', github.tokenFor('octo-maintainer'));
  const writer = caller(1002, 'kenji', github.tokenFor('kenji'));
  const repo = { repo: 'meanwhileso/goodfirsttoken' };

  const first = await refusal(requirePermission(maintainer, 'manage_project', repo));
  const again = await refusal(requirePermission(maintainer, 'manage_project', repo));
  const denied = await refusal(requirePermission(writer, 'manage_project', repo));

  expect([first, again, denied]).toEqual([null, null, 'not_maintainer']);
  expect(github.calls.map((call) => [call.operation, call.login])).toEqual([
    ['GET /repos/{owner}/{repo}', 'octo-maintainer'],
    ['GET /repos/{owner}/{repo}', 'octo-maintainer'],
    ['GET /repos/{owner}/{repo}', 'kenji'],
  ]);
});

test('an admin of Good First Token is no maintainer of a repo GitHub says they only read', async () => {
  env.ADMIN_GITHUB_IDS = '1001';

  const code = await refusal(
    requirePermission(caller(1001, 'priya', github.tokenFor('priya')), 'manage_project', {
      repo: 'meanwhileso/goodfirsttoken',
    }),
  );

  expect(code).toBe('not_maintainer');
});

test('with no GitHub token, or a repo GitHub says is not there, the caller is no maintainer', async () => {
  const noToken = await refusal(
    requirePermission(caller(1008, 'octo-maintainer'), 'manage_project', { repo: 'meanwhileso/goodfirsttoken' }),
  );
  const missing = await refusal(
    requirePermission(caller(1008, 'octo-maintainer', github.tokenFor('octo-maintainer')), 'manage_project', {
      repo: 'sample-owner/no-such-repo',
    }),
  );

  expect([noToken, missing]).toEqual(['not_maintainer', 'not_maintainer']);
});

test('only the person who made a claim may work it', async () => {
  const claim = { claimantGithubId: 1001 };

  expect(await refusal(requirePermission(caller(1001, 'priya'), 'work_claim', claim))).toBeNull();
  expect(await refusal(requirePermission(caller(1002, 'priya'), 'work_claim', claim))).toBe('not_claim_owner');
});
