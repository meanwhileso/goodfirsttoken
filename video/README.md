# Launch video source

`index.html` is the whole 36-second launch video as one HTML page. Every
element's position is a function of a single time value, so the video renders
the same way every time and can be re-rendered whenever the site changes.

- Open `index.html?play` in a browser to watch it loop.
- `pnpm video:stills 2.5 12.8 24.2 28.9 35` writes a few frames to
  `stills/` for a layout check.
- `pnpm video:render` writes all 1,080 frames, encodes
  `prototype/assets/good-first-token-launch.mp4`, and writes the WebP poster
  beside it. It needs `ffmpeg` and `cwebp` (`brew install ffmpeg webp`) and
  takes about 30 seconds.

Both need Chromium for Playwright once: `pnpm exec playwright install chromium`.

Every issue shown belongs to `meanwhileso/goodfirsttoken`, so the video says
nothing about other projects. The two donor handles are sample names and the
browser frame is labeled "demo data." Seed those three issues on launch day
so the video matches real work.

In production the MP4 and poster will be served from
`static.goodfirsttoken.org`.
