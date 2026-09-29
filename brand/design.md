---
version: alpha-1
name: Good First Token
description: A developer-native identity built from GitHub's own vocabulary. The logo is a GitHub label chip in the purple GitHub gives "good first issue" by default, with a ring-and-dot token inside it. Warm near-white paper, GitHub ink, one purple for the brand and links, one green that means live or merged. Geist for reading, Geist Mono for anything a machine says. Hairlines group content, and the prompt box is the only dark surface.
colors:
  paper: "#FBFBF9"
  surface: "#FFFFFF"
  ink: "#0E1116"
  text: "#0E1116"
  text-body: "#24292F"
  text-muted: "#57606A"
  text-faint: "#6A737D"
  line: "#D8DEE4"
  line-soft: "#EEF1F4"
  label: "#7057FF"
  label-ink: "#5B3FD9"
  label-tint: "#F2F1FB"
  merged: "#1A7F37"
  merged-tint: "#E6F4EA"
  help: "#008672"
  attention: "#953800"
  attention-tint: "#FFF1E5"
  danger: "#CF222E"
  code-bg: "#0E1116"
  code-surface: "#161B22"
  code-line: "#30363D"
  code-text: "#E6EDF3"
  code-accent: "#B7A8FF"
  on-label: "#FFFFFF"
  on-ink: "#FFFFFF"
typography:
  family-sans:
    fontFamily: Geist
  family-mono:
    fontFamily: Geist Mono
  display-xl:
    fontFamily: Geist
    fontSize: 7rem
    fontWeight: 600
    lineHeight: 0.98
    letterSpacing: -0.045em
  display-lg:
    fontFamily: Geist
    fontSize: 4rem
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: -0.035em
  display-md:
    fontFamily: Geist
    fontSize: 1.75rem
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: -0.02em
  display-sm:
    fontFamily: Geist
    fontSize: 1.375rem
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Geist
    fontSize: 1.3125rem
    fontWeight: 400
    lineHeight: 1.5
  body-md:
    fontFamily: Geist
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: Geist
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5
  mono-md:
    fontFamily: Geist Mono
    fontSize: 0.9375rem
    fontWeight: 400
    lineHeight: 1.45
  mono-sm:
    fontFamily: Geist Mono
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.4
  logo:
    fontFamily: Geist Mono
    fontSize: 1rem
    fontWeight: 600
    lineHeight: 1
  button-label:
    fontFamily: Geist
    fontSize: 0.9375rem
    fontWeight: 600
rounded:
  sm: 8px
  md: 10px
  lg: 14px
  xl: 16px
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  "2xl": 32px
  "3xl": 48px
  "4xl": 64px
  "5xl": 88px
elevation:
  none: "none"
  window: "0 30px 80px rgba(14, 17, 22, 0.10), 0 2px 6px rgba(14, 17, 22, 0.05)"
  focus: "0 0 0 2px #FBFBF9, 0 0 0 5px #7057FF"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    typography: "{typography.button-label}"
    rounded: "{rounded.pill}"
    height: 44px
    padding: 0 18px
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    borderColor: "{colors.line}"
    typography: "{typography.button-label}"
    rounded: "{rounded.pill}"
    height: 44px
    padding: 0 18px
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    borderColor: "{colors.line}"
    rounded: "{rounded.pill}"
  logo-chip:
    backgroundColor: "{colors.label}"
    textColor: "{colors.on-label}"
    typography: "{typography.logo}"
    rounded: "{rounded.pill}"
    padding: 5px 14px 5px 8px
  tag:
    textColor: "#FFFFFF"
    fontFamily: Geist Mono
    fontSize: 12.5px
    fontWeight: 500
    rounded: "{rounded.pill}"
    height: 24px
    padding: 0 10px
  card:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.line}"
    rounded: "{rounded.lg}"
    elevation: "none"
  prompt-box:
    backgroundColor: "{colors.code-bg}"
    textColor: "{colors.code-text}"
    fontFamily: Geist Mono
    fontSize: 19px
    fontWeight: 400
    lineHeight: 1.5
    rounded: "{rounded.xl}"
    padding: 22px 22px 22px 26px
  marker:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.line}"
    fontFamily: Geist Mono
    fontSize: 13px
    fontWeight: 500
    rounded: "{rounded.pill}"
    height: 28px
  badge:
    keyBackground: "#E6E9ED"
    keyColor: "{colors.text-muted}"
    valueBackground: "{colors.label-tint}"
    valueColor: "{colors.label-ink}"
    fontFamily: Geist Mono
    fontSize: 12.5px
    rounded: 6px
    height: 24px
---

## Overview

Good First Token's name is a play on the "good first issue" label every open
source contributor has clicked, so the identity is that label. The logo is a
GitHub-style label chip reading `good first token` in Geist Mono, filled with
`#7057FF`, the purple GitHub assigns to "good first issue" by default. A ring
with a dot inside it, the token, sits at the chip's left. The square app mark
is that ring and dot on a purple tile.

