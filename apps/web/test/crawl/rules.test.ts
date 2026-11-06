import { describe, expect, test } from 'vitest';
import { readPolicy, safeForm, sentencesOf, suggestSettings, type PolicyFile } from '../../src/crawl/rules';
import { MAX_DOC_BYTES } from '../../src/projects/docs';
import { BAN_CASES, BAN_WORDINGS } from './corpus/bans';
import { contributing, file, LISTING_TIERS } from './corpus/cases';
import { FORM_GROUPS } from './corpus/forms';
import { SETTINGS_CASES } from './corpus/settings';
import { HELD_OUT_CASES, WELCOMING_CASES } from './corpus/welcoming';

// The policy crawler's rules, called directly on made-up files. Every line of
// policy text here is made up, and says nothing about a real project. The
// corpus the rules and the model reader's eval share is in corpus/, and the
// tests here hold the rules to what they read today.

const welcome = contributing('AI help is fine.');
/** The tier of the docs when CONTRIBUTING.md welcomes AI help and `other` says what it says. */
const tierWith = (other: PolicyFile) => readPolicy([welcome, other]).tier;

describe('the regression corpus of ban wordings', () => {
  test('holds every wording the reviews found, 93 in all, each beside a welcome and beside an invitation', () => {
    expect(BAN_WORDINGS).toHaveLength(93);
    expect(BAN_CASES).toHaveLength(186);
  });

  test('has no sentence that says no and is one of the forms known to say no to something else', () => {
    // Every form is a whole sentence with closed slots, so a ban is safe
    // only if all of one of its sentences is a form. One sentence is: a
    // checkbox that says no AI was used, whose ban is the sentence after it.
    const forms = BAN_WORDINGS.flatMap(({ text }) => sentencesOf(text).map((sentence) => [sentence.text, safeForm(sentence.text, sentence.choice)] as const));
    expect(forms.length).toBeGreaterThan(BAN_WORDINGS.length);
    expect(forms.filter(([, form]) => form !== null)).toEqual([['- [ ] No AI tools were used.', 1]]);
    expect(tierWith(file('prTemplate', '- [ ] No AI tools were used.'))).toBe('allows_with_conditions');
    expect(tierWith(file('prTemplate', 'AI-written code is off-limits here.'))).toBe('bans_or_restricts');
  });

  test("has each form's own example read as that form, so the check above can find one", () => {
    const examples: [string, number, boolean?][] = [
      ['- [ ] I did not use AI', 1, true],
      ['Do not use AI on issues labeled "good first issue".', 2],
      ['Agents must not open PRs without a person.', 3],
      ['Never open a PR without running the tests.', 4],
      ["Don't submit code you don't understand.", 5],
      ['We only ask that you disclose it.', 6],
      ["Don't delete this section.", 7],
      ["Don't submit AI-assisted code without disclosing it.", 8],
      ['Agents should not push to main.', 9],
      ['Do not use AI to write commit messages without reading them.', 10],
      ['If an agent cannot run the tests, say so in the pull request.', 11],
      ['Agents may only work on issues labeled `agent ready`.', 12],
    ];
    expect(examples.map(([text, , choice]) => safeForm(text, choice))).toEqual(examples.map(([, form]) => form));
  });

  test('reads a form inside an HTML comment as that form, whichever way the comment closes', () => {
    expect(safeForm("<!-- Don't delete this section. -->")).toBe(7);
    expect(safeForm("<!-- Don't delete this section. --!>")).toBe(7);
    expect(safeForm("<!-- Don't delete this section, and don't use AI. --!>")).toBeNull();
  });

  test.each(BAN_CASES.map((c) => [c.id, c] as const))('%s is a ban', (_id, c) => {
    const reading = readPolicy(c.files);

    expect(reading.tier).toBe('bans_or_restricts');
    expect(reading.welcome).toBeNull();
  });
});

