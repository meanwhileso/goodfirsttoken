import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createStaticServer, parseRange, resolvePath } from './serve.mjs';

let root;
let server;
let origin;

before(async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'serve-'));
  root = path.join(base, 'site');
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<h1>home</h1>');
  await writeFile(path.join(root, 'start.md'), '# start');
  await writeFile(path.join(root, 'assets', 'clip.mp4'), '0123456789');
  await writeFile(path.join(root, 'assets', 'big.mp4'), Buffer.alloc(8 * 1024 * 1024));
  await writeFile(path.join(base, 'outside.txt'), 'secret');
  server = createStaticServer(root);
  await new Promise((resolve) => server.listen(0, resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('a folder URL serves its index.html', async () => {
  const res = await fetch(`${origin}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await res.text(), '<h1>home</h1>');
});

test('markdown is served as text an agent can read', async () => {
  const res = await fetch(`${origin}/start.md`);
  assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(await res.text(), '# start');
});

test('a byte range returns 206 with only those bytes, which Safari needs for video', async () => {
  const res = await fetch(`${origin}/assets/clip.mp4`, { headers: { range: 'bytes=2-5' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(await res.text(), '2345');
});

test('a range past the end returns 416 with the real size', async () => {
  const res = await fetch(`${origin}/assets/clip.mp4`, { headers: { range: 'bytes=50-' } });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), 'bytes */10');
});

test('a range that ends before it starts is ignored and the whole file is sent', async () => {
  const res = await fetch(`${origin}/assets/clip.mp4`, { headers: { range: 'bytes=5-2' } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '0123456789');
});

test('HEAD with a range answers 206 with headers and no body', async () => {
  const res = await fetch(`${origin}/assets/clip.mp4`, { method: 'HEAD', headers: { range: 'bytes=0-3' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-length'), '4');
  assert.equal(await res.text(), '');
});

test('a browser that aborts a video request leaves no file open', async () => {
  const openFiles = () => readdirSync('/dev/fd').length;
  const before = openFiles();
  const { port } = server.address();
  await Promise.all(
    Array.from({ length: 10 }, () => new Promise((resolve) => {
      const req = http.get({ port, path: '/assets/big.mp4', headers: { range: 'bytes=0-' } }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => {});
    })),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(openFiles() <= before + 2, `open files went from ${before} to ${openFiles()}`);
});

test('paths that climb out of the folder are refused', async () => {
  for (const url of ['/../outside.txt', '/%2e%2e/outside.txt', '/assets/..%2f..%2foutside.txt']) {
    const res = await fetch(`${origin}${url}`);
    assert.equal(res.status, 404, url);
  }
});

test('resolvePath keeps every decoded path inside the root', () => {
  const site = path.resolve('/srv/site');
  assert.equal(resolvePath(site, '/'), path.join(site, 'index.html'));
  assert.equal(resolvePath(site, '/a/b.css?v=2'), path.join(site, 'a', 'b.css'));
  assert.equal(resolvePath(site, '/..%2foutside.txt'), null);
  assert.equal(resolvePath(site, '/%E0%A4%A'), null);
});

test('a missing file returns 404', async () => {
  const res = await fetch(`${origin}/nope.html`);
  assert.equal(res.status, 404);
});

test('parseRange reads suffix ranges and rejects malformed headers', () => {
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=4-', 10), { start: 4, end: 9 });
  assert.deepEqual(parseRange('bytes=8-40', 10), { start: 8, end: 9 });
  assert.deepEqual(parseRange('bytes=-0', 10), { unsatisfiable: true });
  assert.equal(parseRange('bytes=5-2', 10), null);
  assert.equal(parseRange('bytes=0-1,4-5', 10), null);
  assert.equal(parseRange('bytes=-', 10), null);
  assert.equal(parseRange('items=0-1', 10), null);
  assert.equal(parseRange(undefined, 10), null);
});
