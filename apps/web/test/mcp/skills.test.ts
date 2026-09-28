import { tools, type Audience, type ToolName } from '@goodfirsttoken/core';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { connectAgent, emptyKv } from './helpers';

// The maintain and admin skills in skill-src/, checked against the MCP
// server they drive. Each is read by the agent of the person it is for: a
// maintainer with no admin role, and one of Good First Token's admins.
//
// - A skill names only the tools that agent is served. The refusal codes it
//   names are ones those tools can give, and the fields and values it names
//   are in their schemas. A field named in the same sentence as a tool, like
//   "`admin_block_donor` with `login`", is that tool's.
// - Its `## Refusals` section has one `- \`code\`:` entry for each refusal
//   the tools it names can give, as their specs in packages/core list them,
//   and no other.
// - Each call it shows in a code block, as `tool {json}`, is one the tool
//   takes.
// - It names every tool of its audience.
//
// Its `## Connect` section tells an agent how to add the server in its own
// harness, in that harness's words, so it isn't checked. The helpers fail
// any MCP test in which a tool refuses with a code its spec doesn't list.
// The Vitest config reads the sources in Node and passes them in.

const { TEST_SKILLS: skills } = env as Env & { TEST_SKILLS: Record<string, string> };

const READERS: Record<string, { login: string; audience: Audience }> = {
  maintain: { login: 'sample-maintainer', audience: 'maintainer' },
  admin: { login: 'sample-admin', audience: 'admin' },
};
const ADMIN_ID = 1010;

/** Words a skill may put in backticks that no schema names: JSON's literals, and our label and plugin's name. */
const PLAIN_WORDS = new Set(['null', 'true', 'false', 'goodfirsttoken']);

let github: GitHubFake;
const configuredAdmins = env.ADMIN_GITHUB_IDS;

beforeEach(async () => {
  await emptyDatabase();
  await emptyKv();
  github = startGitHub();
  env.ADMIN_GITHUB_IDS = String(ADMIN_ID);
});

afterEach(() => {
  env.ADMIN_GITHUB_IDS = configuredAdmins;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A skill's `## ` sections by heading, with what comes before the first one under ''. */
function sections(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const parts = text.split(/^## /m);
  found.set('', parts[0] ?? '');
  for (const part of parts.slice(1)) {
    const end = part.indexOf('\n');
    found.set(part.slice(0, end).trim(), part.slice(end + 1));
  }
  return found;
}

/** A skill's text split into prose and the code blocks' lines. The Connect section is left out. */
function readSkill(text: string): { prose: string; codeLines: string[] } {
  const kept = [...sections(text)].filter(([heading]) => heading !== 'Connect').map(([, body]) => body);
  const codeLines: string[] = [];
  const prose = kept
    .join('\n')
    .replace(/^```[^\n]*\n([\s\S]*?)^```$/gm, (_block, body: string) => {
      codeLines.push(...body.split('\n').filter((line) => line.trim() !== ''));
      return '.\n';
    });
  return { prose, codeLines };
}

/** The codes of the `- \`code\`:` entries under `## Refusals`, as many times as they appear. */
function refusalEntries(text: string): string[] {
  const body = sections(text).get('Refusals') ?? '';
  return [...body.matchAll(/^- `([a-z_]+)`:/gm)].map((match) => match[1] ?? '');
}

const SNAKE = /\b[a-z]+(?:_[a-z]+)+\b/g;
/** A word in backticks the checks read: one snake_case name, or one word like `prMode`. */
const CHECKED_WORD = /^(?:[a-z]+(?:_[a-z]+)+|[a-z][A-Za-z]*)$/;

/** Every snake_case name in the text: tool names, refusal codes, and values like `too_soon` are written that way. */
function snakeNames(text: string): string[] {
  return text.match(SNAKE) ?? [];
}

/**
 * Every property name, and every string an `enum` or `const` allows,
 * anywhere in a JSON Schema.
 */
function schemaWords(schema: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) schemaWords(item, found);
  } else if (typeof schema === 'object' && schema !== null) {
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === 'enum' && Array.isArray(value)) {
        for (const allowed of value) if (typeof allowed === 'string') found.add(allowed);
      } else if (key === 'const' && typeof value === 'string') {
        found.add(value);
      } else {
        if (key === 'properties' && typeof value === 'object' && value !== null) {
          for (const property of Object.keys(value)) found.add(property);
        }
        schemaWords(value, found);
      }
    }
  }
  return found;
}

/** The tools the skill's reader is served, each with the fields and values in its schemas, read from the server as their agent. */
async function servedTo(login: string): Promise<Map<string, Set<string>>> {
  const agent = await connectAgent(github, login);
  const listed = (await agent.client.listTools()).tools;
  return new Map(listed.map((tool) => [tool.name, schemaWords([tool.inputSchema, tool.outputSchema])]));
}