describe('the held-out welcoming policies', () => {
  // A measurement, with no rule behind it. It records what the rules read
  // today, so a change to the rate shows here. 9 of 12 read as a ban, up
  // from 8 before the forms became whole sentences: three in four. In seven,
  // a rule for how to work takes its AI naming from somewhere else: five
  // from their AI policy file and its heading, two of them from the
  // sentence before it too, one from a heading, and one from the sentence
  // before it alone. Two name AI themselves and say no to something else.
  test('the rules read 9 of the 12 as a ban', () => {
    const tiers = HELD_OUT_CASES.map((c) => readPolicy(c.files).tier);

    expect(tiers.filter((tier) => tier === 'bans_or_restricts')).toHaveLength(9);
    expect(tiers).toEqual([
      'bans_or_restricts',
      'bans_or_restricts',
      'bans_or_restricts',
      'bans_or_restricts',
      'bans_or_restricts',
      'invites_agents',
      'bans_or_restricts',
      'bans_or_restricts',
      'bans_or_restricts',
      'allows_with_conditions',
      'bans_or_restricts',
      'invites_agents',
    ]);
    expect(tiers).toEqual(HELD_OUT_CASES.map((c) => c.rules));
  });

  test('each should read as a welcome', () => {
    expect(HELD_OUT_CASES).toHaveLength(12);
    for (const c of HELD_OUT_CASES) expect(LISTING_TIERS, c.id).toContain(c.expect.tier);
  });
});

describe('the welcoming corpus', () => {
  test('has 38 policies written alongside the rules, and the rules read 4 of them as a ban', () => {
    expect(WELCOMING_CASES).toHaveLength(38);
    expect(WELCOMING_CASES.filter((c) => c.rules === 'bans_or_restricts')).toHaveLength(4);
    for (const c of WELCOMING_CASES) expect(LISTING_TIERS, c.id).toContain(c.expect.tier);
  });

  test.each(WELCOMING_CASES.map((c) => [c.id, c.rules, c] as const))('%s reads as %s, as the rules read it today', (_id, tier, c) => {
    expect(readPolicy(c.files).tier).toBe(tier);
  });
});

describe('a ban, with a welcome elsewhere, is a ban', () => {
  // The same review's cases, as it wrote them.
  test.each([
    'We cannot accept AI-generated contributions.',
    'AI-generated pull requests will be refused.',
    "We're not interested in AI-generated pull requests.",
    'We do _not_ accept AI-generated code.',
    'AI-generated code, however, will not be merged.',
    'Please do not submit pull requests whose code or description was generated in whole or in part by AI.',
    'Maintainers reject AI-generated pull requests.',
    "We don't take AI-written patches.",
    '## AI-generated contributions\n\nWe do not accept them.',
    'Code written by language models is not accepted.',
  ])('an AI policy file that says %j', (text) => {
    expect(tierWith(file('aiPolicy', text))).toBe('bans_or_restricts');
  });

  test('a PR template checkbox that acknowledges the ban', () => {
    expect(tierWith(file('prTemplate', '- [ ] I understand that AI-generated pull requests will be closed.\n'))).toBe('bans_or_restricts');
  });

  test("an AGENTS.md that refuses agents' contributions", () => {
    expect(tierWith(file('agents', 'This project does not accept contributions from coding agents.\n'))).toBe('bans_or_restricts');
  });

  test.each([
    'We do not accept AI-generated pull requests.',
    'AI-generated code is not accepted.',
    "Please don't use AI to write your change.",
    'Pull requests made with LLMs will be closed.',
    'No AI-generated contributions.',
    'Contributions written with ChatGPT or Copilot are prohibited.',
    'Code must not be AI-generated.',
    'AI tools must not be used to write code here.',
    'This pull request must not contain AI-generated code.',
    'We will not merge pull requests from coding agents.',
    'Agents are not welcome here.',
    'AI help is fine for questions, but AI-written code is not allowed.',
    'Autonomous agents and AI-generated PRs are not accepted.',
    'Please refrain from using AI tools.',
    'Please avoid AI-generated code.',
    'This project has a no-AI policy.',
    'Submitting AI-generated code will result in a ban.',
    'We reserve the right to close any PR made with AI.',
    "I don't accept AI-generated pull requests.",
    '- [ ] I confirm this pull request has no AI-generated code.',
    'We only accept code a person wrote, and no AI output.',
    'Use of generative tools is restricted to the docs.',
    'Pull requests from AI agents are welcome, except here, where they are closed.',
  ])('a PR template that says %j', (sentence) => {
    const reading = readPolicy([contributing('AI help is fine. Agent pull requests are welcome.'), file('prTemplate', sentence)]);

    expect(reading.tier).toBe('bans_or_restricts');
    expect(reading.welcome).toBeNull();
  });

  test.each([
    'Code must not be written by agents.',
    'Pull requests must not be generated by coding agents.',
    'Contributions must not be made with Claude, Codex, or Gemini.',
  ])('a CONTRIBUTING.md that says %j, with a welcome in the AI policy', (text) => {
    const reading = readPolicy([file('aiPolicy', 'AI help is fine for questions.\n'), file('contributing', text)]);

    expect(reading.tier).toBe('bans_or_restricts');
  });

  test.each([
    'We do **not** accept AI-generated code.',
    'We do <strong>not</strong> accept AI-generated code.',
    'We do <em>not</em> accept <b>AI</b>-generated code.',
    'We do not accept __AI__-generated code.',
    'We ~~do~~ do not accept AI-generated code.',
    'We don’t accept AI‑generated code.',
  ])('emphasis, strike marks, and curly quotes hide nothing: %j', (text) => {
    expect(tierWith(file('contributing', text))).toBe('bans_or_restricts');
  });

  test('a ban wrapped over two lines is still a ban', () => {
    const reading = readPolicy([contributing('AI help\nis fine.\n\nWe do not accept pull requests that were\ngenerated by AI tools.')]);

    expect(reading.tier).toBe('bans_or_restricts');
  });

  test('a ban in an issue template counts, like one anywhere else', () => {
    expect(tierWith(file('issueTemplate', '---\nname: Bug\n---\n\nIssues written by AI will be closed.\n'))).toBe('bans_or_restricts');
  });

  test('the ban keeps its line, as the file has it', () => {
    const reading = readPolicy([welcome, file('aiPolicy', '# AI\n\nAI help is fine for questions.\nWe **do not** accept AI-generated code.\n')]);

    expect(reading.ban).toMatchObject({ file: { path: 'AI_POLICY.md' }, line: 'We **do not** accept AI-generated code.' });
  });
});

