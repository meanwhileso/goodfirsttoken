import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { describe, expect, test } from 'vitest';
import { text } from '../../src/readable/markdown';

// text() on its own: untrusted text, escaped, renders as exactly its words,
// on its own line, in a list item, and in a heading, with GFM and raw HTML
// let through, so anything it let in would show as an element.

function render(markdown: string): string {
  return micromark(markdown, { extensions: [gfm()], htmlExtensions: [gfmHtml()], allowDangerousHtml: true });
}

/** The words as a renderer writes text: with &, <, >, and " as entities. */
function asText(words: string): string {
  return words.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

// Each is made up, and each would add to the page, or lose a character, if
// it weren't escaped.
const INPUTS = [
  '\\*x\\*',
  '&lt;b&gt;',
  '# x',
  '1. x',
  '2) x',
  '- x',
  '+ x',
  '= x',
  '> x',
  '<div x',
  '<b>bold</b>',
  'Fix C# #',
  'ends in ###',
  '*x* and _y_ and `z`',
  '[a](https://example.test/a)',
  '![b](https://example.test/b.png)',
  'www.example.test and https://example.test and me@example.test',
  '| a | b |',
  '~~x~~',
];

describe('text()', () => {
  test.each(INPUTS)('%s renders as its words and nothing else, alone, in a list item, and in a heading', (input) => {
    const words = asText(input);

    expect(render(text(input))).toBe(`<p>${words}</p>`);
    expect(render(`- ${text(input)}`)).toBe(`<ul>\n<li>${words}</li>\n</ul>`);
    expect(render(`# ${text(input)}`)).toBe(`<h1>${words}</h1>`);
  });
});
