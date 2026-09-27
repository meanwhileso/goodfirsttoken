# Launch video source

`index.html` is the whole 36-second launch video as one HTML page. Every
element's position is a function of a single time value, so the video renders
the same way every time and can be re-rendered whenever the site changes.

The homepage and the issue page in it are the site's own. They use the markup
and classes of their routes, `apps/web/src/routes/index.tsx` and
`apps/web/src/routes/$owner.$repo.issues.$number.tsx`, and the site's
stylesheets and Geist fonts from `apps/web/src/`. A change to the site's CSS
shows after a re-render. A change to a page's markup or words needs the same
change in `index.html` first.

- Open `index.html?play` in a browser to watch it loop.
- `pnpm video:stills 2.8 11.9 13.3 23 24.6 27 29.5 35` writes one frame from
  each scene to `stills/`, for a layout check. A PR that changes the video
  commits these, so a reviewer can see each scene in the PR's files.
- `pnpm video:render` writes all 1,080 frames, encodes
  `apps/web/src/assets/good-first-token-launch.mp4`, and writes the WebP
  poster beside it, for the homepage and the repo's README. It needs `ffmpeg`
  and `cwebp` (`brew install ffmpeg webp`) and takes a few minutes.

Both need Chromium for Playwright once: `pnpm exec playwright install chromium`.

Every issue shown belongs to `meanwhileso/goodfirsttoken`, so the video says
nothing about other projects. The two donor handles are sample names and the
browser frames are labeled "demo data." Each count on screen comes from the
story itself, like the one PR in merged this week. The issue and PR numbers,
set once in `DEMO` at the top of the script, stand in for real ones. Before
launch, open the three issues, set their numbers there, and render again, so
the video matches real work.

The site's build puts the MP4 and the poster on its static host, with
byte ranges so Safari plays the video.
[architecture.md](../docs/architecture.md#the-static-host) says how.
