import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
const DEFAULT_SKILLS = { give: skillSource('goodfirsttoken'), admin: skillSource('goodfirsttoken-admin') };

const PLUGIN_SETTINGS = {
  goodfirsttoken: { version: '0.1.0', description: 'Donor plugin.' },
  'goodfirsttoken-admin': { version: '0.1.0', description: 'Admin plugin.' },
};

const roots = [];
after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

// Git with no repo variables from the environment, so a test never reaches
// outside its own folder, and no signing or hooks from the machine's config.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
function git(root, ...args) {
  const config = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
  return execFileSync('git', [...config, ...args], { cwd: root, env: cleanEnv(), encoding: 'utf8', stdio: 'pipe' });
}
function commitAll(root, message = 'base') {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', message);
}

// A folder with skill-src/ and nothing else.
async function makeSources(skills = DEFAULT_SKILLS) {
  const root = await mkdtemp(path.join(tmpdir(), 'skills-'));
  roots.push(root);
  await mkdir(path.join(root, 'skill-src'));
  await setPlugins(root, PLUGIN_SETTINGS);
  for (const [name, text] of Object.entries(skills)) await writeFile(path.join(root, 'skill-src', `${name}.md`), text);
  return root;
}

// A git repo whose one commit holds the sources and a production build, like
// main after a release. Checks in these tests compare with that commit.
async function makeRepo(skills = DEFAULT_SKILLS) {
  const root = await makeSources(skills);
  git(root, 'init', '-q');
  await buildAndWrite(root);
  commitAll(root);
  return root;
}

const setPlugins = (root, settings) => writeFile(path.join(root, 'skill-src/plugins.json'), JSON.stringify(settings));
const setVersion = (root, plugin, version) =>
  setPlugins(root, { ...PLUGIN_SETTINGS, [plugin]: { ...PLUGIN_SETTINGS[plugin], version } });
const read = (root, file) => readFile(path.join(root, file), 'utf8');
const exists = (root, file) => read(root, file).then(() => true, () => false);
const checkAgainstHead = (root) => check(root, { base: 'HEAD' });

async function buildAndWrite(root, options) {
  await write(root, await build(root, options));
}

// Runs the command the way pnpm does, from the repo root, with no URL
// override and a base of HEAD unless the test sets them.
function run(root, command, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, command], {
    cwd: root,
    env: { ...cleanEnv(), GOODFIRSTTOKEN_MCP_URL: '', SKILLS_BASE_REF: 'HEAD', ...env },
    encoding: 'utf8',
  });
}

function frontmatter(text) {
  return /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
}

test('a skill source becomes goodfirsttoken-<name> for skills.sh and <name> in the plugin, with the same body', async () => {
  const root = await makeRepo();
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
  assert.ok(await exists(root, 'plugins/goodfirsttoken-admin/skills/admin/SKILL.md'));
  assert.equal(await exists(root, 'skills/goodfirsttoken-admin/SKILL.md'), false);
  assert.equal(await exists(root, 'plugins/goodfirsttoken/skills/admin/SKILL.md'), false);
});

test('every plugin copy carries metadata.internal, which npx skills add skips by default, and no standalone copy does', async () => {
  const root = await makeRepo();
  for (const file of ['plugins/goodfirsttoken/skills/give/SKILL.md', 'plugins/goodfirsttoken-admin/skills/admin/SKILL.md']) {
    assert.match(frontmatter(await read(root, file)), /^metadata:\n {2}internal: true$/m, file);
  }
  assert.doesNotMatch(frontmatter(await read(root, 'skills/goodfirsttoken-give/SKILL.md')), /internal/);
});

test('the marketplace lists both plugins under the names their manifests use, and the admin plugin brings the donor plugin and its MCP server', async () => {
  const root = await makeRepo();
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

  assert.equal(await serverUrl(), `\${GOODFIRSTTOKEN_MCP_URL:-${PRODUCTION_MCP_URL}}`);
  assert.ok((await read(root, 'skills/goodfirsttoken-give/SKILL.md')).endsWith(`Add the server at ${PRODUCTION_MCP_URL}.\n`));

  await buildAndWrite(root, { mcpUrl: LOCAL_URL });
  assert.equal(await serverUrl(), `\${GOODFIRSTTOKEN_MCP_URL:-${LOCAL_URL}}`);
  for (const file of ['skills/goodfirsttoken-give/SKILL.md', 'plugins/goodfirsttoken/skills/give/SKILL.md', 'plugins/goodfirsttoken-admin/skills/admin/SKILL.md']) {
    assert.ok((await read(root, file)).endsWith(`Add the server at ${LOCAL_URL}.\n`), file);
  }
});

