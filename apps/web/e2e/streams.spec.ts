import { expect, test } from './fixtures';

// The live text streams are public and set no cookie. The fixtures check
// every Set-Cookie header these answers carry. The local server holds a
// stream's headers until its first line, and no line comes here, so the
// streams that exist are asked with HEAD, which the Worker answers with the
// same headers and no body.

test('a live stream answers in plain text, or NDJSON for the .ndjson form, with no cookie and no caching', async ({
  request,
}) => {
  for (const [path, type] of [
    ['/live.txt', 'text/plain; charset=utf-8'],
    ['/live.ndjson', 'application/x-ndjson; charset=utf-8'],
  ] as const) {
    const res = await request.head(path);

    expect(res.status(), path).toBe(200);
    expect(res.headers()['content-type'], path).toBe(type);
    expect(res.headers()['cache-control'], path).toBe('no-store, no-transform');
  }
});

test('a stream for a repo that is not a project, or a login no one signed in with, is not found', async ({ request }) => {
  for (const path of ['/sample-owner/not-a-project/live.txt', '/@nobody-signed-in-here/live.ndjson']) {
    const res = await request.get(path);

    expect(res.status(), path).toBe(404);
  }
});
