import type { Suggestion } from '@goodfirsttoken/core';
import { plural } from '@goodfirsttoken/core/text';
import type { Host } from './bridge';
import { h } from './dom';
import { claimPart, type Claimed } from './live';
import { answerText, badge, issueHead, link, listOf, notice, slots } from './parts';

// The issue cards view: suggest_issues' answer, one card per issue, each
// with a Pick button. Pick calls claim_issue through the host, with the
// donor's own connection, and the server's checks decide. A claim turns the
// card live. A refusal shows its own text.

/** Who holds the issue, in the words suggest_issues' text uses. */
function holders(s: Suggestion): string {
  const named = listOf<Suggestion['claimants'][number]>(s.claimants)
    .map((c) => `@${c.login} (${c.agent})`)
    .join(', ');
  if (s.slotsTaken === 0) return 'nobody on it';
  return `${String(s.slotsTaken)} of ${String(s.slots)} slots taken${named === '' ? '' : `: ${named}`}`;
}

/**
 * What the view tells the agent once the card claimed an issue, so it takes
 * the claim up. As after a pick in the terminal, the agent asks the donor
 * for special instructions first (docs/specs/v1.md, "Donor instructions").
 */
export function pickedMessage(issue: string, claimId: string, sessionId: string): string {
  return `I picked ${issue} in the Good First Token card, which claimed it as claim ${claimId}. Call claim_issue with sessionId ${sessionId} and issue ${issue} to get the claim, ask me "Any special instructions for this one?", then work it.`;
}

interface CardsContext {
  host: Host;
  /** The session the suggestions came from, from the call's input. */
  sessionId: string | null;
  /** Every Pick button, so a claim or a call in flight holds the others. */
  picks: HTMLButtonElement[];
}

function card(context: CardsContext, s: Suggestion): HTMLElement {
  const { host } = context;
  const issueRepo = s.issue.slice(0, s.issue.lastIndexOf('#'));
  const cla = s.claUrl ? h('input', { type: 'checkbox', class: 'view-check__box' }) : null;
  const pick = h('button', { type: 'button', class: 'btn btn--primary btn--sm' }, 'Pick');
  const actions = h('div', { class: 'cluster view-actions' }, link(host, s.url, 'Read it', 'btn btn--sm'), pick);
  const status = h('div', { class: 'view-status' });
  const taken = slots(s.slotsTaken, s.slots);
  const who = h('p', { class: 'view-quiet' }, [holders(s), issueRepo !== s.project && `project: ${s.project}`].filter(Boolean).join(' · '));
  const item = h(
    'article',
    { class: 'view-item view-pick' },
    h('div', { class: 'view-pick__top' }, issueHead(s.issue, s.title), taken),
    h(
      'div',
      { class: 'cluster view-tags' },
      h('span', { class: 'tag' }, s.tag),
      s.tough && h('span', { class: 'chip chip--tough' }, `tough: claimed ${plural(s.timesClaimed, 'time')}`),
      badge('PRs', s.prMode, s.prMode === 'reviewed'),
    ),
    who,
    cla &&
      h(
        'label',
        { class: 'view-check' },
        cla,
        h('span', null, "I signed the project's CLA: ", link(host, s.claUrl, s.claUrl ?? '')),
      ),
    actions,
    status,
  );
  context.picks.push(pick);

  pick.addEventListener('click', () => {
    void (async () => {
      status.replaceChildren();
      if (context.sessionId === null) {
        status.appendChild(notice('The card has no session to claim in. Ask your agent to claim this issue.', 'refused'));
        return;
      }
      for (const button of context.picks) button.disabled = true;
      pick.textContent = 'Claiming';
      const answer = await host.callTool('claim_issue', {
        sessionId: context.sessionId,
        issue: s.issue,
        ...(cla?.checked && s.claUrl ? { claConfirmed: s.claUrl } : {}),
      });
      if (answer.isError || answer.data === null) {
        pick.textContent = 'Pick';
        for (const button of context.picks) button.disabled = false;
        status.appendChild(notice(answer.text || "The claim didn't go through.", 'refused'));
        return;
      }
      const claimed = answer.data as Claimed;
      actions.remove();
      cla?.closest('label')?.remove();
      try {
        // The claim's own line counts the slots now, the donor's among them.
        taken.replaceWith(slots(claimed.slotsTaken, claimed.slots));
        who.remove();
        status.appendChild(claimPart(host, claimed, false));
      } catch {
        status.appendChild(answerText(answer.text));
      }
      try {
        await host.message(pickedMessage(claimed.claim.issue, claimed.claim.claimId, context.sessionId));
      } catch {
        status.appendChild(notice(`Tell your agent to work ${claimed.claim.issue}, claim ${claimed.claim.claimId}.`, 'note'));
      }
    })();
  });
  return item;
}

/** suggest_issues' answer as cards, or its own text when it suggests none. */
export function renderCards(host: Host, data: Record<string, unknown>, text: string, sessionId: string | null): HTMLElement[] {
  const suggestions = listOf<Suggestion>(data.suggestions);
  if (suggestions.length === 0) return [h('p', { class: 'view-quiet view-item' }, text || 'No eligible issues right now.')];
  const context: CardsContext = { host, sessionId, picks: [] };
  return suggestions.map((s) => card(context, s));
}

/** The frame's title for the cards. */
export function cardsTitle(data: Record<string, unknown>): string {
  const count = listOf(data.suggestions).length;
  return count === 0 ? 'tagged for outside help' : `${plural(count, 'issue')} tagged for outside help`;
}
