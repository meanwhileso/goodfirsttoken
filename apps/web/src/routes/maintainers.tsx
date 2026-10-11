import {
  DEFAULT_CLAIMS_PER_ISSUE,
  DEFAULT_OPEN_PRS_PER_DONOR,
  DEFAULT_PR_MODE,
  DEFAULT_WHO_CAN_CLAIM,
  defaultDisclosure,
  MAX_CLAIMS_PER_ISSUE,
  MAX_OPEN_PRS_PER_DONOR,
  MIN_CLAIMS_PER_ISSUE,
  MIN_OPEN_PRS_PER_DONOR,
  productName,
} from '@goodfirsttoken/core';
import { createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { SiteNav } from '../auth/SiteNav';
import { Footer } from '../components/Footer';
import { InlineLabel } from '../components/InlineLabel';
import { Marker } from '../components/Marker';
import { REPO_URL } from '../components/Nav';
import { OpenIn } from '../components/OpenIn';
import { Prompt } from '../components/Prompt';
import { Rail, RailHead, RailSection } from '../components/Rail';
import { SplitBadge, SplitBadges } from '../components/SplitBadge';
import maintainersCss from '../styles/maintainers-page.css?url';
import { routeHead } from '../readable/head';

// The page for maintainers (brand/brief-website.md), which replaced
// prototype/maintainers.html: how to register a repo from their own agent,
// the rules they set there, how to take over a listing made from their AI
// policy, and how to ask to be removed. It reads nothing, and is public.
// Each sentence says what docs/how-it-works.md says the tools do, and each
// default and range comes from core, which applies them.
export const Route = createFileRoute('/maintainers')({
  head: ({ matches }) =>
    routeHead(
      matches,
      {
        title: `Maintainers · ${productName}`,
        description:
          'Get agent help on your repo. You pick the issues and set the rules.',
        path: '/maintainers',
      },
      [{ rel: 'stylesheet', href: maintainersCss }],
    ),
  component: Maintainers,
});

const REPO = 'meanwhileso/goodfirsttoken';
const PROMPT = 'Put my repo on Good First Token.';
/** The maintain skill as the standalone skills install it, with its steps for adding the server in each agent. */
const SKILL_URL = `${REPO_URL}/blob/main/skills/goodfirsttoken-maintain/SKILL.md`;

/** The install commands for each harness, in the prompt's small boxes, as the homepage's setup shows them. */
function Install() {
  const skills = `npx skills add ${REPO}`;
  return (
    <dl className="maintainers-install">
      <dt>claude code</dt>
      <dd>
        <Prompt small copy={`/plugin marketplace add ${REPO}`} copyName="Copy the Claude Code marketplace command">
          /plugin marketplace add {REPO}
        </Prompt>
        <Prompt small copy="/plugin install goodfirsttoken@goodfirsttoken" copyName="Copy the Claude Code install command">
          /plugin install goodfirsttoken@goodfirsttoken
        </Prompt>
      </dd>
      <dt>codex, opencode, cursor</dt>
      <dd>
        <Prompt shell copy={skills} copyName="Copy the skills command">
          {skills}
        </Prompt>
      </dd>
      <dt>grok bot</dt>
      <dd>Ask it to install the skill from github.com/{REPO}.</dd>
    </dl>
  );
}

interface Badge {
  rule: string;
  value: string;
  strict?: boolean;
}

/** A rule a maintainer sets, with a badge for each part of its default. */
function Rule({ name, badges, children }: { name: string; badges: Badge[]; children: ReactNode }) {
  return (
    <li className="maintainers-rule">
      <span className="maintainers-rule__name">{name}</span>
      <span className="maintainers-rule__text">{children}</span>
      <SplitBadges>
        {badges.map((badge) => (
          <SplitBadge key={badge.value} rule={badge.rule} value={badge.value} strict={badge.strict} />
        ))}
      </SplitBadges>
    </li>
  );
}

const { trailer, prBody } = defaultDisclosure;

/** The default disclosure as badges, the way a project page draws a project's. */
const disclosureBadges: Badge[] = [
  ...(trailer === null ? [] : [{ rule: 'disclose', value: trailer }]),
  ...(prBody === null ? [] : [{ rule: 'disclose', value: 'in the PR body' }]),
];

/** The default disclosure in words, with the PR body's line as it goes into the PR. */
function DefaultDisclosure() {
  return (
    <>
      By default, {trailer !== null && <>the <span className="mono">{trailer}</span> trailer</>}
      {trailer !== null && prBody !== null && ' and '}
      {prBody !== null && <>the line <q>{prBody}</q> in the PR body</>}.
    </>
  );
}

/** The whole numbers a setting takes, as "1 to 10". */
function range(min: number, max: number): string {
  return `${String(min)} to ${String(max)}`;
}

function Maintainers() {
  return (
    <>
      <SiteNav current="maintainers" />
      <main className="wrap maintainers">
        <h1 className="display maintainers__title">
          Get agent help on your <InlineLabel>issues</InlineLabel>
        </h1>
        <p className="lede maintainers__lede">
          You pick the issues and set the rules.
        </p>

        <section className="maintainers__start" aria-label="Start">
          <Prompt copy={PROMPT} caret>
            {PROMPT}
          </Prompt>
          <OpenIn prompt={PROMPT} />
          <p className="mono small muted">
            already set up? in claude code, run <span className="strong">/goodfirsttoken:maintain owner/repo</span>
          </p>
        </section>

        <Rail className="maintainers__rail">
          <RailSection>
            <RailHead>
              <Marker as="h2">set up your agent</Marker>
            </RailHead>
            <Install />
            <p className="maintainers__note">
              These installs include the maintain skill. Follow <a href={SKILL_URL}>its setup instructions</a> to connect
              your agent.
            </p>
          </RailSection>

          <RailSection node="live">
            <RailHead>
              <Marker as="h2">
                add your repo
              </Marker>
            </RailHead>
            <ol className="maintainers-steps">
              <li>
                Sign in with GitHub through your agent. Good First Token checks that you are a repo admin or
                maintainer on every call.
              </li>
              <li>
                Your repo must be public and accept pull requests from anyone. Archived repos cannot register.
              </li>
              <li>
                Your agent uses <span className="mono">register_project</span> to read your labels and repo rules.
                It suggests settings and explains any changes from the defaults. Confirm the settings before it saves them.
              </li>
              <li>
                A Good First Token admin reviews your repo before agents can claim issues. Your agent checks{' '}
                <span className="mono">project_status</span> for the decision and any rejection reason.
              </li>
            </ol>
          </RailSection>

          <RailSection>
            <RailHead>
              <Marker as="h2">your rules</Marker>
            </RailHead>
            <ul className="maintainers-rules">
              <Rule name="Which issues" badges={[{ rule: 'tags', value: 'required', strict: true }]}>
                Pick the labels agents can work on. Issues must be open and unassigned. Excluded labels keep an issue
                out. If you choose <span className="mono">goodfirsttoken</span>, Good First Token adds that label
                using your GitHub account if it is missing.
              </Rule>
              <Rule name="Slots" badges={[{ rule: 'slots', value: String(DEFAULT_CLAIMS_PER_ISSUE) }]}>
                {`Choose how many people can claim an issue at once. The default is ${String(DEFAULT_CLAIMS_PER_ISSUE)}. You can set it from ${range(MIN_CLAIMS_PER_ISSUE, MAX_CLAIMS_PER_ISSUE)}.`}{' '}
                An open PR linked to the issue closes new claims.
              </Rule>
              <Rule name="PR mode" badges={[{ rule: 'PRs', value: DEFAULT_PR_MODE, strict: DEFAULT_PR_MODE === 'reviewed' }]}>
                <span className="mono">reviewed</span> asks the person to read the diff and open the PR.{' '}
                <span className="mono">automatic</span> opens the PR when the agent submits work. Some changes still
                need a person to review them. These include workflow files and issues with an open PR.
              </Rule>
              <Rule name="Who can claim" badges={[{ rule: 'claim', value: DEFAULT_WHO_CAN_CLAIM, strict: DEFAULT_WHO_CAN_CLAIM === 'vouched' }]}>
                Allow anyone, or require a vouch. With vouches required, people need a vouch in your file or write
                access to the repo. A denouncement in the file blocks someone in either mode.
              </Rule>
              <Rule name="Disclosure" badges={disclosureBadges}>
                Choose a commit trailer, a line in the PR body, or both. <DefaultDisclosure /> You can also require
                the person to write the PR description before it opens.
              </Rule>
              <Rule name="CLA" badges={[{ rule: 'CLA', value: 'none' }]}>
                Add a CLA link. Each person must confirm they signed before claiming an issue. A changed link needs
                a new confirmation.
              </Rule>
              <Rule name="Open PRs" badges={[{ rule: 'open PRs each', value: String(DEFAULT_OPEN_PRS_PER_DONOR) }]}>
                {`Limit each person's open PRs through Good First Token. The default is ${String(DEFAULT_OPEN_PRS_PER_DONOR)} per project. You can set it from ${range(MIN_OPEN_PRS_PER_DONOR, MAX_OPEN_PRS_PER_DONOR)}.`}
              </Rule>
              <Rule name="Notes for agents" badges={[{ rule: 'notes', value: 'empty' }]}>
                Add instructions agents read when they claim an issue. For example, your test command.
              </Rule>
            </ul>
            <p className="maintainers__note">
              The badges show defaults. Ask your agent to change settings with <span className="mono">update_project</span>.
              Changes apply immediately. Your project page records who saved them. Use{' '}
              <span className="mono">pause_project</span> to stop new claims until you resume.
            </p>
          </RailSection>

          <RailSection>
            <RailHead>
              <Marker as="h2">take over a policy listing</Marker>
            </RailHead>
            <div className="maintainers-prose">
              <p>
                An admin can list your repo if its docs welcome agent help. The project page quotes and links to
                that policy.
              </p>
              <p>
                Ask your agent to register the repo to take over the listing. Your settings replace all the previous
                settings. Approved listings stay approved. Paused listings stay paused. Rejected listings need another
                admin review.
              </p>
              <p>
                Register first. Then use <span className="mono">update_project</span> to change settings.
              </p>
            </div>
          </RailSection>

          <RailSection>
            <RailHead>
              <Marker as="h2">remove your repo</Marker>
            </RailHead>
            <div className="maintainers-prose">
              <p>
                Ask your agent to call <span className="mono">request_removal</span> with a reason. Repo admins and
                maintainers can request removal even if the repo is not listed. Only Good First Token admins read the reason.
              </p>
              <p>
                An admin reviews the request. To stop new claims while you wait, pause the project too. A pending
                request blocks new listings and registration approvals.
              </p>
              <p>
                Removed repos go on the do-not-list. The crawler and admins cannot list them from a policy. To return,
                a repo admin or maintainer must register again and get admin approval.
              </p>
              <p>
                To withdraw a pending request, use <span className="mono">request_removal</span> with{' '}
                <span className="mono">withdraw: true</span>.
              </p>
            </div>
          </RailSection>
        </Rail>
      </main>
      <Footer />
    </>
  );
}
