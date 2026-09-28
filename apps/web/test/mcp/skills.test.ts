import { refusalCodes, tools, type Audience, type ToolName } from '@goodfirsttoken/core';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { connectAgent, emptyKv } from './helpers';

// The maintain and admin skills in skill-src/, checked against the MCP
// server they drive. Each is read by the agent of the person it is for: a
// maintainer with no admin role, and one of Good First Token's admins. A
// skill may name only the tools that agent is served, refusal codes the
// server has, and the fields and values the tools take or return. It has to
// name every tool of its audience, and every refusal each tool it names can
// answer with, as the tool's spec in packages/core lists them. The helpers fail
// any MCP test in which a tool refuses with a code its spec doesn't list.
// The Vitest config reads the sources in Node and passes them in.

const { TEST_SKILLS: skills } = env as Env & { TEST_SKILLS: Record<string, string> };

const READERS: Record<string, { login: string; audience: Audience }> = {
  maintain: { login: 'sample-maintainer', audience: 'maintainer' },
  admin: { login: 'sample-admin', audience: 'admin' },
};
const ADMIN_ID = 1010;

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

/**
 * Every snake_case name in a skill. Tool names, refusal codes, and the
 * values tools take or return, like `too_soon`, are written that way, and
 * nothing else in a skill is.
 */
function namesIn(text: string): Set<string> {
  return new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []);
}

/**
 * Every word a skill puts in backticks on its own, like `prMode` or
 * `reviewed`: the fields and values it tells an agent to send or read.
 */
function wordsIn(text: string): Set<string> {
  return new Set([...text.matchAll(/`([a-z][A-Za-z]*)`/g)].map((match) => match[1] ?? ''));
}

/** Words a skill may put in backticks that no schema names: JSON's literals, and our label and plugin's name. */
const PLAIN_WORDS = new Set(['null', 'true', 'false', 'goodfirsttoken']);

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

/** The tools the skill's reader is served, with their schemas, read from the server as their agent. */
async function servedTo(login: string) {
  const agent = await connectAgent(github, login);
  const listed = (await agent.client.listTools()).tools;
  const words = new Set<string>();
  for (const tool of listed) {
    schemaWords(tool.inputSchema, words);
    schemaWords(tool.outputSchema, words);
  }
  return { names: new Set(listed.map((tool) => tool.name)), words };
}

const skillNames = Object.keys(READERS);

test.each(skillNames)(
  "every tool the %s skill names is one its reader's agent is served, and every other name in it is a refusal code, or a field or value the tools take or return",
  async (skill) => {
    const reader = READERS[skill];
    const text = skills[skill];
    if (!reader || text === undefined) throw new Error(`skill-src/${skill}.md is missing`);
    const served = await servedTo(reader.login);
    const codes = new Set<string>(refusalCodes);

    const unknown = [...namesIn(text), ...wordsIn(text)].filter(
      (name) => !served.names.has(name) && !codes.has(name) && !served.words.has(name) && !PLAIN_WORDS.has(name),
    );

    expect(unknown).toEqual([]);
  },
);

test.each(skillNames)(
  'the %s skill names every tool of its audience, and every refusal each tool it names can answer with',
  async (skill) => {
    const reader = READERS[skill];
    const text = skills[skill];
    if (!reader || text === undefined) throw new Error(`skill-src/${skill}.md is missing`);
    const served = await servedTo(reader.login);
    const named = namesIn(text);
    const known = (name: string): name is ToolName => Object.hasOwn(tools, name);

    const ownTools = [...served.names].filter((name) => known(name) && tools[name].audience === reader.audience);
    const missingTools = ownTools.filter((name) => !named.has(name));
    const missingRefusals = [...named]
      .filter((name) => served.names.has(name) && known(name))
      .flatMap((name) => {
        const refusals = tools[name as ToolName].refusals;
        if (refusals === undefined) return [`${name} lists no refusals in packages/core`];
        return refusals.filter((code) => !named.has(code)).map((code) => `${name}: ${code}`);
      });

    expect(ownTools.length).toBeGreaterThan(0);
    expect({ missingTools, missingRefusals }).toEqual({ missingTools: [], missingRefusals: [] });
  },
);
