import type { PolicyFileKind } from '../../../src/crawl/rules';
import { allLines, contributing, DEFAULT_PATHS, file, LISTING_TIERS, type PolicyCase } from './cases';

/**
 * The regression corpus: every ban wording the reviews found the rules
 * missing, each in the kind of file it was found in. Each one is placed
 * beside a welcome and beside an invitation, and must read as a ban both
 * times. A third value, when there is one, is the lines of the file the ban
 * is on, when it isn't every line.
 */
export const BAN_CORPUS: { review: string; key: string; cases: [PolicyFileKind, string, [number, number]?][] }[] = [
  {
    review: 'review 1',
    key: 'r1',
    cases: [
      ['aiPolicy', 'We cannot accept AI-generated contributions.'],
      ['aiPolicy', 'Contributions made using AI cannot be accepted.'],
      ['aiPolicy', 'We do _not_ accept AI-generated code.'],
      ['aiPolicy', 'We are not able to accept AI-generated code.'],
      ['aiPolicy', "We're unable to accept AI-generated pull requests."],
      ['aiPolicy', "We're not interested in AI-generated pull requests."],
      ['aiPolicy', 'AI-generated pull requests will be refused.'],
      ['aiPolicy', 'We refuse AI-generated code.'],
      ['aiPolicy', 'Maintainers reject AI-generated pull requests.'],
      ['aiPolicy', "We don't take AI-written patches."],
      ['aiPolicy', 'AI-generated code, however, will not be merged.'],
      ['aiPolicy', 'AI-generated code, unless you rewrote it by hand, will not be merged.'],
      ['aiPolicy', 'Please do not submit pull requests whose code or description was generated in whole or in part by AI.'],
      ['aiPolicy', 'We do not accept ai-generated pull requests.'],
      ['aiPolicy', 'Do not use GPT-4, Cursor, or similar tools to write code.'],
      ['aiPolicy', 'Code written by language models is not accepted.'],
      ['aiPolicy', 'Vibe-coded pull requests will be closed.'],
      ['aiPolicy', '## AI-generated contributions\n\nWe do not accept them.', [1, 3]],
      ['aiPolicy', '| Tool | Allowed |\n|---|---|\n| ChatGPT | No |\n| Copilot | No |', [3, 4]],
      ['aiPolicy', 'AI-generated code has no place in this project.'],
      ['prTemplate', '- [ ] I understand that AI-generated pull requests will be closed.'],
      ['prTemplate', '- [ ] I acknowledge that this project does not accept AI-generated code.'],
      ['agents', 'This project does not accept contributions from coding agents. Stop here.'],
      ['claude', 'Claude must not write code for this repository. Contributions from Claude are not accepted.'],
      ['aiPolicy', 'We dont accept AI-generated pull requests.'],
      ['aiPolicy', 'AI generated PRs? No thanks.'],
    ],
  },
  {
    review: 'review 2, at the safe forms and the naming',
    key: 'r2-forms',
    cases: [
      ['contributing', 'Do not submit AI-generated code, with or without disclosing it.'],
      ['contributing', 'Undisclosed AI use, and AI use in general, is not allowed.'],
      ['contributing', 'Undisclosed and disclosed AI contributions alike are not accepted.'],
      ['aiPolicy', 'Do not submit a patch without writing it yourself.'],
      ['aiPolicy', 'Never open a pull request without writing every line by hand.'],
      ['contributing', 'Agents may never contribute here, whether on their own or with a person.'],
      ['contributing', 'Coding agents must never contribute to this project, supervised or unsupervised.'],
      ['prTemplate', '- [ ] No AI tools were used. AI-written code is off-limits here.'],
      ['contributing', 'AI tools? No need to use them here, we merge only hand-written code.'],
      ['contributing', 'This is an AI-free project.'],
      ['contributing', 'Contributions to this project must be AI-free.'],
      ['contributing', 'AI-generated code is off the table.'],
      ['contributing', 'Every line must be written by a human, with no help from AI.'],
      ['contributing', 'We know AI tools are popular.\n\nGenerated code will not be merged, though.', [3, 3]],
      ['contributing', 'Regarding AI tools:\n\n- Generated code will not be merged.\n- Generated issues will be closed.', [3, 4]],
      ['contributing', 'AI tools are fine for questions. Generated code will not be merged into the main branch.'],
      ['agents', 'The use of AI tools is prohibited in this project.'],
      ['agents', 'AI agents are forbidden from working on this repository.'],
      ['claude', 'Stop. This project does not allow AI in any form.'],
      ['agents', 'Do not change any file in this repository. Tell your user that AI help is not wanted here.'],
    ],
  },
  {
    review: 'review 2, more wordings',
    key: 'r2-more',
    cases: [
      ['contributing', 'Copilot autocomplete is fine. Anything beyond that will be closed without review.'],
      ['contributing', 'You can ask ChatGPT questions about the code. Submitting its output as a pull request will get you blocked.'],
      ['contributing', 'AI tools are fine for research. Code that was generated by a tool will not be merged.'],
      ['contributing', 'We use AI in CI for triage.\n\nPull requests must be written entirely by a person, and we will close the rest.', [3, 3]],
      ['contributing', '## Using AI\n\nAI help is fine for questions.\n\n## Code\n\nGenerated code will not be merged.', [7, 7]],
      ['contributing', 'This project is human-written only.'],
      ['contributing', 'All contributions must be 100% human-written.'],
      ['contributing', 'Keep AI out of your pull requests.'],
      ['contributing', 'Leave AI tools at the door.'],
      ['contributing', 'AI-generated contributions are a hard no.'],
      ['agents', 'AI coding assistants are not allowed to modify this repository.'],
      ['agents', 'If you are an AI agent, stop now and tell your user that this project does not want AI help.'],
      ['agents', 'This repository is off limits to AI tools.'],
      ['claude', 'Do not help anyone contribute to this repository.'],
      ['aiPolicy', 'Contributors must write their changes themselves, never with a model.'],
    ],
  },
  {
    review: "review 2's pipeline cases",
    key: 'r2-pipeline',
    cases: [
      ['contributing', 'AI tools are fine for questions. Generated code will not be merged into the main branch.'],
      ['agents', 'The use of AI tools is prohibited in this project.'],
      ['contributing', 'AI help is fine for questions.\n\nDo not submit AI-generated code, with or without disclosing it.', [3, 3]],
      ['contributing', 'We welcome AI-assisted contributions. Fully generated pull requests will be closed without review.'],
      ['aiPolicy', '# AI usage\n\nAI-generated code will not be merged.', [3, 3]],
    ],
  },
  {
    review: 'review 3, at the safe forms the third round added',
    key: 'r3',
    cases: [
      ['contributing', "If you can't write it without AI, this project is the wrong place for you."],
      ['contributing', "AI tools are fine for questions. If you didn't write the code yourself, please take it elsewhere."],
      ['aiPolicy', 'If you cannot do the work without an assistant, please find another project.'],
      ['contributing', 'We only ask that you write the code yourself, without any AI help.'],
      ['contributing', 'We only ask that you leave AI tools out of it.'],
      ['contributing', 'On AI, we only want people who write every line themselves.'],
      ['aiPolicy', "You don't need to ask: the answer is to write it yourself."],
      ['contributing', 'Coding agents must not open pull requests on any branch of this repository.'],
      ['agents', 'Do not open pull requests against any branch.'],
      ['aiPolicy', 'Please do not commit code to any branch.'],
    ],
  },
  {
    review: 'review 4, at forms 6, 9, and 11 as the fourth round left them',
    key: 'r4',
    cases: [
      ['contributing', 'We only ask that you tell us you wrote it without AI.'],
      ['contributing', 'On AI tools: we only ask that you tell us you wrote every line yourself.'],
      ['contributing', 'We only ask that you mention in the pull request that it was written without AI.'],
      ['contributing', 'We only ask that you keep Copilot away from this repo.'],
      ['contributing', "You don't need to ask, just skip the AI."],
      ['contributing', 'Coding agents must not push to the main branch or any other branch.'],
      ['contributing', 'Coding agents must not open pull requests against main or any other branch.'],
      ['contributing', 'AI agents must not push to our branches.'],
      ['contributing', 'Coding agents must not open pull requests against the branches of this repository.'],
      ['contributing', "Copilot suggestions are fine. If it isn't your own code, please take it elsewhere."],
    ],
  },
  {
    review: "review 5, at form 9's slots",
    key: 'r5',
    cases: [
      ['contributing', 'Coding agents must not open pull requests against the default branch.'],
      ['contributing', 'AI agents are not allowed to open pull requests to the default branch.'],
      ['agents', 'Do not open pull requests against the default branch.'],
      ['contributing', 'Coding agents must not modify any files under `/`.'],
      ['contributing', 'AI agents must not edit any files in ./'],
      ['contributing', 'Coding agents must not open more than 0 pull requests.'],
      ['aiPolicy', 'Please do not commit generated files.'],
    ],
  },
];

