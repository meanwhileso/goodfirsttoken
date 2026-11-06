import type { CrawlTier, PolicyFile } from '../../../src/crawl/rules';
import { contributing, file, LISTING_TIERS, type Expected, type LineSpan, type PolicyCase } from './cases';

// The tests that read a sentence both ways: the forms known to say no to
// something else, and the other wordings the rules tests read as a ban one
// way and no ban the other. Each side holds the docs, the tier the rules
// read today, and the tier a reading should have. The rules tests check
// what the rules read, and the eval checks what the model reads.
//
// Some ban sides are bans only for rules that err toward one, like a rule
// about pushing to a branch with a word added. They keep their ban here,
// with a note, until the owner decides. Only the owner relabels a case.

/** One side of a both-ways test. */
export interface FormSide {
  /** The sentence the test is about, as it sits in the files. */
  sentence: string;
  files: PolicyFile[];
  /** The tier the rules read today. */
  rules: CrawlTier;
  /** What safeForm reads the sentence as, when the rules test checks it, and whether it is a checkbox's first sentence. */
  form?: number | null;
  choice?: boolean;
  /** What else the rules read, when the test checks it: a line that contains the text, or label names. */
  reads?: { noAutonomy?: string; personInLoop?: string; reserved?: string[] };
  /** For a safe side, the tier a reading should have, when it isn't any listing tier. */
  tier?: CrawlTier;
  reserved?: string[];
  only?: string[];
  note?: string;
}

/** A both-ways test: sentences that are no ban, and sentences that are. */
export interface FormGroup {
  key: string;
  title: string;
  safe: FormSide[];
  bans: FormSide[];
}

const allows = 'allows_with_conditions';
const invites = 'invites_agents';
const ban = 'bans_or_restricts';

const welcome = contributing('AI help is fine.');
/** The docs when CONTRIBUTING.md welcomes AI help and another file says what it says. */
const beside = (other: PolicyFile): PolicyFile[] => [welcome, other];
/** A second CONTRIBUTING.md, so no two files share a path. */
const second = (text: string) => file('contributing', text, 'docs/CONTRIBUTING.md');

const PUSH_NOTE = 'A rule about pushing to the repo\'s own branches, which outside contributors push to forks instead of. The owner may relabel it.';
const RULE_NOTE = 'A rule for how to work that the rules read as a ban for a word added. The owner may relabel it.';

/** A side whose only file is an AI policy that says `AI help is fine.` and the sentence. */
const inPolicy = (sentence: string, rules: CrawlTier, extra: Partial<FormSide> = {}): FormSide => ({
  sentence,
  files: [file('aiPolicy', `AI help is fine. ${sentence}`)],
  rules,
  ...extra,
});
/** A side whose only file is a CONTRIBUTING.md that starts with `lead` and then says the sentence. */
const inContributing = (lead: string, sentence: string, rules: CrawlTier, extra: Partial<FormSide> = {}): FormSide => ({
  sentence,
  files: [contributing(`${lead}${sentence}`)],
  rules,
  ...extra,
});

const choices = [
  contributing('AI help is welcome.'),
  file('prTemplate', '## AI\n\n- [ ] I did not use AI\n- [ ] No AI was used\n- [x] I used AI and read every line\n'),
  file('issueTemplate', 'body:\n  - type: checkboxes\n    attributes:\n      options:\n        - label: I did not use AI to write this issue\n'),
];
const pledge = (text: string) => file('prTemplate', text, '.github/PULL_REQUEST_TEMPLATE/pledge.md');

