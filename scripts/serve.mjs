// Serves a folder over HTTP for local review, with byte ranges so Safari
// plays video. A folder with no index.html lists its pages. No dependencies.
//
//   node scripts/serve.mjs prototype        # http://localhost:8943
//   PORT=9000 node scripts/serve.mjs video
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
};

export function contentType(file) {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export function knownType(file) {
  return Object.hasOwn(TYPES, path.extname(file).toLowerCase());
}

// Returns { start, end } for a satisfiable single range, { unsatisfiable: true }
// for one past the end, or null when the header is missing or malformed.
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return null;
  // A range that ends before it starts is invalid, so the header is ignored.
  if (match[1] !== '' && match[2] !== '' && Number(match[1]) > Number(match[2])) return null;
  let start;
  let end;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return { unsatisfiable: true };
  return { start, end };
}

// Maps a URL path to a file inside root, or null if it would escape root.
export function resolvePath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  const file = path.resolve(root, `.${decoded.endsWith('/') ? `${decoded}index.html` : decoded}`);
  return file === root || file.startsWith(root + path.sep) ? file : null;
}

export function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found\n');
}

// Sends a file with the given headers, or the byte range the request asks
// for. `size` is the file's size in bytes. The file must be inside root. Its
// callers check that already, and this checks again next to the read, so a
// caller can't forget.
export function sendFile(req, res, root, file, size, headers) {
  file = path.resolve(file);
  if (!file.startsWith(path.resolve(root) + path.sep)) return notFound(res);
  headers = { ...headers, 'accept-ranges': 'bytes' };
  const range = parseRange(req.headers.range, size);
  if (range?.unsatisfiable) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
    res.end();
    return;
  }
  if (range) {
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'content-length': range.end - range.start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    pipeline(createReadStream(file, range), res, () => {});
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  if (req.method === 'HEAD') return res.end();
  pipeline(createReadStream(file), res, () => {});
}

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Lists the pages in `folder`, which must be root or inside it. Like
// sendFile, this checks next to the read, so a caller can't forget.
async function sendFolder(res, root, folder) {
  const base = path.resolve(root) + path.sep;
  const dir = path.resolve(folder) + path.sep;
  if (!dir.startsWith(base)) return notFound(res);
  const names = await readdir(dir).catch(() => null);
  if (!names) return notFound(res);
  sendListing(res, `${path.basename(dir)}/`, names);
}

// Answers with a list of the HTML and markdown pages in a folder, linked.
export function sendListing(res, title, names) {
  const pages = names.filter((name) => /\.(html|md)$/.test(name)).sort();
  const items = pages.map((name) => `<li><a href="${escapeHtml(encodeURIComponent(name))}">${escapeHtml(name)}</a></li>`);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(
    `<!doctype html>\n<meta charset="utf-8">\n<title>${escapeHtml(title)}</title>\n<h1>${escapeHtml(title)}</h1>\n<ul>\n${items.join('\n')}\n</ul>\n`,
  );
}

export function createStaticServer(root) {
  const base = path.resolve(root);
  return createServer(async (req, res) => {
    const file = resolvePath(base, req.url ?? '/');
    const info = file && (await stat(file).catch(() => null));
    if (info?.isFile()) {
      return sendFile(req, res, base, file, info.size, { 'content-type': contentType(file), 'cache-control': 'no-store' });
    }
    // A folder URL, whose folder has no index.html, lists the folder's pages.
    const isFolder = file !== null && new URL(req.url ?? '/', 'http://localhost').pathname.endsWith('/');
    if (!isFolder) return notFound(res);
    return sendFolder(res, base, path.dirname(file));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? 'prototype';
  const port = Number(process.env.PORT ?? 8943);
  createStaticServer(root).listen(port, () => {
    console.log(`Serving ${root}/ at http://localhost:${port}`);
  });
}
