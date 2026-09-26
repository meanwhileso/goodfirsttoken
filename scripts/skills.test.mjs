import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, check, PRODUCTION_MCP_URL, write } from './skills.mjs';

const SCRIPT = fileURLToPath(new URL('./skills.mjs', import.meta.url));
const LOCAL_URL = 'http://localhost:5173/mcp';

const skillSource = (plugin, body = 'Do the thing.\n') =>
  `---\ndescription: A skill for tests.\nargument-hint: owner/repo#123\nplugin: ${plugin}\n---\n\n${body}`;

const PLUGIN_SETTINGS = {
  goodfirsttoken: { version: '0.1.0', description: 'Donor plugin.' },
  'goodfirsttoken-admin': { version: '0.1.0', description: 'Admin plugin.' },
};

const roots = [];
after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function makeRepo(skills = { give: skillSource('goodfirsttoken'), admin: skillSource('goodfirsttoken-admin') }) {
  const root = await mkdtemp(path.join(tmpdir(), 'skills-'));
  roots.push(root);
  await mkdir(path.join(root, 'skill-src'));
  await setPlugins(root, PLUGIN_SETTINGS);
  for (const [name, text] of Object.entries(skills)) await writeFile(path.join(root, 'skill-src', `${name}.md`), text);
  return root;
}

const setPlugins = (root, settings) => writeFile(path.join(root, 'skill-src/plugins.json'), JSON.stringify(settings));
const setVersion = (root, plugin, version) =>
  setPlugins(root, { ...PLUGIN_SETTINGS, [plugin]: { ...PLUGIN_SETTINGS[plugin], version } });
const read = (root, file) => readFile(path.join(root, file), 'utf8');
const exists = (root, file) => read(root, file).then(() => true, () => false);

async function buildAndWrite(root, options) {
  await write(root, await build(root, options));
}

// Runs the command the way pnpm does, from the repo root, with no URL override
// unless the test sets one.
function run(root, command, env = {}) {
  const base = { ...process.env };
  delete base.GOODFIRSTTOKEN_MCP_URL;
  return spawnSync(process.execPath, [SCRIPT, command], { cwd: root, env: { ...base, ...env }, encoding: 'utf8' });
}

function frontmatter(text) {
  return /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
}

