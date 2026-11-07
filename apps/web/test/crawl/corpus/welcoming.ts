import type { CrawlTier, PolicyFileKind } from '../../../src/crawl/rules';
import { file, type Expected, type PolicyCase } from './cases';

// Made-up welcoming AI policies, written the way real ones read, many with
// ordinary rules for how to work. Each has the tier and conditions it
// should have, which the eval checks, and the tier the crawler's rules read
// before the model read policies, kept as a record that nothing checks.

interface Welcoming {
  kind: PolicyFileKind;
  text: string;
  /** The tier it should have. */
  tier: 'invites_agents' | 'allows_with_conditions';
  /** The tier the rules read. A record: nothing checks it. */
  rules: CrawlTier;
  /** A person in the loop, when the text asks for one. */
  personInLoop?: true;
  trailer?: string;
  only?: string[];
}

const invites = 'invites_agents';
const allows = 'allows_with_conditions';
const ban = 'bans_or_restricts';

/**
 * The 38 written alongside the rules. The second review's ten come first.
 * The rules read every one as a welcome but the last four, which name AI
 * and say no to something else in a sentence that is no form.
 */
export const WELCOMING: Welcoming[] = [
  { kind: 'aiPolicy', text: '# AI policy\n\nAgents may open pull requests on their own.\n\nDisclose it with an Assisted-by: trailer. Keep each PR to one change.\n', tier: invites, rules: invites, trailer: 'Assisted-by' },
  { kind: 'aiPolicy', text: '# AI policy\n\nAgents may open pull requests on their own.\n\nDo not include secrets or tokens in a PR.\n', tier: invites, rules: invites },
  { kind: 'aiPolicy', text: '# AI policy\n\nAI-assisted contributions are welcome. We only ask that you disclose them.\n', tier: allows, rules: allows },
  { kind: 'aiPolicy', text: "# AI policy\n\nAI help is fine. You don't need to ask first.\n", tier: allows, rules: allows },
  { kind: 'contributing', text: '# Contributing\n\nAI-assisted contributions are welcome. We only ask that you disclose them.\n', tier: allows, rules: allows },
  { kind: 'contributing', text: "# Contributing\n\n## Using AI\n\nAI help is fine. Please don't paste large blocks of code you haven't read.\n", tier: allows, rules: allows, personInLoop: true },
  { kind: 'contributing', text: '# Contributing\n\nAgent pull requests are welcome. Agents should not push to main.\n', tier: invites, rules: invites },
  { kind: 'agents', text: '# AGENTS.md\n\nAgents may open pull requests here. Do not open a PR against the release branch.\n', tier: invites, rules: invites },
  { kind: 'agents', text: '# AGENTS.md\n\nAgents may open pull requests here. Never open more than one PR at a time.\n', tier: invites, rules: invites },
  { kind: 'contributing', text: '# Contributing\n\nCoding agents may open pull requests here. Do not use AI to write commit messages without reading them.\n', tier: allows, rules: allows, personInLoop: true },
  { kind: 'aiPolicy', text: '# AI policy\n\nWe welcome contributions made with AI tools. Review every line before you open a pull request, and disclose AI help with an Assisted-by: trailer.\n', tier: allows, rules: allows, personInLoop: true, trailer: 'Assisted-by' },
  { kind: 'aiPolicy', text: '# Using AI\n\nYou may use Copilot, Claude Code, or any other assistant. You are responsible for the code you submit.\n', tier: allows, rules: allows, personInLoop: true },
  { kind: 'aiPolicy', text: '# AI policy\n\nCoding agents may open pull requests on issues labeled `help wanted`. Keep each pull request small.\n', tier: invites, rules: invites },
  { kind: 'agents', text: '# AGENTS.md\n\nAgents may open pull requests here. Run `make test` before you push. Do not commit generated build output.\n', tier: invites, rules: invites },
  { kind: 'contributing', text: '# Contributing\n\n## AI tools\n\nAI help is welcome. Please do not submit changes you have not tested.\n', tier: allows, rules: allows },
  { kind: 'contributing', text: '# Contributing\n\nWe are happy to take pull requests written with the help of AI. Please mention it in the PR description.\n', tier: allows, rules: allows },
  { kind: 'contributing', text: '# Contributing\n\nAgents are welcome to work on any open issue. They should not force-push to shared branches.\n', tier: invites, rules: invites },
  { kind: 'aiPolicy', text: '# AI policy\n\nAI help is fine. You do not need to ask before using it.\n', tier: allows, rules: allows },
  { kind: 'aiPolicy', text: '# AI policy\n\nAI-generated contributions are accepted. They go through the same review as any other pull request.\n', tier: allows, rules: allows },
  { kind: 'contributing', text: '# Contributing\n\nFeel free to use ChatGPT or Claude to draft your change. There is no need to mention it.\n', tier: allows, rules: allows },
  { kind: 'aiPolicy', text: '# AI policy\n\nUsing AI is fine. We only ask that you test your change.\n', tier: allows, rules: allows },
  { kind: 'contributing', text: '# Contributing\n\nYou can use AI tools for anything here. Please keep pull requests focused on one issue.\n', tier: allows, rules: allows },
  { kind: 'agents', text: '# AGENTS.md\n\nAgents may open pull requests. Never commit API keys or credentials.\n', tier: invites, rules: invites },
  { kind: 'aiPolicy', text: '# AI policy\n\nAgents may open pull requests on their own. Do not open more than two pull requests at a time.\n', tier: invites, rules: invites },
  { kind: 'contributing', text: '# Contributing\n\nAI-assisted contributions are welcome. Do not open a pull request against the `release` branch.\n', tier: allows, rules: allows },
  { kind: 'aiPolicy', text: '# AI policy\n\nAI tools are welcome here. Do not use them to write commit messages without reading them.\n', tier: allows, rules: allows, personInLoop: true },
  { kind: 'aiPolicy', text: '# AI policy\n\nAI help is fine. Contributions are reviewed the same way, whoever or whatever wrote them.\n', tier: allows, rules: allows },
  { kind: 'contributing', text: '# Contributing\n\nUsing LLMs is fine. Please double-check anything they generate before you submit it.\n', tier: allows, rules: allows, personInLoop: true },
  { kind: 'aiPolicy', text: '# AI policy\n\nAgents may open pull requests on their own. Do not modify files under `vendor/`.\n', tier: invites, rules: invites },
  { kind: 'contributing', text: '# Contributing\n\nCoding agents are welcome. Please do not tag maintainers directly; we read every pull request.\n', tier: invites, rules: invites },
  { kind: 'aiPolicy', text: '# AI policy\n\nYou may use AI. Please do not paste output you have not read into issues.\n', tier: allows, rules: allows, personInLoop: true },
  { kind: 'contributing', text: '# Contributing\n\nWe welcome pull requests from coding agents. If an agent cannot run the tests, say so in the pull request.\n', tier: invites, rules: invites },
  { kind: 'contributing', text: '# Contributing\n\nCoding agents may open pull requests. Please do not open pull requests for issues someone else already claimed.\n', tier: invites, rules: invites },
  { kind: 'aiPolicy', text: '# AI policy\n\nAgents may only work on issues labeled `agent ready`.\n', tier: invites, rules: invites, only: ['agent ready'] },
  // The four the rules read as a ban.
  { kind: 'aiPolicy', text: '# AI policy\n\nAI assistance is welcome. Nothing changes about how we review pull requests.\n', tier: allows, rules: ban },
  { kind: 'aiPolicy', text: '# AI policy\n\nAI-assisted work is welcome. We will not ask how you wrote it.\n', tier: allows, rules: ban },
  // Since the forms became whole sentences: each is a form with words added.
  { kind: 'contributing', text: '# Contributing\n\nAgents may open pull requests here, and they do not need to sign anything first.\n', tier: invites, rules: ban },
  { kind: 'aiPolicy', text: '# AI policy\n\nAI help is welcome. We will not merge a PR that fails CI, whoever wrote it.\n', tier: allows, rules: ban },
];