describe('the tests that read a sentence both ways', () => {
  test('each has a side that is no ban and a side that is, by the rules today', () => {
    for (const group of FORM_GROUPS) {
      expect(group.safe.length, group.key).toBeGreaterThan(0);
      expect(group.bans.length, group.key).toBeGreaterThan(0);
      for (const side of group.safe) expect(side.rules, side.sentence).not.toBe('bans_or_restricts');
      for (const side of group.bans) expect(side.rules, side.sentence).toBe('bans_or_restricts');
    }
  });

  test.each(FORM_GROUPS.map((group) => [group.title, group] as const))('%s', (_title, group) => {
    for (const side of [...group.safe, ...group.bans]) {
      const reading = readPolicy(side.files);

      expect(reading.tier, side.sentence).toBe(side.rules);
      if (side.form !== undefined) expect(safeForm(side.sentence, side.choice), side.sentence).toBe(side.form);
      if (side.reads?.noAutonomy !== undefined) expect(reading.noAutonomy?.line, side.sentence).toContain(side.reads.noAutonomy);
      if (side.reads?.personInLoop !== undefined) expect(reading.personInLoop?.line, side.sentence).toContain(side.reads.personInLoop);
      if (side.reads?.reserved !== undefined) expect(reading.reserved.map((r) => r.name), side.sentence).toEqual(side.reads.reserved);
      if (side.rules === 'bans_or_restricts') expect(reading.welcome, side.sentence).toBeNull();
    }
  });

  test('a CLAUDE.md that tells agents not to open pull requests on their own keeps them from working on their own, with its line', () => {
    const reading = readPolicy([contributing('Coding agents may open pull requests here.'), file('claude', 'Do not open pull requests on your own.')]);

    expect(reading.tier).toBe('allows_with_conditions');
    expect(reading.noAutonomy).toMatchObject({ file: { path: 'CLAUDE.md' }, line: 'Do not open pull requests on your own.' });
  });

  test('a sentence that names AI and says no to anything is a ban, even when it says no to something else, since a missed ban costs more', () => {
    expect(tierWith(file('contributing', 'AI tools help you avoid typos.', 'docs/CONTRIBUTING.md'))).toBe('bans_or_restricts');
    expect(tierWith(file('contributing', 'Cursor keys do not work in the TUI.', 'docs/CONTRIBUTING.md'))).toBe('bans_or_restricts');
  });
});