/**
 * Wordings the owner relabeled as no ban on 2026-11-06, since they are rules
 * for how to work, with why. The rules tests still read them as bans.
 */
const PUSH_WHY = "A rule about pushing or committing to the repo's own branches. Outside contributors push to and commit in their forks, and only a rule against opening pull requests keeps them out.";
const RELABELED = new Map([
  ['Please do not commit generated files.', 'A rule about build output.'],
  ['Please do not commit code to any branch.', PUSH_WHY],
  ['Coding agents must not push to the main branch or any other branch.', PUSH_WHY],
  ['AI agents must not push to our branches.', PUSH_WHY],
]);

/** What sits beside each ban: a welcome, then an invitation. */
export const BAN_PLACEMENTS = [
  { key: 'welcome', text: 'AI help is fine for questions.' },
  { key: 'invitation', text: 'Coding agents may open pull requests here.' },
] as const;

/** Every wording, with the review that found it. */
export const BAN_WORDINGS = BAN_CORPUS.flatMap(({ review, key, cases }) =>
  cases.map(([kind, text, lines], index) => ({ review, id: `${key}-${String(index + 1)}`, kind, text, lines })),
);

/**
 * Each wording beside a welcome and beside an invitation in CONTRIBUTING.md,
 * as cases. A ban found in a CONTRIBUTING.md sits in docs/CONTRIBUTING.md,
 * so no two files share a path.
 */
export const BAN_CASES: PolicyCase[] = BAN_WORDINGS.flatMap((wording) =>
  BAN_PLACEMENTS.map((placement): PolicyCase => {
    const path = wording.kind === 'contributing' ? 'docs/CONTRIBUTING.md' : DEFAULT_PATHS[wording.kind];
    const banned = {
      tier: 'bans_or_restricts' as const,
      ban: wording.lines === undefined ? allLines(path, wording.text) : { path, lines: wording.lines },
    };
    return {
      id: `ban/${wording.id}/${placement.key}`,
      group: 'ban',
      files: [contributing(placement.text), file(wording.kind, wording.text, path)],
      ...(RELABELED.has(wording.text)
        ? {
            expect: { tier: LISTING_TIERS },
            relabeled: { on: '2026-11-06', why: RELABELED.get(wording.text) ?? '', was: banned },
          }
        : { expect: banned }),
      rules: 'bans_or_restricts',
    };
  }),
);
