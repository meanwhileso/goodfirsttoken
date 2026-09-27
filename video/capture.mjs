// Renders index.html (a scene driven by one time value) into the launch video.
//
//   pnpm video:stills 2.5 12.8 24.2
//       writes video/stills/t-<seconds>.png for a quick layout check
//   pnpm video:render
//       writes every frame at 30 fps, encodes the MP4 with ffmpeg, and writes
//       the WebP poster, both into ../apps/web/src/assets/, which the site's
//       build puts on its static host for the homepage.
//
// Needs ffmpeg and cwebp on PATH (brew install ffmpeg webp).
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = await import('playwright');

const FPS = 30;
const POSTER_AT = 23.9;
const assets = path.resolve(here, '../apps/web/src/assets');
const [mode = 'stills', ...rest] = process.argv.slice(2);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.join(here, 'index.html')).href);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);

async function shoot(t, file) {
  await page.evaluate((x) => window.__setTime(x), t);
  await page.screenshot({ path: file });
}

if (mode === 'stills') {
  const dir = path.join(here, 'stills');
  mkdirSync(dir, { recursive: true });
  for (const t of rest.map(Number)) await shoot(t, path.join(dir, `t-${t}.png`));
  await browser.close();
} else if (mode === 'render') {
  const frames = path.join(here, 'frames');
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  const duration = await page.evaluate(() => window.__duration);
  const total = Math.round(duration * FPS);
  for (let i = 0; i < total; i++) {
    await shoot(i / FPS, path.join(frames, String(i).padStart(5, '0') + '.png'));
  }
  await shoot(POSTER_AT, path.join(frames, 'poster.png'));
  await browser.close();

  mkdirSync(assets, { recursive: true });
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(frames, '%05d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart',
    path.join(assets, 'good-first-token-launch.mp4'),
  ], { stdio: 'inherit' });
  execFileSync('cwebp', ['-quiet', '-q', '82', path.join(frames, 'poster.png'), '-o', path.join(assets, 'launch-poster.webp')], { stdio: 'inherit' });
  rmSync(frames, { recursive: true, force: true });
  console.log(`Rendered ${total} frames to apps/web/src/assets/good-first-token-launch.mp4`);
} else {
  await browser.close();
  throw new Error(`Unknown mode "${mode}". Use "stills" or "render".`);
}
