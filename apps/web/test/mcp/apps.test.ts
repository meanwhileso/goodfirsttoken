import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createProject, savePerson, saveIssues } from '../../src/db';
import { startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { freshNumbers } from '../sync/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from './helpers';

// The views hosts that support MCP Apps show: ui:// resources the MCP
// server lists and reads, and the tools that name them. A host without MCP
// Apps reads neither, and gets each tool's answer as before. How each view
// draws an answer, and what its buttons do, is tested in a browser, in
// e2e/mcp-apps.spec.ts. The project and issue here are made up.

const REPO = 'sample-owner/sample-app';
const MIME = 'text/html;profile=mcp-app';
const VIEWS = {
  'ui://goodfirsttoken/issue-cards.html': 'suggest_issues',
  'ui://goodfirsttoken/live-feed.html': 'claim_issue',
  'ui://goodfirsttoken/review-queue.html': 'my_work',
} as const;
type ViewUri = keyof typeof VIEWS;

let github: GitHubFake;

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  freshNumbers(github, REPO);
  vi.spyOn(env.MCP_LIMITER, 'limit').mockResolvedValue({ success: true });
  await savePerson(env.DB, { githubId: 1009, login: 'sample-maintainer' }, Date.now());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Meta {
  ui?: { resourceUri?: string; csp?: { connectDomains?: string[]; resourceDomains?: string[] }; prefersBorder?: boolean };
  'ui/resourceUri'?: string;
}

async function read(agent: ConnectedAgent, uri: string) {
  const { contents } = await agent.client.readResource({ uri });
  expect(contents).toHaveLength(1);
  const [content] = contents as [{ uri: string; mimeType?: string; text?: string; _meta?: Meta }];
  return content;
}

/** A project with one tagged issue, as a sync leaves it. */
async function taggedIssue(): Promise<string> {
  await createProject(
    env.DB,
    { repo: REPO, status: 'approved', source: 'registered', policy: null, settings: { tags: ['help wanted'] }, addedBy: 1009 },
    Date.now(),
  );
  const number = github.openIssue(REPO, { title: 'Fix a sample bug', body: 'The sample breaks.', labels: ['help wanted'], by: 'sample-maintainer' });
  const issue = `${REPO}#${String(number)}`;
  await saveIssues(env.DB, [{ issue, project: REPO, title: 'Fix a sample bug', labels: ['help wanted'], linkedPr: null, syncedAt: Date.now() }]);
  return issue;
}

test('the server lists a view for the issue cards, the live feed, and the review queue, each a ui:// page of the MCP Apps type', async () => {
  const agent = await connectAgent(github, 'priya');

  const { resources } = await agent.client.listResources();

  expect(resources.map((r) => [r.uri, r.mimeType])).toEqual(Object.keys(VIEWS).map((uri) => [uri, MIME]));
  expect(agent.client.getServerCapabilities()?.resources).toBeDefined();
});

test('suggest_issues names the issue cards, claim_issue the live feed, and my_work the review queue, and no other tool names a view', async () => {
  const agent = await connectAgent(github, 'priya');

  const { tools } = await agent.client.listTools();
  const named = tools.filter((tool) => tool._meta !== undefined);

  expect(named.map((tool) => [tool.name, (tool._meta as Meta).ui?.resourceUri])).toEqual(
    Object.entries(VIEWS).map(([uri, tool]) => [tool, uri]).sort((a, b) => tools.findIndex((t) => t.name === a[0]) - tools.findIndex((t) => t.name === b[0])),
  );
  // Hosts from before the spec deprecated the flat key still read it.
  for (const tool of named) expect((tool._meta as Meta)['ui/resourceUri']).toBe((tool._meta as Meta).ui?.resourceUri);
  for (const [uri] of Object.entries(VIEWS)) expect((await read(agent, uri)).mimeType).toBe(MIME);
});

test('each view is one HTML page with its script and styles inline, which loads nothing from anywhere', async () => {
  const agent = await connectAgent(github, 'priya');

  for (const uri of Object.keys(VIEWS) as ViewUri[]) {
    const { text = '', mimeType } = await read(agent, uri);
    const view = uri.slice('ui://goodfirsttoken/'.length, -'.html'.length);

    expect(mimeType).toBe(MIME);
    expect(text.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(text).toContain(`<body data-view="${view}">`);
    expect(text.match(/<script/g)).toHaveLength(1);
    expect(text.match(/<style/g)).toHaveLength(1);
    const style = text.slice(text.indexOf('<style>'), text.indexOf('</style>'));
    const script = text.slice(text.indexOf('<script>'), text.indexOf('</script>'));
    // Nothing a browser would fetch: no script, style, image, or font by
    // URL, and no import.
    expect(text).not.toMatch(/<(link|img|iframe|object|embed)[\s>]/i);
    expect(style).not.toMatch(/@import|url\(/i);
    expect(script).not.toMatch(/\bimport\(|importScripts|\bfetch\(|XMLHttpRequest/);
    expect(style.length).toBeGreaterThan(1000);
    expect(script.length).toBeGreaterThan(1000);
    // The site's own zod-checked schemas stay on the server, so the page stays small.
    expect(text.length).toBeLessThan(60_000);
  }
});

test("a live view may reach one origin, the site's own that the tools' answers name the live pages on, by WebSocket, and the review queue reaches none", async () => {
  const issue = await taggedIssue();
  const agent = await connectAgent(github, 'priya');
  const started = await agent.client.callTool({ name: 'start_session', arguments: { agent: 'claude-code', budget: { kind: 'until_limit' } } });
  const suggested = await agent.client.callTool({
    name: 'suggest_issues',
    arguments: { sessionId: (started.structuredContent as { sessionId: string }).sessionId },
  });
  const [suggestion] = (suggested.structuredContent as { suggestions: { issue: string; liveUrl: string }[] }).suggestions;
  expect(suggestion?.issue).toBe(issue);
  const live = new URL(suggestion?.liveUrl ?? '');
  const socket = `${live.protocol === 'https:' ? 'wss:' : 'ws:'}//${live.host}`;

  const { resources } = await agent.client.listResources();
  for (const uri of Object.keys(VIEWS) as ViewUri[]) {
    const expected = uri.endsWith('review-queue.html') ? [] : [socket];
    const listed = resources.find((r) => r.uri === uri)?._meta as Meta | undefined;
    const content = await read(agent, uri);

    // The listing lets a host review the policy before any call, and the
    // page carries it too, which a host reads first.
    for (const meta of [listed, content._meta]) {
      expect(meta?.ui?.csp).toEqual({ connectDomains: expected, resourceDomains: [] });
      expect(meta?.ui?.prefersBorder).toBe(false);
    }
  }
  expect(socket).toBe('wss://primary.example');
});

test("an agent in a host with no MCP Apps gets each tool's answer as before: its text and its data, and nothing more", async () => {
  const issue = await taggedIssue();
  const agent = await connectAgent(github, 'priya');
  const started = await agent.client.callTool({ name: 'start_session', arguments: { agent: 'claude-code', budget: { kind: 'until_limit' } } });
  const sessionId = (started.structuredContent as { sessionId: string }).sessionId;

  const answers = [
    await agent.client.callTool({ name: 'suggest_issues', arguments: { sessionId } }),
    await agent.client.callTool({ name: 'claim_issue', arguments: { sessionId, issue } }),
    await agent.client.callTool({ name: 'my_work', arguments: {} }),
  ];

  for (const answer of answers) {
    expect(Object.keys(answer).sort()).toEqual(['content', 'structuredContent']);
    expect(answer.content).toEqual([{ type: 'text', text: expect.any(String) as string }]);
  }
  const [suggested, claimed, work] = answers.map((answer) => answer.content.map((part) => (part.type === 'text' ? part.text : '')).join(''));
  expect(suggested).toContain(`Issues maintainers tagged for outside help (1):\n1  ${issue}  Fix a sample bug`);
  expect(claimed).toContain(`Claimed ${issue} as claim`);
  expect(work).toContain('In progress (1):');
});
