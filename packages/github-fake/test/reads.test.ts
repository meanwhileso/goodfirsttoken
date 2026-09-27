import { beforeEach, expect, test } from 'vitest';
import { createGitHubFake, type GitHubFake } from '../src/index.ts';
import { fromBase64, graphql, rest } from './call.ts';

let fake: GitHubFake;

beforeEach(() => {
  fake = createGitHubFake();
});

const UPSTREAM = '/repos/meanwhileso/goodfirsttoken';
const numbers = (items: unknown) => (items as { number: number }[]).map((i) => i.number);

test('listing issues filters by label, state, and assignee, and marks the pull requests it lists', async () => {
  const tagged = await rest(fake, 'GET', `${UPSTREAM}/issues?labels=goodfirsttoken&assignee=none`);
  const everything = await rest<{ number: number; pull_request?: { merged_at: string | null } }[]>(
    fake,
    'GET',
    `${UPSTREAM}/issues?state=all`,
  );
  const mergedAt = (n: number) => everything.body.find((i) => i.number === n)?.pull_request?.merged_at;

  expect(numbers(tagged.body)).toEqual([925, 921, 912]);
  expect(everything.body.filter((i) => i.pull_request).map((i) => i.number)).toEqual([958, 957, 952, 949]);
  expect(Date.parse(mergedAt(949) ?? '')).toBeLessThan(Date.now());
  expect(mergedAt(957)).toBeNull();
});

test('lists come in pages with a Link header, as on GitHub', async () => {
  const first = await rest(fake, 'GET', `${UPSTREAM}/issues?state=all&per_page=3`);
  const next = /<([^>]+)>; rel="next"/.exec(first.headers.get('link') ?? '')?.[1] ?? '';
  const second = await rest(fake, 'GET', next.slice(fake.apiUrl.length));

  expect(numbers(first.body)).toEqual([958, 957, 952]);
  expect(first.headers.get('link')).toContain('rel="last"');
  expect(numbers(second.body)).toEqual([949, 925, 921]);
});

test('a label list has the fields GitHub sends for each label', async () => {
  const { body } = await rest<Record<string, unknown>[]>(fake, 'GET', `${UPSTREAM}/labels`);
  const label = body.find((l) => l.name === 'goodfirsttoken');

  // https://docs.github.com/en/rest/issues/labels#list-labels-for-a-repository
  expect(Object.keys(label ?? {}).sort()).toEqual(['color', 'default', 'description', 'id', 'name', 'node_id', 'url']);
  expect(label).toMatchObject({
    url: `${fake.apiUrl}/repos/meanwhileso/goodfirsttoken/labels/goodfirsttoken`,
    color: '7057ff',
    default: false,
  });
});

test("a test can commit files to a repo's default branch, as a maintainer would push them", async () => {
  fake.commitFiles('sample-owner/sample-harbor', { 'docs/AI_POLICY.md': '# AI policy\n' }, 'octo-maintainer');

  const file = await rest<{ content: string }>(fake, 'GET', '/repos/sample-owner/sample-harbor/contents/docs/AI_POLICY.md');
  const kept = await rest(fake, 'GET', '/repos/sample-owner/sample-harbor/contents/justfile');

  expect(fromBase64(file.body.content)).toBe('# AI policy\n');
  expect(kept.status).toBe(200);
});

test('one label is found by name without case, and a label the repo lacks answers 404', async () => {
  const found = await rest(fake, 'GET', `${UPSTREAM}/labels/GoodFirstToken`);
  const spaced = await rest(fake, 'GET', `${UPSTREAM}/labels/${encodeURIComponent('help wanted')}`);
  const missing = await rest(fake, 'GET', '/repos/sample-owner/sample-app/labels/goodfirsttoken');

  // https://docs.github.com/en/rest/issues/labels#get-a-label
  expect(found.body).toMatchObject({ name: 'goodfirsttoken', color: '7057ff' });
  expect(spaced.body).toMatchObject({ name: 'help wanted' });
  expect(missing.status).toBe(404);
  expect(missing.body).toMatchObject({ documentation_url: 'https://docs.github.com/en/rest/issues/labels#get-a-label' });
});

test('search finds open tagged issues across repos with no PR linked to them', async () => {
  const q = encodeURIComponent('is:issue is:open label:"help wanted" -linked:pr');

  const { body } = await rest<{ total_count: number; search_type: string; items: { html_url: string }[] }>(
    fake,
    'GET',
    `/search/issues?q=${q}`,
  );

  // meanwhileso/goodfirsttoken#918 is tagged too, but PR #957 says it closes it.
  expect(body.items.map((i) => i.html_url).sort()).toEqual([
    `${fake.webUrl}/sample-owner/sample-app/issues/311`,
    `${fake.webUrl}/sample-owner/sample-harbor/issues/88`,
  ]);
  expect(body.total_count).toBe(2);
  // https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests lists it as required.
  expect(body.search_type).toBe('lexical');
});