test('the server URL must be a URL', async () => {
  const root = await makeSources();
  await assert.rejects(build(root, { mcpUrl: 'localhost 5173' }), /GOODFIRSTTOKEN_MCP_URL must be a URL/);
  const result = run(root, 'build', { GOODFIRSTTOKEN_MCP_URL: 'localhost 5173' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GOODFIRSTTOKEN_MCP_URL must be a URL/);
  assert.equal(await exists(root, 'skills/goodfirsttoken-give/SKILL.md'), false);
});

test('pnpm skills:check passes after a build and fails when any generated file is edited by hand', async () => {
  const root = await makeRepo();
  assert.equal(run(root, 'check').status, 0);
  const generated = [
    'skills/goodfirsttoken-give/SKILL.md',
    'plugins/goodfirsttoken/skills/give/SKILL.md',
    'plugins/goodfirsttoken-admin/skills/admin/SKILL.md',
    'plugins/goodfirsttoken/.claude-plugin/plugin.json',
    'plugins/goodfirsttoken-admin/.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
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
  for (const file of ['skills/goodfirsttoken-extra/SKILL.md', 'plugins/goodfirsttoken-admin/skills/admin/notes.md', '.claude-plugin/plugin.json']) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'hand-written\n');
    assert.ok((await checkAgainstHead(root)).includes(`${file} is not written by the build.`), file);
    await buildAndWrite(root);
    assert.equal(await exists(root, file), false);
    assert.deepEqual(await checkAgainstHead(root), []);
  }
});

