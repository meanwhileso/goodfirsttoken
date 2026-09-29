import { doNotListNote, productName, type ToolOutputInput } from '@goodfirsttoken/core';
import { createFileRoute, Link, notFound, redirect } from '@tanstack/react-router';
import { useId, type CSSProperties, type ReactNode } from 'react';
import { getAdminPage, type AdminPage, type PolicyListing } from '../admin/data';
import { answerAdminForm } from '../admin/page';
import { ADMIN_PATH } from '../admin/paths';
import { SiteNav } from '../auth/SiteNav';
import { Button } from '../components/Button';
import { Tag } from '../components/Chip';
import { Footer } from '../components/Footer';
import { Marker } from '../components/Marker';
import { Quote } from '../components/Quote';
import { SplitBadge, SplitBadges } from '../components/SplitBadge';
import adminCss from '../styles/admin-page.css?url';

// The admin pages (brand/brief-website.md), which replaced prototype/admin.html: the
// crawler's finds and the registrations waiting for an admin, the projects
// listed from a policy, a form to list one by hand, and the blocked donors.
// Only admins see it. Its forms post to /admin, and go through the same
// actions as the admin's MCP tools (src/admin/).
export const Route = createFileRoute('/admin')({
  validateSearch: (search: Record<string, unknown>): { notice?: string; sig?: string } => ({
    ...(typeof search.notice === 'string' ? { notice: search.notice } : {}),
    ...(typeof search.sig === 'string' ? { sig: search.sig } : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const result = await getAdminPage({ data: deps });
    if (result.state === 'signed_out') throw redirect({ to: '/sign-in' });
    if (result.state === 'not_found') throw notFound();
    return result.page;
  },
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData ? `Admin · ${productName}` : `Not found · ${productName}` }],
    links: [{ rel: 'stylesheet', href: adminCss }],
  }),
  server: {
    handlers: {
      POST: ({ request }) => answerAdminForm(request),
    },
  },
  component: Admin,
  notFoundComponent: NotFound,
});

type QueueItem = ToolOutputInput<'admin_queue'>['items'][number];
type Settings = QueueItem['settings'];

const YEAR = 365 * 24 * 60 * 60 * 1000;
const UNITS: [number, string][] = [
  [YEAR, 'year'],
  [30 * 24 * 60 * 60 * 1000, 'month'],
  [24 * 60 * 60 * 1000, 'day'],
  [60 * 60 * 1000, 'hour'],
  [60 * 1000, 'minute'],
];

/** How long ago, like `3 hours`, from the time the page was read, so the server and the page agree. */
function span(then: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(then));
  for (const [size, unit] of UNITS) {
    const n = Math.floor(elapsed / size);
    if (n >= 1) return `${String(n)} ${unit}${n === 1 ? '' : 's'}`;
  }
  return 'under a minute';
}

function tierName(tier: PolicyListing['policy']['tier']): string {
  return tier === 'invites_agents' ? 'invites agents' : 'allows with conditions';
}

/**
 * The repo's facts from GitHub, or why there are none. When GitHub no longer
 * takes the admin's token, the banner says to sign in again, and the item
 * says nothing more.
 */
function Facts({ item, now, signInAgain }: { item: QueueItem; now: number; signInAgain: boolean }) {
  const facts = item.facts;
  if (facts === null) {
    if (signInAgain) return null;
    return item.factsMissing === 'no_answer' ? (
      <p className="admin-item__warning">
        GitHub didn't answer when asked about {item.repo}. Load the page again for its facts.
      </p>
    ) : (
      <p className="admin-item__warning">GitHub showed no public repo named {item.repo} just now.</p>
    );
  }
  return (
    <SplitBadges>
      <SplitBadge rule="stars" value={facts.stars.toLocaleString('en-US')} />
      <SplitBadge rule="created" value={`${span(facts.createdAt, now)} ago`} />
      <SplitBadge rule="last push" value={`${span(facts.pushedAt, now)} ago`} />
      <SplitBadge rule="owner" value={`${span(facts.ownerCreatedAt, now)} old`} />
    </SplitBadges>
  );
}

