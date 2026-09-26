// Builds every skill from its one source file in skill-src/ into the copies
// that installers read, and checks that the committed copies match.
//
//   node scripts/skills.mjs build   # pnpm skills:build
//   node scripts/skills.mjs check   # pnpm skills:check, part of pnpm check
//
// skill-src/<name>.md becomes:
//   skills/goodfirsttoken-<name>/SKILL.md          for npx skills add
//   plugins/<plugin>/skills/<name>/SKILL.md        for the Claude Code plugin
// The build also writes each plugin's .claude-plugin/plugin.json, the
// marketplace in .claude-plugin/marketplace.json, and the version record in
// skill-src/plugins.lock.json.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The one place the MCP server's address is set. Committed output always uses
// it. To point the copies somewhere else, such as pnpm dev, set
// GOODFIRSTTOKEN_MCP_URL when you build. Claude Code also reads the same
// variable when it starts the plugin's server.
export const PRODUCTION_MCP_URL = 'https://goodfirsttoken.org/mcp';
export const MCP_URL_VARIABLE = 'GOODFIRSTTOKEN_MCP_URL';

const PREFIX = 'goodfirsttoken';
const OWNER = { name: 'Meanwhile', url: 'https://github.com/meanwhileso' };
const REPOSITORY = 'https://github.com/meanwhileso/goodfirsttoken';
const MARKETPLACE_DESCRIPTION =
  'Spend your spare tokens on open source issues that maintainers tagged for outside help.';

// What each plugin holds. Versions and descriptions are in skill-src/plugins.json.
// Only the donor plugin's skills are published to skills.sh, and only it
// carries the MCP server. The admin plugin brings it in as a dependency.
const PLUGINS = {
  goodfirsttoken: { standalone: true, mcpServer: true },
  'goodfirsttoken-admin': { dependencies: ['goodfirsttoken'] },
};

const SOURCE_DIR = 'skill-src';
const PLUGINS_FILE = `${SOURCE_DIR}/plugins.json`;
const LOCK_FILE = `${SOURCE_DIR}/plugins.lock.json`;
const MARKETPLACE_FILE = '.claude-plugin/marketplace.json';
// Folders that hold only what the build writes. Anything else in them is removed.
const OWNED_DIRS = [
  'skills',
  '.claude-plugin',
  ...Object.keys(PLUGINS).flatMap((name) => [`plugins/${name}/skills`, `plugins/${name}/.claude-plugin`]),
];

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
// Git can check files out with CRLF line endings on Windows, so every read
// turns them back into LF before the build or the check compares anything.
const unixLines = (text) => text.replace(/\r\n/g, '\n');

