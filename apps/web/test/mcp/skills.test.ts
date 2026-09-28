import { tools, type Audience, type ToolName } from '@goodfirsttoken/core';
import type { GitHubFake } from '@goodfirsttoken/github-fake';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { startGitHub } from '../auth/helpers';
import { emptyDatabase } from '../db/helpers';
import { connectAgent, emptyKv } from './helpers';

// The maintain and admin skills in skill-src/, checked against the MCP
// server they drive. Each is read by the agent of the person it is for: a
// maintainer with no admin role, and one of Good First Token's admins. The
// tools a skill calls are the ones of its audience. It may name another
// tool its reader is served, to say what someone else sees.
//
// - A skill names only tools its reader's agent is served. The refusal codes
//   it names are ones the tools it calls can give, and the fields and values
//   it names are in the schemas of the tools it names. In a sentence that
//   names tools, like "`admin_block_donor` with `login`", each field is one
//   of those tools'. A value paired with a field, like "`prMode` `reviewed`",
//   is one that field takes.
// - Its `## Refusals` section has one entry, a list item that starts with the
//   code in backticks, for each refusal the tools it calls can give, as their
//   specs in packages/core list them, and no other.
// - Each call it shows in a code block, as `tool {json}`, is to a tool it
//   calls, and one that tool's input schema takes.
// - Each sentence it quotes from the server in backticks is in the source of
//   the tools' answers.
// - It names every tool of its audience.
//
// Its `## Connect` section tells an agent how to add the server in its own
// harness, in that harness's words. There only a tool name alone in
// backticks is checked. The helpers fail any MCP test in which a tool
// refuses with a code its spec doesn't list. The Vitest config reads the
// sources in Node and passes them in.

const { TEST_SKILLS: skills, TEST_SERVER_TEXT: serverText } = env as Env & {
  TEST_SKILLS: Record<string, string>;
  TEST_SERVER_TEXT: string;
};

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

/** A skill's text split into its Connect section, the rest of its prose, and its code blocks' lines. */
function readSkill(text: string): { connect: string; prose: string; codeLines: string[] } {
  const parts = sections(text);
  const kept = [...parts].filter(([heading]) => heading !== 'Connect').map(([, body]) => body);
  const codeLines: string[] = [];
  const prose = kept.join('\n').replace(/^```[^\n]*\n([\s\S]*?)^```$/gm, (_block, body: string) => {
    codeLines.push(...body.split('\n').filter((line) => line.trim() !== ''));
    return '.\n';
  });
  return { connect: parts.get('Connect') ?? '', prose, codeLines };
}

/** The codes of the `## Refusals` entries, as many times as they appear. */
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
 * The prose's sentences, each as the words and JSON keys it puts in
 * backticks. A sentence ends at a full stop, a blank line, or a new item of
 * a list. A backticked span keeps its own full stops.
 */
function sentencesOf(prose: string): { spans: string[] }[] {
  const found: { spans: string[] }[] = [{ spans: [] }];
  for (const token of prose.split(/(`[^`\n]+`)/)) {
    if (token.startsWith('`')) found[found.length - 1]?.spans.push(token.slice(1, -1));
    else if (/[.!?](\s|$)|\n\s*\n|\n\s*(?:-|\d+\.)\s/.test(token)) found.push({ spans: [] });
  }
  return found;
}

/** What a property takes: its closed set of values, or free when it takes any string, number, list, or object. */
interface Takes {
  values: Set<string>;
  free: boolean;
}

function takesOf(schema: unknown, takes: Takes = { values: new Set(), free: false }): Takes {
  if (typeof schema !== 'object' || schema === null) return takes;
  const s = schema as Record<string, unknown>;
  const types = Array.isArray(s.type) ? (s.type as unknown[]) : [s.type];
  if (Array.isArray(s.enum)) {
    for (const value of s.enum) takes.values.add(String(value));
  } else if ('const' in s) {
    takes.values.add(String(s.const));
  } else if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    for (const option of [...((s.anyOf as unknown[] | undefined) ?? []), ...((s.oneOf as unknown[] | undefined) ?? [])]) {
      takesOf(option, takes);
    }
  } else {
    for (const type of types) {
      if (type === 'boolean') takes.values.add('true').add('false');
      else if (type === 'null') takes.values.add('null');
      else takes.free = true;
    }
  }
  return takes;
}

/** A tool's schemas, read for what a skill may name. */
interface ToolWords {
  /** Every property name and every value an `enum` or `const` allows, anywhere in its schemas. */
  words: Set<string>;
  /** What each property takes, joined over every property of that name. */
  properties: Map<string, Takes>;
}

function readSchemas(schemas: unknown[]): ToolWords {
  const read: ToolWords = { words: new Set(), properties: new Map() };
  const visit = (schema: unknown): void => {
    if (Array.isArray(schema)) {
      for (const item of schema) visit(item);
      return;
    }
    if (typeof schema !== 'object' || schema === null) return;
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === 'enum' && Array.isArray(value)) {
        for (const allowed of value) if (typeof allowed === 'string') read.words.add(allowed);
      } else if (key === 'const' && typeof value === 'string') {
        read.words.add(value);
      } else {
        if (key === 'properties' && typeof value === 'object' && value !== null) {
          for (const [name, property] of Object.entries(value as Record<string, unknown>)) {
            read.words.add(name);
            const takes = takesOf(property);
            const before = read.properties.get(name);
            read.properties.set(name, {
              values: new Set([...(before?.values ?? []), ...takes.values]),
              free: (before?.free ?? false) || takes.free,
            });
          }
        }
        visit(value);
      }
    }
  };
  visit(schemas);
  return read;
}