test('a skill source becomes goodfirsttoken-<name> for skills.sh and <name> in the plugin, with the same body', async () => {
  const root = await makeRepo();
  await buildAndWrite(root);
  const standalone = await read(root, 'skills/goodfirsttoken-give/SKILL.md');
  const plugin = await read(root, 'plugins/goodfirsttoken/skills/give/SKILL.md');
  assert.match(frontmatter(standalone), /^name: goodfirsttoken-give$/m);
  assert.match(frontmatter(plugin), /^name: give$/m);
  for (const copy of [standalone, plugin]) {
    assert.match(frontmatter(copy), /^description: A skill for tests\.$/m);
    assert.match(frontmatter(copy), /^argument-hint: owner\/repo#123$/m);
    assert.doesNotMatch(frontmatter(copy), /^plugin:/m);
    assert.ok(copy.endsWith('\n\nDo the thing.\n'));
  }
});

test('the admin skill goes only into the admin plugin and is never published to skills.sh', async () => {
  const root = await makeRepo();
  await buildAndWrite(root);
  assert.ok(await exists(root, 'plugins/goodfirsttoken-admin/skills/admin/SKILL.md'));
  assert.equal(await exists(root, 'skills/goodfirsttoken-admin/SKILL.md'), false);
  assert.equal(await exists(root, 'plugins/goodfirsttoken/skills/admin/SKILL.md'), false);
});

test('every plugin copy is marked internal, which npx skills add skips, and no standalone copy is', async () => {
  const root = await makeRepo();
  await buildAndWrite(root);
  for (const file of ['plugins/goodfirsttoken/skills/give/SKILL.md', 'plugins/goodfirsttoken-admin/skills/admin/SKILL.md']) {
    assert.match(frontmatter(await read(root, file)), /^metadata:\n {2}internal: true$/m, file);
  }
  assert.doesNotMatch(frontmatter(await read(root, 'skills/goodfirsttoken-give/SKILL.md')), /internal/);
});

test('the marketplace lists both plugins under the names their manifests use, and the admin plugin brings the donor plugin and its MCP server', async () => {
  const root = await makeRepo();
  await buildAndWrite(root);
  const marketplace = JSON.parse(await read(root, '.claude-plugin/marketplace.json'));
  assert.deepEqual(marketplace.plugins.map((p) => p.name), ['goodfirsttoken', 'goodfirsttoken-admin']);
  const manifests = {};
  for (const entry of marketplace.plugins) {
    const manifest = JSON.parse(await read(root, path.join(entry.source, '.claude-plugin/plugin.json')));
    assert.equal(manifest.name, entry.name);
    assert.equal(manifest.version, '0.1.0');
    manifests[entry.name] = manifest;
  }
  assert.deepEqual(manifests['goodfirsttoken-admin'].dependencies, ['goodfirsttoken']);
  assert.equal(manifests['goodfirsttoken-admin'].mcpServers, undefined);
  assert.equal(manifests.goodfirsttoken.mcpServers.goodfirsttoken.type, 'http');
});

test('the MCP server URL is set once and reaches the plugin config and the skill text', async () => {
  const body = 'Add the server at {{MCP_URL}}.\n';
  const root = await makeRepo({ give: skillSource('goodfirsttoken', body), admin: skillSource('goodfirsttoken-admin', body) });
  const serverUrl = async () =>
    JSON.parse(await read(root, 'plugins/goodfirsttoken/.claude-plugin/plugin.json')).mcpServers.goodfirsttoken.url;

  await buildAndWrite(root);
  assert.equal(await serverUrl(), `\${GOODFIRSTTOKEN_MCP_URL:-${PRODUCTION_MCP_URL}}`);
  assert.ok((await read(root, 'skills/goodfirsttoken-give/SKILL.md')).endsWith(`Add the server at ${PRODUCTION_MCP_URL}.\n`));

  await buildAndWrite(root, { mcpUrl: LOCAL_URL });
  assert.equal(await serverUrl(), `\${GOODFIRSTTOKEN_MCP_URL:-${LOCAL_URL}}`);
  for (const file of ['skills/goodfirsttoken-give/SKILL.md', 'plugins/goodfirsttoken/skills/give/SKILL.md', 'plugins/goodfirsttoken-admin/skills/admin/SKILL.md']) {
    assert.ok((await read(root, file)).endsWith(`Add the server at ${LOCAL_URL}.\n`), file);
  }
});

test('pnpm skills:check passes after a build and fails when any generated file is edited by hand', async () => {
  const root = await makeRepo();
  assert.equal(run(root, 'build').status, 0);
  assert.equal(run(root, 'check').status, 0);
  const generated = [
    'skills/goodfirsttoken-give/SKILL.md',
    'plugins/goodfirsttoken/skills/give/SKILL.md',
    'plugins/goodfirsttoken-admin/skills/admin/SKILL.md',
    'plugins/goodfirsttoken/.claude-plugin/plugin.json',
    'plugins/goodfirsttoken-admin/.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    'skill-src/plugins.lock.json',
  ];
  for (const file of generated) {
    const original = await read(root, file);
    await writeFile(path.join(root, file), `${original} `);
    const result = run(root, 'check');
    assert.equal(result.status, 1, file);
    assert.match(result.stderr, new RegExp(`${file.replaceAll('.', '\\.')} is not what the build writes`));
    await writeFile(path.join(root, file), original);
  }
  await rm(path.join(root, 'skills/goodfirsttoken-give/SKILL.md'));
  assert.match(run(root, 'check').stderr, /skills\/goodfirsttoken-give\/SKILL\.md is missing/);
});

test('a file the build did not write in a generated folder fails the check, and the next build removes it', async () => {
  const root = await makeRepo();
  await buildAndWrite(root);
  for (const file of ['skills/goodfirsttoken-extra/SKILL.md', 'plugins/goodfirsttoken-admin/skills/admin/notes.md', '.claude-plugin/plugin.json']) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'hand-written\n');
    assert.deepEqual(await check(root), [`${file} is not written by the build.`]);
    await buildAndWrite(root);
    assert.equal(await exists(root, file), false);
    assert.deepEqual(await check(root), []);
  }
});

test('a deleted skill source leaves no copies behind', async () => {
  const root = await makeRepo({ give: skillSource('goodfirsttoken'), work: skillSource('goodfirsttoken'), admin: skillSource('goodfirsttoken-admin') });
  await buildAndWrite(root);
  await rm(path.join(root, 'skill-src/work.md'));
  await setVersion(root, 'goodfirsttoken', '0.2.0');
  assert.ok((await check(root)).includes('skills/goodfirsttoken-work/SKILL.md is not written by the build.'));
  await buildAndWrite(root);
  assert.equal(await exists(root, 'skills/goodfirsttoken-work/SKILL.md'), false);
  assert.equal(await exists(root, 'plugins/goodfirsttoken/skills/work/SKILL.md'), false);
});

test('the check always compares with the production URL, so copies built for local dev never pass', async () => {
  const root = await makeRepo();
  assert.equal(run(root, 'build', { GOODFIRSTTOKEN_MCP_URL: LOCAL_URL }).status, 0);
  const result = run(root, 'check', { GOODFIRSTTOKEN_MCP_URL: LOCAL_URL });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugins\/goodfirsttoken\/\.claude-plugin\/plugin\.json is not what the build writes/);
  assert.equal(run(root, 'build').status, 0);
  assert.equal(run(root, 'check', { GOODFIRSTTOKEN_MCP_URL: LOCAL_URL }).status, 0);
});