/** The settings as badges, for the ones given. */
function SettingsBadges({ settings }: { settings: Settings }) {
  const badges: ReactNode[] = [];
  const add = (rule: string, value: string, strict?: boolean) =>
    badges.push(<SplitBadge key={rule} rule={rule} value={value} strict={strict} />);
  if (settings.tags !== undefined) add('tags', settings.tags.length > 0 ? settings.tags.join(', ') : 'none');
  if (settings.excludedTags !== undefined && settings.excludedTags.length > 0) add('excluded', settings.excludedTags.join(', '));
  if (settings.issueRepo) add('issues in', settings.issueRepo);
  if (settings.prMode !== undefined) add('PRs', settings.prMode, settings.prMode === 'reviewed');
  if (settings.whoCanClaim !== undefined) add('claim', settings.whoCanClaim);
  if (settings.personWrittenDescription !== undefined) {
    add('description', settings.personWrittenDescription ? 'person writes' : 'agent may write');
  }
  if (settings.disclosure?.trailer) add('disclose', `${settings.disclosure.trailer}:`);
  if (settings.claUrl !== undefined) add('CLA', settings.claUrl ?? 'none');
  if (settings.claimsPerIssue !== undefined) add('slots', String(settings.claimsPerIssue));
  if (settings.openPrsPerDonor !== undefined) add('open PRs each', String(settings.openPrsPerDonor));
  return badges.length > 0 ? <SplitBadges>{badges}</SplitBadges> : <p className="small muted">None suggested.</p>;
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="admin-item__block">
      <span className="mono small faint">{label}</span>
      {children}
    </div>
  );
}

function ReasonField({ label, placeholder }: { label: string; placeholder: string }) {
  const id = useId();
  return (
    <div className="admin-field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} name="reason" className="admin-textarea" required maxLength={500} placeholder={placeholder} />
    </div>
  );
}

const SOURCE_LABELS: Record<QueueItem['sources'][number]['about'], string> = {
  excludedTags: 'excluded tags',
  whoCanClaim: 'who can claim',
  disclosure: 'disclosure',
  personWrittenDescription: 'person-written PR description',
  claUrl: 'CLA',
  prMode: 'PR mode',
  canary: 'a canary for agents that read the file. No setting comes from it',
};

/** The line in the repo's files behind each suggested setting, and any canary, as the files have them. */
function Sources({ item }: { item: QueueItem }) {
  if (item.sources.length === 0) return null;
  return (
    <Block label="the lines behind them, from the repo's files">
      {item.sources.map((source) => (
        <div
          key={`${source.about} ${source.path} ${source.line ?? ''}`}
          className="stack"
          style={{ '--gap': '6px' } as CSSProperties}
        >
          <span className="mono small muted">
            {SOURCE_LABELS[source.about]} · {source.path}
          </span>
          {source.line !== null && <Quote>{source.line}</Quote>}
        </div>
      ))}
    </Block>
  );
}

/**
 * Every sentence in the repo's docs that names AI, with the rest of its
 * paragraph, as the files have them, for the admin to read before a verdict.
 */
function AiSentences({ item }: { item: QueueItem }) {
  if (item.aiSentences.length === 0 && item.moreAiSentences === 0) return null;
  return (
    <Block label="every sentence in its docs that names AI, with the rest of its paragraph. Read them before you decide">
      {item.aiSentences.map((sentence, i) => (
        <div key={`${String(i)} ${sentence.path}`} className="stack" style={{ '--gap': '6px' } as CSSProperties}>
          <span className="mono small muted">{sentence.path}</span>
          {sentence.cutBefore && <span className="mono small muted">The paragraph starts earlier in the file.</span>}
          <Quote>{sentence.text}</Quote>
          {sentence.cutAfter && <span className="mono small muted">The paragraph goes on in the file.</span>}
        </div>
      ))}
      {item.moreAiSentences > 0 && (
        <span className="mono small muted">
          {item.moreAiSentences.toLocaleString('en-US')} more in the files. Read them there.
        </span>
      )}
    </Block>
  );
}

function DoNotListNote({ item }: { item: QueueItem }) {
  return item.onDoNotList ? <p className="admin-item__warning">{doNotListNote(item.kind)}</p> : null;
}

