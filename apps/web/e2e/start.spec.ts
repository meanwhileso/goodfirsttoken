import { expect, test } from './fixtures';
import { SITE } from './hosts';

// /start.md from the production build, which puts the skills' shared steps
// into the Worker. The fixtures check every Set-Cookie header it carries.

test("the production build serves /start.md as markdown, with each harness's steps at this site's server", async ({ request }) => {
  const res = await request.get('/start.md');

  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('text/markdown; charset=utf-8');
  const page = await res.text();
  for (const harness of ['Claude Code', 'Codex', 'OpenCode', 'Cursor', 'Grok Bot']) {
    expect(page, harness).toContain(`- ${harness}:`);
  }
  expect(page).toContain(`codex mcp add goodfirsttoken --url ${SITE}/mcp`);
  expect(page).not.toContain('{{');
});
