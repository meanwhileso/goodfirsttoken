# Launch video source

`index.html` is the whole 36-second launch video as one HTML page. Every
element's position is a function of a single time value, so the video renders
the same way every time and can be re-rendered whenever the site changes.

It draws parts of the site's pages with their routes' markup and classes:
the issue page from `apps/web/src/routes/$owner.$repo.issues.$number.tsx`,
and the homepage's hero, prompt, and merged this week from
`apps/web/src/routes/index.tsx`. It links the site's stylesheets and Geist
fonts from `apps/web/src/`, so a change to the site's CSS shows after a
re-render. The markup is copied from the routes by hand, so a change to a
page's markup or words needs the same change in `index.html`.

- Open `index.html?play` in a browser to watch it loop.
- `pnpm video:stills 2.8 11.9 15.6 23 24.6 27 29.5 35` writes the frames at
  these times to `stills/`, for a layout check. A PR that changes the video
  commits them, so a reviewer can see every scene in the PR's files.
- `pnpm video:render` writes all 1,080 frames, encodes
  `apps/web/src/assets/good-first-token-launch.mp4`, and writes the WebP
  poster beside it, for the homepage and the repo's README. It needs `ffmpeg`
  and `cwebp` (`brew install ffmpeg webp`) and takes a few minutes.

Both need Chromium for Playwright once: `pnpm exec playwright install chromium`.

Every issue shown belongs to `meanwhileso/goodfirsttoken`, so the video says
nothing about other projects. They are its launch seeds, tagged
`goodfirsttoken`, the tag the repo is listed for. The two donor handles are
sample names and the browser frames are labeled "demo data." The counts the
site shows, like slots taken and the one PR in merged this week, follow from
the story. The agents' lines state no counts, commit hashes, or diff sizes.

The issue and PR numbers stand in for real ones. They, the titles, and the
special instructions live once, in `DEMO` at the top of the script. To set
real ones, change `DEMO` and render again. [ROADMAP.md](../ROADMAP.md) has the
step that does this before launch.

The site's build puts the MP4 and the poster on its static host, with
byte ranges so Safari plays the video.
[architecture.md](../docs/architecture.md#the-static-host) says how.