test('the fake refuses an issue search that names neither is:issue nor is:pull-request', async () => {
  const reply = await rest(fake, 'GET', `/search/issues?q=${encodeURIComponent('label:bug')}`);

  expect(reply.status).toBe(422);
  expect(reply.body).toMatchObject({ message: "Query must include 'is:issue' or 'is:pull-request'" });
});

test('search refuses a qualifier the fake does not know, so a test never passes on a misread query', async () => {
  const reply = await rest<{ errors: { message: string }[] }>(
    fake,
    'GET',
    `/search/issues?q=${encodeURIComponent('is:issue reactions:>5')}`,
  );

  expect(reply.status).toBe(422);
  expect(reply.body.errors[0]?.message).toContain('packages/github-fake/src/search.ts');
});

test('repository search filters by stars and push date, and leaves forks out', async () => {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const q = encodeURIComponent(`stars:>=4000 pushed:>=${since}`);

  const { body } = await rest<{ items: { full_name: string }[] }>(fake, 'GET', `/search/repositories?q=${q}`);
  const all = await rest<{ items: { fork: boolean }[] }>(fake, 'GET', `/search/repositories?q=${encodeURIComponent('stars:>=0')}`);

  expect(body.items.map((r) => r.full_name)).toEqual([
    'sample-owner/sample-bundler',
    'sample-owner/sample-desktop',
    'sample-owner/sample-app',
    'sample-owner/sample-harbor',
  ]);
  expect(all.body.items.some((r) => r.fork)).toBe(false);
});

test('search serves only the first 1,000 results, and refuses a page past them as GitHub does', async () => {
  const template = fake.state.repos['sample-owner/sample-tools'];
  if (!template) throw new Error('missing sample repo');
  for (let n = 0; n < 1005; n++) {
    fake.state.repos[`bulk/r${String(n)}`] = { ...template, id: 9_000_000 + n, owner: 'bulk', name: `r${String(n)}` };
  }

  const page = (n: number) =>
    rest<{ total_count: number; items: unknown[] }>(
      fake,
      'GET',
      `/search/repositories?q=${encodeURIComponent('org:bulk')}&per_page=100&page=${String(n)}`,
    );
  const last = await page(10);
  const past = await page(11);

  expect(last.body).toMatchObject({ total_count: 1005 });
  expect(last.body.items).toHaveLength(100);
  expect(past.status).toBe(422);
  expect(past.body).toMatchObject({ message: 'Only the first 1000 search results are available' });
});

test('file contents come back base64 encoded, and a folder as a list of its entries', async () => {
  const file = await rest<{ content: string; encoding: string; path: string }>(fake, 'GET', `${UPSTREAM}/contents/AGENTS.md`);
  const folder = await rest<{ name: string; type: string }[]>(fake, 'GET', `${UPSTREAM}/contents/.github`);
  const missing = await rest(fake, 'GET', `${UPSTREAM}/contents/NOPE.md`);
  const otherBranch = await rest(fake, 'GET', '/repos/sample-owner/sample-harbor/contents/justfile?ref=develop');

  expect(file.body).toMatchObject({ type: 'file', encoding: 'base64', path: 'AGENTS.md' });
  expect(fromBase64(file.body.content)).toContain('# AGENTS.md');
  expect(folder.body.map((e) => [e.name, e.type])).toEqual([
    ['pull_request_template.md', 'file'],
    ['workflows', 'dir'],
  ]);
  expect(missing.status).toBe(404);
  expect(missing.body).toMatchObject({
    message: 'Not Found',
    documentation_url: 'https://docs.github.com/en/rest/repos/contents#get-repository-content',
  });
  expect(otherBranch.status).toBe(200);
});

test("a repo's vouch file is served like any file: base64 through the contents API, and as text through GraphQL", async () => {
  const desktop = '/repos/sample-owner/sample-desktop';
  const file = await rest<{ content: string; encoding: string; path: string; name: string; type: string }>(
    fake,
    'GET',
    `${desktop}/contents/.github/VOUCHED.td`,
  );
  const reply = await graphql<{
    repository: {
      root: { text: string } | null;
      dotGithub: { text: string; byteSize: number; isBinary: boolean } | null;
      defaultBranchRef: { target: { oid: string } };
    };
  }>(
    fake,
    fake.tokenFor('kenji'),
    `{ repository(owner: "sample-owner", name: "sample-desktop") {
        root: object(expression: "HEAD:VOUCHED.td") { ... on Blob { text } }
        dotGithub: object(expression: "HEAD:.github/VOUCHED.td") { ... on Blob { text byteSize isBinary } }
        defaultBranchRef { target { oid } }
      } }`,
  );
  const text = fromBase64(file.body.content);

  // https://docs.github.com/en/rest/repos/contents#get-repository-content
  expect(file.body).toMatchObject({ type: 'file', encoding: 'base64', path: '.github/VOUCHED.td', name: 'VOUCHED.td' });
  expect(text.split('\n').filter((line) => line !== '' && !line.startsWith('#'))).toEqual([
    '-arjun opened agent PRs nobody had read',
    'github:kenji',
    'gitlab:priya',
    'lena',
  ]);
  expect(reply.body.data?.repository.root).toBeNull();
  expect(reply.body.data?.repository.dotGithub).toEqual({ text, byteSize: new TextEncoder().encode(text).length, isBinary: false });
  expect(reply.body.data?.repository.defaultBranchRef.target.oid).toMatch(/^[0-9a-f]{40}$/);
});

