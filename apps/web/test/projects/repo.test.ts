import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MAX_DOC_BYTES, readDocs, readLabels } from '../../src/projects/repo';
import { startGitHub } from '../auth/helpers';

// What registration reads from a repo on GitHub, from the GitHub fake's
// sample repos. octo-maintainer is an admin of sample-owner/sample-harbor.

let github: GitHubFake;
const REPO = 'sample-owner/sample-harbor';

beforeEach(() => {
  github = startGitHub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('each file is found without case, in the root first, then .github/, then docs/, on the default branch', async () => {
  github.commitFiles(
    REPO,
    {
      '.github/Contributing.md': 'The .github copy.',
      'docs/ai-policy.md': 'Agents welcome.',
      'agents.MD': 'Run go test.',
      'docs/agents.md': 'Not read: AGENTS.md is read from the root only.',
      '.github/PULL_REQUEST_TEMPLATE.md': '## What changed',
      'docs/pull_request_template.txt': 'Not read: .github comes first.',
    },
    'octo-maintainer',
  );

  const docs = await readDocs(github.tokenFor('octo-maintainer'), REPO);

  // sample-harbor keeps CONTRIBUTING.md in the root, on its default branch, develop.
  expect(docs.contributing).toMatchObject({ path: 'CONTRIBUTING.md', text: expect.stringContaining('AI help is welcome') as unknown });
  expect(docs.aiPolicy).toEqual({ path: 'docs/ai-policy.md', text: 'Agents welcome.' });
  expect(docs.agents).toEqual({ path: 'agents.MD', text: 'Run go test.' });
  expect(docs.prTemplate).toEqual({ path: '.github/PULL_REQUEST_TEMPLATE.md', text: '## What changed' });
});

test('a file over 100 KB is left unread, and the next place is looked in', async () => {
  github.commitFiles(
    REPO,
    { 'CONTRIBUTING.md': 'x'.repeat(MAX_DOC_BYTES + 1), 'docs/CONTRIBUTING.md': 'The short one.' },
    'octo-maintainer',
  );

  const docs = await readDocs(github.tokenFor('octo-maintainer'), REPO);

  expect(docs.contributing).toEqual({ path: 'docs/CONTRIBUTING.md', text: 'The short one.' });
});

test('a repo with none of the files reads as none, in one query', async () => {
  const token = github.tokenFor('octo-maintainer');

  const docs = await readDocs(token, 'sample-owner/sample-desktop');

  expect(docs).toEqual({ contributing: null, aiPolicy: null, agents: null, prTemplate: null });
  expect(github.calls.map((call) => [call.operation, call.token])).toEqual([['query repository', token]]);
});

test('labels are read page by page, 100 at a time', async () => {
  const repo = github.state.repos['sample-owner/sample-harbor'];
  if (!repo) throw new Error('missing sample repo');
  for (let n = 0; n < 150; n++) repo.labels.push({ id: 7_000_000 + n, name: `area ${String(n)}`, color: 'ededed', description: null, default: false });

  const labels = await readLabels(github.tokenFor('octo-maintainer'), REPO);

  expect(labels).toHaveLength(154);
  expect(labels).toContain('help wanted');
  expect(labels).toContain('area 149');
  expect(github.calls.filter((call) => call.operation === 'GET /repos/{owner}/{repo}/labels')).toHaveLength(2);
});
