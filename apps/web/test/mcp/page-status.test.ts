import { expect, test } from 'vitest';
import { withPageStatus } from '../../src/mcp/page-status';
import { PAGE_STATUS_HEADER } from '../../src/mcp/paths';

// The page where a person approves an agent names its status in a header,
// since TanStack Start renders every page with 200. The Worker sets it from
// there, and only to a status the page has.

const page = (status: string) =>
  new Response('<!DOCTYPE html>', { headers: { 'content-type': 'text/html', [PAGE_STATUS_HEADER]: status } });

test.each(['400', '429', '503'])('a page that names %s answers with it, and the header never leaves the Worker', (status) => {
  const answer = withPageStatus(page(status));

  expect(answer.status).toBe(Number(status));
  expect(answer.headers.has(PAGE_STATUS_HEADER)).toBe(false);
  expect(answer.headers.get('content-type')).toBe('text/html');
});

test.each(['302', '200', '999', '0', 'teapot', ''])(
  'any other status a page names, like %j, leaves it at 200, and the header is still removed',
  (status) => {
    const answer = withPageStatus(page(status));

    expect(answer.status).toBe(200);
    expect(answer.headers.has(PAGE_STATUS_HEADER)).toBe(false);
  },
);
