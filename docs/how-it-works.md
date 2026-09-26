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

## Calls to GitHub

- Every call to GitHub names the token it runs with, the token of the person
  the call is for. There is no default token, so a call can act only as the
  person it names. Nothing calls GitHub yet. Sign-in (#8) is the first.
- When GitHub refuses a call, the refusal comes back with GitHub's status
  and message.
- In local development, GitHub is the GitHub fake, and its sign-in page
  lets you pick any sample person to be.