/**
 * A held-out set: 12 made-up welcoming policies the third review wrote to
 * measure the false-ban rate, which no rule was written or changed to fit.
 * The 38 above were written alongside the rules, so their rate says little
 * about docs the rules have never seen. This set does. Keep its wordings
 * out of the reader's prompt, for the same reason.
 */
export const HELD_OUT: Welcoming[] = [
  { kind: 'aiPolicy', text: '# AI policy\n\nAI-assisted pull requests are welcome. Please keep them small, and do not bundle unrelated changes.\n', tier: allows, rules: ban },
  { kind: 'aiPolicy', text: "# AI policy\n\nAgents may open pull requests on their own. Don't open a PR for an issue that is still being discussed.\n", tier: invites, rules: ban },
  { kind: 'contributing', text: '# Contributing\n\n## AI\n\nUsing AI tools is fine. Never commit a `.env` file.\n', tier: allows, rules: ban },
  { kind: 'contributing', text: '# Contributing\n\nYou can use Copilot or Claude. We review AI-assisted code like any other code, no special rules.\n', tier: allows, rules: ban },
  { kind: 'aiPolicy', text: '# AI policy\n\nCoding agents are welcome to work on any issue. Please avoid reformatting files you did not change.\n', tier: invites, rules: ban },
  { kind: 'agents', text: '# AGENTS.md\n\nAgents may open pull requests. Do not run `npm publish`. Do not edit CHANGELOG.md by hand.\n', tier: invites, rules: invites },
  { kind: 'aiPolicy', text: '# AI policy\n\nWe welcome contributions made with AI. There is no limit on how much of a change an assistant wrote.\n', tier: allows, rules: ban },
  { kind: 'contributing', text: '# Contributing\n\nAI help is fine. If the tests fail, fix them before asking for review; we cannot merge red builds.\n', tier: allows, rules: ban },
  { kind: 'aiPolicy', text: '# AI policy\n\nAgents may open pull requests on their own. Only one pull request per issue, please.\n', tier: invites, rules: ban },
  { kind: 'contributing', text: '# Contributing\n\nAI-generated contributions are accepted. No need to label them.\n', tier: allows, rules: allows },
  { kind: 'aiPolicy', text: "# AI policy\n\nFeel free to use AI. Just don't paste secrets into a chatbot.\n", tier: allows, rules: ban },
  { kind: 'contributing', text: '# Contributing\n\nAgent pull requests are welcome. Please do not close issues yourself; a maintainer will.\n', tier: invites, rules: invites },
];

function toCase(group: 'welcoming' | 'heldOut', policy: Welcoming, index: number): PolicyCase {
  const expect: Expected = {
    tier: policy.tier,
    conditions: { noAutonomy: false, personInLoop: policy.personInLoop === true, personWritten: false },
    ...(policy.trailer === undefined ? {} : { trailer: policy.trailer }),
    ...(policy.only === undefined ? {} : { only: policy.only }),
  };
  return {
    id: `${group}/${String(index + 1).padStart(2, '0')}`,
    group,
    files: [file(policy.kind, policy.text)],
    expect,
    rules: policy.rules,
  };
}

export const WELCOMING_CASES: PolicyCase[] = WELCOMING.map((policy, index) => toCase('welcoming', policy, index));
export const HELD_OUT_CASES: PolicyCase[] = HELD_OUT.map((policy, index) => toCase('heldOut', policy, index));
