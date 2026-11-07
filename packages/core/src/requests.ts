import { z } from 'zod';

// Donors' requests for a repo they want to work on (docs/specs/add-a-repo.md,
// under Requesting a repo). A request lists nothing. It records who asked for
// which repo, and reports only what the site already shows: whether the repo
// has a project page.

/** The most new requests one person sends in a UTC day, withdrawn ones included. */
export const MAX_REQUESTS_PER_DAY = 10;

/** The most live requests one person has. */
export const MAX_LIVE_REQUESTS = 50;

/**
 * Where a requested repo stands, worked out when it is read, by the rule the
 * project page uses for which projects have a page.
 *
 * - `listed`: a project that has the repo as its code repo or its issue repo
 *   has a page and is approved.
 * - `paused`: such a project has a page and is paused.
 * - `not_listed`: no such project has a page. Pending and rejected projects,
 *   the do-not-list, and delisted projects all read this way, so none shows.
 */
export const requestStatuses = ['listed', 'paused', 'not_listed'] as const;
export const requestStatusSchema = z.enum(requestStatuses);
export type RequestStatus = z.infer<typeof requestStatusSchema>;

/** The words for the person, for each status. */
export const REQUEST_STATUS_WORDS: Record<RequestStatus, string> = {
  listed: 'Listed. Find its issues on its project page.',
  paused: 'Listed and paused. It takes no claims right now.',
  not_listed: 'Not listed on Good First Token yet. Its maintainers can register it at /maintainers.',
};

/** The longest repo a request takes, as typed: a name, or a link to one. */
export const MAX_REQUEST_INPUT = 300;
