// Small helpers for GitHub-shaped HTTP responses.

import type { ValidationError } from './state.ts';

export const REST_DOCS = 'https://docs.github.com/rest';

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

// GitHub's error body: a message, the docs page for the endpoint, the status
// as a string, and the field errors for a 422.
export function errorResponse(status: number, message: string, docs: string, errors: ValidationError[] = []) {
  return json(
    { message, ...(errors.length > 0 ? { errors } : {}), documentation_url: docs, status: String(status) },
    status,
  );
}

// Pages a list the way GitHub does: per_page (30 by default, at most 100),
// page, and a Link header with the first, prev, next, and last pages.
export function paginate<T>(url: URL, items: T[]): { items: T[]; start: number; headers: Record<string, string> } {
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  const last = Math.max(1, Math.ceil(items.length / perPage));
  const link = (n: number, rel: string) => {
    const target = new URL(url);
    target.searchParams.set('page', String(n));
    return `<${target.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (page > 1) links.push(link(page - 1, 'prev'));
  if (page < last) links.push(link(page + 1, 'next'), link(last, 'last'));
  if (page > 1) links.push(link(1, 'first'));
  return {
    items: items.slice((page - 1) * perPage, page * perPage),
    start: (page - 1) * perPage,
    headers: links.length > 0 ? { link: links.join(', ') } : {},
  };
}