describe('what a sentence inherits', () => {
  test('a sentence under a heading that names AI names AI, and a heading of the same level or higher ends that', () => {
    const under = contributing('## AI\n\nAI help is fine.\n\n### Code\n\nWe will not merge it.');
    const after = contributing('## AI\n\nAI help is fine.\n\n## Releases\n\nDo not tag releases by hand.');

    expect(readPolicy([under]).tier).toBe('bans_or_restricts');
    expect(readPolicy([after]).tier).toBe('allows_with_conditions');
  });

  test('a short answer, or a sentence that points back with a pronoun, after one that names AI in its paragraph names AI', () => {
    expect(readPolicy([contributing('AI help is fine. AI-generated code? No.')]).tier).toBe('bans_or_restricts');
    expect(readPolicy([contributing('AI help is fine for questions. We will not merge it in code.')]).tier).toBe('bans_or_restricts');
    expect(readPolicy([contributing('AI help is fine.\n\nWe will not merge a PR that fails CI.')]).tier).toBe('allows_with_conditions');
    expect(readPolicy([contributing('AI help is fine. We will not merge a PR that fails CI.')]).tier).toBe('allows_with_conditions');
  });

  test('every sentence of an AI policy file is about AI', () => {
    expect(tierWith(file('aiPolicy', '# Policy\n\nWe will not merge it.'))).toBe('bans_or_restricts');
    expect(tierWith(file('contributing', '# Contributing\n\nWe will not merge it.'))).toBe('allows_with_conditions');
  });

  test('a sentence inherits from any sentence before it in its paragraph that names AI, when it is short or points back with a pronoun', () => {
    expect(readPolicy([contributing('AI help is fine. Run the whole test suite first. We will close it otherwise.')]).tier).toBe(
      'bans_or_restricts',
    );
    expect(readPolicy([contributing('Copilot autocomplete is fine. Anything beyond that will be closed.')]).tier).toBe('bans_or_restricts');
    expect(readPolicy([contributing('You can ask ChatGPT about the code. Its output will be closed as a pull request.')]).tier).toBe(
      'bans_or_restricts',
    );
    expect(readPolicy([contributing('AI help is fine. Run the tests. Old branches will be closed after a year.')]).tier).toBe(
      'allows_with_conditions',
    );
  });

  test('a lead-in that names AI and ends with a colon carries to the list after it, and the list ends it', () => {
    expect(readPolicy([contributing('AI help is fine.\n\nAbout AI assistants:\n\n- Their pull requests will be closed on sight.')]).tier).toBe(
      'bans_or_restricts',
    );
    expect(readPolicy([contributing('AI help is fine.\n\nAbout the release process:\n\n- Their pull requests will be closed on sight.')]).tier).toBe(
      'allows_with_conditions',
    );
    expect(
      readPolicy([contributing('AI help is fine.\n\nAbout AI assistants:\n\n- Disclose them.\n\nOld pull requests will be closed after a year.')]).tier,
    ).toBe('allows_with_conditions');
  });

  test('a heading that names AI carries to its own section, and to no section beside it', () => {
    expect(readPolicy([contributing('## Using AI\n\nAI help is welcome.\n\n## Security\n\nDo not report security issues in public issues.')]).tier).toBe(
      'allows_with_conditions',
    );
  });
});