function isTool(name: string): name is ToolName {
  return Object.hasOwn(tools, name);
}

/** The refusals a tool's spec lists, or none when it lists nothing. */
function refusalsOf(name: string): readonly string[] {
  return isTool(name) ? (tools[name].refusals ?? []) : [];
}

/** Everything a check needs about one skill, as its reader's agent sees the server. */
async function skillAndServer(skill: string) {
  const reader = READERS[skill];
  const text = skills[skill];
  if (!reader || text === undefined) throw new Error(`skill-src/${skill}.md is missing`);
  const served = await servedTo(reader.login);
  const { prose, codeLines } = readSkill(text);
  const calls = codeLines.map((line) => /^([a-z_]+) (\{.*\})$/.exec(line));
  const named = new Set(
    [...snakeNames(prose), ...calls.map((match) => match?.[1] ?? '')].filter((name) => served.has(name)),
  );
  return { reader, text, served, prose, codeLines, calls, named };
}

const skillNames = Object.keys(READERS);

test.each(skillNames)(
  "every tool the %s skill names is one its reader's agent is served, and every refusal, field, and value it names is one of those tools'",
  async (skill) => {
    const { prose, served, named } = await skillAndServer(skill);
    const codes = new Set([...named].flatMap(refusalsOf));
    const fields = new Set([...named].flatMap((name) => [...(served.get(name) ?? [])]));
    const known = (word: string) => named.has(word) || codes.has(word) || fields.has(word) || PLAIN_WORDS.has(word);
    const unknown: string[] = [];

    // Snake_case names anywhere in the prose, and words and JSON keys in backticks.
    for (const name of snakeNames(prose)) if (!known(name)) unknown.push(name);
    // A field in the same sentence as a tool, after it, is that tool's.
    let tool: string | null = null;
    for (const token of prose.split(/(`[^`\n]+`)/)) {
      if (!token.startsWith('`')) {
        if (/[.!?](\s|$)|\n\s*\n|\n\s*(?:-|\d+\.)\s/.test(token)) tool = null;
        continue;
      }
      const inner = token.slice(1, -1);
      if (served.has(inner)) {
        tool = inner;
        continue;
      }
      const words = inner.startsWith('{') ? [...inner.matchAll(/"([A-Za-z_]+)"\s*:/g)].map((m) => m[1] ?? '') : [inner];
      for (const word of words.filter((w) => CHECKED_WORD.test(w))) {
        if (!known(word)) unknown.push(word);
        else if (tool !== null && !PLAIN_WORDS.has(word) && !served.get(tool)?.has(word) && !refusalsOf(tool).includes(word)) {
          unknown.push(`${tool}: ${word}`);
        }
      }
    }

    expect([...new Set(unknown)]).toEqual([]);
  },
);

test.each(skillNames)(
  'the %s skill names every tool of its audience, and has one entry under Refusals for each refusal its tools can give, and no other',
  async (skill) => {
    const { reader, text, served, named } = await skillAndServer(skill);

    const ownTools = [...served.keys()].filter((name) => isTool(name) && tools[name].audience === reader.audience);
    const missingTools = ownTools.filter((name) => !named.has(name));
    const unlisted = [...named].filter((name) => !isTool(name) || tools[name].refusals === undefined);
    const entries = refusalEntries(text);
    const expected = [...new Set([...named].flatMap(refusalsOf))].sort();

    expect(ownTools.length).toBeGreaterThan(0);
    expect({ missingTools, unlisted }).toEqual({ missingTools: [], unlisted: [] });
    expect(entries.length).toBe(new Set(entries).size);
    expect([...entries].sort()).toEqual(expected);
  },
);

test.each(skillNames)('every call the %s skill shows in a code block is one its tool takes', async (skill) => {
  const { codeLines, calls, served } = await skillAndServer(skill);
  const problems: string[] = [];

  codeLines.forEach((line, i) => {
    const match = calls[i];
    const name = match?.[1] ?? '';
    if (!match || !served.has(name) || !isTool(name)) {
      problems.push(`not a call to a tool its reader is served, as \`tool {json}\`: ${line}`);
      return;
    }
    let args: unknown;
    try {
      args = JSON.parse(match[2] ?? '');
    } catch {
      problems.push(`not JSON: ${line}`);
      return;
    }
    const checked = tools[name].input.safeParse(args);
    if (!checked.success) problems.push(`${name}: ${checked.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ')}`);
  });

  expect(codeLines.length).toBeGreaterThan(0);
  expect(problems).toEqual([]);
});
