import type { NoticeParams } from './notice-params';
import { authSecret } from './settings';

// A page with forms, like /admin or /me, says what its last form did with a
// notice in the address it sends the person back to, beside a signature of
// it made with AUTH_SECRET. The page shows the notice only when the
// signature matches, so a link made elsewhere can't put words on it. Each
// page signs for a purpose of its own, so a notice signed for one page, or
// for one person's page, shows nowhere else.

/** The longest notice a page shows. */
const MAX_NOTICE = 2000;

const encoder = new TextEncoder();

/** The HMAC-SHA256 of the notice for `purpose`, keyed with AUTH_SECRET, in base64url. */
export async function signNotice(purpose: string, notice: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(authSecret()), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${purpose}:${notice}`)));
  return btoa(String.fromCharCode(...mac)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** The notice, when its signature is the one `purpose` gives it, or null. */
export async function verifiedNotice(purpose: string, { notice, sig }: NoticeParams): Promise<string | null> {
  if (typeof notice !== 'string' || typeof sig !== 'string' || notice.length > MAX_NOTICE) return null;
  const expected = await signNotice(purpose, notice);
  if (expected.length !== sig.length) return null;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return difference === 0 ? notice : null;
}

/**
 * Sends the person back to `path` with a notice of what the form did,
 * signed for `purpose`, and any cookies to set. A notice longer than a page
 * shows is cut to fit.
 */
export async function backWithNotice(path: string, purpose: string, said: string, setCookies: string[]): Promise<Response> {
  const notice = said.slice(0, MAX_NOTICE);
  const query = new URLSearchParams({ notice, sig: await signNotice(purpose, notice) });
  const headers = new Headers({ location: `${path}?${query.toString()}`, 'cache-control': 'no-store' });
  for (const cookie of setCookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}