describe('welcomes', () => {
  test('docs that let agents open pull requests on their own invite agents, quoted from the paragraph that says so', () => {
    const policy = file('aiPolicy', '# AI policy\n\nAgents may open pull requests on their own.\nThey pick issues from the board.\n\nRun the tests first.\n');

    const reading = readPolicy([policy]);

    expect(reading.tier).toBe('invites_agents');
    expect(reading.welcome).toMatchObject({
      file: policy,
      quote: 'Agents may open pull requests on their own.\nThey pick issues from the board.',
    });
  });

  test.each([
    'Agent pull requests are welcome.',
    'Coding agents are welcome to open pull requests here.',
    'An AI agent may submit a fix for any open issue.',
    'We welcome pull requests from coding agents.',
    'Pull requests from AI agents are welcome.',
    'Agents are welcome here.',
  ])('%j invites agents', (sentence) => {
    expect(readPolicy([contributing(sentence)]).tier).toBe('invites_agents');
  });

  test.each([
    'AI help is fine.',
    'AI-assisted contributions are welcome.',
    'Using AI is fine.',
    'You may use AI to help with your change.',
    'We welcome AI-assisted pull requests.',
    'Feel free to use Claude Code, Codex, or Copilot.',
    'Feel free to use Gemini.',
  ])('%j allows AI help with conditions', (sentence) => {
    const reading = readPolicy([contributing(sentence)]);

    expect(reading.tier).toBe('allows_with_conditions');
    expect(reading.welcome?.sentence).toBe(sentence);
  });

  test.each(['Pull requests from AI agents are welcome.', 'Agents are welcome here.', 'Feel free to use Claude Code, Codex, or Copilot.'])(
    'the invitation %j weakens no ban',
    (sentence) => {
      expect(readPolicy([contributing(sentence), file('aiPolicy', 'AI-generated code will be closed.')]).tier).toBe('bans_or_restricts');
    },
  );

  test.each([
    ['a person in the loop', 'A person must review every change before it opens.'],
    ['a person-written PR description', 'Write the pull request description yourself.'],
  ])('an invitation with %s allows AI help with conditions', (_condition, sentence) => {
    const reading = readPolicy([contributing(`Agent pull requests are welcome. ${sentence}`)]);

    expect(reading.tier).toBe('allows_with_conditions');
    expect(reading.welcome?.sentence).toBe('Agent pull requests are welcome.');
  });

  test.each([
    ['nothing about AI', 'Run the tests before you open a pull request.'],
    ['a mention of AI that welcomes nothing', 'If you use AI, say so in the pull request.'],
    ['nothing at all', ''],
  ])('docs that say %s have no policy', (_what, text) => {
    const reading = readPolicy([contributing(text)]);

    expect(reading.tier).toBe('no_policy');
    expect(reading.welcome).toBeNull();
  });

  test('no files have no policy', () => {
    expect(readPolicy([]).tier).toBe('no_policy');
  });

  test('the quote is the first sentence that invites agents, or else the first that welcomes AI help, in the order the files are read', () => {
    const policy = file('aiPolicy', 'AI help is fine.');
    const reading = readPolicy([policy, contributing('Agent pull requests are welcome.')]);

    expect(reading.welcome).toMatchObject({ file: { path: 'CONTRIBUTING.md' }, quote: 'Agent pull requests are welcome.' });
    expect(readPolicy([policy, contributing('Run the tests.')]).welcome).toMatchObject({ file: policy, quote: 'AI help is fine.' });
  });
});

