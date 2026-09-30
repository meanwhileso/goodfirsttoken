import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PRODUCTION_MCP_URL } from './skills.mjs';

// The README's install table repeats the steps the skills and /start.md take
// from skill-src/shared/. These tests hold it to them, so the two can't drift.

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const HARNESSES = ['Claude Code', 'Codex', 'OpenCode', 'Cursor', 'Grok Bot'];

/** Each harness's bullet in the shared parts, with the production URL filled in. */
function sharedSteps() {
  const text = [read('skill-src/shared/connect-claude-code.md'), read('skill-src/shared/connect.md')]
    .join('')
    .replaceAll('{{MCP_URL}}', PRODUCTION_MCP_URL);
  const steps = new Map();
  for (const bullet of text.split(/\n(?=- )/)) {
    const match = /^- ([^:]+): ([\s\S]*)$/.exec(bullet.trim());
    if (match) steps.set(match[1], match[2]);
  }
  return steps;
}

function readmeRow(harness) {
  return read('README.md')
    .split('\n')
    .find((line) => line.startsWith(`| ${harness} |`));
}

const codeSpans = (text) => [...text.replace(/\n\s*/g, ' ').matchAll(/`([^`]+)`/g)].map((match) => match[1]);

test('the shared steps cover every harness', () => {
  const steps = sharedSteps();
  for (const harness of HARNESSES) assert.ok(steps.has(harness), harness);
});

test("the README's install table gives each harness the shared steps' own commands and server URL", () => {
  const steps = sharedSteps();
  for (const harness of HARNESSES) {
    const row = readmeRow(harness);
    assert.ok(row, `README.md has no row for ${harness}`);
    for (const command of codeSpans(steps.get(harness))) {
      assert.ok(row.includes(`\`${command}\``), `${harness}'s row lacks ${command}`);
    }
    assert.ok(row.includes(PRODUCTION_MCP_URL), `${harness}'s row lacks the server's URL`);
  }
});
