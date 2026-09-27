// Serves a folder over HTTP for local review, with byte ranges so Safari
// plays video. No dependencies.
//
//   node scripts/serve.mjs prototype        # http://localhost:8943
//   PORT=9000 node scripts/serve.mjs video
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
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
// for. `size` is the file's size in bytes.
export function sendFile(req, res, file, size, headers) {
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

export function createStaticServer(root) {
  const base = path.resolve(root);
  return createServer(async (req, res) => {
    const file = resolvePath(base, req.url ?? '/');
    const info = file && (await stat(file).catch(() => null));
    if (!info?.isFile()) return notFound(res);
    sendFile(req, res, file, info.size, { 'content-type': contentType(file), 'cache-control': 'no-store' });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? 'prototype';
  const port = Number(process.env.PORT ?? 8943);
  createStaticServer(root).listen(port, () => {
    console.log(`Serving ${root}/ at http://localhost:${port}`);
  });
}