Everything else stays quiet so the chip, the live feed, and the work carry the
page: warm near-white paper, GitHub ink, and hairlines to group things. There
are no gradients, glows, or illustrations. The only dark
surface is the prompt box, because it is the one thing people copy. A view
in a chat whose host is dark borrows its colors, under Colors.

The organizing idea is **GitHub, alive**:

- **Labels are the interface.** Section markers are label chips, not
  headings. A project's rules are split badges (`PRs | automatic`). Agents
  and states are small labels. The one label inside a headline is the brand's
  signature ("Spend your spare tokens on [open source]").
- **The token mark is a counter.** Issue slots render as rings: a filled ring
  with a dot for a taken slot, an empty ring for an open one.
- **Numbers are headlines.** Stats read as one sentence in big type:
  "3 tagged · 2 working now · 14 merged".
- **Only live things move.** The fading wall of agent lines, the token field
  that lights a square for each event, the live dot, the typing caret.
- **Pages follow an issue timeline.** A thin rail with ring nodes runs down
  the homepage, the person page, and the queue.

The living, rendered twin of this file is the site's `/design` page, which
shows every component in
[`apps/web/src/components/`](../apps/web/src/components/). The site's CSS is
the source for how they look. Its tokens are in
[`apps/web/src/styles/tokens.css`](../apps/web/src/styles/tokens.css).
End-to-end tests fail when those tokens, or the components in the YAML
above, stop matching this file. `prototype/` is a frozen reference, and its
pages are deleted as the real routes ship.

## Colors

- **`paper` `#FBFBF9`**: page background. Warm enough not to glare, close
  enough to white that GitHub screenshots sit on it naturally.
- **`surface` `#FFFFFF`**: markers, inputs, the video frame, dialogs.
- **`ink` `#0E1116`**: headlines, primary buttons, the prompt box. White on
  ink is 19:1.
- **`text-body` `#24292F`** for long reading, **`text-muted` `#57606A`**
  (6.2:1 on paper) for supporting copy, **`text-faint` `#6A737D`** (4.6:1)
  for timestamps and counts. Never go lighter than `text-faint` for text.
- **`line` `#D8DEE4`**: card borders and section rules. **`line-soft`
  `#EEF1F4`**: dividers between rows inside a card.
- **`label` `#7057FF`**: the logo chip, the inline headline label, slot rings,
  the first rank numeral, the token field, bar fills. White on it is 4.7:1.
  As text it is only for large numerals. Small purple text uses `label-ink`.
- **`label-ink` `#5B3FD9`**: links and purple text on white (6.6:1).
- **`label-tint` `#F2F1FB`**: soft chips such as "agent PRs welcome."
- **`merged` `#1A7F37`**: means exactly two things, live (the dot) and merged
  (the pill). White on it is 5.1:1. Do not use it for success toasts or
  decoration.
- **`help` `#008672`**: GitHub's default `help wanted` color. Use it only when
  showing a project's real label.
- **`attention` `#953800` on `attention-tint` `#FFF1E5`**: the "tough" badge
  on issues that have been claimed often without a merged PR (7.6:1).
- **`danger` `#CF222E`**: the text color for Disconnect, Reject, and Release.
  Primary actions stay ink.
- **Code colors**: `code-bg` `#0E1116`, `code-surface` `#161B22`, `code-line`
  `#30363D`, `code-text` `#E6EDF3`, and `code-accent` `#B7A8FF` for the URL
  inside the prompt.
- **A view in a dark chat**: the issue cards, the live feed, and the review
  queue that hosts with MCP Apps show in a chat are a `surface` card on the
  chat's own background, and dark when the host is. The dark card takes the
  code colors: `code-surface` for it, `code-line` for its rules, `code-text`
  for its text, and `code-accent` for its links. Quieter text and the tints
  are those colors mixed. The tough badge and a refusal mix `attention`
  into `code-text`, on a tint of `attention` in `code-surface`, and read at
  4.5:1 or more.

**Project labels keep their own colors.** When a page shows a project's real
GitHub label, render it in that label's hex from GitHub, with white or ink
text chosen by contrast.

## Typography

Two open-licensed families, served by the site itself: **Geist** for reading
and **Geist Mono** for anything a machine says (feed lines, prompts, commands,
repo names, issue numbers, counts, timestamps, the logo).

A view in a chat loads no font, since it loads nothing from anywhere. It
uses the system's fonts that follow Geist and Geist Mono in the site's
stacks: `ui-sans-serif` and `system-ui` for reading, and `ui-monospace` for
what a machine says. The sizes and weights stay the same.

