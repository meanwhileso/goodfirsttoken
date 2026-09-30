import { foldUntrusted } from '@goodfirsttoken/core';
import type { ContainerNode, Node } from '@takumi-rs/wasm';
import type { CSSProperties } from 'react';

// The share cards: the Open Graph image of each public page, as a tree of
// boxes and text the renderer (./render.ts) lays out and draws at 1200 by
// 630. There are four: a person's month, a merged PR, a project's totals,
// and the default card every other page uses. Nothing on a card is smaller
// than 40px (brand/design.md, under Share cards), so a card still reads in
// a chat preview 250 to 360px wide. docs/how-it-works.md, under Share
// cards, says what each one shows and hides.
//
// Every name on a card came from GitHub, so each one is folded to one line
// of what a person can see with core's foldUntrusted, cut to a length, and
// cut again with an ellipsis where it would run past the card's edge.

/** A card's size, in pixels. */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/** The smallest anything on a card may be, in pixels. */
export const SMALLEST = 40;

const PAD = 64;
/** The width inside the card's padding. */
const INNER = CARD_WIDTH - 2 * PAD;

// The colors, from the YAML at the top of brand/design.md.
const PAPER = '#FBFBF9';
const INK = '#0E1116';
const MUTED = '#57606A';
const FAINT = '#6A737D';
const LABEL = '#7057FF';
const LABEL_INK = '#5B3FD9';
const LABEL_TINT = '#F2F1FB';
const MERGED = '#1A7F37';
const WHITE = '#FFFFFF';

const SANS = 'Geist';
const MONO = 'Geist Mono';

/** The images a card may draw, by the name its nodes use. */
export const CARD_IMAGES = {
  // The ring-and-dot token, white, for the logo chip (brand/design.md).
  mark: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" fill="none" stroke="#FFFFFF" stroke-width="4"/><circle cx="18" cy="18" r="6" fill="#FFFFFF"/></svg>',
} as const;

/** A card, ready to draw. */
export interface Card {
  node: Node;
}

function text(value: string, style: CSSProperties = {}): Node {
  return { type: 'text', text: value, style };
}

function box(style: CSSProperties, children: Node[]): ContainerNode {
  return { type: 'container', style: { display: 'flex', ...style }, children };
}

/** One line that ends in an ellipsis where it would run past its box. */
const ONE_LINE: CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 };

/**
 * The size of a title of `length` characters: as large as `largest` while
 * it would fit the card's width at `em` of its size for each character, and
 * no smaller than `smallest`. A title too long even then is cut at the
 * card's edge.
 */
function titleSize(length: number, { largest, smallest, em }: { largest: number; smallest: number; em: number }): number {
  const fits = Math.floor(INNER / (Math.max(length, 1) * em));
  return Math.max(smallest, Math.min(largest, fits));
}

/** A label chip: a pill with mono text. */
function chip(value: string, colors: { background: string; color: string }): Node {
  return box(
    {
      alignItems: 'center',
      flexShrink: 0,
      padding: '10px 24px',
      borderRadius: 999,
      backgroundColor: colors.background,
      color: colors.color,
      fontFamily: MONO,
      fontSize: 40,
      fontWeight: 500,
    },
    [text(value)],
  );
}

/** The logo: the `good first token` label chip, with the token at its left. */
function logo(): Node {
  return box(
    {
      alignItems: 'center',
      flexShrink: 0,
      gap: 14,
      padding: '10px 28px 10px 14px',
      borderRadius: 999,
      backgroundColor: LABEL,
      color: WHITE,
      fontFamily: MONO,
      fontSize: 40,
      fontWeight: 600,
    },
    [{ type: 'image', src: 'mark', width: 44, height: 44 }, text('good first token')],
  );
}

/**
 * The frame every card shares: the logo and what the card is about at the
 * top, the card's own lines in the middle, and the site's address at the
 * foot.
 */
function frame({ site, corner, body }: { site: string; corner?: Node; body: Node[] }): Card {
  return {
    node: box(
      {
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: PAD,
        backgroundColor: PAPER,
        color: INK,
        fontFamily: SANS,
        lineHeight: 1,
      },
      [
        box({ alignItems: 'center', justifyContent: 'space-between', gap: 32 }, [logo(), ...(corner ? [corner] : [])]),
        box({ flexDirection: 'column', gap: 28 }, body),
        text(foldUntrusted(site, 60), { fontFamily: MONO, fontSize: 40, color: FAINT, ...ONE_LINE }),
      ],
    ),
  };
}

/** A number in big type with its words beside it, as in a stat line. */
function stat(value: number, words: string): Node {
  return box({ alignItems: 'baseline', gap: 14, flexShrink: 0 }, [
    text(value.toLocaleString('en-US'), { fontSize: 80, fontWeight: 600, letterSpacing: '-0.02em' }),
    text(words, { fontSize: 40, color: MUTED }),
  ]);
}

