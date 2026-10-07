import { parseProjectSettings, type ProjectSettings } from '@goodfirsttoken/core';
import { expect, test } from 'vitest';
import { ORIGIN } from '../auth/helpers';
import { workerFetch } from '../worker';

// /maintainers, fetched through the whole Worker by someone who isn't signed
// in. It reads nothing, so it needs no database or GitHub.

async function page(): Promise<string> {
  return (await workerFetch(new URL('/maintainers', ORIGIN))).text();
}

/** A split badge as the page draws it. */
function badge(rule: string, value: string): string {
  return `<span class="badge__rule">${rule}</span><span class="badge__value">${value}</span>`;
}

/** The settings a project gets when it sets only its tags, as core fills them in. */
function defaults(): ProjectSettings {
  const parsed = parseProjectSettings({ tags: ['help wanted'] });
  if (!parsed.ok) throw new Error('tags alone should be valid settings');
  return parsed.value;
}

/** The whole numbers from 0 to 100 that core takes for a setting, as "min to max". */
function range(setting: 'claimsPerIssue' | 'openPrsPerDonor'): string {
  const taken = Array.from({ length: 101 }, (_, n) => n).filter(
    (n) => parseProjectSettings({ tags: ['help wanted'], [setting]: n }).ok,
  );
  return `${String(taken[0])} to ${String(taken.at(-1))}`;
}

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
  expect(html).toContain('register_project</span> to read your labels and repo rules.');
  expect(html).toContain('Ask your agent to register the repo to take over the listing.');
  expect(html).toContain('request_removal');
  expect(html).toContain('withdraw: true');
});

test("each rule's badge and words give the default a project gets when it sets only its tags", async () => {
  const html = await page();
  const settings = defaults();
  const { trailer, prBody } = settings.disclosure;
  if (trailer === null || prBody === null) throw new Error('the default disclosure has a trailer and a PR body line');

  expect(html).toContain('The badges show defaults.');
  expect(html).toContain(badge('PRs', settings.prMode));
  expect(html).toContain(badge('claim', settings.whoCanClaim));
  expect(html).toContain(badge('slots', String(settings.claimsPerIssue)));
  expect(html).toContain(badge('open PRs each', String(settings.openPrsPerDonor)));
  // Disclosure is both a trailer and a line in the PR body, and the page shows both.
  expect(html).toContain(badge('disclose', trailer));
  expect(html).toContain(badge('disclose', 'in the PR body'));
  expect(html).toContain(prBody);
  expect(html).toContain(`The default is ${String(settings.claimsPerIssue)}.`);
  expect(html).toContain(`You can set it from ${range('claimsPerIssue')}.`);
  expect(html).toContain(`You can set it from ${range('openPrsPerDonor')}.`);
});