/** The tools the skill's reader is served, each with its schemas read, from the server as their agent. */
async function servedTo(login: string): Promise<Map<string, ToolWords>> {
  const agent = await connectAgent(github, login);
  const listed = (await agent.client.listTools()).tools;
  return new Map(listed.map((tool) => [tool.name, readSchemas([tool.inputSchema, tool.outputSchema])]));
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
  const { connect, prose, codeLines } = readSkill(text);
  const calls = codeLines.map((line) => /^([a-z_]+) (\{.*\})$/.exec(line));
  const named = new Set(
    [...snakeNames(prose), ...calls.map((match) => match?.[1] ?? '')].filter((name) => served.has(name)),
  );
  const called = new Set([...named].filter((name) => isTool(name) && tools[name].audience === reader.audience));
  return { reader, text, served, connect, prose, codeLines, calls, named, called };
}

const skillNames = Object.keys(READERS);

test.each(skillNames)(
  "every tool the %s skill names is one its reader's agent is served, and every refusal, field, and value it names is one of those tools'",
  async (skill) => {
    const { served, connect, prose, named, called } = await skillAndServer(skill);
    const codes = new Set([...called].flatMap(refusalsOf));
    const namedSchemas = [...named].map((name) => served.get(name)).filter((read) => read !== undefined);
    const fields = new Set(namedSchemas.flatMap((read) => [...read.words]));
    const properties = new Map<string, Takes>();
    for (const read of namedSchemas) {
      for (const [name, takes] of read.properties) {
        const before = properties.get(name);
        properties.set(name, {
          values: new Set([...(before?.values ?? []), ...takes.values]),
          free: (before?.free ?? false) || takes.free,
        });
      }
    }
    const values = new Set([...properties.values()].flatMap((takes) => [...takes.values]));
    const known = (word: string) => named.has(word) || codes.has(word) || fields.has(word) || PLAIN_WORDS.has(word);
    const unknown: string[] = [];

    // In Connect, a tool named alone in backticks.
    for (const match of connect.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
      const name = match[1] ?? '';
      if (!served.has(name)) unknown.push(`Connect: ${name}`);
    }
    // Snake_case names anywhere in the rest.
    for (const name of snakeNames(prose)) if (!known(name)) unknown.push(name);
    // Words and JSON keys in backticks, sentence by sentence.
    for (const { spans } of sentencesOf(prose)) {
      const toolsHere = spans.filter((span) => served.has(span));
      let field: string | null = null;
      for (const span of spans) {
        if (served.has(span)) continue;
        const words = span.startsWith('{') ? [...span.matchAll(/"([A-Za-z_]+)"\s*:/g)].map((m) => m[1] ?? '') : [span];
        for (const word of words.filter((w) => CHECKED_WORD.test(w))) {
          if (!known(word)) {
            unknown.push(word);
            continue;
          }
          const ofATool = toolsHere.some((tool) => served.get(tool)?.words.has(word) || refusalsOf(tool).includes(word));
          if (toolsHere.length > 0 && !PLAIN_WORDS.has(word) && !ofATool) unknown.push(`${toolsHere.join(' or ')}: ${word}`);
          // A value the field before it takes keeps that field, so a list of
          // its values reads as one. A property starts a new field.
          const takes: Takes | undefined = field === null ? undefined : properties.get(field);
          const closed = takes !== undefined && !takes.free;
          if (closed && takes.values.has(word)) continue;
          if (properties.has(word)) field = word;
          else if (closed && values.has(word)) unknown.push(`${field ?? ''}: ${word}`);
        }
      }
    }

    expect([...new Set(unknown)]).toEqual([]);
  },
);

test.each(skillNames)(
  'the %s skill names every tool of its audience, and has one entry under Refusals for each refusal the tools it calls can give, and no other',
  async (skill) => {
    const { reader, text, served, called } = await skillAndServer(skill);

    const ownTools = [...served.keys()].filter((name) => isTool(name) && tools[name].audience === reader.audience);
    const missingTools = ownTools.filter((name) => !called.has(name));
    const unlisted = [...called].filter((name) => !isTool(name) || tools[name].refusals === undefined);
    const entries = refusalEntries(text);
    const expected = [...new Set([...called].flatMap(refusalsOf))].sort();

    expect(ownTools.length).toBeGreaterThan(0);
    expect({ missingTools, unlisted }).toEqual({ missingTools: [], unlisted: [] });
    expect(entries.length).toBe(new Set(entries).size);
    expect([...entries].sort()).toEqual(expected);
  },
);

test.each(skillNames)('every call the %s skill shows in a code block is one a tool it calls takes', async (skill) => {
  const { codeLines, calls, called } = await skillAndServer(skill);
  const problems: string[] = [];

  codeLines.forEach((line, i) => {
    const match = calls[i];
    const name = match?.[1] ?? '';
    if (!match || !called.has(name) || !isTool(name)) {
      problems.push(`not a call, as \`tool {json}\`, to a tool of the skill's audience: ${line}`);
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
    if (!checked.success) {
      problems.push(`${name}: ${checked.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ')}`);
    }
  });

  expect(codeLines.length).toBeGreaterThan(0);
  expect(problems).toEqual([]);
});

test.each(skillNames)('every sentence the %s skill quotes from the server is in the source of its answers', (skill) => {
  const { prose } = readSkill(skills[skill] ?? '');

  const quoted = [...prose.matchAll(/`([A-Z][^`\n]* [^`\n]*\.)`/g)].map((match) => match[1] ?? '');
  const missing = quoted.filter((sentence) => !serverText.includes(sentence));

  expect(missing).toEqual([]);
});
