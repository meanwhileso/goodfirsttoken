import { describe, expect, test } from 'vitest';
import { aiPassages, bare, namesAiByWordList, quoteOf, scan, type PolicyFile } from '../../src/crawl/rules';
import { MAX_DOC_BYTES } from '../../src/projects/docs';
import { CASES, contributing, file } from './corpus';
import { BAN_CASES, BAN_WORDINGS } from './corpus/bans';
import { FORM_CASES } from './corpus/forms';
import { MODEL_CASES } from './corpus/model';
import { SETTINGS_POLICY_CASES } from './corpus/settings';
import { HELD_OUT_CASES, WELCOMING_CASES } from './corpus/welcoming';

// The word list the crawler keeps beside the model policy reader, called
// directly on made-up files: the admin's net of sentences that name AI, and
// the sentences and quotes the reader's checks use. It decides nothing.
// Every line of policy text here is made up, and says nothing about a real
// project. The corpus in corpus/ is the model reader's eval.

/** How many cases the eval runs from the corpus, besides the real repos it fetches. */
const EVAL_CASES = 458;

/** The passages the admin's net keeps from the files. */
const kept = (...files: PolicyFile[]) => aiPassages(files).aiSentences.map(({ text }) => text);

/** The quote for the first sentence in the file that has `needle` in it. */
function quoteAt(f: PolicyFile, needle: string): string {
  const { paragraphs, sentences } = scan(f.text);
  const sentence = sentences.find((s) => s.text.includes(needle));
  if (sentence === undefined) throw new Error(`no sentence has ${needle}`);
  return quoteOf(f.text, paragraphs, sentence);
}

describe('the corpus, kept as the eval\'s cases', () => {
  test('holds every wording the reviews found, 93 in all, each beside a welcome and beside an invitation', () => {
    expect(BAN_WORDINGS).toHaveLength(93);
    expect(BAN_CASES).toHaveLength(186);
    expect(WELCOMING_CASES).toHaveLength(38);
    expect(HELD_OUT_CASES).toHaveLength(12);
  });

  test('every case is one the eval runs', () => {
    const groups = [BAN_CASES, WELCOMING_CASES, HELD_OUT_CASES, FORM_CASES, SETTINGS_POLICY_CASES, MODEL_CASES];
    const ids = new Set(CASES.map((c) => c.id));
    for (const group of groups) for (const c of group) expect(ids.has(c.id), c.id).toBe(true);
    expect(CASES).toHaveLength(groups.reduce((n, group) => n + group.length, 0));
    expect(CASES).toHaveLength(EVAL_CASES);
  });
});

describe('what counts as about AI', () => {
  test('a sentence under a heading that names AI is about AI, and a heading of the same level or higher ends that', () => {
    expect(kept(contributing('## AI\n\nAI help is fine.\n\n### Code\n\nWe will not merge it.'))).toContain('We will not merge it.');
    expect(kept(contributing('## AI\n\nAI help is fine.\n\n## Releases\n\nDo not tag releases by hand.'))).not.toContain(
      'Do not tag releases by hand.',
    );
  });

  test('every sentence of an AI policy file is about AI', () => {
    expect(kept(file('aiPolicy', '# Policy\n\nWe will not merge it.'))).toContain('We will not merge it.');
    expect(kept(file('contributing', '# Contributing\n\nWe will not merge it.'))).toEqual([]);
  });

  test('a lead-in that names AI and ends with a colon carries to the list after it, and the list ends it', () => {
    expect(kept(contributing('AI help is fine.\n\nAbout AI assistants:\n\n- Their pull requests will be closed on sight.'))).toContain(
      '- Their pull requests will be closed on sight.',
    );
    expect(kept(contributing('AI help is fine.\n\nAbout the release process:\n\n- Their pull requests will be closed on sight.'))).not.toContain(
      '- Their pull requests will be closed on sight.',
    );
    expect(kept(contributing('AI help is fine.\n\nAbout AI assistants:\n\n- Disclose them.\n\nOld pull requests will be closed after a year.'))).not.toContain(
      'Old pull requests will be closed after a year.',
    );
  });

  test('a heading that names AI carries to its own section, and to no section beside it', () => {
    expect(kept(contributing('## Using AI\n\nAI help is welcome.\n\n## Security\n\nDo not report security issues in public issues.'))).not.toContain(
      'Do not report security issues in public issues.',
    );
  });

  test('a short sentence, or one that points back with a pronoun, after one in its paragraph that names AI is about AI', () => {
    const steps = Array.from({ length: 40 }, (_, i) => `Step ${String(i)} of the build runs here.`).join(' ');
    const passages = (tail: string) => {
      const reading = aiPassages([contributing(`AI help is fine. ${steps} ${tail}`)]);
      return reading.aiSentences.map(({ text }) => text.includes(tail));
    };

    expect(passages('We will close it otherwise.')).toEqual([false, true]);
    expect(passages('No, never, thanks.')).toEqual([false, true]);
    expect(passages('Old branches will be closed after a year.')).toEqual([false]);
  });

  test('a ban with no word for AI counts: generated work turned away, work only a person writes, and a project free of AI', () => {
    expect(kept(contributing('Generated pull requests will be closed.'))).toEqual(['Generated pull requests will be closed.']);
    expect(kept(contributing('Code must be written by a human.'))).toEqual(['Code must be written by a human.']);
    expect(kept(contributing('This is an AI-free project.'))).toEqual(['This is an AI-free project.']);
  });

  test("in a file for agents, the fingerprint's word list names AI only in work AI made and a refusal of AI, though the net keeps every AI word", () => {
    expect(namesAiByWordList('Claude, run the tests first.', true)).toBe(false);
    expect(namesAiByWordList('Claude, run the tests first.')).toBe(true);
    expect(kept(file('agents', 'Claude, run the tests first.'))).toEqual(['Claude, run the tests first.']);
    expect(namesAiByWordList('AI-generated changes need a test.', true)).toBe(true);
    expect(namesAiByWordList('AI coding assistants are not allowed to modify this repository.', true)).toBe(true);
  });
});

