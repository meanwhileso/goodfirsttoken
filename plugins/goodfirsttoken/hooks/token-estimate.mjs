// The goodfirsttoken plugin's PreToolUse hook for submit_work. Claude Code
// runs it before each submit_work call, as hooks.json says, with the call on
// stdin. It reads the session's transcript on this computer, adds up the
// tokens spent on the claim, and prints the call's input back with that sum
// as tokenEstimate. The number is an estimate. Nothing else from the
// transcript leaves this process, and the hook makes no network call.
//
// When anything goes wrong, like a transcript it can't read, it prints
// nothing and exits 0, so the submit goes on without an estimate.
//
// The window it counts:
// - It starts after the last submit_work for the same claim that the server
//   took, since the server adds up the estimates of every submit. A refused
//   submit, whose result is an error, doesn't start a window.
// - With no such submit, it starts after the claim_issue result that names
//   the claim, which is where the claim was made or resumed.
// - With neither, it starts after the latest boundary of any claim: a
//   submit_work the server took or a claim_issue result. A session that
//   answers follow-ups submits with no claim_issue in it, and this keeps one
//   claim's tokens out of the next.
// - With no boundary at all, it is the whole transcript.
// - A sum too large to be a safe integer gives no estimate, since the server
//   would refuse the submit.
// Each assistant message counts once, however many transcript lines it
// spans: its input, cache write, cache read, and output tokens. Subagents
// keep transcripts of their own, which the hook doesn't read.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SUBMIT = /^mcp__.*goodfirsttoken.*__submit_work$/;
const CLAIM = /^mcp__.*goodfirsttoken.*__claim_issue$/;
const USAGE_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
const ID_CHARACTER = /[A-Za-z0-9_-]/;

function tokensIn(usage) {
  let sum = 0;
  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (Number.isSafeInteger(value) && value > 0) sum += value;
  }
  return sum;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('\n');
}

/** Whether the text holds the claim's ID as a whole word, as claim_issue's answer does. */
function namesClaim(text, claimId) {
  for (let at = text.indexOf(claimId); at !== -1; at = text.indexOf(claimId, at + 1)) {
    const before = at > 0 ? text[at - 1] : ' ';
    const after = at + claimId.length < text.length ? text[at + claimId.length] : ' ';
    if (!ID_CHARACTER.test(before) && !ID_CHARACTER.test(after)) return true;
  }
  return false;
}

/**
 * The tokens spent on the claim, from the transcript's lines, or null when
 * the window holds no assistant message with usage. `toolUseId` is the
 * submit_work call the hook runs for, which never starts a window.
 */
export async function estimateTokens(lines, { claimId, toolUseId }) {
  const claimCalls = new Set();
  // The claim ID of each submit_work call, by call ID.
  const submitCalls = new Map();
  // The tokens of each assistant message, by message ID: since the last
  // boundary of this claim, and since the last boundary of any claim.
  let own = new Map();
  let any = new Map();
  let ownBoundary = false;
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message;
    if (!message || !Array.isArray(message.content)) continue;
    if (entry.type === 'assistant') {
      if (message.usage && typeof message.usage === 'object') {
        const key = typeof message.id === 'string' ? message.id : `line ${String(lineNumber)}`;
        const tokens = tokensIn(message.usage);
        own.set(key, tokens);
        any.set(key, tokens);
      }
      for (const part of message.content) {
        if (part?.type !== 'tool_use' || typeof part.name !== 'string' || part.id === toolUseId) continue;
        if (CLAIM.test(part.name)) claimCalls.add(part.id);
        else if (SUBMIT.test(part.name)) submitCalls.set(part.id, part.input?.claimId);
      }
    } else if (entry.type === 'user') {
      for (const part of message.content) {
        if (part?.type !== 'tool_result' || part.is_error === true) continue;
        const isClaim = claimCalls.has(part.tool_use_id);
        if (!isClaim && !submitCalls.has(part.tool_use_id)) continue;
        any = new Map();
        const mine = isClaim ? namesClaim(resultText(part.content), claimId) : submitCalls.get(part.tool_use_id) === claimId;
        if (mine) {
          own = new Map();
          ownBoundary = true;
        }
      }
    }
  }
  const counted = ownBoundary ? own : any;
  if (counted.size === 0) return null;
  let sum = 0;
  for (const tokens of counted.values()) sum += tokens;
  return Number.isSafeInteger(sum) ? sum : null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** What the hook prints for the call on stdin, or '' to leave the call as it is. */
export async function hookOutput(stdin) {
  const call = JSON.parse(stdin);
  if (call?.hook_event_name !== 'PreToolUse' || typeof call.tool_name !== 'string' || !SUBMIT.test(call.tool_name)) return '';
  const input = call.tool_input;
  if (!input || typeof input !== 'object' || typeof input.claimId !== 'string' || !input.claimId) return '';
  if (typeof call.transcript_path !== 'string' || !call.transcript_path) return '';
  const lines = createInterface({ input: createReadStream(call.transcript_path, 'utf8'), crlfDelay: Infinity });
  const tokens = await estimateTokens(lines, { claimId: input.claimId, toolUseId: call.tool_use_id });
  if (tokens === null) return '';
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, tokenEstimate: tokens } },
  });
}

async function main() {
  let output;
  try {
    output = await hookOutput(await readStdin());
  } catch {
    output = '';
  }
  if (output) process.stdout.write(`${output}\n`);
  process.exitCode = 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