test('changing a skill without raising its plugin version fails the build and the check', async () => {
  const root = await makeRepo();
  await buildAndWrite(root);
  await writeFile(path.join(root, 'skill-src/give.md'), skillSource('goodfirsttoken', 'Do it differently.\n'));
  await assert.rejects(build(root), /goodfirsttoken changed, so its version must go up\. Raise it above 0\.1\.0/);
  const result = run(root, 'check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /goodfirsttoken changed, so its version must go up/);
  assert.match(run(root, 'build').stderr, /goodfirsttoken changed, so its version must go up/);
  assert.ok((await read(root, 'skills/goodfirsttoken-give/SKILL.md')).endsWith('Do the thing.\n'));

  await setVersion(root, 'goodfirsttoken', '0.1.1');
  await buildAndWrite(root);
  assert.equal(JSON.parse(await read(root, 'plugins/goodfirsttoken/.claude-plugin/plugin.json')).version, '0.1.1');
  assert.equal(JSON.parse(await read(root, 'skill-src/plugins.lock.json')).goodfirsttoken.version, '0.1.1');
  assert.deepEqual(await check(root), []);
});

test('each plugin has its own version: changing the admin skill needs only the admin plugin raised', async () => {
  const root = await makeRepo();
  await buildAndWrite(root);
  await writeFile(path.join(root, 'skill-src/admin.md'), skillSource('goodfirsttoken-admin', 'New admin steps.\n'));
  await assert.rejects(build(root), /goodfirsttoken-admin changed/);
  await setVersion(root, 'goodfirsttoken-admin', '0.2.0');
  await buildAndWrite(root);
  const lock = JSON.parse(await read(root, 'skill-src/plugins.lock.json'));
  assert.equal(lock.goodfirsttoken.version, '0.1.0');
  assert.equal(lock['goodfirsttoken-admin'].version, '0.2.0');
});

test('a plugin version that goes down is refused', async () => {
  const root = await makeRepo();
  await setVersion(root, 'goodfirsttoken', '0.3.0');
  await buildAndWrite(root);
  await setVersion(root, 'goodfirsttoken', '0.2.9');
  await assert.rejects(build(root), /version of goodfirsttoken went down, from 0\.3\.0 to 0\.2\.9/);
});

test('raising a version with no skill change is allowed, for a change to the MCP tools', async () => {
  const root = await makeRepo();
  await buildAndWrite(root);
  await setVersion(root, 'goodfirsttoken', '0.2.0');
  await buildAndWrite(root);
  assert.equal(JSON.parse(await read(root, 'plugins/goodfirsttoken/.claude-plugin/plugin.json')).version, '0.2.0');
});

test('a build for local dev leaves the version record alone', async () => {
  const root = await makeRepo();
  await buildAndWrite(root);
  const lock = await read(root, 'skill-src/plugins.lock.json');
  await writeFile(path.join(root, 'skill-src/give.md'), skillSource('goodfirsttoken', 'Try something locally.\n'));
  await buildAndWrite(root, { mcpUrl: LOCAL_URL });
  assert.ok((await read(root, 'skills/goodfirsttoken-give/SKILL.md')).endsWith('Try something locally.\n'));
  assert.equal(await read(root, 'skill-src/plugins.lock.json'), lock);
});

test('a skill source must say which plugin it belongs to, describe itself, and leave name and metadata to the build', async () => {
  const cases = [
    ['---\ndescription: No plugin.\n---\nBody.\n', /needs plugin set to one of: goodfirsttoken, goodfirsttoken-admin/],
    ['---\ndescription: Wrong plugin.\nplugin: someone-else\n---\nBody.\n', /needs plugin set to one of/],
    ['---\nplugin: goodfirsttoken\n---\nBody.\n', /needs a description/],
    ['---\nname: give\ndescription: Named.\nplugin: goodfirsttoken\n---\nBody.\n', /sets name, which the build writes/],
    ['---\ndescription: Meta.\nplugin: goodfirsttoken\nmetadata:\n  internal: false\n---\nBody.\n', /sets metadata, which the build writes/],
    ['No frontmatter.\n', /must start with frontmatter/],
    ['---\ndescription: Admin: the queue.\nplugin: goodfirsttoken\n---\nBody.\n', /put the value of description in quotes/],
  ];
  for (const [text, message] of cases) {
    const root = await makeRepo({ give: text });
    await assert.rejects(build(root), message);
  }
  const quoted = await makeRepo({ give: '---\ndescription: "Admin: the queue."\nplugin: "goodfirsttoken"\n---\nBody.\n' });
  await buildAndWrite(quoted);
  assert.match(await read(quoted, 'skills/goodfirsttoken-give/SKILL.md'), /^description: "Admin: the queue\."$/m);
});