describe('the sentences that name AI, for the admin', () => {
  test('are every sentence in the files that names AI, or that the word list reads as about AI, each with the rest of its paragraph as the file has it, each paragraph once', () => {
    const files = [
      contributing('Run the tests.\n\nAI help is **fine**. Disclose it.\n\nGenerated code will not be merged.'),
      file('agents', 'Claude should not use emojis. Run make test.'),
      file('agents', 'Claude should not use emojis. Run make test.', 'docs/AGENTS.md'),
    ];

    const reading = aiPassages(files);

    expect(reading.aiSentences.map(({ file: f, text, cutBefore, cutAfter }) => [f.path, text, cutBefore, cutAfter])).toEqual([
      ['CONTRIBUTING.md', 'AI help is **fine**. Disclose it.', false, false],
      ['CONTRIBUTING.md', 'Generated code will not be merged.', false, false],
      ['AGENTS.md', 'Claude should not use emojis. Run make test.', false, false],
      ['docs/AGENTS.md', 'Claude should not use emojis. Run make test.', false, false],
    ]);
    expect(reading.moreAiSentences).toBe(0);
  });

  test('show a sentence about contributing in a file for agents, with no AI word in it', () => {
    const reading = aiPassages([file('agents', 'Run make test.\n\nOpen pull requests against the `next` branch.')]);

    expect(reading.aiSentences.map(({ text }) => text)).toEqual(['Open pull requests against the `next` branch.']);
  });

  test('show a ban in the next sentence that names no AI, in the paragraph kept', () => {
    const reading = aiPassages([contributing('AI tools are fine for questions. Any code from a machine gets closed right away.')]);

    expect(reading.aiSentences.map(({ text }) => text)).toEqual(['AI tools are fine for questions. Any code from a machine gets closed right away.']);
  });

  test('keep a long sentence whole when its paragraph fits', () => {
    const long = `AI help is fine for questions about ${'the build, the docs, the tests, '.repeat(20)}but code from a machine gets closed right away.`;
    expect(long.length).toBeGreaterThan(500);
    expect(long.length).toBeLessThanOrEqual(1000);

    const reading = aiPassages([contributing(long)]);

    expect(reading.aiSentences.map(({ text, cutBefore, cutAfter }) => [text, cutBefore, cutAfter])).toEqual([[long, false, false]]);
  });

  test('cut a paragraph longer than 1,000 characters to 1,000 centered on the words that name AI, between words, and say where', () => {
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `Step ${String(i)} of the build runs here.`);
    const paragraph = [...filler(40), 'AI help is fine.', 'Code from a machine gets closed.', ...filler(40)].join(' ');

    const reading = aiPassages([contributing(paragraph)]);

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

    const [kept] = aiPassages([contributing(long)]).aiSentences;

    expect(kept).toMatchObject({ cutBefore: true, cutAfter: false });
    expect(kept?.text).toContain('and keep Copilot away from this repo.');
  });

  test('keep a paragraph that starts with the sentence uncut at the start', () => {
    const paragraph = ['AI help is fine.', ...Array.from({ length: 60 }, (_, i) => `Step ${String(i)} of the build runs here.`)].join(' ');

    const [kept] = aiPassages([contributing(paragraph)]).aiSentences;

    expect(kept).toMatchObject({ cutBefore: false, cutAfter: true });
    expect(kept?.text.startsWith('AI help is fine. Step 0')).toBe(true);
    // The cut at the end falls between words, wherever the words fall.
    for (let pad = 0; pad < 9; pad++) {
      const words = `AI help is fine. ${'x'.repeat(pad)} ${'abcdefgh '.repeat(200)}`.trim();
      const [cut] = aiPassages([contributing(words)]).aiSentences;
      const text = cut?.text ?? '';
      expect(words.startsWith(text), String(pad)).toBe(true);
      expect(words[text.length], String(pad)).toBe(' ');
    }
  });

  test('keep a second sentence in a long paragraph that the first passage left out, and not one it holds', () => {
    const steps = (from: number, n: number) => Array.from({ length: n }, (_, i) => `Step ${String(from + i)} of the build runs here.`);
    const paragraph = ['AI help is fine.', ...steps(0, 15), 'Claude may help.', ...steps(15, 30), 'Copilot may help too.', ...steps(45, 40)].join(' ');

    const reading = aiPassages([contributing(paragraph)]);

    expect(reading.aiSentences.map(({ text, cutBefore }) => [text.includes('Claude may help.'), text.includes('Copilot may help too.'), cutBefore])).toEqual([
      [true, false, false],
      [false, true, true],
    ]);
    expect(reading.moreAiSentences).toBe(0);
  });

  test('keep the same paragraph once in a file', () => {
    const reading = aiPassages([contributing('AI help is fine.\n\nRun the tests.\n\nAI help is fine.')]);

    expect(reading.aiSentences.map(({ text }) => text)).toEqual(['AI help is fine.']);
  });

  test('count the sentences past the 60th passage that are in no passage kept', () => {
    const paragraphs = Array.from({ length: 59 }, (_, i) => `Rule ${String(i)} for agents here.`);
    const long = ['AI help is fine.', 'Claude may help.', ...Array.from({ length: 60 }, (_, i) => `Step ${String(i)} of the build runs here.`), 'Copilot may help too.'];

    const reading = aiPassages([file('aiPolicy', [...paragraphs, long.join(' ')].join('\n\n'))]);

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

    const reading = aiPassages([policy]);

    expect(reading.aiSentences).toHaveLength(60);
    expect(reading.moreAiSentences).toBe(15);
  });
});

