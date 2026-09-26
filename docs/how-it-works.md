# How it works

Every product rule Good First Token follows, as the code does it today. The
plan for what comes next is in [specs/v1.md](specs/v1.md). When a piece of the
plan is built, its rules move here in the same pull request.

Nothing is live yet. The site serves a placeholder home page while the build
goes on in the open.

## Health check

- `GET /healthz` answers `200` with `{"ok": true, "environment": "<name>"}`,
  where the name is `development`, `staging`, or `production`. A deploy's
  smoke test reads it to check that it reached the environment it meant to.
- It reads nothing but the environment name, so it answers even when storage
  or GitHub is down.
- It is sent with `Cache-Control: no-store`, so every check reaches the Worker
  that is live now.

## Domains

- The site is served on one primary domain. A deployment can also have
  redirect domains.
- A request to a redirect domain answers `301` with the same path and query
  on the primary domain, over https. Every path redirects, `/healthz`
  included.
- Any other host is served as it is, such as workers.dev when a deployment
  has no domain.
- The domains come from the deployment's settings, listed in
  [self-hosting.md](self-hosting.md). With no primary domain, as in local
  development, nothing redirects.
