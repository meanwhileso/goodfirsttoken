import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { ServiceGitHub, type Allowance } from '../../src/sync/github';
import { ALLOWANCES } from '../../src/sync/scheduled';

// Shared setup for the jobs that read GitHub with the service token. The
// test config sets GH_SERVICE_TOKEN, and the GitHub fake knows it as the
// token of a made-up account that reads public data only, as a deployed
// token does.

export const SERVICE_LOGIN = 'sample-sync-bot';

/** Makes the fake take the service token the test config sets. */
export function knowServiceToken(github: GitHubFake): void {
  github.state.tokens[env.GH_SERVICE_TOKEN] = { login: SERVICE_LOGIN, scopes: [], clientId: null };
}

/** What a job runs with: the Worker's bindings, and a fresh count of calls under `allowance`. */
export function jobDeps(github: GitHubFake, allowance: Allowance = ALLOWANCES.sync) {
  knowServiceToken(github);
  return {
    db: env.DB,
    rooms: env.ISSUE_ROOM,
    github: new ServiceGitHub(env.GH_SERVICE_TOKEN, allowance),
    now: () => Date.now(),
  };
}

// Issue rooms keep their storage across the tests in a file, and a room is
// named by its issue. So each test's new issues start at numbers of their
// own, and meet no room an earlier test used.
let nextNumber = 2000;

/** Gives the repo's next issues and PRs numbers no earlier test in the file used. */
export function freshNumbers(github: GitHubFake, repo: string): void {
  const record = github.state.repos[repo];
  if (!record) throw new Error(`the fake has no repo ${repo}`);
  record.nextNumber = nextNumber;
  nextNumber += 100;
}

/** The calls the fake recorded for an operation, like `GET /repos/{owner}/{repo}`. */
export function callsTo(github: GitHubFake, operation: string) {
  return github.calls.filter((call) => call.operation === operation);
}

export const TIMELINE = 'GET /repos/{owner}/{repo}/issues/{issue_number}/timeline';
