import type { AiSentence, BanLine } from '@goodfirsttoken/core';
import { getProject, keepCrawlerPause, setProjectStatusFrom } from '../db';

// The pause the policy crawler makes on its own (spec section 5, and
// docs/specs/model-policy-reader.md, under Pausing a listing): a pause that
// names no one, so only an admin lifts it, kept in the status history, with
// why for the admin queue. The weekly read makes it for a move into a ban,
// and for pull requests limited to collaborators.

/** The reason for a pause on a ban the crawler's rules read, before the model read policies, which those pauses still have. The project's maintainers read it with project_status. It holds no text of the repo's. */
export const BAN_REASON =
  "Its docs now read as a ban on AI help, by the policy crawler's rules. An admin checks them before agents can claim its issues again.";

/** The reason for a pause on a ban the model reader read twice, once it decides. It holds no text of the repo's. */
export const MODEL_BAN_REASON = 'Its docs now read as a ban on AI help. An admin checks them before agents can claim its issues again.';

/** How many times a pause is decided again when the status changed while it ran. */
const PAUSE_ATTEMPTS = 3;

/**
 * Pauses the project for Good First Token with `reason`, naming no one, and
 * keeps why for the admin queue. It lands only on the status it was decided
 * on, so a change someone made meanwhile is decided on again. With
 * `anyPause`, a pause someone else made becomes this one: a maintainer's, an
 * admin's, or one Good First Token made for another reason. Without it, only
 * an approved project is paused. True when it paused the project.
 */
export async function pauseForCrawler(
  deps: { db: D1Database; now: () => number },
  repo: string,
  reason: string,
  why: { ban: BanLine | null; aiSentences: AiSentence[]; moreAiSentences: number },
  anyPause: boolean,
): Promise<boolean> {
  const { db, now } = deps;
  let current = await getProject(db, repo);
  for (let attempt = 0; attempt < PAUSE_ATTEMPTS; attempt++) {
    if (current === null) return false;
    const open = current.status === 'approved' || (anyPause && current.status === 'paused');
    if (!open) return false;
    if (current.status === 'paused' && current.statusChangedBy === null && current.statusReason === reason) {
      // Paused for this already. The admins see the latest reading.
      await keepCrawlerPause(db, current.repo, { pausedAt: current.statusChangedAt, ...why }, now());
      return false;
    }
    const paused = await setProjectStatusFrom(db, current, { status: 'paused', reason, changedBy: null }, now());
    if (paused !== null) {
      await keepCrawlerPause(db, paused.repo, { pausedAt: paused.statusChangedAt, ...why }, now());
      console.warn(`The policy crawler paused ${paused.repo}: ${reason}`);
      return true;
    }
    current = await getProject(db, repo);
  }
  return false;
}
