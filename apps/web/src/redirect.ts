// A request to one of the redirect domains answers 301 with the same path and
// query on the primary domain. The deploy sets both variables from the GitHub
// environment. Locally they are empty, so nothing redirects.
export function redirectToPrimaryDomain(
  request: Request,
  env: Pick<Env, 'PRIMARY_DOMAIN' | 'REDIRECT_DOMAINS'>,
): Response | undefined {
  const primary = env.PRIMARY_DOMAIN.trim().toLowerCase();
  if (!primary) return undefined;
  const url = new URL(request.url);
  const host = url.hostname.replace(/\.$/, '');
  const redirects = env.REDIRECT_DOMAINS.toLowerCase().split(/[\s,]+/);
  if (!redirects.includes(host)) return undefined;
  return Response.redirect(`https://${primary}${url.pathname}${url.search}`, 301);
}
