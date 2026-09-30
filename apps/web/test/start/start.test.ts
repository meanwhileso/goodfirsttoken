import { describe, expect, test } from 'vitest';
import { workerFetch } from '../worker';

// /start.md, read through the Worker the way an agent reads it. The tests
// set PRIMARY_DOMAIN to primary.example, so the page names that site's
// server.

const MCP_URL = 'https://primary.example/mcp';
// The harnesses spec section 2 supports.
const HARNESSES = ['Claude Code', 'Codex', 'OpenCode', 'Cursor', 'Grok Bot'];

async function startPage(): Promise<string> {
  const res = await workerFetch('http://localhost/start.md');
  expect(res.status).toBe(200);
  return res.text();
}

/** The bullet for a harness under "Add the MCP server", with its continuation lines. */
function serverStep(page: string, harness: string): string | null {
  const section = page.split('\n## ').find((part) => part.startsWith('1. '));
  if (!section) return null;
  const bullets = section.split(/\n(?=- )/);
  return bullets.find((bullet) => bullet.startsWith(`- ${harness}:`)) ?? null;
}

describe('/start.md', () => {
  test('it is markdown anyone can read, with no cookie', async () => {
    const res = await workerFetch('http://localhost/start.md');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toMatch(/^# Good First Token: setup for agents\n/);
  });

  test("it says how to add the MCP server in every harness, each at this site's own server", async () => {
    const page = await startPage();

    for (const harness of HARNESSES) {
      const step = serverStep(page, harness);
      expect(step, harness).not.toBeNull();
      expect(step, harness).toContain(MCP_URL);
    }
    expect(page).not.toContain('{{');
    expect(page).not.toContain('https://goodfirsttoken.org/mcp');
  });

  test('it says how to get the skills in every harness', async () => {
    const page = await startPage();
    const section = page.split('\n## ').find((part) => part.startsWith('2. ')) ?? '';

    for (const harness of HARNESSES) expect(section, harness).toContain(harness);
    expect(section).toContain('`npx skills add meanwhileso/goodfirsttoken`');
  });

  test('it calls the token count an estimate', async () => {
    const page = await startPage();

    expect(page).toContain('`tokenEstimate`');
    expect(page).toContain('It is always an estimate.');
  });

  test('HEAD gets the headers with no body, and any other method is 405', async () => {
    const head = await workerFetch('http://localhost/start.md', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await head.text()).toBe('');

    const post = await workerFetch('http://localhost/start.md', { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });
});
