import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { openInTab } from './skill-run.ts';

const TEST_LIMIT_MS = 2_000;
const TEST_DEADLINE_MS = 200;


function withLimit(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function startServer(respond) {
  const server = createServer(respond);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('openInTab gives up when the server never answers', async () => {
  const server = await startServer(() => {});
  try {
    const { port } = server.address();
    const url = new URL(`http://127.0.0.1:${port}/approve`);
    await assert.rejects(
      withLimit(openInTab(url, {}, TEST_DEADLINE_MS), TEST_LIMIT_MS),
      /did not answer/,
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('openInTab gives up when the server stops halfway through the page', async () => {
  const server = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.write('<html><input type="hidden" name="handle" value="x"');
  });
  try {
    const { port } = server.address();
    const url = new URL(`http://127.0.0.1:${port}/approve`);
    await assert.rejects(
      withLimit(openInTab(url, {}, TEST_DEADLINE_MS), TEST_LIMIT_MS),
      /did not answer/,
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});