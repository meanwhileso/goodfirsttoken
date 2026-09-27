import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadAdminPage } from '../../src/admin/page';
import { createProject, getBlock, getProject, savePerson } from '../../src/db';
import { Browser, ORIGIN, location, signIn, startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';

// The admin pages at /admin, fetched through the whole Worker by a browser
// signed in with the GitHub fake, and the function behind the page's server
// function, called on its own. sample-admin is the admin here, and priya
// and octo-maintainer are not. The repos are the fake's made-up ones.

let github: GitHubFake;
const configuredAdmins = env.ADMIN_GITHUB_IDS;
const HARBOR = 'sample-owner/sample-harbor';
const BUNDLER = 'sample-owner/sample-bundler';

beforeEach(async () => {
  await emptyDatabase();
  github = startGitHub();
  env.ADMIN_GITHUB_IDS = '1010';
  await savePerson(env.DB, { githubId: 1008, login: 'octo-maintainer' }, Date.now());
  await createProject(
    env.DB,
    {
      repo: HARBOR,
      status: 'pending',
      source: 'registered',
      policy: null,
      settings: { tags: ['help wanted'], agentNotes: 'Run just test before submitting.' },
      addedBy: 1008,
    },
    Date.now(),
  );
});

afterEach(() => {
  env.ADMIN_GITHUB_IDS = configuredAdmins;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function signedIn(login: string): Promise<Browser> {
  const browser = new Browser();
  await signIn(browser, github, login);
  return browser;
}

/** Follows the form's redirect back to the page, and returns the page's HTML. */
async function back(browser: Browser, answer: Response): Promise<string> {
  expect(answer.status).toBe(303);
  const to = location(answer);
  expect(to.pathname).toBe('/admin');
  const page = await browser.fetch(`${to.pathname}${to.search}`);
  expect(page.status).toBe(200);
  return page.text();
}

/** The queue item ID of HARBOR's registration, from the page's form. */
function harborId(html: string): string {
  const id = /name="id" value="(reg_\d+)"/.exec(html)?.[1];
  if (!id) throw new Error('the registration has no form');
  return id;
}

describe('who sees /admin', () => {
  test('someone signed out is sent to sign in', async () => {
    const page = await new Browser().fetch('/admin');

    expect(location(page).pathname).toBe('/sign-in');
  });

  test("someone signed in who isn't an admin gets a 404 with none of the queue in it, and no admin link in the nav", async () => {
    const browser = await signedIn('priya');

    const page = await browser.fetch('/admin');
    const html = await page.text();
    const home = await (await browser.fetch('/')).text();

    expect(page.status).toBe(404);
    expect(html).toContain('Not found');
    expect(html).not.toContain(HARBOR);
    expect(html).not.toContain('Run just test');
    expect(home).not.toContain('href="/admin"');
  });

  test("an admin sees the registration with its repo's facts from GitHub, the maintainer, the settings, and the notes, and the nav links the page", async () => {
    const browser = await signedIn('sample-admin');
    const reads = github.calls.length;

    const page = await browser.fetch('/admin');
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(html).toContain(HARBOR);
    expect(html).toContain('@<!-- -->octo-maintainer');
    expect(html).toContain('4,200');
    expect(html).toContain('Run just test before submitting.');
    expect(html).toContain('href="/admin"');
    expect(github.calls.slice(reads).map((c) => [new URL(c.url).pathname, c.login])).toEqual(
      expect.arrayContaining([
        [`/repos/${HARBOR}`, 'sample-admin'],
        ['/users/sample-owner', 'sample-admin'],
      ]),
    );
  });

  test("the page's server function gives someone who isn't an admin nothing, and asks GitHub nothing", async () => {
    const browser = await signedIn('priya');
    const cookie = [...browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const fetch = vi.spyOn(globalThis, 'fetch');

    const { result } = await loadAdminPage(new Request(`${ORIGIN}/admin`, { headers: { cookie } }), {});
    const signedOut = await loadAdminPage(new Request(`${ORIGIN}/admin`), {});

    expect(result).toEqual({ state: 'not_found' });
    expect(signedOut.result).toEqual({ state: 'signed_out' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the admin page's forms", () => {
  test('a form sent from another site is refused, and nothing changes', async () => {
    const browser = await signedIn('sample-admin');
    const id = harborId(await (await browser.fetch('/admin')).text());

    const answer = await browser.post('/admin', { action: 'decide', id, decision: 'approve' }, 'https://elsewhere.example');
    const none = await browser.post('/admin', { action: 'decide', id, decision: 'approve' }, null);

    expect(answer.status).toBe(403);
    expect(none.status).toBe(403);
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'pending' });
  });

  test("a form from someone who isn't an admin gets a 404, and nothing changes", async () => {
    const admin = await signedIn('sample-admin');
    const id = harborId(await (await admin.fetch('/admin')).text());
    const maintainer = await signedIn('octo-maintainer');

    const answer = await maintainer.post('/admin', { action: 'decide', id, decision: 'approve' });

    expect(answer.status).toBe(404);
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'pending' });
  });

  test('rejecting needs a reason: the form without one changes nothing and says so, and with one the maintainer gets the reason', async () => {
    const browser = await signedIn('sample-admin');
    const id = harborId(await (await browser.fetch('/admin')).text());

    const refused = await back(browser, await browser.post('/admin', { action: 'decide', id, decision: 'reject', reason: '  ' }));
    const pending = await getProject(env.DB, HARBOR);
    const rejected = await back(
      browser,
      await browser.post('/admin', { action: 'decide', id, decision: 'reject', reason: 'The notes ask agents to skip the tests.' }),
    );

    expect(refused).toContain('Nothing changed. A rejection needs a reason.');
    expect(pending).toMatchObject({ status: 'pending' });
    expect(rejected).toContain(`Rejected ${HARBOR}.`);
    expect(rejected).toContain('No registrations waiting.');
    expect(await getProject(env.DB, HARBOR)).toMatchObject({
      status: 'rejected',
      statusReason: 'The notes ask agents to skip the tests.',
      statusChangedBy: 1010,
    });
  });

  test('approving lists the registration, and the page says so', async () => {
    const browser = await signedIn('sample-admin');
    const id = harborId(await (await browser.fetch('/admin')).text());

    const html = await back(browser, await browser.post('/admin', { action: 'decide', id, decision: 'approve' }));

    expect(html).toContain(`Approved ${HARBOR}. It is listed now.`);
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'approved', statusChangedBy: 1010 });
  });

  test('when GitHub no longer takes the admin\'s token, the queue shows no facts, a form changes nothing, and each says to sign in again', async () => {
    const browser = await signedIn('sample-admin');
    for (const [token, grant] of Object.entries(github.state.tokens)) {
      if (grant.login === 'sample-admin') Reflect.deleteProperty(github.state.tokens, token);
    }

    const page = await (await browser.fetch('/admin')).text();
    const answer = await back(
      browser,
      await browser.post('/admin', {
        action: 'add',
        repo: BUNDLER,
        url: `https://github.com/${BUNDLER}/blob/main/CONTRIBUTING.md`,
        quote: 'AI help is fine. Write the PR description yourself.',
        tier: 'allows_with_conditions',
        tags: 'contribution welcome',
      }),
    );

    expect(page).toContain(HARBOR);
    // React puts an empty comment around each value it fills into text.
    expect(page).toContain(`answer when asked about <!-- -->${HARBOR}<!-- -->. Load the page again for its facts.`);
    expect(page).not.toContain('no public repo');
    expect(page).toContain('GitHub no longer takes the token this site holds for you, so the queue shows no facts from GitHub.');
    expect(answer).toContain('GitHub no longer takes the token this site holds for you.');
    expect(await getProject(env.DB, BUNDLER)).toBeNull();
  });

  test("a notice in a link the page's own form didn't make shows nothing", async () => {
    const browser = await signedIn('sample-admin');

    // A signature as long as a real one, so the page has to compare it.
    const forged = 'A'.repeat(43);
    const html = await (await browser.fetch(`/admin?notice=Approve+sample-owner%2Fevil+now.&sig=${forged}`)).text();

    expect(html).not.toContain('Approve sample-owner/evil now.');
  });

  test('listing one by hand lists it from its policy, and the list shows it', async () => {
    const browser = await signedIn('sample-admin');

    const html = await back(
      browser,
      await browser.post('/admin', {
        action: 'add',
        repo: BUNDLER,
        url: `https://github.com/${BUNDLER}/blob/main/CONTRIBUTING.md`,
        quote: 'AI help is fine. Write the PR description yourself.',
        tier: 'allows_with_conditions',
        tags: 'contribution welcome, help wanted',
      }),
    );

    expect(html).toContain(`Listed ${BUNDLER} from its AI policy.`);
    expect(await getProject(env.DB, BUNDLER)).toMatchObject({
      status: 'approved',
      source: 'policy',
      settings: { tags: ['contribution welcome', 'help wanted'] },
    });
  });

  test('listing a listed repo again by hand changes its policy and tags, and keeps the settings the form has no field for', async () => {
    const browser = await signedIn('sample-admin');
    await createProject(
      env.DB,
      {
        repo: BUNDLER,
        status: 'approved',
        source: 'policy',
        policy: { quote: 'AI help is fine.', url: `https://github.com/${BUNDLER}/blob/main/CONTRIBUTING.md`, tier: 'allows_with_conditions' },
        settings: { tags: ['contribution welcome'], prMode: 'automatic', agentNotes: 'Write the description yourself.' },
        addedBy: 1010,
      },
      Date.now(),
    );

    const html = await back(
      browser,
      await browser.post('/admin', {
        action: 'add',
        repo: BUNDLER,
        url: `https://github.com/${BUNDLER}/blob/main/AGENTS.md`,
        quote: 'Agents are welcome.',
        tier: 'invites_agents',
        tags: 'help wanted',
      }),
    );

    expect(html).toContain(`Updated the listing of ${BUNDLER}.`);
    expect(await getProject(env.DB, BUNDLER)).toMatchObject({
      policy: { quote: 'Agents are welcome.', tier: 'invites_agents' },
      settings: { tags: ['help wanted'], prMode: 'automatic', agentNotes: 'Write the description yourself.' },
    });
  });

  test('blocking a donor by login, and unblocking them', async () => {
    const browser = await signedIn('sample-admin');
    await savePerson(env.DB, { githubId: 1001, login: 'priya' }, Date.now());

    const blocked = await back(browser, await browser.post('/admin', { action: 'block', login: '@priya', reason: 'Spam.' }));
    const block = await getBlock(env.DB, 1001);
    const unblocked = await back(browser, await browser.post('/admin', { action: 'unblock', login: 'priya' }));

    expect(blocked).toContain('Blocked @priya.');
    expect(block).toMatchObject({ reason: 'Spam.', blockedBy: 1010 });
    expect(unblocked).toContain('Unblocked @priya.');
    expect(await getBlock(env.DB, 1001)).toBeNull();
  });
});