async function readText(root, file) {
  try {
    return unixLines(await readFile(path.join(root, file), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readJson(root, file) {
  const text = await readText(root, file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`, { cause: error });
  }
}

function parseVersion(version, where) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(typeof version === 'string' ? version : '');
  if (!match) throw new Error(`${where} must be a version like 1.2.3.`);
  return match.slice(1).map(Number);
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// Reads the frontmatter as top-level `key: value` lines. Indented lines
// continue the key above them. Keys are copied to the output as written.
function parseSkillSource(name, text) {
  const file = `${SOURCE_DIR}/${name}.md`;
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file} must start with frontmatter between --- lines.`);
  const fields = [];
  for (const line of match[1].split('\n')) {
    const key = /^([A-Za-z][\w-]*):/.exec(line)?.[1];
    if (key) {
      if (fields.some((field) => field.key === key)) throw new Error(`${file} sets ${key} twice.`);
      fields.push({ key, text: line });
    } else if (fields.length > 0 && /^(\s|$)/.test(line)) {
      fields[fields.length - 1].text += `\n${line}`;
    } else {
      throw new Error(`${file} has a frontmatter line the build can't read: "${line}"`);
    }
  }
  const value = (key) => {
    const field = fields.find((f) => f.key === key);
    return field && field.text.slice(key.length + 1).trim();
  };
  for (const { key, text } of fields) {
    // YAML ends a plain value at ": " or " #". Every harness would then drop
    // the skill's fields, so catch it here.
    const plain = text.slice(key.length + 1).trim();
    if (!text.includes('\n') && !/^['"|>]/.test(plain) && /: | #|:$/.test(plain)) {
      throw new Error(`${file}: put the value of ${key} in quotes, because it contains ": " or " #".`);
    }
  }
  for (const key of ['name', 'metadata']) {
    if (value(key) !== undefined) throw new Error(`${file} sets ${key}, which the build writes. Remove it.`);
  }
  if (!value('description')) throw new Error(`${file} needs a description.`);
  const plugin = value('plugin')?.replace(/^(['"])(.*)\1$/, '$2');
  if (!plugin || !Object.hasOwn(PLUGINS, plugin)) {
    throw new Error(`${file} needs plugin set to one of: ${Object.keys(PLUGINS).join(', ')}.`);
  }
  return { name, file, plugin, fields: fields.filter((field) => field.key !== 'plugin'), body: match[2] };
}

function renderSkill(source, name, body, { internal }) {
  const lines = [
    '---',
    `# Generated from ${source.file}. To change it, edit that file and run pnpm skills:build.`,
    `name: ${name}`,
    ...source.fields.map((field) => field.text),
  ];
  // npx skills add skips skills marked internal, so it installs only skills/.
  if (internal) lines.push('metadata:', '  internal: true');
  lines.push('---');
  return `${lines.join('\n')}\n${body}`;
}

function hashPlugin(files) {
  const hash = createHash('sha256');
  for (const [file, content] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    hash.update(`${file}\0${content}\0`);
  }
  return hash.digest('hex');
}

async function readSkillSources(root) {
  const entries = await readdir(path.join(root, SOURCE_DIR)).catch(() => []);
  const sources = [];
  for (const entry of entries.filter((e) => e.endsWith('.md')).sort()) {
    const name = entry.slice(0, -'.md'.length);
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
      throw new Error(`${SOURCE_DIR}/${entry}: skill names use lowercase letters, digits, and hyphens.`);
    }
    sources.push(parseSkillSource(name, (await readText(root, `${SOURCE_DIR}/${entry}`)) ?? ''));
  }
  if (sources.length === 0) throw new Error(`${SOURCE_DIR}/ has no skills.`);
  return sources;
}

async function readPluginSettings(root) {
  const settings = await readJson(root, PLUGINS_FILE);
  if (settings === null) throw new Error(`${PLUGINS_FILE} is missing.`);
  const expected = Object.keys(PLUGINS).sort().join(', ');
  if (Object.keys(settings).sort().join(', ') !== expected) {
    throw new Error(`${PLUGINS_FILE} must list exactly these plugins: ${expected}.`);
  }
  for (const [name, { version, description }] of Object.entries(settings)) {
    parseVersion(version, `The version of ${name} in ${PLUGINS_FILE}`);
    if (typeof description !== 'string' || !description) throw new Error(`${name} needs a description in ${PLUGINS_FILE}.`);
  }
  return settings;
}

// Returns every file the build writes, keyed by path from the repo root.
// Throws when a source is invalid, or when a plugin's files changed and its
// version did not go up.
export async function build(root, { mcpUrl = PRODUCTION_MCP_URL } = {}) {
  if (!URL.canParse(mcpUrl)) throw new Error(`${MCP_URL_VARIABLE} must be a URL, like http://localhost:5173/mcp.`);
  const local = mcpUrl !== PRODUCTION_MCP_URL;
  const settings = await readPluginSettings(root);
  const sources = await readSkillSources(root);
  const files = new Map();

  for (const source of sources) {
    const body = source.body.replaceAll('{{MCP_URL}}', mcpUrl);
    files.set(`plugins/${source.plugin}/skills/${source.name}/SKILL.md`, renderSkill(source, source.name, body, { internal: true }));
    if (PLUGINS[source.plugin].standalone) {
      const name = `${PREFIX}-${source.name}`;
      files.set(`skills/${name}/SKILL.md`, renderSkill(source, name, body, { internal: false }));
    }
  }

  const lock = (await readJson(root, LOCK_FILE)) ?? {};
  const nextLock = {};
  for (const [name, plugin] of Object.entries(PLUGINS)) {
    const { version, description } = settings[name];
    const manifest = {
      name,
      version,
      description,
      author: OWNER,
      repository: REPOSITORY,
      license: 'MIT',
      ...(plugin.dependencies && { dependencies: plugin.dependencies }),
      ...(plugin.mcpServer && {
        mcpServers: { [PREFIX]: { type: 'http', url: `\${${MCP_URL_VARIABLE}:-${mcpUrl}}` } },
      }),
    };
    const dir = `plugins/${name}/`;
    const pluginFiles = [...files].filter(([file]) => file.startsWith(dir)).map(([file, content]) => [file.slice(dir.length), content]);
    const sha256 = hashPlugin([...pluginFiles, ['.claude-plugin/plugin.json', json({ ...manifest, version: undefined })]]);
    const recorded = lock[name];
    if (!local && recorded) {
      const change = compareVersions(parseVersion(version, name), parseVersion(recorded.version, `The version of ${name} in ${LOCK_FILE}`));
      if (change < 0) {
        throw new Error(`The version of ${name} went down, from ${recorded.version} to ${version}. Set it above ${recorded.version} in ${PLUGINS_FILE}.`);
      }
      if (change === 0 && recorded.sha256 !== sha256) {
        throw new Error(`${name} changed, so its version must go up. Raise it above ${recorded.version} in ${PLUGINS_FILE}, then run pnpm skills:build again.`);
      }
    }
    nextLock[name] = { version, sha256 };
    files.set(`${dir}.claude-plugin/plugin.json`, json(manifest));
  }

  files.set(
    MARKETPLACE_FILE,
    json({
      name: PREFIX,
      description: MARKETPLACE_DESCRIPTION,
      owner: OWNER,
      plugins: Object.keys(PLUGINS).map((name) => ({
        name,
        source: `./plugins/${name}`,
        description: settings[name].description,
      })),
    }),
  );
  // A local build leaves the version record alone, so it stays about production.
  if (!local) files.set(LOCK_FILE, json(nextLock));
  return { files, local };
}

async function listFiles(root, dir) {
  const entries = await readdir(path.join(root, dir), { recursive: true, withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
}

export async function write(root, { files }) {
  for (const dir of OWNED_DIRS) await rm(path.join(root, dir), { recursive: true, force: true });
  for (const [file, content] of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
}

// Compares the committed files with a production build. Returns one line per
// problem, or an empty list when everything matches.
export async function check(root) {
  let output;
  try {
    output = await build(root);
  } catch (error) {
    return [error.message];
  }
  const problems = [];
  for (const [file, content] of output.files) {
    const committed = await readText(root, file);
    if (committed === null) problems.push(`${file} is missing.`);
    else if (committed !== content) problems.push(`${file} is not what the build writes.`);
  }
  for (const dir of OWNED_DIRS) {
    for (const file of await listFiles(root, dir)) {
      if (!output.files.has(file)) problems.push(`${file} is not written by the build.`);
    }
  }
  return problems;
}

async function main(command, root) {
  if (command === 'build') {
    const mcpUrl = process.env[MCP_URL_VARIABLE] || PRODUCTION_MCP_URL;
    const output = await build(root, { mcpUrl });
    await write(root, output);
    console.log(`Wrote ${output.files.size} files from ${SOURCE_DIR}/.`);
    if (output.local) {
      console.log(`They point at ${mcpUrl}. Run pnpm skills:build without ${MCP_URL_VARIABLE} before you commit.`);
    }
    return 0;
  }
  if (command === 'check') {
    const problems = await check(root);
    if (problems.length === 0) {
      console.log(`The skills and plugins match ${SOURCE_DIR}/.`);
      return 0;
    }
    console.error(
      [
        ...problems.map((problem) => `- ${problem}`),
        '',
        `The skills and plugins are built from ${SOURCE_DIR}/. Edit the source, then run pnpm skills:build.`,
      ].join('\n'),
    );
    return 1;
  }
  console.error('Usage: node scripts/skills.mjs build|check');
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2], process.cwd()).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