describe('the sentences that name AI, for the admin', () => {
  test('are every sentence in the files that names AI, or that the rules read as about AI, each with the rest of its paragraph as the file has it, each paragraph once', () => {
    const files = [
      contributing('Run the tests.\n\nAI help is **fine**. Disclose it.\n\nGenerated code will not be merged.'),
      file('agents', 'Claude should not use emojis. Run make test.'),
      file('agents', 'Claude should not use emojis. Run make test.', 'docs/AGENTS.md'),
    ];

    const reading = readPolicy(files);

    expect(reading.aiSentences.map(({ file: f, text, cutBefore, cutAfter }) => [f.path, text, cutBefore, cutAfter])).toEqual([
      ['CONTRIBUTING.md', 'AI help is **fine**. Disclose it.', false, false],
      ['CONTRIBUTING.md', 'Generated code will not be merged.', false, false],
      ['AGENTS.md', 'Claude should not use emojis. Run make test.', false, false],
      ['docs/AGENTS.md', 'Claude should not use emojis. Run make test.', false, false],
    ]);
    expect(reading.moreAiSentences).toBe(0);
  });

  test('show a sentence about contributing in a file for agents, which the rules read for a ban, with no AI word in it', () => {
    const reading = readPolicy([file('agents', 'Run make test.\n\nOpen pull requests against the `next` branch.')]);

    expect(reading.aiSentences.map(({ text }) => text)).toEqual(['Open pull requests against the `next` branch.']);
  });

  test('show a ban in the next sentence that names no AI, which the rules miss', () => {
    const reading = readPolicy([contributing('AI tools are fine for questions. Any code from a machine gets closed right away.')]);

    expect(reading.aiSentences.map(({ text }) => text)).toEqual(['AI tools are fine for questions. Any code from a machine gets closed right away.']);
  });

  test('keep a long sentence whole when its paragraph fits', () => {
    const long = `AI help is fine for questions about ${'the build, the docs, the tests, '.repeat(20)}but code from a machine gets closed right away.`;
    expect(long.length).toBeGreaterThan(500);
    expect(long.length).toBeLessThanOrEqual(1000);

    const reading = readPolicy([contributing(long)]);

    expect(reading.aiSentences.map(({ text, cutBefore, cutAfter }) => [text, cutBefore, cutAfter])).toEqual([[long, false, false]]);
  });

  test('cut a paragraph longer than 1,000 characters to 1,000 centered on the words that name AI, between words, and say where', () => {
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `Step ${String(i)} of the build runs here.`);
    const paragraph = [...filler(40), 'AI help is fine.', 'Code from a machine gets closed.', ...filler(40)].join(' ');

    const reading = readPolicy([contributing(paragraph)]);

    expect(reading.aiSentences).toHaveLength(1);
    const [kept] = reading.aiSentences;
    expect(kept).toMatchObject({ cutBefore: true, cutAfter: true });
    const text = kept?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text.length).toBeGreaterThan(940);
    // About as much before the words that name AI as after them.
    const lead = text.indexOf('AI help is fine.');
    expect(lead).toBeGreaterThan(440);
    expect(lead).toBeLessThanOrEqual(500);
    expect(text).toContain('AI help is fine. Code from a machine gets closed.');
    // Each cut falls between words.
    expect(paragraph).toContain(` ${text} `);
  });

  test('center a long sentence that names AI near its end on its AI words', () => {
    const long = `${'Please read the build guide, the style guide, the release notes, and the docs, '.repeat(25)}and keep Copilot away from this repo.`;
    expect(long.length).toBeGreaterThan(2000);

    const [kept] = readPolicy([contributing(long)]).aiSentences;

    expect(kept).toMatchObject({ cutBefore: true, cutAfter: false });
    expect(kept?.text).toContain('and keep Copilot away from this repo.');
  });

  test('keep a paragraph that starts with the sentence uncut at the start', () => {
    const paragraph = ['AI help is fine.', ...Array.from({ length: 60 }, (_, i) => `Step ${String(i)} of the build runs here.`)].join(' ');

    const [kept] = readPolicy([contributing(paragraph)]).aiSentences;

    expect(kept).toMatchObject({ cutBefore: false, cutAfter: true });
    expect(kept?.text.startsWith('AI help is fine. Step 0')).toBe(true);
    // The cut at the end falls between words, wherever the words fall.
    for (let pad = 0; pad < 9; pad++) {
      const words = `AI help is fine. ${'x'.repeat(pad)} ${'abcdefgh '.repeat(200)}`.trim();
      const [cut] = readPolicy([contributing(words)]).aiSentences;
      const text = cut?.text ?? '';
      expect(words.startsWith(text), String(pad)).toBe(true);
      expect(words[text.length], String(pad)).toBe(' ');
    }
  });

  test('keep a second sentence in a long paragraph that the first passage left out, and not one it holds', () => {
    const steps = (from: number, n: number) => Array.from({ length: n }, (_, i) => `Step ${String(from + i)} of the build runs here.`);
    const paragraph = ['AI help is fine.', ...steps(0, 15), 'Claude may help.', ...steps(15, 30), 'Copilot may help too.', ...steps(45, 40)].join(' ');

    const reading = readPolicy([contributing(paragraph)]);

    expect(reading.aiSentences.map(({ text, cutBefore }) => [text.includes('Claude may help.'), text.includes('Copilot may help too.'), cutBefore])).toEqual([
      [true, false, false],
      [false, true, true],
    ]);
    expect(reading.moreAiSentences).toBe(0);
  });

  test('keep the same paragraph once in a file', () => {
    const reading = readPolicy([contributing('AI help is fine.\n\nRun the tests.\n\nAI help is fine.')]);

    expect(reading.aiSentences.map(({ text }) => text)).toEqual(['AI help is fine.']);
  });

  test('count the sentences past the 60th passage that are in no passage kept', () => {
    const paragraphs = Array.from({ length: 59 }, (_, i) => `Rule ${String(i)} for agents here.`);
    const long = ['AI help is fine.', 'Claude may help.', ...Array.from({ length: 60 }, (_, i) => `Step ${String(i)} of the build runs here.`), 'Copilot may help too.'];

    const reading = readPolicy([file('aiPolicy', [...paragraphs, long.join(' ')].join('\n\n'))]);

    expect(reading.aiSentences).toHaveLength(60);
    // Every sentence of an AI policy counts: the 60th passage holds the two
    // first ones and some steps whole, and the rest are counted.
    const held = reading.aiSentences[59]?.text.match(/\.(?= |$)/g)?.length ?? 0;
    expect(held).toBeGreaterThan(2);
    expect(held).toBeLessThan(long.length);
    expect(reading.moreAiSentences).toBe(long.length - held);
  });

  test('stop at 60, and count the rest', () => {
    const policy = file('aiPolicy', Array.from({ length: 75 }, (_, i) => `Rule ${String(i)} for agents here.`).join('\n\n'));

    const reading = readPolicy([policy]);

    expect(reading.aiSentences).toHaveLength(60);
    expect(reading.moreAiSentences).toBe(15);
  });
});

