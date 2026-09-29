import { expect, test } from 'vitest';
import { ORIGIN } from '../auth/helpers';
import { workerFetch } from '../worker';

// /maintainers, fetched through the whole Worker by someone who isn't signed
// in. It reads nothing, so it needs no database or GitHub.

test('/maintainers answers anyone, sets no cookie, and says how to register, take over a listing, and ask to be removed, from an agent', async () => {
  const response = await workerFetch(new URL('/maintainers', ORIGIN));
  const html = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(html).toContain('<a href="/maintainers" aria-current="page">maintainers</a>');
  // How to install the plugin or the skills, and the maintain skill's own steps.
  expect(html).toContain('/plugin install goodfirsttoken@goodfirsttoken');
  expect(html).toContain('npx skills add meanwhileso/goodfirsttoken');
  expect(html).toContain('https://github.com/meanwhileso/goodfirsttoken/blob/main/skills/goodfirsttoken-maintain/SKILL.md');
  // Registering, taking over a listing, and asking to be removed.
  expect(html).toContain('register_project</span> reads your labels');
  expect(html).toContain('To take the listing over, register the repo from your agent.');
  expect(html).toContain('request_removal');
  expect(html).toContain('withdraw: true');
});