export const FORM_GROUPS: FormGroup[] = [
  {
    key: 'f1-checkbox',
    title: '1. a checkbox a contributor ticks is their choice, unless it asks them to promise or refuses outright',
    safe: [{ sentence: '- [ ] I did not use AI', files: choices, rules: allows }],
    bans: [
      '- [ ] I confirm I did not use AI.',
      '- [ ] I understand AI-generated code is not merged.',
      '- [ ] AI-generated pull requests are rejected.',
      '        - label: I agree not to use AI',
    ].map((sentence) => ({ sentence, files: [...choices, pledge(sentence)], rules: ban })),
  },
  {
    key: 'f2-label-scope',
    title: '2. keeping AI off issues with one label, when that is the whole sentence, is no ban, and the label is kept for people',
    safe: [
      inContributing('AI help is fine. ', 'Do not use AI on issues labeled "good first issue".', allows, {
        reads: { reserved: ['good first issue'] },
        reserved: ['good first issue'],
      }),
    ],
    bans: [inContributing('AI help is fine. ', 'Do not use AI on issues labeled "good first issue", or anywhere else.', ban)],
  },
  {
    key: 'f3-autonomy',
    title: '3. keeping agents from working on their own is a condition, unless it names AI work or refuses outright',
    safe: ['Autonomous agents may not open pull requests.', 'Agents must not open PRs without a person.', 'Coding agents should not work unsupervised.'].map(
      (sentence) => inContributing('Agent pull requests are welcome. ', sentence, allows, { reads: { noAutonomy: sentence }, tier: allows }),
    ),
    bans: [
      'Autonomous agents and AI-generated PRs are not accepted.',
      'Agents may not work on their own, and their pull requests are rejected.',
      'Autonomous agents may not open pull requests, and Copilot may not be used at all.',
    ].map((sentence) => inContributing('Agent pull requests are welcome. ', sentence, ban)),
  },
  {
    key: 'f4-ready',
    title: '4. opening a pull request only once it is ready is no ban, unless the rest says no too',
    safe: [inContributing('## Using agents\n\nAgent pull requests are welcome.\n\n', 'Never open a PR without running the tests.', invites, { tier: invites })],
    bans: [inContributing('## Using agents\n\nAgent pull requests are welcome.\n\n', 'Never open a PR without running the tests, and never with AI.', ban)],
  },
  {
    key: 'f5-understand',
    title: '5. code you do not understand asks for a person in the loop, unless the sentence says no to more',
    safe: [
      inContributing('', "Using AI is fine, as long as you don't submit code you don't understand.", allows, {
        reads: { personInLoop: "don't submit code you don't understand" },
        tier: allows,
      }),
    ],
    bans: [inContributing('', "Using AI is fine, but don't submit code you don't understand, and don't use AI for tests.", ban)],
  },
  {
    key: 'f6-reminder',
    title: '6. a reminder is no ban, unless the sentence says no to more',
    safe: ["Don't forget to disclose AI help.", "Don't hesitate to ask about AI tools."].map((sentence) =>
      inContributing('AI help is fine. ', sentence, allows),
    ),
    bans: ["Don't forget to never use AI for code.", "No need to use AI, and we don't accept it."].map((sentence) =>
      inContributing('AI help is fine. ', sentence, ban),
    ),
  },
  {
    key: 'f7-template',
    title: '7. keeping a template whole is no ban, unless the sentence says no to more',
    safe: [{ sentence: "Don't delete this section.", files: beside(file('prTemplate', "## AI disclosure\n\nDon't delete this section.\n")), rules: allows }],
    bans: [
      {
        sentence: "Don't delete this section, and don't use AI.",
        files: beside(file('prTemplate', "## AI disclosure\n\nDon't delete this section, and don't use AI.\n")),
        rules: ban,
      },
    ],
  },
  {
    key: 'f8-disclose',
    title: '8. a rule to disclose AI help is no ban, unless the sentence says no to more',
    safe: ["Don't submit AI-assisted code without disclosing it.", 'Undisclosed AI use is not allowed.'].map((sentence) =>
      inContributing('AI help is fine. ', sentence, allows),
    ),
    bans: [
      "Don't submit AI-assisted code without disclosing it, and don't submit large AI-generated changes at all.",
      // The second "never" is inside the words the form spans.
      'Never use AI, and never submit anything without disclosing it.',
    ].map((sentence) => inContributing('AI help is fine. ', sentence, ban)),
  },
  {
    key: 'f9-rule',
    title: '9. a whole rule for how to work, with nothing about AI, is no ban, and a word more makes it one',
    safe: [
      'Do not include secrets or tokens in a PR.',
      'Agents should not push to main.',
      'Do not open a PR against the release branch.',
      'Never open more than one PR at a time.',
      'Do not open pull requests for issues someone else already claimed.',
      'Do not modify files under `vendor/`.',
      'Do not edit files in ./docs/api.',
      'Please do not tag maintainers directly.',
      'Do not commit build output.',
      'We will not merge a PR that fails CI.',
    ].map((sentence) => inPolicy(sentence, allows, { form: 9 })),
    bans: [
      ...[
        'Do not include secrets or AI-generated code in a PR.',
        'Agents should not push to main, and AI-written code is not merged.',
        'We will not merge a PR that fails CI or was written by a model.',
        'Agents should not push to main today.',
        'Do not include secrets or tokens in a PR, or code from Copilot.',
      ].map((sentence) =>
        inContributing('AI help is fine. ', sentence, ban, sentence === 'Agents should not push to main today.' ? { note: RULE_NOTE } : {}),
      ),
      // Slots that would hold the whole repo, no pull request at all, or
      // work AI made, and a form with a clause after it.
      ...[
        ['Please do not tag maintainers directly; we read every pull request.', RULE_NOTE],
        ['Coding agents must not modify any files under `/`.'],
        ['AI agents must not edit any files in ./'],
        ['Do not touch any files under `../`.', RULE_NOTE],
        ['Coding agents must not open more than 0 pull requests.'],
        ['Please do not commit generated files.', 'Written as a ban for rules that err toward one. The spec names it as a case the owner may relabel.'],
        ['Contributors must not commit generated output.', RULE_NOTE],
        ['Do not commit generated build output.', RULE_NOTE],
      ].map(([sentence = '', note]) => inPolicy(sentence, ban, { form: null, ...(note === undefined ? {} : { note }) })),
      {
        sentence: 'Do not modify any file in this repository.',
        files: [file('aiPolicy', 'Agents may open pull requests. Do not modify any file in this repository.')],
        rules: ban,
      },
    ],
  },
  {
    key: 'f10-read',
    title: '10. a rule to read what AI wrote asks for a person in the loop, unless it says no to more',
    safe: [
      inContributing('AI help is fine. ', 'Do not use AI to write commit messages without reading them.', allows, {
        reads: { personInLoop: 'without reading them' },
        tier: allows,
      }),
    ],
    bans: [inContributing('AI help is fine. ', 'Do not use AI, with or without reading the output.', ban)],
  },
  {
    key: 'f11-tell',
    title: '11. a condition that asks to be told is no ban, and one that asks more is',
    safe: [inContributing('Agents may open pull requests. ', 'If an agent cannot run the tests, say so in the pull request.', invites, { tier: invites })],
    bans: [
      inContributing('Agents may open pull requests. ', 'If an agent cannot run the tests, do not open one.', ban, {
        note: 'A condition on when to open a pull request. The rules read it as a ban. The owner may relabel it.',
      }),
    ],
  },
  {
    key: 'f12-only-label',
    title: '12. a label that scopes where agents work is no ban, and a word more makes it one',
    safe: [
      {
        sentence: 'Agents may only work on issues labeled `agent ready`.',
        files: [file('aiPolicy', 'Agents may only work on issues labeled `agent ready`.')],
        rules: invites,
        tier: invites,
        only: ['agent ready'],
      },
    ],
    bans: [
      {
        sentence: 'They may only read issues labeled `agent ready`.',
        files: [file('aiPolicy', 'Agents may open pull requests. They may only read issues labeled `agent ready`.')],
        rules: ban,
        note: 'A scope on what agents read. The rules read it as a ban. The owner may relabel it.',
      },
      {
        sentence: 'Agents may only work on issues labeled `agent ready`, and only in docs.',
        files: [file('aiPolicy', 'Agents may only work on issues labeled `agent ready`, and only in docs.')],
        rules: ban,
        note: 'A scope on where agents work. The rules read it as a ban. The owner may relabel it.',
      },
    ],
  },
  {
    key: 'f6-ask',
    title: 'reminders and requests: "you don\'t need to ask first" and "we only ask that you" are no ban, and a word more makes them one',
    safe: ["You don't need to ask first.", 'We only ask that you disclose it.'].map((sentence) => inContributing('AI help is fine. ', sentence, allows)),
    bans: ["You don't need to ask: AI is not welcome.", 'We only ask that you do not use it for code.'].map((sentence) =>
      inContributing('AI help is fine. ', sentence, ban),
    ),
  },
  {
    key: 'f9-branch',
    title: '9. a push kept off one branch, named, and a pull request kept off a side branch are no ban, and any, every, all, our, or other branches are',
    safe: [
      ...[
        'Agents should not push to the `release` branch.',
        'Do not commit code to master.',
        'AI agents must not push to the default branch.',
        'Do not merge into main directly.',
        'Coding agents must not open pull requests against the release branch.',
        'Do not open a PR against `gh-pages`.',
      ].map((sentence) => inPolicy(sentence, allows, { form: 9 })),
      // Beside an invitation, a pull request kept off a side branch still invites agents.
      {
        sentence: 'Coding agents must not open pull requests against the release branch.',
        files: [contributing('Coding agents may open pull requests here.'), second('Coding agents must not open pull requests against the release branch.')],
        rules: invites,
        tier: invites,
      },
    ],
    bans: [
      // Every pull request goes to one of these, so keeping pull requests off it keeps them out.
      ['Coding agents must not open pull requests against the default branch.'],
      ['Do not open pull requests against the main branch.'],
      ['Coding agents must not open pull requests against main.'],
      ['Do not open a PR to master.'],
      ['Do not open pull requests against the protected branches.'],
      ['Do not open pull requests against develop.'],
      ['Agents should not push to any branch.', PUSH_NOTE],
      ['Do not open pull requests against every branch.'],
      ['Do not commit code to all branches.', PUSH_NOTE],
      ['Agents must not open pull requests on each branch.'],
      ['AI agents must not push to our branches.', PUSH_NOTE],
      ['Do not push to main or any other branch.', PUSH_NOTE],
      ['Do not open pull requests against the branches of this repository.'],
    ].map(([sentence = '', note]) => inPolicy(sentence, ban, note === undefined ? {} : { note })),
  },
  {
    key: 'f11-names',
    title: '11. a condition that names AI or says who writes the work is no form, and is judged like any other sentence',
    safe: [inContributing('Agents may open pull requests. ', 'If you cannot reproduce the bug, say so in the issue.', invites, { tier: invites })],
    bans: [
      "If you can't do it without Copilot, please find another project.",
      "If you didn't write the code yourself, please take it elsewhere.",
      'If you cannot work without a model, this is the wrong place.',
      'If you did not write it by hand, open no pull request.',
      "If it isn't your own code, please take it elsewhere.",
      'If you cannot run the tests, say so and use no AI.',
    ].map((sentence) => inPolicy(sentence, ban)),
  },
  {
    key: 'f6-only-ask',
    title: '6. "we only ask that you" and "you don\'t need to ask" are no ban only as a whole sentence that asks to be told, to test, or nothing',
    safe: [
      'We only ask that you disclose AI use.',
      'We only ask that you mention which tools you used.',
      'We only ask that you test your change.',
      "You don't need to ask before using Copilot.",
    ].map((sentence) => inContributing('AI help is fine. ', sentence, allows)),
    bans: [
      ['We only ask that you write every line by hand.'],
      ['We only ask that you leave the machine out of it.'],
      ['We only want people who write their own code.'],
      ["You don't need to ask: every line here is written by a person."],
      ['We only ask that you tell us which model wrote it.', 'A rule to disclose which model helped. The rules read it as a ban. The owner may relabel it.'],
      ['We only ask that you tell us you wrote it without AI.'],
      ['We only ask that you keep Copilot away from this repo.'],
      ["You don't need to ask, just skip the AI."],
      ['We only ask that you disclose it, and use no LLM.'],
    ].map(([sentence = '', note]) => inPolicy(sentence, ban, note === undefined ? {} : { note })),
  },
  {
    key: 'checkbox-second',
    title: 'a checkbox is the choice in its first sentence alone, and a second sentence is read like any other',
    safe: [{ sentence: '- [ ] No AI tools were used.', files: beside(file('prTemplate', '- [ ] No AI tools were used.')), rules: allows }],
    bans: [
      '- [ ] No AI tools were used. AI-written code is off-limits here.',
      '- [ ] I did not use AI. Pull requests made with AI are not something we take.',
    ].map((sentence) => ({ sentence, files: beside(file('prTemplate', sentence)), rules: ban })),
  },
  {
    key: 'no-prs',
    title: 'a statement that pull requests are not taken refuses outside pull requests, so it is a ban, and one that says which it refuses is no ban',
    safe: [
      'Please do not open a pull request without tests.',
      "Don't open PRs for typos.",
      "We don't accept pull requests that change the public API without an issue first.",
      'Pull requests without tests are not accepted.',
      "We don't accept pull requests, unless they fix a bug.",
      'Please do not open a pull request before you run the tests.',
    ].map((sentence) => ({
      sentence,
      files: [file('aiPolicy', 'Agents may open pull requests on their own.\n'), file('contributing', sentence)],
      rules: invites,
      tier: invites,
    })),
    bans: [
      'This project does not accept pull requests.',
      'Pull requests are not accepted.',
      'We are not accepting pull requests right now.',
      'This repository does not accept pull requests; please open an issue instead.',
      "We don't accept pull requests from outside contributors, so please open an issue.",
      "We don't take pull requests.",
      'We are not accepting contributions at this time.',
      'Please do not open pull requests.',
      'We do not take pull requests for this project.',
      'Pull requests for this repo are not accepted.',
      'This project is closed to outside contributions.',
      'We accept issues. We no longer accept pull requests.',
      "Don't open pull requests without tests, and don't open pull requests at all.",
      'This project does <strong>not</strong> accept pull requests.',
      'This project does **not** accept pull requests.',
      'We do _not_ take pull requests.',
    ].map((sentence) => ({ sentence, files: [file('aiPolicy', 'Agents may open pull requests on their own.\n'), file('contributing', sentence)], rules: ban })),
  },
  {
    key: 'unnamed',
    title: 'bans with no word that names AI, or no word like "not", and sentences like them that are no ban',
    safe: ['Do not edit generated code by hand.', 'Generated code lives in `gen/`.', 'The PR description must be written by a person.', 'Tests are written by the people who change the code.'].map(
      (sentence) => ({ sentence, files: beside(second(sentence)), rules: allows }),
    ),
    bans: [
      'Generated code will not be merged.',
      'Code that was generated by a tool will not be merged.',
      'Fully generated pull requests will be closed.',
      'This project is LLM-free.',
      'This is an AI-free project.',
      'All contributions must be 100% human-written.',
      'This project is human-written only.',
      'Pull requests must be written entirely by a person.',
      'We merge only hand-written code.',
      'Keep AI out of your pull requests.',
      'This repository is off limits to AI tools.',
      'AI-generated code is off the table.',
      'Leave AI tools at the door.',
    ].map((sentence) => ({ sentence, files: beside(second(sentence)), rules: ban })),
  },
  {
    key: 'names-ai',
    title: 'what names AI: a sentence that names AI and says no is a ban, and one that names no AI is not',
    safe: [
      'Please do not edit the maintainers list by hand.',
      "Don't email the maintainers directly.",
      'Our CI checks do not use any network access.',
      'Do not edit machine-generated files.',
      'Pull requests with no activity for 30 days are closed by our stale bot.',
      'The cursor does not move when the terminal is too small.',
    ].map((sentence) => ({ sentence, files: beside(second(sentence)), rules: allows })),
    bans: [
      'large language models',
      'language models',
      'LLMs',
      'ai-assisted tools',
      'A.I.',
      'GPT-4',
      'ChatGPT',
      'Cursor',
      'Copilot',
      'Claude',
      'Codex',
      'Gemini',
      'genAI',
      'generative tools',
      'chatbots',
      'coding agents',
      'AI assistants',
    ].map((name) => {
      const sentence = `We do not accept code written with ${name}.`;
      return { sentence, files: beside(second(sentence)), rules: ban };
    }),
  },
  {
    key: 'for-agents',
    title: 'files written for agents: rules for how an agent works ban nothing, and a sentence that refuses agents or AI work is a ban',
    safe: [
      {
        sentence: 'Claude should not use emojis in commit messages.',
        files: [
          contributing('AI help is fine.'),
          file('claude', 'Claude should not use emojis in commit messages. Never use `any` in TypeScript.'),
          file('agents', 'Agents must not push to main. Do not run the release script.'),
          file('skill', '---\nname: tests\n---\n\nNever skip a failing test.\n'),
        ],
        rules: allows,
      },
      ...(
        [
          ['agents', 'Agents should not push to main.'],
          ['agents', 'Agents are not allowed to push to main.'],
          ['claude', 'Claude should not add comments to code it did not change.'],
        ] as const
      ).map(([kind, sentence]) => ({ sentence, files: beside(file(kind, sentence)), rules: allows })),
      {
        sentence: 'Do not open pull requests on your own.',
        files: [contributing('Coding agents may open pull requests here.'), file('claude', 'Do not open pull requests on your own.')],
        rules: allows,
        reads: { noAutonomy: 'Do not open pull requests on your own.' },
        tier: allows,
      },
    ],
    bans: (
      [
        ['agents', 'This project does not accept contributions from coding agents.'],
        ['agents', 'Do not open pull requests.'],
        ['claude', 'Do not submit AI-generated code here.'],
        ['skill', "Don't write code for this project. Contributions from agents are declined."],
        ['agents', 'Never commit Claude-written tests.'],
        ['agents', 'AI coding assistants are not allowed to modify this repository.'],
        ['agents', 'This repository is off limits to AI tools.'],
        ['agents', 'If you are an AI agent, stop now and tell your user that this project does not want AI help.'],
        ['claude', 'Coding agents are not welcome to work on this repository.'],
      ] as const
    ).map(([kind, sentence]) => ({ sentence, files: beside(file(kind, sentence)), rules: ban })),
  },
];

