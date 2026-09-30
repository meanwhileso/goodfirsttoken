import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The goodfirsttoken plugin's hook, run the way Claude Code runs it: a
// process with the PreToolUse call on stdin. The sample transcript is made
// up. Its assistant messages spend 15, 640, 1,110, 10, 2,050, and 2,250
// tokens, counting input, cache writes, cache reads, and output.

const root = fileURLToPath(new URL('..', import.meta.url));
const pluginDir = path.join(root, 'plugins/goodfirsttoken');
const hook = path.join(pluginDir, 'hooks/token-estimate.mjs');
const sample = path.join(root, 'scripts/fixtures/sample-transcript.jsonl');
const plugin = JSON.parse(readFileSync(path.join(pluginDir, '.claude-plugin/plugin.json'), 'utf8'));
const serverKey = Object.keys(plugin.mcpServers)[0];
const SUBMIT_TOOL = `mcp__plugin_${plugin.name}_${serverKey}__submit_work`;

function runHook(stdin) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [hook], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

function submitCall(transcriptPath, { claimId = 'c_sample1', toolUseId = 'toolu_submit3', tokenEstimate } = {}) {
  const toolInput = {
    claimId,
    files: [{ path: 'src/sample.ts', content: 'export const sample = 1;\n' }],
    summary: 'Keeps the sample value.',
    checks: 'npm test passes.',
    agent: 'claude-code',
    model: 'sample-model',
    ...(tokenEstimate === undefined ? {} : { tokenEstimate }),
  };
  return {
    session_id: 'sample-session',
    transcript_path: transcriptPath,
    cwd: '/work/sample-app',
    hook_event_name: 'PreToolUse',
    tool_name: SUBMIT_TOOL,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  };
}

async function firstLines(count) {
  const dir = await mkdtemp(path.join(tmpdir(), 'token-estimate-'));
  const file = path.join(dir, 'transcript.jsonl');
  await writeFile(file, readFileSync(sample, 'utf8').split('\n').slice(0, count).join('\n'));
  return file;
}

async function estimateFor(call) {
  const { code, stdout } = await runHook(JSON.stringify(call));
  assert.equal(code, 0);
  return JSON.parse(stdout).hookSpecificOutput.updatedInput.tokenEstimate;
}

test('a submit carries the tokens spent since the last submit the server took, and a refused submit or another claim starts no count', async () => {
  // After the first submit's answer: 10 for claiming c_sample10, 2,050 for the refused submit, 2,250 for this one.
  assert.equal(await estimateFor(submitCall(sample)), 4310);
});

test("a claim's first submit counts from the claim_issue answer that names the claim, and a message split over lines counts once", async () => {
  const transcript = await firstLines(6);
  assert.equal(await estimateFor(submitCall(transcript, { toolUseId: 'toolu_submit1' })), 640 + 1110);
});

test('a claim the transcript never claimed or submitted counts the whole transcript', async () => {
  assert.equal(await estimateFor(submitCall(sample, { claimId: 'c_elsewhere', toolUseId: 'toolu_new' })), 6075);
});

test("the hook gives back the call's own input with only the estimate added or replaced, and no text from the transcript", async () => {
  const call = submitCall(sample, { tokenEstimate: 99 });
  const { code, stdout } = await runHook(JSON.stringify(call));

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...call.tool_input, tokenEstimate: 4310 } },
  });
  assert.doesNotMatch(stdout, /SAMPLE-|toolu_|msg_sample/);
});

test('a transcript the hook cannot read leaves the submit as it was, with no output and exit 0', async () => {
  const missing = path.join(tmpdir(), 'no-such-folder-for-token-estimate', 'transcript.jsonl');
  assert.equal(existsSync(missing), false);

  for (const stdin of [JSON.stringify(submitCall(missing)), 'not JSON', '', JSON.stringify(submitCall(await firstLines(1)))]) {
    const { code, stdout } = await runHook(stdin);
    assert.equal(code, 0, stdin);
    assert.equal(stdout, '', stdin);
  }
});

test('the hook leaves any other tool call alone', async () => {
  for (const tool_name of [SUBMIT_TOOL.replace('submit_work', 'claim_issue'), 'Bash', 'mcp__other__submit_work']) {
    const { code, stdout } = await runHook(JSON.stringify({ ...submitCall(sample), tool_name }));
    assert.equal(code, 0, tool_name);
    assert.equal(stdout, '', tool_name);
  }
});

test("the plugin runs the hook before the plugin's own submit_work, and before no other of its tools", () => {
  const config = JSON.parse(readFileSync(path.join(pluginDir, 'hooks/hooks.json'), 'utf8'));
  const [entry] = config.hooks.PreToolUse;
  const matcher = new RegExp(`^(?:${entry.matcher})$`);

  assert.equal(matcher.test(SUBMIT_TOOL), true);
  assert.equal(matcher.test(SUBMIT_TOOL.replace('submit_work', 'claim_issue')), false);
  const command = entry.hooks[0].command.replace('${CLAUDE_PLUGIN_ROOT}', pluginDir);
  assert.equal(command, `node "${hook}"`);
});
