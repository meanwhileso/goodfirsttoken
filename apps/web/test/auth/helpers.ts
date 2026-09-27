import { createGitHubFake, type GitHubFake } from '@goodfirsttoken/github-fake';
import { env, exports } from 'cloudflare:workers';
import { vi } from 'vitest';

// Shared setup for the sign-in tests. Requests go to the whole Worker, on the
// primary domain the test config sets, and GitHub is the in-process fake.

export const ORIGIN = 'https://primary.example';

/** The environment's OAuth app, registered with the fake the way self-hosting.md says. */
export const APP = {
  name: 'Good First Token (test)',
  clientId: env.OAUTH_CLIENT_ID,
  clientSecret: env.OAUTH_CLIENT_SECRET,
  callbackUrl: `${ORIGIN}/auth/callback`,
};

/** A fresh GitHub fake that knows the app, standing in for the global fetch. */
export function startGitHub(): GitHubFake {
  const github = createGitHubFake({ apiUrl: env.GH_API_URL, webUrl: env.GH_WEB_URL });
  github.state.oauthApps[APP.clientId] = { ...APP };
  vi.stubGlobal('fetch', github.fetch);
  return github;
}

export interface SetCookie {
  name: string;
  value: string;
  attributes: string[];
  header: string;
}

export function parseSetCookie(header: string): SetCookie {
  const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
  const eq = pair.indexOf('=');
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes, header };
}

function randomAddress(): string {
  const words = [...crypto.getRandomValues(new Uint16Array(4))].map((word) => word.toString(16));
  return `2001:db8::${words.join(':')}`;
}

/**
 * A browser: it keeps the cookies the Worker sets and sends them back, and
 * records every Set-Cookie header it gets. Each one comes from its own
 * address, so the sign-in rate limit counts it alone.
 */
export class Browser {
  readonly cookies = new Map<string, string>();
  readonly setCookies: SetCookie[] = [];
  readonly address: string;

  constructor(address = randomAddress()) {
    this.address = address;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('cf-connecting-ip', this.address);
    if (this.cookies.size > 0) {
      headers.set('cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    }
    // The Worker's fetch would follow a redirect back into the Worker, so
    // redirects come back as they are, as the tests follow them by hand.
    const response = await exports.default.fetch(
      new Request(new URL(path, ORIGIN), { ...init, headers, redirect: 'manual' }),
    );
    for (const header of response.headers.getSetCookie()) {
      const cookie = parseSetCookie(header);
      this.setCookies.push(cookie);
      if (/^max-age=0$/i.test(cookie.attributes.find((a) => /^max-age=/i.test(a)) ?? '') || cookie.value === '') {
        this.cookies.delete(cookie.name);
      } else {
        this.cookies.set(cookie.name, cookie.value);
      }
    }
    return response;
  }

  /** Posts a form from one of the site's own pages. */
  post(path: string, fields: Record<string, string> = {}, origin = ORIGIN): Promise<Response> {
    return this.fetch(path, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
  }
}

/** Where a redirect points. */
export function location(response: Response): URL {
  const to = response.headers.get('location');
  if (!to) throw new Error(`Expected a redirect, and got ${String(response.status)}.`);
  return new URL(to, ORIGIN);
}

/**
 * Picks a sample person on the fake's sign-in page, the way a person does
 * after the site sends them there, and returns where the fake sends them
 * back to.
 */
export async function pickOnGitHub(github: GitHubFake, authorize: URL, login: string): Promise<URL> {
  const fields = new URLSearchParams(authorize.searchParams);
  fields.set('login', login);
  const response = await github.fetch(`${authorize.origin}${authorize.pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: fields,
    redirect: 'manual',
  });
  return location(response);
}

/** Signs `browser` in as `login` through the site's sign-in and GitHub. Returns the callback's answer. */
export async function signIn(browser: Browser, github: GitHubFake, login: string): Promise<Response> {
  const start = await browser.post('/auth/sign-in');
  const back = await pickOnGitHub(github, location(start), login);
  return browser.fetch(back.toString());
}

/** The text of the nav's link to /me, which shows who is signed in, or null when it isn't there. */
export async function navLogin(response: Response): Promise<string | null> {
  const html = await response.text();
  // The login is the text after the avatar. React puts an empty comment
  // between the "@" and the login, and nothing else sits in the link.
  const text = /<a class="site-nav__me"[^>]*>\s*<span class="avatar"[^>]*>[^<]*<\/span>([^<]*(?:<!-- -->[^<]*)*)<\/a>/.exec(html)?.[1];
  return text === undefined ? null : text.split('<!-- -->').join('').trim();
}

/** The tokens the fake gave the app through sign-in, oldest first. */
export function tokensIssued(github: GitHubFake): string[] {
  return Object.entries(github.state.tokens)
    .filter(([, grant]) => grant.clientId === APP.clientId)
    .map(([token]) => token);
}

/** Every row of every table, as one string, to search for a value anywhere in the database. */
export async function wholeDatabase(): Promise<string> {
  const { results: tables } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '_cf_*' AND name != 'sqlite_sequence'`,
  ).all<{ name: string }>();
  const rows = await Promise.all(tables.map(({ name }) => env.DB.prepare(`SELECT * FROM "${name}"`).all()));
  return JSON.stringify(rows.map((result) => result.results));
}
