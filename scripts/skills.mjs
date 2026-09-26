// Builds every skill from its one source file in skill-src/ into the copies
// that installers read, and checks that the committed copies match.
//
//   node scripts/skills.mjs build                  # pnpm skills:build
//   node scripts/skills.mjs check [--base <ref>]   # pnpm skills:check, part of pnpm check
//
// skill-src/<name>.md becomes:
//   skills/goodfirsttoken-<name>/SKILL.md          for npx skills add
//   plugins/<plugin>/skills/<name>/SKILL.md        for the Claude Code plugin
// The build also writes each plugin's .claude-plugin/plugin.json and the
// marketplace in .claude-plugin/marketplace.json.
//
// The check also compares each plugin folder with a base commit, origin/main
// unless --base or SKILLS_BASE_REF names another. When anything in the folder
// changed, the plugin's version must be higher than it was there.
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// The one place the MCP server's address is set. Committed output always uses
// it. To point the copies somewhere else, such as pnpm dev, set
// GOODFIRSTTOKEN_MCP_URL when you build. Claude Code also reads the same
// variable when it starts the plugin's server.
export const PRODUCTION_MCP_URL = 'https://goodfirsttoken.org/mcp';
export const MCP_URL_VARIABLE = 'GOODFIRSTTOKEN_MCP_URL';
const BASE_VARIABLE = 'SKILLS_BASE_REF';
const DEFAULT_BASE = 'origin/main';

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
  // By default npx skills add skips a skill whose metadata.internal is true,
  // so it installs the copies in skills/.
  if (internal) lines.push('metadata:', '  internal: true');
  lines.push('---');
  return `${lines.join('\n')}\n${body}`;
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
// Throws when a source is invalid.
export async function build(root, { mcpUrl = PRODUCTION_MCP_URL } = {}) {
  if (!URL.canParse(mcpUrl)) throw new Error(`${MCP_URL_VARIABLE} must be a URL, like http://localhost:5173/mcp.`);
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
    files.set(`plugins/${name}/.claude-plugin/plugin.json`, json(manifest));
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
  return { files, local: mcpUrl !== PRODUCTION_MCP_URL };
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

// Runs git in root. Repo variables from the environment, such as GIT_DIR in a
// git hook, would point it at another repo, so they are left out.
const execFileAsync = promisify(execFile);
async function git(root, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR)$/.test(key)),
  );
  const { stdout } = await execFileAsync('git', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
const paths = (output) => output.split('\0').filter(Boolean);

// Whether any file under dir differs from the base commit, counting files
// added or removed. Files git ignores are left out.
async function changedSince(root, commit, dir) {
  const before = paths(await git(root, ['ls-tree', '-r', '-z', '--name-only', commit, '--', dir]));
  const listed = paths(await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', dir]));
  const now = new Map();
  for (const file of new Set(listed)) {
    const text = await readText(root, file);
    if (text !== null) now.set(file, text);
  }
  if (before.length !== now.size || before.some((file) => !now.has(file))) return true;
  for (const file of before) {
    if (unixLines(await git(root, ['show', `${commit}:${file}`])) !== now.get(file)) return true;
  }
  return false;
}

// For each plugin that changed since the base, its version in plugins.json
// must be higher than the version the base published. A lower version always
// fails. A plugin the base doesn't have can start at any version.
async function checkVersions(root, base) {
  let commit;
  try {
    commit = (await git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])).trim();
  } catch {
    return [
      `The base ref ${base} was not found, so the plugin versions can't be checked. Run git fetch origin main, or name another base with --base <ref> or ${BASE_VARIABLE}.`,
    ];
  }
  const settings = await readPluginSettings(root);
  const problems = [];
  for (const name of Object.keys(PLUGINS)) {
    const dir = `plugins/${name}/`;
    let published;
    try {
      published = JSON.parse(await git(root, ['show', `${commit}:${dir}.claude-plugin/plugin.json`])).version;
    } catch {
      continue;
    }
    const version = settings[name].version;
    const change = compareVersions(parseVersion(version, name), parseVersion(published, `The version of ${name} at ${base}`));
    if (change < 0) {
      problems.push(`The version of ${name} went down from ${published} at ${base} to ${version}. Set it higher than ${published} in ${PLUGINS_FILE}.`);
    } else if (change === 0 && (await changedSince(root, commit, dir))) {
      problems.push(`${dir} changed since ${base}, so its version in ${PLUGINS_FILE} must be higher than ${published}.`);
    }
  }
  return problems;
}

// Compares the committed files with a production build, and each plugin's
// version with the base. Returns one line per problem, or an empty list.
export async function check(root, { base = DEFAULT_BASE } = {}) {
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
  return [...problems, ...(await checkVersions(root, base))];
}

async function main([command, ...args], root) {
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
    const flag = args.indexOf('--base');
    const base = (flag === -1 ? process.env[BASE_VARIABLE] : args[flag + 1]) || DEFAULT_BASE;
    const problems = await check(root, { base });
    if (problems.length === 0) {
      console.log(`The skills and plugins match ${SOURCE_DIR}/, and every plugin that changed since ${base} has a higher version.`);
      return 0;
    }
    console.error(
      [
        ...problems.map((problem) => `- ${problem}`),
        '',
        'See "Changing a skill or a plugin" in CONTRIBUTING.md.',
      ].join('\n'),
    );
    return 1;
  }
  console.error('Usage: node scripts/skills.mjs build | check [--base <ref>]');
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.cwd()).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
