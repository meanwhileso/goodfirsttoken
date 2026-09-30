import { siteOrigin } from '../auth/settings';
import type { Card } from './cards';
import { loadIssueCard, loadPersonCard, loadProjectCard, siteCard, type CardResult } from './load';
import { renderCard } from './render';

// The share cards' paths, beside the pages they belong to, as the live text
// streams are (src/feed/streams.ts):
//
//   /card.png                              the default card
//   /@<user>/card.png                      a person's month
//   /<owner>/<repo>/card.png               a project's totals
//   /<owner>/<repo>/issues/<n>/card.png    the issue's merged PR
//
// Each page names its card in its og:image tag (./meta.ts). A card is made
// when it is asked for, as a page is, and is public and the same for
// everyone, so it reads no cookie and sets none.

const DEFAULT = /^\/card\.png$/;
const PERSON = /^\/@([^/]+)\/card\.png$/;
const REPO = /^\/([^/]+)\/([^/]+)\/card\.png$/;
const ISSUE = /^\/([^/]+)\/([^/]+)\/issues\/([^/]+)\/card\.png$/;

/** True when the path is shaped like a card's, whether or not the card exists. */
export function isCardPath(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return [DEFAULT, PERSON, REPO, ISSUE].some((pattern) => pattern.test(pathname));
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', ...headers },
  });
}

/** The card a path names. */
async function cardFor(request: Request, pathname: string): Promise<CardResult> {
  if (DEFAULT.test(pathname)) return { state: 'ready', card: siteCard(request), isDefault: true };
  let match = PERSON.exec(pathname);
  if (match) return loadPersonCard(request, match[1] ?? '');
  match = ISSUE.exec(pathname);
  if (match) return loadIssueCard(request, match[1] ?? '', match[2] ?? '', match[3] ?? '');
  match = REPO.exec(pathname);
  if (match) return loadProjectCard(request, match[1] ?? '', match[2] ?? '');
  return { state: 'not_found' };
}

// The default card's PNG for each site origin, kept for the isolate's life.
// It is the same bytes every time, and any issue path with no merged PR
// asks for it, so it is drawn once. With no primary domain, the origin is
// the request's, which a wildcard route lets anyone pick, so only the few
// asked for most lately are kept.
const defaultPngs = new Map<string, Uint8Array<ArrayBuffer>>();
const DEFAULT_PNGS_KEPT = 4;

async function drawDefault(request: Request, card: Card): Promise<Uint8Array<ArrayBuffer>> {
  const origin = siteOrigin(request);
  let png = defaultPngs.get(origin);
  if (png) {
    // Asked for again, so it moves to the newest place.
    defaultPngs.delete(origin);
  } else {
    png = await renderCard(card);
  }
  defaultPngs.set(origin, png);
  for (const oldest of defaultPngs.keys()) {
    if (defaultPngs.size <= DEFAULT_PNGS_KEPT) break;
    defaultPngs.delete(oldest);
  }
  // A copy for each answer, so no answer can change the kept bytes.
  return png.slice();
}

/**
 * Answers a request on a card's path with the card as a PNG, or why there is
 * none. HEAD gets the same status and headers, with no card drawn.
 */
export async function answerCard(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'A card is read with GET.', { allow: 'GET, HEAD' });
  const { pathname } = new URL(request.url);
  const headers = { 'content-type': 'image/png', 'x-content-type-options': 'nosniff' };
  let png: Uint8Array<ArrayBuffer>;
  try {
    const found = await cardFor(request, pathname);
    if (found.state === 'not_found') return text(404, 'There is no card at this address.');
    if (request.method === 'HEAD') return new Response(null, { headers });
    png = found.isDefault ? await drawDefault(request, found.card) : await renderCard(found.card);
  } catch (error) {
    console.warn(`The card at ${pathname} could not be made.`, error);
    return text(503, "This card can't be made right now. Try again in a moment.");
  }
  return new Response(png, { headers });
}
