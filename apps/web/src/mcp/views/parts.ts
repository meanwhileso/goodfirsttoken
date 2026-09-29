import type { ClaimSummary } from '@goodfirsttoken/core';
import { when } from '@goodfirsttoken/core/text';
import type { Host } from './bridge';
import { h, tokenMark, webLink } from './dom';

// The pieces every view is built from, with the design system's classes
// from src/components and src/styles.

/** The view's frame: the logo chip, a title, and the parts under them. */
export function frame(title: string, ...parts: Node[]): HTMLElement {
  return h(
    'section',
    { class: 'view', 'aria-label': `Good First Token: ${title}` },
    h('header', { class: 'view__head' }, h('span', { class: 'logo-chip' }, tokenMark(), 'good first token'), h('span', { class: 'view__title' }, title)),
    parts,
  );
}

/**
 * A button that asks the host to open a web page, since a sandboxed frame
 * can't open one, and the host decides. It carries no URL of its own. When
 * the host won't open it, the page's address shows beside it, to copy. A URL
 * webLink doesn't take shows as its text alone.
 */
export function link(host: Host, url: unknown, text: string, className = 'view-link'): HTMLElement {
  const page = webLink(url);
  if (page === null) return h('span', null, text);
  const button = h('button', { type: 'button', class: className }, text);
  const shown = h('span', { class: 'view-link-wrap' }, button);
  button.addEventListener('click', () => {
    void host.openLink(page).catch(() => {
      if (shown.querySelector('.view-url') === null) shown.appendChild(h('span', { class: 'view-url' }, page));
    });
  });
  return shown;
}

/** An issue's reference and title, as the cards and the queue head each item. */
export function issueHead(issue: string, title: string): HTMLElement {
  return h('div', { class: 'view-issue' }, h('span', { class: 'view-issue__ref' }, issue), h('span', { class: 'view-issue__title' }, title));
}

/** A notice under an item: what a button did, or the refusal's own text. */
export function notice(text: string, kind: 'refused' | 'done' | 'note'): HTMLElement {
  return h('p', { class: `view-notice view-notice--${kind}`, role: kind === 'refused' ? 'alert' : 'status' }, text);
}

/** The answer's own text, when there is nothing else to show, as a terminal harness would show it. */
export function answerText(text: string): HTMLElement {
  return h('pre', { class: 'view-text' }, text || 'No answer came back.');
}

/** An issue's slots as token marks, as Slots in src/components draws them. */
export function slots(taken: number, total: number): HTMLElement {
  const rings = Array.from({ length: Math.max(0, Math.min(total, 10)) }, (_, i) =>
    h('i', { class: i < taken ? 'slots__slot slots__slot--taken' : 'slots__slot' }),
  );
  return h('span', { class: 'slots', role: 'img', 'aria-label': `${String(taken)} of ${String(total)} taken` }, rings);
}

/** A rule and its value, as SplitBadge draws it, with a strict value on ink. */
export function badge(rule: string, value: string, strict: boolean): HTMLElement {
  return h('span', { class: strict ? 'badge badge--strict' : 'badge' }, h('span', { class: 'badge__rule' }, rule), h('span', { class: 'badge__value' }, value));
}

/** When a claim expires, as the tools' text says it, or nothing once it can't. */
export function expires(claim: Pick<ClaimSummary, 'expiresAt'>): string | null {
  return claim.expiresAt ? `expires ${when(claim.expiresAt)}` : null;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The items of a list in a tool's answer, or none when it isn't one. */
export function listOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter(isObject) as T[]) : [];
}