test('a deleted skill source leaves no copies behind', async () => {
  const root = await makeRepo({ ...DEFAULT_SKILLS, work: skillSource('goodfirsttoken') });
  await rm(path.join(root, 'skill-src/work.md'));
  await setVersion(root, 'goodfirsttoken', '0.2.0');
  assert.ok((await checkAgainstHead(root)).includes('skills/goodfirsttoken-work/SKILL.md is not written by the build.'));
  await buildAndWrite(root);
  assert.equal(await exists(root, 'skills/goodfirsttoken-work/SKILL.md'), false);
  assert.equal(await exists(root, 'plugins/goodfirsttoken/skills/work/SKILL.md'), false);
  assert.deepEqual(await checkAgainstHead(root), []);
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

test('a Windows checkout with CRLF line endings matches the build and counts as unchanged', async () => {
  const root = await makeRepo();
  const lf = new Map();
  for (const file of git(root, 'ls-files').trim().split('\n')) {
    const text = await read(root, file);
    lf.set(file, text);
    await writeFile(path.join(root, file), text.replaceAll('\n', '\r\n'));
  }
  assert.deepEqual(await checkAgainstHead(root), []);
  const output = await build(root);
  assert.equal(output.files.get('skills/goodfirsttoken-give/SKILL.md'), lf.get('skills/goodfirsttoken-give/SKILL.md'));
});

test('changing a plugin without raising its version fails the check', async () => {
  const root = await makeRepo();
  await writeFile(path.join(root, 'skill-src/give.md'), skillSource('goodfirsttoken', 'Do it differently.\n'));
  await buildAndWrite(root);
  assert.deepEqual(await checkAgainstHead(root), [
    'plugins/goodfirsttoken/ changed since HEAD, so its version in skill-src/plugins.json must be higher than 0.1.0.',
  ]);
  const result = run(root, 'check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugins\/goodfirsttoken\/ changed since HEAD/);
});

test('raising the version once covers every later change on the branch', async () => {
  const root = await makeRepo();
  await writeFile(path.join(root, 'skill-src/give.md'), skillSource('goodfirsttoken', 'Do it differently.\n'));
  await setVersion(root, 'goodfirsttoken', '0.1.1');
  await buildAndWrite(root);
  assert.deepEqual(await checkAgainstHead(root), []);
  commitAll(root, 'first change');
  await writeFile(path.join(root, 'skill-src/give.md'), skillSource('goodfirsttoken', 'Do it a third way.\n'));
  await buildAndWrite(root);
  const base = git(root, 'rev-parse', 'HEAD~1').trim();
  assert.deepEqual(await check(root, { base }), []);
});

test('each plugin has its own version: changing the admin skill needs only the admin plugin raised', async () => {
  const root = await makeRepo();
  await writeFile(path.join(root, 'skill-src/admin.md'), skillSource('goodfirsttoken-admin', 'New admin steps.\n'));
  await buildAndWrite(root);
  assert.deepEqual(await checkAgainstHead(root), [
    'plugins/goodfirsttoken-admin/ changed since HEAD, so its version in skill-src/plugins.json must be higher than 0.1.0.',
  ]);
  await setVersion(root, 'goodfirsttoken-admin', '0.2.0');
  await buildAndWrite(root);
  assert.deepEqual(await checkAgainstHead(root), []);
});

test('a hand-written file in a plugin folder is covered: editing, adding, or deleting one needs a higher version', async () => {
  const root = await makeSources();
  git(root, 'init', '-q');
  await buildAndWrite(root);
  await mkdir(path.join(root, 'plugins/goodfirsttoken/hooks'));
  await writeFile(path.join(root, 'plugins/goodfirsttoken/hooks/hooks.json'), '{}\n');
  commitAll(root);
  const problem = 'plugins/goodfirsttoken/ changed since HEAD, so its version in skill-src/plugins.json must be higher than 0.1.0.';

  await writeFile(path.join(root, 'plugins/goodfirsttoken/hooks/hooks.json'), '{"hooks": {}}\n');
  assert.deepEqual(await checkAgainstHead(root), [problem]);
  git(root, 'checkout', '--', '.');

  await writeFile(path.join(root, 'plugins/goodfirsttoken/hooks/estimate.mjs'), 'export {};\n');
  assert.deepEqual(await checkAgainstHead(root), [problem]);
  await rm(path.join(root, 'plugins/goodfirsttoken/hooks/estimate.mjs'));

  await rm(path.join(root, 'plugins/goodfirsttoken/hooks/hooks.json'));
  assert.deepEqual(await checkAgainstHead(root), [problem]);

  await setVersion(root, 'goodfirsttoken', '0.1.1');
  await buildAndWrite(root);
  assert.deepEqual(await checkAgainstHead(root), []);
});

test('a plugin version lower than the base fails, even with no other change', async () => {
  const root = await makeSources();
  await setVersion(root, 'goodfirsttoken', '0.3.0');
  git(root, 'init', '-q');
  await buildAndWrite(root);
  commitAll(root);
  await setVersion(root, 'goodfirsttoken', '0.2.9');
  await buildAndWrite(root);
  assert.deepEqual(await checkAgainstHead(root), [
    'The version of goodfirsttoken went down from 0.3.0 at HEAD to 0.2.9. Set it higher than 0.3.0 in skill-src/plugins.json.',
  ]);
});

test('raising a version with no skill change passes, for a change to the MCP tools', async () => {
  const root = await makeRepo();
  await setVersion(root, 'goodfirsttoken', '0.2.0');
  await buildAndWrite(root);
  assert.equal(JSON.parse(await read(root, 'plugins/goodfirsttoken/.claude-plugin/plugin.json')).version, '0.2.0');
  assert.deepEqual(await checkAgainstHead(root), []);
});

test('a plugin the base does not have yet can start at any version', async () => {
  const root = await makeSources();
  git(root, 'init', '-q');
  commitAll(root);
  await buildAndWrite(root);
  assert.deepEqual(await checkAgainstHead(root), []);
});

test('a missing base ref fails the check with a message saying how to get it', async () => {
  const root = await makeRepo();
  const [problem] = await check(root, { base: 'origin/main' });
  assert.match(problem, /The base ref origin\/main was not found/);
  const result = run(root, 'check', { SKILLS_BASE_REF: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /The base ref origin\/main was not found/);
  const withFlag = spawnSync(process.execPath, [SCRIPT, 'check', '--base', 'no-such-ref'], { cwd: root, env: cleanEnv(), encoding: 'utf8' });
  assert.equal(withFlag.status, 1);
  assert.match(withFlag.stderr, /The base ref no-such-ref was not found/);
});

test('a skill source must say which plugin it belongs to, describe itself, and leave name and metadata to the build', async () => {
  const cases = [
    ['---\ndescription: No plugin.\n---\nBody.\n', /needs plugin set to one of: goodfirsttoken, goodfirsttoken-admin/],
    ['---\ndescription: Wrong plugin.\nplugin: someone-else\n---\nBody.\n', /needs plugin set to one of/],
    ['---\nplugin: goodfirsttoken\n---\nBody.\n', /needs a description/],
    ['---\nname: give\ndescription: Named.\nplugin: goodfirsttoken\n---\nBody.\n', /sets name, which the build writes/],
    ['---\ndescription: Meta.\nplugin: goodfirsttoken\nmetadata:\n  internal: false\n---\nBody.\n', /sets metadata, which the build writes/],
    ['---\ndescription: Once.\ndescription: Twice.\nplugin: goodfirsttoken\n---\nBody.\n', /sets description twice/],
    ['No frontmatter.\n', /must start with frontmatter/],
    ['---\ndescription: Admin: the queue.\nplugin: goodfirsttoken\n---\nBody.\n', /put the value of description in quotes/],
  ];
  for (const [text, message] of cases) {
    const root = await makeSources({ give: text });
    await assert.rejects(build(root), message);
  }
  const quoted = await makeSources({ give: '---\ndescription: "Admin: the queue."\nplugin: "goodfirsttoken"\n---\nBody.\n' });
  await buildAndWrite(quoted);
  assert.match(await read(quoted, 'skills/goodfirsttoken-give/SKILL.md'), /^description: "Admin: the queue\."$/m);
});

test('a skill file name must be lowercase letters, digits, and hyphens, since it becomes the command', async () => {
  for (const name of ['Give', 'give_now', 'give-', '-give']) {
    const root = await makeSources({ [name]: skillSource('goodfirsttoken') });
    await assert.rejects(build(root), /skill names use lowercase letters, digits, and hyphens/, name);
  }
});

test('plugins.json must list exactly the two plugins', async () => {
  const missing = await makeSources();
  await setPlugins(missing, { goodfirsttoken: PLUGIN_SETTINGS.goodfirsttoken });
  await assert.rejects(build(missing), /must list exactly these plugins: goodfirsttoken, goodfirsttoken-admin/);
  const extra = await makeSources();
  await setPlugins(extra, { ...PLUGIN_SETTINGS, 'goodfirsttoken-extra': { version: '0.1.0', description: 'Extra.' } });
  await assert.rejects(build(extra), /must list exactly these plugins/);
});