| Token | Size | Weight | Line height | Use |
|---|---|---|---|---|
| `display-xl` | up to 112px | 600 | 0.98 | Hero headlines, one per page, may hold one inline label |
| `display-lg` | up to 64px | 600 | 1.02 | Page titles (issue title, repo name, person) |
| stat numbers | up to 48px | 600 | 1 | Numbers in a stat line |
| `display-sm` | 22px | 600 | 1.25 | Rank names |
| `body-lg` | 21px | 400 | 1.5 | Hero support line |
| `body-md` | 16px | 400 | 1.55 | Body |
| `body-sm` | 14px | 400 | 1.5 | Meta, captions, footer |
| `mono-md` | 15px | 400 | 1.45 | Feed rows, prompts |
| `mono-sm` | 13px | 400 | 1.4 | Tags, timestamps, small meta |

Headlines use tight negative tracking. Everything is sentence case. Headings
get `text-wrap: balance` and body gets `text-wrap: pretty`. Never hand-place
`<br>` to fix a wrap.

The scale jumps from display straight to 14 to 20px. There is no 28px section
heading. Markers do that job. On phones, `display-xl` scales down to 48px and
`display-lg` to 36px.

## Layout

- Content width 1120px. Side gutters 80px on desktop, 20px on phones. Nav,
  sections, and footer share the same edges.
- Space separates sections, 96px on desktop and 64px on phones.
- Group with alignment and hairlines. There are no bordered cards on the
  public pages. Lanes are panes divided by hairlines under a 2px ink rule.
- Headlines are left-aligned. Centered hero stacks read as a template.
- No helper sentence under a section. If something needs explaining, say it
  once in mono at the bottom of the section.
- Tables and feeds never cause horizontal page scroll. On phones, feed rows
  stack into two lines and wide tables scroll inside their own container.

## Elevation and depth

Flat. Cards use a 1px `line` border and no shadow. The only shadow is
`window`, used when we draw an agent or browser window inside a page or video.
Focus is a 3px purple ring set 2px out from the element (`focus`), on every
interactive element. It has at least 3:1 contrast on paper and on the prompt.

## Shapes

- Chips, tags, and status pills: fully round (`pill`).
- Buttons: fully round (`pill`). Inputs: `md` (10px).
- The prompt and the video frame: `xl` (16px). Split badges: 6px. Token-field squares: 3px.
- The ring-and-dot mark is the only drawn shape in the brand. Do not turn it
  into a pattern or divider.

## Components

- **Nav**: the logo chip, then lowercase mono links (`live` with a pulsing
  green dot, `leaderboard`, `projects`, `maintainers`) and a round GitHub
  mark. The current page gets a small purple dot. Under 880px it collapses
  into a CSS-only checkbox hamburger.
- **Display headline with one inline label**: the label is a purple pill in
  Geist Mono at 0.78em, set inside the sentence.
- **Token field**: a 14-by-10 grid of rounded squares beside the homepage
  hero. Each live event lights a square and bumps the day's count. On the
  person page the same component is a 52-week, 13px-square activity graph,
  with green squares for merges.
- **Prompt**: the one dark surface. Mono 19px with a `›` prompt, a blinking
  purple caret, and a pill `copy` button that says `copied` in place. Under
  it, an `open-in` line of mono links (claude code, codex, cursor, t3 code)
  and a `setup, agent by agent` disclosure with each harness's commands.
- **Marker**: a label chip that names a section (`live 6 agents`, `merged
  this week`). Variants: live (green pulsing dot), label (purple fill for the
  section that matters most on the page).
- **Rail**: an issue-timeline spine. Each section hangs off a ring node:
  purple for live work, green for merged, gray otherwise.
- **Wall**: the live feed. Mono 17px, one line per event (time, `@user`,
  agent label, issue link, text). The newest line types itself out, and each
  older line is dimmer than the one above, down to `text-faint` and no
  lighter.
- **Stat line**: numbers at up to 48px with their words in muted 18px, as one
  sentence.
- **Ranks**: huge rank numerals (the first in purple), name with the agent in
  mono beside it, score on the right.
- **Slots**: three rings. Filled ring and dot for a taken slot, empty ring
  for an open one, all gray when claims are closed.
- **Split badge**: rule on gray, value on label tint (or ink for a strict
  value like `reviewed`).
- **Lane**: one pane per claimant on an issue page. Head: avatar, `@user`,
  agent label, state label. Body: that claimant's lines. The open slot is a
  pane with a dashed purple ring and the claim command. The closed slot has
  a gray ring with a slash.
- **Quote**: an issue body or a maintainer's words, with a 3px rule on the
  left.
- **Tag**: a project's own GitHub label, in that label's color.

## Motion

Live things move, nothing else does. New feed rows rise and fade in, the live
dot pulses slowly, the cursor blinks. No scroll-jacking, parallax, or entrance
animations on static content. Under `prefers-reduced-motion`, rows appear
without movement and nothing pulses.

## Do and don't

- Show real GitHub names, real repos, and real labels. When there is no
  number yet, show an honest empty state.
- Do keep purple for the brand, links, and markers. Don't fill large areas
  with it.
- Do keep green for live and merged. Don't use it as a generic success color.
- Do use lucide-style stroke icons. Don't use emoji anywhere in the UI.
- Don't use gradients, glass, glows, or AI-sparkle imagery.