/** Stats in a row, which wraps onto a second line when the numbers run long. */
function stats(parts: Node[]): Node {
  return box({ flexWrap: 'wrap', alignItems: 'baseline', columnGap: 44, rowGap: 12 }, parts);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The card for every page without one of its own. */
export function defaultCard({ site }: { site: string }): Card {
  // The headline with its one inline label, as on the homepage. Each word is
  // its own box, so the line wraps between words.
  const words = 'Spend your spare tokens on'.split(' ').map((word) => text(word));
  return frame({
    site,
    body: [
      box(
        { flexWrap: 'wrap', alignItems: 'center', columnGap: 26, rowGap: 14, fontSize: 96, fontWeight: 600, letterSpacing: '-0.035em' },
        [
          ...words,
          box(
            {
              padding: '4px 24px 10px',
              borderRadius: 999,
              backgroundColor: LABEL,
              color: WHITE,
              fontFamily: MONO,
              fontSize: 76,
              letterSpacing: '-0.04em',
            },
            [text('open source')],
          ),
        ],
      ),
    ],
  });
}

export interface PersonMonth {
  site: string;
  /** Their login now. */
  login: string;
  /** The month, like september 2026. */
  month: string;
  /** PRs merged in the month, from claims on someone else's project. */
  merged: number;
  /** PRs opened in the month, as merged. */
  opened: number;
  /** Projects with a PR of theirs merged in the month. */
  projects: number;
}

/** A person's month: their PRs merged, the projects they helped, and their PRs opened. */
export function personCard(month: PersonMonth): Card {
  const login = `@${foldUntrusted(month.login, 39)}`;
  const size = titleSize(login.length, { largest: 104, smallest: 56, em: 0.58 });
  const counts =
    month.merged === 0
      ? [
          text('No PRs merged yet', { fontSize: 64, fontWeight: 600, letterSpacing: '-0.02em', flexShrink: 0 }),
          ...(month.opened === 0 ? [] : [stat(month.opened, 'opened')]),
        ]
      : [
          stat(month.merged, 'merged'),
          stat(month.projects, plural(month.projects, 'project helped', 'projects helped')),
          stat(month.opened, 'opened'),
        ];
  return frame({
    site: month.site,
    corner: text(foldUntrusted(month.month, 20), { fontFamily: MONO, fontSize: 40, color: MUTED, flexShrink: 0 }),
    body: [text(login, { fontSize: size, fontWeight: 600, letterSpacing: '-0.035em', ...ONE_LINE }), stats(counts)],
  });
}

export interface ProjectTotals {
  site: string;
  /** The project's code repo, as it was saved. */
  repo: string;
  /** PRs merged from claims on it, its own maintainers' included, as its page counts them. */
  merged: number;
  /** People with a PR merged on it from someone else's project. */
  people: number;
  /** Issues claimed on it by people who don't maintain it. */
  issues: number;
}

/** A project's totals of all time: PRs merged, people who helped, and issues worked. */
export function projectCard(totals: ProjectTotals): Card {
  const repo = foldUntrusted(totals.repo, 140);
  const size = titleSize(repo.length, { largest: 88, smallest: 56, em: 0.6 });
  return frame({
    site: totals.site,
    body: [
      box({ flexDirection: 'column', gap: 20 }, [
        text(repo, { fontFamily: MONO, fontSize: size, fontWeight: 600, letterSpacing: '-0.03em', ...ONE_LINE }),
        text('Tagged issues for outside help.', { fontSize: 40, color: MUTED }),
      ]),
      stats([
        stat(totals.merged, 'merged'),
        stat(totals.people, plural(totals.people, 'person helped', 'people helped')),
        stat(totals.issues, plural(totals.issues, 'issue worked', 'issues worked')),
      ]),
    ],
  });
}

export interface MergedPr {
  site: string;
  /** The repo the issue is in. */
  repo: string;
  /** The issue's number. */
  number: number;
  /** The donor's login now. */
  login: string;
  /** The agent the claim named. */
  agent: string;
}

/**
 * A merged PR: the issue it fixed, the donor, and their agent. Never the
 * PR's title, which is the repo's own text and could name anyone.
 */
export function mergedCard(merged: MergedPr): Card {
  const repo = foldUntrusted(merged.repo, 140);
  const number = `#${String(merged.number)}`;
  const size = titleSize(repo.length + number.length, { largest: 88, smallest: 56, em: 0.6 });
  return frame({
    site: merged.site,
    corner: chip('merged', { background: MERGED, color: WHITE }),
    body: [
      // The issue's number stays whole, and a long repo is what gets cut.
      box({ alignItems: 'baseline', fontFamily: MONO, fontSize: size, fontWeight: 600, letterSpacing: '-0.03em' }, [
        text(repo, ONE_LINE),
        text(number, { flexShrink: 0 }),
      ]),
      box({ alignItems: 'center', gap: 24, overflow: 'hidden' }, [
        text(`@${foldUntrusted(merged.login, 39)}`, { fontSize: 64, fontWeight: 600, letterSpacing: '-0.02em', ...ONE_LINE }),
        chip(foldUntrusted(merged.agent, 40), { background: LABEL_TINT, color: LABEL_INK }),
      ]),
    ],
  });
}
