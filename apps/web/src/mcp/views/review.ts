import type { ToolOutput } from '@goodfirsttoken/core';
import { plural } from '@goodfirsttoken/core/text';
import type { Host } from './bridge';
import { h } from './dom';
import { expires, isObject, issueHead, link, listOf, notice } from './parts';

// The review queue view: my_work's answer. Each piece of work waiting to
// open as a PR has its diff, its notes, and an Open PR button, which calls
// open_pr through the host with the donor's own connection. The server's
// checks decide, and a refusal shows its own text. The follow-ups and the
// claims in progress are listed after it. A field the view doesn't know is
// left out, so the answer can grow without breaking it.

type MyWork = ToolOutput<'my_work'>;
type ReadyItem = MyWork['readyToOpen'][number];
type WorkingClaim = MyWork['working'][number];

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function section(title: string, items: HTMLElement[]): HTMLElement | null {
  if (items.length === 0) return null;
  return h('div', { class: 'view-section' }, h('h2', { class: 'view-section__title' }, title), items);
}

/**
 * An item waiting to open as a PR. `told` holds what the agent heard of each
 * PR the queue opened so far. A context update takes the place of the one
 * before it, so each one names them all.
 */
function readyItem(host: Host, item: ReadyItem, told: string[]): HTMLElement {
  const size = item.additions === null || item.deletions === null ? null : `+${String(item.additions)} -${String(item.deletions)}`;
  const description = item.personWrittenDescription
    ? h('textarea', { class: 'view-field', rows: 5, 'aria-label': 'Your PR description, in your own words' })
    : null;
  const open = h('button', { type: 'button', class: 'btn btn--primary btn--sm' }, 'Open PR');
  const actions = h('div', { class: 'cluster view-actions' }, link(host, item.diffUrl, 'Read the diff', 'btn btn--sm'), open);
  const status = h('div', { class: 'view-status' });
  if (!item.openable) {
    open.disabled = true;
    status.appendChild(notice(`Can't open it now: ${item.reason ?? 'Release the claim with release_claim.'}`, 'note'));
  }

  open.addEventListener('click', () => {
    void (async () => {
      status.replaceChildren();
      open.disabled = true;
      open.textContent = 'Opening';
      const written = description?.value.trim() ?? '';
      const answer = await host.callTool('open_pr', { claimId: item.claimId, ...(written === '' ? {} : { description: written }) });
      if (answer.isError || !isObject(answer.data)) {
        open.textContent = 'Open PR';
        open.disabled = false;
        status.appendChild(notice(answer.text || "The PR didn't open.", 'refused'));
        return;
      }
      const opened = answer.data as ToolOutput<'open_pr'>;
      actions.remove();
      description?.closest('label')?.remove();
      status.appendChild(
        h(
          'p',
          { class: 'view-notice view-notice--done', role: 'status' },
          `Opened PR #${String(opened.pr.number)}: `,
          link(host, opened.pr.url, opened.pr.url),
          opened.prOnIssue && ` Another PR is open on the issue too: ${opened.prOnIssue.url}`,
        ),
      );
      // The agent hears of it at its next turn, so it doesn't open it again.
      // When the host won't tell it, the donor can.
      told.push(answer.text);
      await host.updateContext(told.join('\n')).catch(() => {
        status.appendChild(notice(`Tell your agent you opened PR #${String(opened.pr.number)} for claim ${item.claimId}.`, 'note'));
      });
    })();
  });

  return h(
    'article',
    { class: 'view-item view-ready' },
    issueHead(item.issue, item.title),
    h('p', { class: 'view-meta' }, [`claim ${item.claimId}`, size, `${item.agent} (${item.model})`, expires(item)].filter(Boolean).join(' · ')),
    text(item.summary) && h('blockquote', { class: 'quote view-summary' }, item.summary),
    text(item.checks) && h('p', { class: 'view-quiet' }, `checked: ${item.checks}`),
    item.prOnIssue &&
      h(
        'p',
        { class: 'view-notice view-notice--note' },
        'A PR is already open on the issue: ',
        link(host, item.prOnIssue.url, item.prOnIssue.url),
        '. Open this one if a second PR helps.',
      ),
    description && h('label', { class: 'view-label' }, h('span', null, 'The project asks you to write the PR description.'), description),
    actions,
    status,
  );
}

/** A maintainer asked for changes. Each field is read with care, since follow-ups are still taking shape. */
function followUpItem(host: Host, followUp: Record<string, unknown>): HTMLElement {
  const pr = isObject(followUp.pr) ? followUp.pr : {};
  const ref = text(pr.repo) && typeof pr.number === 'number' ? `${String(pr.repo)}#${String(pr.number)}` : text(followUp.issue);
  const comment = text(followUp.comment)?.split('\n')[0];
  return h(
    'article',
    { class: 'view-item' },
    issueHead(ref ?? '', text(followUp.title) ?? ''),
    h('p', { class: 'view-quiet' }, [text(followUp.reviewer) && `@${String(followUp.reviewer)} asked for changes`, comment].filter(Boolean).join(': ')),
    text(followUp.commentUrl) && h('p', { class: 'view-links' }, link(host, followUp.commentUrl, 'the comment on GitHub')),
  );
}

function workingItem(host: Host, claim: WorkingClaim): HTMLElement {
  return h(
    'article',
    { class: 'view-item' },
    issueHead(claim.issue, claim.title),
    h('p', { class: 'view-meta' }, [`claim ${claim.claimId}`, expires(claim)].filter(Boolean).join(' · ')),
    !claim.resumable && notice(`Can't go on: ${claim.reason ?? 'Release it with release_claim.'}`, 'note'),
    h('p', { class: 'view-links' }, link(host, claim.liveUrl, 'watch it on the issue page')),
  );
}

/** my_work's answer as the review queue, or its own text when nothing waits. */
export function renderReview(host: Host, data: Record<string, unknown>, answerText: string): HTMLElement[] {
  const ready = listOf<ReadyItem>(data.readyToOpen);
  const followUps = listOf<Record<string, unknown>>(data.followUps);
  const working = listOf<WorkingClaim>(data.working);
  if (ready.length + followUps.length + working.length === 0) {
    return [h('p', { class: 'view-quiet view-item' }, answerText || 'Nothing waiting.')];
  }
  const told: string[] = [];
  return [
    section(`Maintainers asked for changes (${String(followUps.length)})`, followUps.map((f) => followUpItem(host, f))),
    ready.length === 0
      ? h('p', { class: 'view-quiet view-item' }, 'No work waits to open as a PR.')
      : section(`Ready to open as a PR (${String(ready.length)})`, ready.map((item) => readyItem(host, item, told))),
    section(`In progress (${String(working.length)})`, working.map((claim) => workingItem(host, claim))),
  ].filter((part): part is HTMLElement => part !== null);
}

/** The frame's title for the queue. */
export function reviewTitle(data: Record<string, unknown>): string {
  const ready = listOf(data.readyToOpen).length;
  return ready === 0 ? 'review queue' : `review queue: ${plural(ready, 'PR')} to open`;
}