test('one GraphQL query reads files from many repos, with an error for each repo that is not there', async () => {
  const reply = await graphql<Record<string, { contributing: { text: string } | null } | null>>(
    fake,
    fake.tokenFor('lena'),
    `{
      a: repository(owner: "meanwhileso", name: "goodfirsttoken") { contributing: object(expression: "HEAD:CONTRIBUTING.md") { ... on Blob { text } } }
      b: repository(owner: "sample-owner", name: "sample-harbor") { contributing: object(expression: "HEAD:CONTRIBUTING.md") { ... on Blob { text } } }
      c: repository(owner: "sample-owner", name: "sample-tools") { contributing: object(expression: "HEAD:CONTRIBUTING.md") { ... on Blob { text } } }
      d: repository(owner: "nobody", name: "nothing") { contributing: object(expression: "HEAD:CONTRIBUTING.md") { ... on Blob { text } } }
    }`,
  );

  expect(reply.body.data?.a?.contributing?.text).toContain('AI help is welcome');
  expect(reply.body.data?.b?.contributing?.text).toContain('write the PR description yourself');
  expect(reply.body.data?.c).toEqual({ contributing: null });
  expect(reply.body.data?.d).toBeNull();
  expect(reply.body.errors).toMatchObject([
    { type: 'NOT_FOUND', path: ['d'], message: "Could not resolve to a Repository with the name 'nobody/nothing'." },
  ]);
});

test("a PR's reviews and review comments come back with who wrote them", async () => {
  const reviews = await rest(fake, 'GET', `${UPSTREAM}/pulls/957/reviews`);
  const comments = await rest(fake, 'GET', `${UPSTREAM}/pulls/957/comments`);

  expect(reviews.body).toMatchObject([
    {
      state: 'CHANGES_REQUESTED',
      user: { login: 'octo-maintainer' },
      body: 'Can the formatter skip events with an empty text field? Otherwise looks good.',
    },
  ]);
  expect(comments.body).toMatchObject([
    { path: 'apps/web/src/feed/format.ts', line: 2, side: 'RIGHT', user: { login: 'octo-maintainer' } },
  ]);
});

// Every URL a client might follow stays on the fake. Only the docs links
// point elsewhere.
function urlsIn(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string' && /^https?:\/\//.test(value)) found.push(value);
  else if (Array.isArray(value)) for (const item of value) urlsIn(item, found);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) urlsIn(item, found);
  return found;
}

test('no URL in a response leads off the fake, except links to GitHub docs', async () => {
  const token = fake.tokenFor('priya');
  const paths = [
    '/user',
    '/users/octo-maintainer',
    UPSTREAM,
    `${UPSTREAM}/labels`,
    `${UPSTREAM}/issues?state=all`,
    `${UPSTREAM}/issues/918/timeline`,
    `${UPSTREAM}/pulls/957`,
    `${UPSTREAM}/pulls/957/reviews`,
    `${UPSTREAM}/pulls/957/comments`,
    `${UPSTREAM}/contents/README.md`,
    `${UPSTREAM}/branches/main`,
    '/repos/priya/goodfirsttoken',
    `/search/issues?q=${encodeURIComponent('is:pr author:priya')}`,
    `${UPSTREAM}/contents/NOPE.md`,
  ];

  const urls: string[] = [];
  for (const path of paths) urlsIn((await rest(fake, 'GET', path, { token })).body, urls);
  const avatar = await fake.fetch(urls.find((u) => u.includes('/avatars/')) ?? '');
  const raw = await fake.fetch(urls.find((u) => u.includes('/raw/')) ?? '');

  expect(urls.length).toBeGreaterThan(100);
  expect(urls.filter((u) => ![fake.apiUrl, fake.webUrl, 'https://docs.github.com/'].some((b) => u.startsWith(b)))).toEqual([]);
  expect(avatar.headers.get('content-type')).toBe('image/svg+xml');
  expect(await raw.text()).toContain('Good First Token');
});
