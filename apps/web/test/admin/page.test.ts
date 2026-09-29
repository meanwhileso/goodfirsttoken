import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadAdminPage } from '../../src/admin/page';
import {
  addCandidate,
  addToDoNotList,
  askRemoval,
  closeRemoval,
  createProject,
  getBlock,
  getDoNotListEntry,
  getProject,
  getWaitingRemoval,
  savePerson,
} from '../../src/db';
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

  test("an admin sees a crawler find's sentences that name AI, each with the rest of its paragraph, and where a paragraph was cut", async () => {
    const now = Date.now();
    await addCandidate(
      env.DB,
      {
        repo: BUNDLER,
        facts: { stars: 12000, createdAt: now - 6 * 365 * 86_400_000, pushedAt: now - 7_200_000, ownerCreatedAt: now - 9 * 365 * 86_400_000 },
        policy: {
          quote: 'AI tools are fine for questions.',
          url: `https://github.com/${BUNDLER}/blob/main/CONTRIBUTING.md`,
          tier: 'allows_with_conditions',
        },
        settings: {},
        suggestedTags: [],
        aiSentences: [
          { path: 'CONTRIBUTING.md', text: 'AI tools are fine for questions. Any code from a machine gets closed right away.', cutBefore: false, cutAfter: false },
          { path: 'docs/AI.md', text: 'Step 9 runs here. Claude may help.', cutBefore: true, cutAfter: true },
        ],
        moreAiSentences: 2,
      },
      now,
    );
    const browser = await signedIn('sample-admin');

    const html = await (await browser.fetch('/admin')).text();

    expect(html).toContain('every sentence in its docs that names AI, with the rest of its paragraph. Read them before you decide');
    expect(html).toContain('AI tools are fine for questions. Any code from a machine gets closed right away.');
    expect(html).toContain('Step 9 runs here. Claude may help.');
    // Only the cut paragraph says so, once each way.
    expect(html.split('The paragraph starts earlier in the file.')).toHaveLength(2);
    expect(html.split('The paragraph goes on in the file.')).toHaveLength(2);
    expect(html.indexOf('The paragraph starts earlier in the file.')).toBeLessThan(html.indexOf('Step 9 runs here.'));
    expect(html.indexOf('The paragraph goes on in the file.')).toBeGreaterThan(html.indexOf('Claude may help.'));
    expect(html).toContain(' more in the files. Read them there.');
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
    // The banner says what to do. No item says to load the page again, or
    // that its repo isn't public.
    expect(page).not.toContain('Load the page again for its facts.');
    expect(page).not.toContain('no public repo');
    expect(page).toContain('GitHub no longer takes the token this site holds for you, so the queue shows no facts from GitHub.');
    expect(answer).toContain('GitHub no longer takes the token this site holds for you.');
    expect(await getProject(env.DB, BUNDLER)).toBeNull();
  });

  test("a registration of a repo its maintainers asked to be removed says so, and approving it takes the repo off the do-not-list", async () => {
    const browser = await signedIn('sample-admin');
    await addToDoNotList(env.DB, { repo: HARBOR, reason: null, addedBy: 1010 }, Date.now());

    const page = await (await browser.fetch('/admin')).text();
    const answer = await back(browser, await browser.post('/admin', { action: 'decide', id: harborId(page), decision: 'approve' }));

    expect(page).toContain(
      'Its maintainers asked to be removed, so it is on the do-not-list. Approving this registration takes it off.',
    );
    expect(answer).toContain(`Approved ${HARBOR}.`);
    expect(await getDoNotListEntry(env.DB, HARBOR)).toBeNull();
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

describe("maintainers' requests to be removed on /admin", () => {
  const reason = 'We review every pull request by hand now, so please take us off.';

  test("an admin sees who asked, when, and their reason, and removing the repo closes the request, with who asked in the do-not-list's note", async () => {
    const askedAt = Date.now() - 3 * 60 * 60 * 1000;
    await askRemoval(env.DB, { repo: HARBOR, reason, requestedBy: 1008 }, askedAt);
    const browser = await signedIn('sample-admin');

    const page = await (await browser.fetch('/admin')).text();
    const answer = await back(browser, await browser.post('/admin', { action: 'remove', repo: HARBOR }));

    expect(page).toContain('asking to be removed');
    expect(page).toContain('@<!-- -->octo-maintainer<!-- --> · <!-- -->3 hours<!-- --> ago');
    expect(page).toContain(reason);
    expect(page).toContain('Its project is pending, registered by its maintainers.');
    expect(answer).toContain(`Removed ${HARBOR} at its maintainers&#x27; request.`);
    expect(answer).toContain('No requests to be removed.');
    expect(await getWaitingRemoval(env.DB, HARBOR)).toBeNull();
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'rejected', statusReason: "Removed at its maintainers' request." });
    expect(await getDoNotListEntry(env.DB, HARBOR)).toMatchObject({
      addedBy: 1010,
      reason: `Asked by @octo-maintainer with request_removal on ${new Date(askedAt).toISOString()}.`,
    });
  });

  test('a registration of a repo whose request to be removed waits says so, and its approval changes nothing', async () => {
    await askRemoval(env.DB, { repo: HARBOR, reason, requestedBy: 1008 }, Date.now());
    const browser = await signedIn('sample-admin');

    const page = await (await browser.fetch('/admin')).text();
    const answer = await back(browser, await browser.post('/admin', { action: 'decide', id: harborId(page), decision: 'approve' }));

    expect(page).toContain('A request to be removed waits for this repo too, so it can&#x27;t be approved while that waits.');
    expect(answer).toContain(`A maintainer of ${HARBOR} asked to have it removed, and that request waits in the admin queue.`);
    expect(await getProject(env.DB, HARBOR)).toMatchObject({ status: 'pending' });
  });

  test('a registration whose repo had a request withdrawn by someone other than its asker says who asked and who withdrew it', async () => {
    await savePerson(env.DB, { githubId: 1002, login: 'kenji' }, Date.now());
    await askRemoval(env.DB, { repo: HARBOR, reason, requestedBy: 1002 }, Date.now() - 60_000);
    await closeRemoval(env.DB, HARBOR, { status: 'withdrawn', by: 1008 }, Date.now());
    const browser = await signedIn('sample-admin');

    const page = await (await browser.fetch('/admin')).text();

    expect(page).toContain('@kenji asked to remove this repo, and @octo-maintainer withdrew the request on ');
  });

  test("someone who isn't an admin sees no request, and their form removes nothing", async () => {
    await askRemoval(env.DB, { repo: HARBOR, reason, requestedBy: 1008 }, Date.now());
    const maintainer = await signedIn('octo-maintainer');

    const page = await maintainer.fetch('/admin');
    const html = await page.text();
    const answer = await maintainer.post('/admin', { action: 'remove', repo: HARBOR });

    expect(page.status).toBe(404);
    expect(html).not.toContain(reason);
    expect(answer.status).toBe(404);
    expect(await getWaitingRemoval(env.DB, HARBOR)).toMatchObject({ reason });
    expect(await getDoNotListEntry(env.DB, HARBOR)).toBeNull();
  });
});
