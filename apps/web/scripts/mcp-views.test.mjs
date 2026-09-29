import assert from 'node:assert/strict';
import { test } from 'node:test';
import { viewProblem } from './mcp-views.ts';

// What the build of a view refuses. The build runs viewProblem on what it
// built, and stops with its reason, so these are the rules a view's script
// and styles have to keep.

const KB = 1024;
const small = { script: 'document.body.dataset.ok = "1";', style: '.view{color:red}' };

test('a small view with no file named in its styles can be a view', () => {
  assert.equal(viewProblem(small), null);
});

test("a view's script and styles may hold 64 KB together, and no more", () => {
  const half = 'x'.repeat(32 * KB);
  assert.equal(viewProblem({ script: half, style: half }), null);
  assert.match(viewProblem({ script: half, style: `${half}y` }) ?? '', /65537 bytes, over the 65536/);
  assert.match(viewProblem({ script: 'x'.repeat(64 * KB + 1), style: '' }) ?? '', /over the 65536/);
});

test('the limit counts bytes of UTF-8, so text beyond ASCII counts for more', () => {
  // Each é is two bytes, so 32,769 of them are 65,538 bytes.
  assert.match(viewProblem({ script: 'é'.repeat(32 * KB + 1), style: '' }) ?? '', /65538 bytes/);
});

test("styles that name a file with url() can't make a view, even a data: URL Vite wrote in", () => {
  for (const style of [
    '@font-face{font-family:Geist;src:url(data:font/woff2;base64,d09GMgABAAAAAA)}',
    '.view{background:url("/assets/grain.png")}',
    '.view{background:URL(x.png)}',
  ]) {
    assert.match(viewProblem({ script: '', style }) ?? '', /url\(\)/, style);
  }
});

test("styles that @import another stylesheet can't make a view", () => {
  assert.match(viewProblem({ script: '', style: '@import "fonts.css";.view{color:red}' }) ?? '', /@import/);
});
