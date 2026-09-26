# How it works

Every product rule Good First Token follows, as the code does it today. The
plan for what comes next is in [specs/v1.md](specs/v1.md). When a piece of the
plan is built, its rules move here in the same pull request.

Nothing is live yet. The site serves a placeholder home page and the design
system at `/design` while the build goes on in the open.

## Health check

- `GET /healthz` answers `200` with `{"ok": true, "environment": "<name>"}`,
  where the name is `development`, `staging`, or `production`. A deploy's
  smoke test reads it to check that it reached the environment it meant to.
- It reads nothing but the environment name, so it answers even when storage
  or GitHub is down.
- It is sent with `Cache-Control: no-store`, so every check reaches the Worker
  that is live now.

## The design system

Every page is built from one set of components. `/design` shows each of
them, with sample data that the page says is sample.

- An element with the `hidden` attribute is always hidden, whatever display
  its class sets.
- Geist and Geist Mono are served by the site itself, so a page view makes no
  third-party requests.
- Only live things move. Under `prefers-reduced-motion: reduce`, nothing
  animates: live dots don't pulse, carets don't blink, and new lines appear
  in full without rising or typing.
- The wall shows the newest line first, and each older line is dimmer than
  the one above. A line that arrives after the page loads rises in. On a
  wall set to type, the newest of those types itself out, one character
  every 18 ms.
- A project's label is drawn in its GitHub color. Its text is white or ink,
  whichever has the higher WCAG contrast on that color.
- A prompt's copy button puts the prompt's full text on the clipboard, and
  says `copied`, or `select it` when the browser refuses, then goes back to
  `copy` after 1.6 seconds. A command can show a shorter form than it
  copies, like a URL without `https://`.
- The open-in links open each harness with the prompt filled in, encoded as
  a URL parameter: Claude Code at `claude://code/new?q=`, Codex at
  `codex://new?prompt=`, and Cursor at
  `cursor://anysphere.cursor-deeplink/prompt?text=`. T3 Code takes no
  prompt, so its button copies the prompt, says so, and opens `t3code://`
  0.6 seconds later.
- The nav marks the current page with a dot. Signed in, it shows the
  person's avatar and login where the GitHub mark would be. When the nav is
  880px wide or narrower, its links fold into a menu that opens from a
  checkbox, so it works before any script runs.
- Tabs show one panel at a time. The left and right arrow keys, Home, and
  End move between them.