describe('quotes', () => {
  test('a heading that welcomes AI help is quoted with the paragraph under it', () => {
    const reading = readPolicy([contributing('## AI help is welcome\n\nDisclose it with an Assisted-by: trailer.\n\n## Tests\n\nRun them.')]);

    expect(reading.welcome?.quote).toBe('## AI help is welcome\n\nDisclose it with an Assisted-by: trailer.');
  });

  test('a sentence wrapped over two lines is quoted as the file has it', () => {
    const reading = readPolicy([contributing('Coding agents may open\npull requests here.')]);

    expect(reading.tier).toBe('invites_agents');
    expect(reading.welcome?.quote).toBe('Coding agents may open\npull requests here.');
  });

  test('a paragraph longer than a quote may be is quoted by its sentence alone, as the file has it', () => {
    const long = `${'Some words about the project. '.repeat(80)}**Agents** may open pull requests on “any” issue ~~now~~. ${'More words. '.repeat(10)}`;

    const quote = readPolicy([file('aiPolicy', long)]).welcome?.quote;

    expect(quote).toBe('**Agents** may open pull requests on “any” issue ~~now~~.');
    expect(long).toContain(quote);
  });

  test('the quote is the text as the file has it', () => {
    const text = '# Policy\n\n**AI help** is fine’s own way… “really”.\nAI help is fine.\n';

    const quote = readPolicy([file('aiPolicy', text)]).welcome?.quote;

    expect(quote).toBe('**AI help** is fine’s own way… “really”.\nAI help is fine.');
  });
});