function Candidate({ item, now, signInAgain }: { item: QueueItem; now: number; signInAgain: boolean }) {
  const titleId = useId();
  const tagsId = useId();
  const tierId = useId();
  const policy = item.policy;
  const tags = item.settings.tags ?? item.suggestedTags.map((tag) => tag.name);
  return (
    <article className="admin-item" aria-labelledby={titleId}>
      <div className="stack" style={{ '--gap': '6px' } as CSSProperties}>
        <h3 id={titleId} className="admin-item__repo">
          {item.repo}
        </h3>
        <span className="mono small muted">found {span(item.requestedAt, now)} ago</span>
      </div>
      <Facts item={item} now={now} signInAgain={signInAgain} />
      {policy && (
        <Quote>
          &ldquo;{policy.quote}&rdquo;{' '}
          <a className="mono small" href={policy.url}>
            {policy.url.replace(/^https:\/\//, '')}
          </a>
        </Quote>
      )}
      <Block label="what the crawler read from it">
        <SplitBadges>
          {policy && <SplitBadge rule="tier" value={tierName(policy.tier)} strict />}
        </SplitBadges>
        <SettingsBadges settings={item.settings} />
      </Block>
      <Sources item={item} />
      <AiSentences item={item} />
      {item.suggestedTags.length > 0 && (
        <Block label="labels that could mean ready for help">
          <div className="admin-item__labels">
            {item.suggestedTags.map((tag) => (
              <span key={tag.name} className="cluster" style={{ '--gap': '8px' } as CSSProperties}>
                <Tag>{tag.name}</Tag>
                <span className="mono small muted">{tag.openIssues.toLocaleString('en-US')} open</span>
              </span>
            ))}
          </div>
        </Block>
      )}
      <DoNotListNote item={item} />
      <form method="post" action={ADMIN_PATH}>
        <input type="hidden" name="action" value="decide" />
        <input type="hidden" name="id" value={item.id} />
        <div className="admin-field">
          <label htmlFor={tagsId}>its own tags, separated by commas</label>
          <input id={tagsId} name="tags" className="admin-input admin-input--mono" defaultValue={tags.join(', ')} />
        </div>
        <div className="admin-field">
          <label htmlFor={tierId}>tier</label>
          <select id={tierId} name="tier" className="admin-select" defaultValue={policy?.tier ?? 'allows_with_conditions'}>
            <option value="invites_agents">invites agents</option>
            <option value="allows_with_conditions">allows with conditions</option>
          </select>
        </div>
        <ReasonField label="reason, needed to skip" placeholder="Why this project should stay out for now." />
        <div className="cluster admin-item__buttons">
          <Button type="submit" variant="danger" name="decision" value="reject">
            Skip
          </Button>
          <Button type="submit" variant="primary" name="decision" value="approve" formNoValidate>
            List from its policy
          </Button>
        </div>
      </form>
    </article>
  );
}

function Registration({ item, now, signInAgain }: { item: QueueItem; now: number; signInAgain: boolean }) {
  const titleId = useId();
  const notes = item.settings.agentNotes ?? '';
  return (
    <article className="admin-item" aria-labelledby={titleId}>
      <div className="stack" style={{ '--gap': '6px' } as CSSProperties}>
        <h3 id={titleId} className="admin-item__repo">
          {item.repo}
        </h3>
        <span className="mono small muted">
          from @{item.requestedBy} · {span(item.requestedAt, now)} ago
        </span>
      </div>
      <Facts item={item} now={now} signInAgain={signInAgain} />
      <DoNotListNote item={item} />
      <Block label="settings they chose">
        <SettingsBadges settings={item.settings} />
      </Block>
      <Block label="notes every agent will read, word for word">
        {notes === '' ? <p className="small muted">No notes.</p> : <p className="admin-item__note">{notes}</p>}
      </Block>
      <form method="post" action={ADMIN_PATH}>
        <input type="hidden" name="action" value="decide" />
        <input type="hidden" name="id" value={item.id} />
        <ReasonField label="reason, needed to reject" placeholder="What should they change? Their agent shows them this." />
        <div className="cluster admin-item__buttons">
          <Button type="submit" variant="danger" name="decision" value="reject">
            Reject
          </Button>
          <Button type="submit" variant="primary" name="decision" value="approve" formNoValidate>
            Approve and list
          </Button>
        </div>
      </form>
    </article>
  );
}

function Listings({ listings }: { listings: PolicyListing[] }) {
  return (
    <section className="stack" aria-label="listed from their policy">
      <Marker as="h2" count={listings.length}>
        listed from their policy
      </Marker>
      {listings.length === 0 ? (
        <p className="admin__empty">No projects listed from a policy yet.</p>
      ) : (
        <ul className="admin-list mono small">
          {listings.map((listing) => (
            <li key={listing.repo}>
              <span className="strong">{listing.repo}</span>
              {listing.status !== 'approved' && <span className="faint"> · {listing.status}</span>}
              <br />
              <a href={listing.policy.url}>{tierName(listing.policy.tier)} ↗</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ListByHand() {
  const ids = { repo: useId(), url: useId(), quote: useId(), tier: useId(), tags: useId() };
  return (
    <section className="stack" aria-label="list one by hand">
      <Marker as="h2">list one by hand</Marker>
      <form method="post" action={ADMIN_PATH}>
        <input type="hidden" name="action" value="add" />
        <div className="admin-field">
          <label htmlFor={ids.repo}>repository</label>
          <input id={ids.repo} name="repo" className="admin-input admin-input--mono" required placeholder="owner/repo" />
        </div>
        <div className="admin-field">
          <label htmlFor={ids.url}>link to where their docs welcome AI</label>
          <input id={ids.url} name="url" type="url" className="admin-input admin-input--mono" required placeholder="https://github.com/owner/repo/blob/main/CONTRIBUTING.md" />
        </div>
        <div className="admin-field">
          <label htmlFor={ids.quote}>their words, quoted exactly</label>
          <textarea id={ids.quote} name="quote" className="admin-textarea" required maxLength={2000} />
        </div>
        <div className="admin-field">
          <label htmlFor={ids.tier}>tier</label>
          <select id={ids.tier} name="tier" className="admin-select" defaultValue="allows_with_conditions">
            <option value="invites_agents">invites agents</option>
            <option value="allows_with_conditions">allows with conditions</option>
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor={ids.tags}>its own tags, separated by commas</label>
          <input id={ids.tags} name="tags" className="admin-input admin-input--mono" required placeholder="help wanted" />
        </div>
        <Button type="submit" variant="primary">
          Add
        </Button>
      </form>
    </section>
  );
}

function Blocked({ blocked }: { blocked: AdminPage['blocked'] }) {
  const loginId = useId();
  const reasonId = useId();
  return (
    <section className="stack" aria-label="blocked">
      <Marker as="h2" count={blocked.length}>
        blocked
      </Marker>
      {blocked.length > 0 && (
        <ul className="admin-list mono small">
          {blocked.map((donor) => (
            <li key={donor.login} className="admin-list__row">
              <span>
                <span className="strong">@{donor.login}</span>
                {donor.reason !== null && (
                  <>
                    <br />
                    <span className="muted">{donor.reason}</span>
                  </>
                )}
              </span>
              <form method="post" action={ADMIN_PATH}>
                <input type="hidden" name="action" value="unblock" />
                <input type="hidden" name="login" value={donor.login} />
                <Button type="submit" size="sm" aria-label={`Unblock @${donor.login}`}>
                  Unblock
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <form method="post" action={ADMIN_PATH}>
        <input type="hidden" name="action" value="block" />
        <div className="admin-field">
          <label htmlFor={loginId}>block a GitHub user</label>
          <input id={loginId} name="login" className="admin-input admin-input--mono" required placeholder="@username" />
        </div>
        <div className="admin-field">
          <label htmlFor={reasonId}>reason, for the admins</label>
          <input id={reasonId} name="reason" className="admin-input" maxLength={500} />
        </div>
        <Button type="submit" variant="danger">
          Block
        </Button>
      </form>
    </section>
  );
}

function Admin() {
  const page = Route.useLoaderData();
  return (
    <>
      <SiteNav current="admin" />
      <main className="wrap admin">
        <div className="admin__head">
          <h1 className="admin__title">Admin</h1>
          <span className="mono small faint">same tools in /goodfirsttoken-admin:admin</span>
        </div>
        {page.notice !== null && (
          <p className="admin__notice" role="status">
            {page.notice}{' '}
            <Link to={ADMIN_PATH} className="mono small">
              dismiss
            </Link>
          </p>
        )}
        {page.signInAgain && (
          <p className="admin__notice">
            GitHub no longer takes the token this site holds for you, so the queue shows no facts from GitHub. Sign out and
            in again to see them.
          </p>
        )}
        <div className="admin__split">
          <div className="admin__main">
            <section className="stack" aria-label="found by the crawler">
              <div className="rail__head">
                <Marker as="h2" variant="label" count={page.candidates.length}>
                  found by the crawler
                </Marker>
                <span className="mono small faint">their docs welcome AI</span>
              </div>
              {page.candidates.length === 0 ? (
                <p className="admin__empty">No finds waiting.</p>
              ) : (
                page.candidates.map((item) => (
                  <Candidate key={item.id} item={item} now={page.now} signInAgain={page.signInAgain} />
                ))
              )}
            </section>
            <section className="stack" aria-label="registrations">
              <div className="rail__head">
                <Marker as="h2" count={page.registrations.length}>
                  registrations
                </Marker>
              </div>
              {page.registrations.length === 0 ? (
                <p className="admin__empty">No registrations waiting.</p>
              ) : (
                page.registrations.map((item) => (
                  <Registration key={item.id} item={item} now={page.now} signInAgain={page.signInAgain} />
                ))
              )}
            </section>
          </div>
          <aside className="admin__aside">
            <Listings listings={page.listings} />
            <ListByHand />
            <Blocked blocked={page.blocked} />
          </aside>
        </div>
      </main>
      <Footer />
    </>
  );
}

function NotFound() {
  return (
    <>
      <SiteNav />
      <main className="wrap admin">
        <h1 className="admin__title">Not found</h1>
        <p className="lede">There is no page at this address.</p>
      </main>
      <Footer />
    </>
  );
}
