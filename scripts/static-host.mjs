// The static host: the files the build names after their content, which
// pages load from STATIC_ORIGIN when a deploy sets it. The deploy uploads them
// to an R2 bucket (scripts/deploy.mjs static-assets), and a Cloudflare custom
// domain serves them. The end-to-end tests serve the same files from a
// stand-in on this machine, with the headers the upload stores for each one.
//
//   node scripts/static-host.mjs apps/web/dist/client    # http://127.0.0.1:4174
//   PORT=9000 node scripts/static-host.mjs apps/web/dist/client
import { readdirSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentType, notFound, resolvePath, sendFile } from './serve.mjs';

// Where the Vite build writes the files a browser loads, and the folder in it
// whose files carry a content hash in their names.
export const CLIENT_DIR = 'apps/web/dist/client';
export const ASSETS_DIR = 'assets';

// A file's name changes whenever its content does, so a browser or a cache
// can keep it for a year without asking again.
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

// The headers R2 stores with an object and sends with it.
export function objectHeaders(file) {
  return { 'content-type': contentType(file), 'cache-control': CACHE_CONTROL };
}

// Every file the deploy uploads: each file under assets/ in the build, keyed
// by its path from the build's root, which is its path on the static host.
// Nothing outside assets/ goes, since only those names change with content.
export function staticObjects(clientDir) {
  const dir = path.join(clientDir, ASSETS_DIR);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      const key = path.relative(clientDir, file).split(path.sep).join('/');
      return { key, file, headers: objectHeaders(file) };
    })
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

// Answers the way the static host does: each file under assets/ with the
// headers the upload stores for it, byte ranges included, and a 404 for
// anything else. It sets no cookie. Access-Control-Allow-Origin stands in for
// the response header rule on the static host's hostname, which lets pages on
// the site load fonts and scripts from another origin.
export function createStaticHost(clientDir) {
  const root = path.resolve(clientDir);
  const assets = path.join(root, ASSETS_DIR) + path.sep;
  return createServer(async (req, res) => {
    const file = resolvePath(root, req.url ?? '/');
    if (!file?.startsWith(assets) || !['GET', 'HEAD'].includes(req.method ?? '')) return notFound(res);
    // The build may still be running when the stand-in starts, so each
    // request looks for its file afresh.
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return notFound(res);
    sendFile(req, res, file, info.size, { ...objectHeaders(file), 'access-control-allow-origin': '*' });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? CLIENT_DIR;
  const port = Number(process.env.PORT ?? 4174);
  createStaticHost(dir).listen(port, '127.0.0.1', () => {
    console.log(`Serving ${dir}/${ASSETS_DIR}/ as the static host at http://127.0.0.1:${port}`);
  });
}