describe('the marks around a sentence', () => {
  test("come off a list item, a checkbox, an issue form's option, a heading, a quote, and an HTML comment, whichever way the comment closes", () => {
    expect(bare('- [ ] I did not use AI')).toBe('I did not use AI');
    expect(bare('- label: I did not use AI')).toBe('I did not use AI');
    expect(bare('## AI help is fine')).toBe('AI help is fine');
    expect(bare('> AI help is fine.')).toBe('AI help is fine.');
    expect(bare("<!-- Don't delete this section. -->")).toBe("Don't delete this section.");
    expect(bare("<!-- Don't delete this section. --!>")).toBe("Don't delete this section.");
    expect(bare('AI help is fine. -->')).toBe('AI help is fine.');
  });
});

describe('quotes', () => {
  test('a heading is quoted with the paragraph under it', () => {
    expect(quoteAt(contributing('## AI help is welcome\n\nDisclose it with an Assisted-by: trailer.\n\n## Tests\n\nRun them.'), 'AI help is welcome')).toBe(
      '## AI help is welcome\n\nDisclose it with an Assisted-by: trailer.',
    );
  });

  test('a sentence wrapped over two lines is quoted as the file has it', () => {
    expect(quoteAt(contributing('Coding agents may open\npull requests here.'), 'Coding agents may open pull requests here.')).toBe(
      'Coding agents may open\npull requests here.',
    );
  });

  test('a paragraph longer than a quote may be is quoted by its sentence alone, as the file has it', () => {
    const long = `${'Some words about the project. '.repeat(80)}**Agents** may open pull requests on “any” issue ~~now~~. ${'More words. '.repeat(10)}`;

    const quote = quoteAt(file('aiPolicy', long), 'Agents may open pull requests on "any" issue now.');

    expect(quote).toBe('**Agents** may open pull requests on “any” issue ~~now~~.');
    expect(long).toContain(quote);
  });

  test('the quote is the text as the file has it', () => {
    const text = '# Policy\n\n**AI help** is fine’s own way… “really”.\nAI help is fine.\n';

    expect(quoteAt(file('aiPolicy', text), "AI help is fine's own way")).toBe('**AI help** is fine’s own way… “really”.\nAI help is fine.');
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
      aiPassages(files);
      for (const f of files) scan(f.text);
      // Read in one pass, each takes tens of milliseconds at most. A pattern
      // that tries each start again took seconds on a file like these.
      expect(performance.now() - started).toBeLessThan(1500);
    },
  );
});