describe('suggested settings', () => {
  test.each(SETTINGS_CASES.map((s) => [s.title, s] as const))('%s', (_title, s) => {
    const reading = readPolicy(s.files);
    const labels = s.labels.map(({ name, openIssues }) => ({ name, openIssues }));

    const { settings, suggestedTags, sources } = suggestSettings(reading, s.files, labels, s.vouch);

    if (s.rules.tier !== undefined) expect(reading.tier).toBe(s.rules.tier);
    if (s.rules.settings !== undefined) expect(settings).toMatchObject(s.rules.settings);
    if (s.rules.allSettings !== undefined) expect(settings).toEqual(s.rules.allSettings);
    for (const key of s.rules.without ?? []) expect(settings).not.toHaveProperty(key);
    if (s.rules.suggestedTags !== undefined) expect(suggestedTags).toEqual(s.rules.suggestedTags);
    if (s.rules.sources !== undefined) expect(sources).toEqual(s.rules.sources);
  });

  test('a label kept for people or from AI is no tag and no suggestion', () => {
    for (const s of SETTINGS_CASES.filter((c) => c.key === 'kept-for-people' || c.key === 'kept-from-ai')) {
      const { settings, suggestedTags } = suggestSettings(readPolicy(s.files), s.files, s.labels, s.vouch);
      expect(settings.tags, s.key).not.toContain('good first issue');
      expect(suggestedTags.map((tag) => tag.name), s.key).not.toContain('good first issue');
    }
  });
});

describe('speed', () => {
  // Each pattern runs on one sentence at a time, and none can try a start
  // again after it fails, so a file takes time that grows with its length
  // alone. These files try every pattern at the size limit: runs of each
  // kind of space and mark, and each phrase a pattern starts with, over and
  // over, with a letter at the end that no pattern takes.
  const runs = [' ', '\t', '\n', '\r\n', ' \t', '\n\n', '.', '. ', '!', '?', '-', '_', '*', '~', '`', '"', "'", '#', '|', '>', '[', ']', ':', ','];
  const phrases = [
    'not ', "n't ", 'no ', 'AI ', 'ai-', 'A.I. ', 'GPT-4', 'GPT-4.', 'agents ', 'agent ', 'Cursor ', 'vibe-cod', 'LLM ',
    'pull requests ', 'PRs ', 'do not open ', 'not accept ', 'not accept any ', 'no outside ', 'are not ', 'is not ',
    "don't submit code you don't ", "don't forget to ", 'do not delete this ', 'undisclosed ', 'do not submit AI without ',
    'without ', 'on your own ', 'autonomous ', 'if you are an AI ', 'on issues labeled "', 'reserved for ', '- [ ] ',
    '- label: ', '# ', '## AI\n', 'agents may ', 'we welcome ', 'feel free to use ', 'AI-generated ', 'contributions ',
    'Sign the CLA ', 'https://', 'PR description ', 'Assisted-by', '<strong>', '<em>not</em> ', 'you must ',
    'off limits ', 'keep AI ', 'generated code ', 'generated by a ', '100% human-written ', 'written entirely by a ',
    'agents should not push to ', 'do not include secrets ', 'if an agent cannot ', 'only on issues labeled "',
    'we only ask that you ', 'About AI:\n- ', 'AI-free ', 'do not use AI without reading ', "you don't need to ask ",
    'we only ask that you disclose ', 'leave AI ', 'if you cannot write it, ', 'do not push to any ',
    'AI help is fine. Step one. ',
  ];
  const fill = (unit: string) => `${unit.repeat(Math.ceil(MAX_DOC_BYTES / unit.length)).slice(0, MAX_DOC_BYTES - 1)}x`;
  const texts = [
    ...runs.map(fill),
    ...phrases.map(fill),
    ...runs.map((run) => {
      const head = 'We do not accept pull requests';
      return `${head}${run.repeat(Math.ceil(MAX_DOC_BYTES / run.length)).slice(0, MAX_DOC_BYTES - head.length - 1)}x`;
    }),
  ];

  test.each(texts.map((text, i) => [i, JSON.stringify(text.slice(0, 24)), text] as const))(
    'file %i, which starts %s, is read in time that grows with its length alone, as each kind of file',
    (_i, _start, text) => {
      expect(text.length).toBeLessThanOrEqual(MAX_DOC_BYTES);
      const files = (['aiPolicy', 'agents', 'prTemplate'] as const).map((kind) => file(kind, text));
      const started = performance.now();
      const reading = readPolicy(files);
      suggestSettings(reading, files, [{ name: 'help wanted', openIssues: 1 }], null);
      // Read in one pass, each takes tens of milliseconds at most. A pattern
      // that tries each start again took seconds on a file like these.
      expect(performance.now() - started).toBeLessThan(1500);
    },
  );
});