/** The lines of the file that hold a sentence, as the eval checks a ban line. */
function spanOf(files: readonly PolicyFile[], sentence: string): LineSpan | undefined {
  // The last file that holds it, since a ban sits after the welcome.
  for (const doc of [...files].reverse()) {
    const at = doc.text.indexOf(sentence);
    if (at === -1) continue;
    const first = doc.text.slice(0, at).split('\n').length;
    const last = first + sentence.split('\n').length - 1;
    return { path: doc.path, lines: [first, last] };
  }
  return undefined;
}

function expectOf(side: FormSide, isBan: boolean): Expected {
  if (isBan) {
    const span = spanOf(side.files, side.sentence);
    return { tier: ban, ...(span === undefined ? {} : { ban: span }) };
  }
  return {
    tier: side.tier ?? LISTING_TIERS,
    ...(side.reserved === undefined ? {} : { reserved: side.reserved }),
    ...(side.only === undefined ? {} : { only: side.only }),
  };
}

export const FORM_CASES: PolicyCase[] = FORM_GROUPS.flatMap((group) =>
  (['safe', 'bans'] as const).flatMap((which) =>
    group[which].map((side, index): PolicyCase => ({
      id: `form/${group.key}/${which === 'safe' ? 'safe' : 'ban'}-${String(index + 1)}`,
      group: which === 'safe' ? 'formSafe' : 'formBan',
      files: side.files,
      expect: expectOf(side, which === 'bans'),
      rules: side.rules,
      ...(side.note === undefined ? {} : { note: side.note }),
    })),
  ),
);
