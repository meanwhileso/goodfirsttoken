import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// The admin pages, signed in through the GitHub fake with the dev sign-in.
// In development the fake's sample-admin is an admin, and priya is not. The
// sample work from POST /dev/seed leaves two registrations and a crawler
// find waiting, on the fake's made-up repos. Approving a registration lists
// it on the homepage, so these run in the `admin` project, once the other
// tests are done. Every sign-in counts toward the limit of 20 a minute from
// this machine, so the tests sign in as few times as they can.

const NOTES = 'sample-owner/sample-notes';
const HARBOR = 'sample-owner/sample-harbor';
const CLI = 'sample-owner/sample-cli';

async function devSignIn(page: Page, login: string) {
  await page.goto('/');
  await page.evaluate((person) => {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = '/auth/dev/sign-in';
    const field = document.createElement('input');
    field.name = 'login';
    field.value = person;
    form.append(field);
    document.body.append(form);
    form.submit();
  }, login);
  await page.waitForURL((url) => url.pathname === '/me');
}

function adminLink(page: Page) {
  return page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'admin', exact: true });
}

test.beforeEach(async ({ request }) => {
  const seeded = await request.post('/dev/seed');
  expect(seeded.status()).toBe(200);
});

test("someone who isn't an admin gets no admin page, no admin link, and nothing from the page's server function", async ({
  page,
  browser,
}) => {
  await devSignIn(page, 'sample-admin');
  await page.goto('/admin');
  // A form that changes nothing still says so.
  const byHand = page.getByRole('region', { name: 'list one by hand' });
  await byHand.getByLabel('repository').fill('sample-owner/no-such-repo');
  await byHand.getByLabel('link to where their docs welcome AI').fill('https://github.com/sample-owner/no-such-repo');
  await byHand.getByLabel('their words, quoted exactly').fill('Agents are welcome.');
  await byHand.getByLabel('its own tags, separated by commas').fill('help wanted');
  await byHand.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('status')).toContainText('GitHub shows no public repo named sample-owner/no-such-repo.');
  // Dismissing the notice reads the page's data again, through its server
  // function, which answers with the queue.
  const call = page.waitForResponse(
    async (response) =>
      new URL(response.url()).pathname.startsWith('/_serverFn/') && (await response.text()).includes('registrations'),
  );
  await page.getByRole('link', { name: 'dismiss' }).click();
  const answer = await call;
  expect(await answer.text()).toContain(CLI);
  await expect(page.getByRole('status')).toHaveCount(0);

  const other = await browser.newContext();
  const priya = await other.newPage();
  await devSignIn(priya, 'priya');
  await expect(adminLink(priya)).toHaveCount(0);
  const response = await priya.goto('/admin');
  const headers = Object.fromEntries(Object.entries(await answer.request().allHeaders()).filter(([name]) => name !== 'cookie'));
  const replay = await priya.request.get(answer.url(), { headers });
  const body = await replay.text();

  expect(response?.status()).toBe(404);
  await expect(priya.getByRole('heading', { level: 1 })).toHaveText('Not found');
  await expect(priya.getByText(NOTES)).toHaveCount(0);
  expect(body).toContain('not_found');
  expect(body).not.toContain('sample-owner/');
  await other.close();
});

test('an admin rejects a registration only with a reason, approves another, and each leaves the queue', async ({ page }) => {
  await devSignIn(page, 'sample-admin');
  await adminLink(page).click();
  await page.waitForURL((url) => url.pathname === '/admin');
  const notes = page.getByRole('article', { name: NOTES });
  await expect(notes.getByText('Skip the tests, they are slow.')).toBeVisible();
  await expect(notes.getByText('900', { exact: true })).toBeVisible();

  // The form refuses an empty reason.
  const reason = notes.getByLabel('reason, needed to reject');
  await notes.getByRole('button', { name: 'Reject' }).click();
  expect(await reason.evaluate((field: HTMLTextAreaElement) => field.validity.valueMissing)).toBe(true);
  expect(new URL(page.url()).search).toBe('');
  await expect(notes).toBeVisible();

  await reason.fill('The notes ask agents to skip the tests. Take that line out and register again.');
  await notes.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByRole('status')).toContainText(`Rejected ${NOTES}.`);
  await expect(page.getByRole('article', { name: NOTES })).toHaveCount(0);

  const harbor = page.getByRole('article', { name: HARBOR });
  await expect(harbor.getByText('4,200')).toBeVisible();
  await harbor.getByRole('button', { name: 'Approve and list' }).click();
  await expect(page.getByRole('status')).toContainText(`Approved ${HARBOR}. It is listed now.`);
  await expect(page.getByRole('article', { name: HARBOR })).toHaveCount(0);
  await expect(page.getByText('No registrations waiting.')).toBeVisible();
  await expect(page.getByRole('article', { name: CLI })).toBeVisible();
});
