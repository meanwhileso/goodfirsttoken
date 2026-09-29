import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer, Protocol } from '@modelcontextprotocol/server';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createProject, savePerson, saveIssues } from '../../src/db';
import { registerViews } from '../../src/mcp/apps';
import { startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { freshNumbers } from '../sync/helpers';
import { connectAgent, emptyKv, type ConnectedAgent } from './helpers';

// The views hosts that support MCP Apps show: ui:// resources the MCP
// server reads by URI, and the tools that name them. The server lists none
// of them, so a host without MCP Apps sees an empty resource list, a _meta
// on three tools, and each tool's answer as before. How each view draws an
// answer, and what its buttons do, is tested in a browser, in
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

test('the server serves a view for the issue cards, the live feed, and the review queue by URI, each a ui:// page of the MCP Apps type, and lists none of them', async () => {
  const agent = await connectAgent(github, 'priya');

  for (const uri of Object.keys(VIEWS)) {
    const content = await read(agent, uri);
    expect([content.uri, content.mimeType]).toEqual([uri, MIME]);
  }
  expect((await agent.client.listResources()).resources).toEqual([]);
  expect((await agent.client.listResourceTemplates()).resourceTemplates).toEqual([]);
});

test('a resource that is no view still lists, registered before the views or after them, and the views still read', async () => {
  const server = new McpServer({ name: 'goodfirsttoken-test', version: '0.0.0' });
  const text = (uri: URL) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'A note.' }] });
  server.registerResource('before', 'goodfirsttoken://notes/before', { mimeType: 'text/plain' }, text);
  registerViews(server, 'https://primary.example');
  server.registerResource('after', 'goodfirsttoken://notes/after', { mimeType: 'text/plain' }, text);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'goodfirsttoken-test', version: '0.0.0' });
  await client.connect(clientSide);

  const { resources } = await client.listResources();

  expect(resources.map((r) => r.uri)).toEqual(['goodfirsttoken://notes/before', 'goodfirsttoken://notes/after']);
  for (const uri of Object.keys(VIEWS)) expect((await client.readResource({ uri })).contents[0]?.mimeType).toBe(MIME);
  await client.close();
});

/** Ways a new MCP SDK could leave registerViews no list to wrap. Each gives back how to undo it. */
const breaks = {
  'has no accessor for its handlers': () => {
    const proto = Protocol.prototype as unknown as Record<string, unknown>;
    const accessor = proto._getRequestHandler;
    delete proto._getRequestHandler;
    return () => {
      proto._getRequestHandler = accessor;
    };
  },
  'has installed no resources/list handler yet': () => {
    const spy = vi.spyOn(Protocol.prototype as unknown as { _getRequestHandler(method: string): unknown }, '_getRequestHandler').mockReturnValue(undefined);
    return () => {
      spy.mockRestore();
    };
  },
};

for (const [broken, breakIt] of Object.entries(breaks)) {
  test(`when the MCP SDK ${broken}, every tool still answers, the views still read, and resources/list lists them as the SDK does, with a line in the log`, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const restore = breakIt();
    try {
      const agent = await connectAgent(github, 'priya');

      const { tools } = await agent.client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['start_session', 'suggest_issues', 'claim_issue', 'my_work']));
      const started = await agent.client.callTool({ name: 'start_session', arguments: { agent: 'claude-code', budget: { kind: 'until_limit' } } });
      expect(started.isError).toBeFalsy();
      for (const uri of Object.keys(VIEWS)) expect((await read(agent, uri)).mimeType).toBe(MIME);
      expect((await agent.client.listResources()).resources.map((r) => r.uri)).toEqual(Object.keys(VIEWS));
      const said = warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('resources/list'));
      expect(said.length).toBeGreaterThan(0);
      for (const line of said) expect(line).toBe('The MCP SDK gave registerViews no resources/list handler to wrap, so resources/list lists the views too.');
    } finally {
      restore();
    }
  });
}

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
    // A doctype first, or a browser draws the page in quirks mode.
    expect(text).toMatch(/^<!doctype html>/i);
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

  for (const uri of Object.keys(VIEWS) as ViewUri[]) {
    const expected = uri.endsWith('review-queue.html') ? [] : [socket];
    // The page carries its policy, which a host reads before it draws the view.
    const { _meta: meta } = await read(agent, uri);

    expect(meta?.ui?.csp).toEqual({ connectDomains: expected, resourceDomains: [] });
    expect(meta?.ui?.prefersBorder).toBe(false);
  }
  expect(socket).toBe('wss://primary.example');
});

test("an agent in a host with no MCP Apps sees a resources capability with an empty list, a _meta on three tools, and each tool's answer as before: its text and its data, and nothing more", async () => {
  const issue = await taggedIssue();
  const agent = await connectAgent(github, 'priya');

  // The server says it has resources, since it serves the views, and lists none.
  expect(agent.client.getServerCapabilities()?.resources).toEqual({ listChanged: true });
  expect((await agent.client.listResources()).resources).toEqual([]);
  // Three tools carry a _meta that names a view, which a host without MCP Apps passes over.
  const { tools } = await agent.client.listTools();
  expect(tools.filter((tool) => tool._meta !== undefined).map((tool) => Object.keys(tool._meta ?? {}).sort())).toEqual([
    ['ui', 'ui/resourceUri'],
    ['ui', 'ui/resourceUri'],
    ['ui', 'ui/resourceUri'],
  ]);

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
