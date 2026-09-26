import { createGitHubFake, type GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GitHubError, gitHubGraphQL, gitHubRest } from '../src/github';

// The GitHub fake answers the URLs the config names. It stands in for the
// global fetch, and throws for any other URL, so nothing reaches the network.
let github: GitHubFake;

beforeEach(() => {
  github = createGitHubFake({ apiUrl: env.GITHUB_API_URL, webUrl: env.GITHUB_WEB_URL });
  vi.stubGlobal('fetch', github.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Repo {
  full_name: string;
  permissions: { admin: boolean; maintain: boolean; push: boolean; pull: boolean };
}

test('a REST call reaches the configured GitHub as the person whose token it carries', async () => {
  const priya = github.tokenFor('priya');
  const jdconley = github.tokenFor('jdconley');

  const asDonor = await gitHubRest<Repo>(priya, 'GET', '/repos/meanwhileso/goodfirsttoken');
  const asMaintainer = await gitHubRest<Repo>(jdconley, 'GET', '/repos/meanwhileso/goodfirsttoken');

  expect(asDonor.permissions).toMatchObject({ admin: false, maintain: false, push: false, pull: true });
  expect(asMaintainer.permissions).toMatchObject({ admin: true, maintain: true, push: true });
  expect(github.calls.map((call) => [call.operation, call.login])).toEqual([
    ['GET /repos/{owner}/{repo}', 'priya'],
    ['GET /repos/{owner}/{repo}', 'jdconley'],
  ]);
});

test('a GraphQL call reaches the configured GitHub as the person whose token it carries', async () => {
  const kenji = github.tokenFor('kenji');

  const result = await gitHubGraphQL<{ repository: { file: { text: string } | null } }>(
    kenji,
    `query ($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        file: object(expression: "HEAD:CONTRIBUTING.md") { ... on Blob { text } }
      }
    }`,
    { owner: 'harbor-dev', name: 'harbor' },
  );

  expect(result.errors).toEqual([]);
  expect(result.data?.repository.file?.text).toContain('AI help is welcome');
  expect(github.calls).toEqual([expect.objectContaining({ operation: 'query repository', login: 'kenji' })]);
});

test("GitHub's refusal comes back as an error with its status and message", async () => {
  const priya = github.tokenFor('priya');

  const call = gitHubRest(priya, 'POST', '/repos/meanwhileso/goodfirsttoken/labels', { name: 'mine' });

  await expect(call).rejects.toThrow(GitHubError);
  await expect(call).rejects.toMatchObject({ status: 404, message: 'Not Found' });
});
