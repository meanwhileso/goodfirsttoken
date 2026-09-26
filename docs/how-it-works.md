# How it works

Every product rule Good First Token follows, as the code does it today. The
plan for what comes next is in [specs/v1.md](specs/v1.md). When a piece of the
plan is built, its rules move here in the same pull request.

Nothing is live yet. The site serves a placeholder home page while the build
goes on in the open.

## Health check

- `GET /healthz` answers `200` with `{"ok": true, "environment": "<name>"}`,
  where the name is `development`, `staging`, or `production`. A deploy's
  smoke test reads it to check that it reached the environment it meant to.
- It reads nothing but the environment name, so it answers even when storage
  or GitHub is down.
- It is sent with `Cache-Control: no-store`, so every check reaches the Worker
  that is live now.

## Claims

A claim is one person's hold on an issue while their agent works it. The
rules for a single claim are one pure function in `packages/core`,
`nextClaimState(claim, event, now)`. It returns the claim after the event, or
a refusal with its reason. The same claim, event, and time always give the
same answer. Nothing stores claims or runs their timers yet.

| State | Meaning | Holds a slot |
|---|---|---|
| `active` | Working, with updates arriving | Yes |
| `paused` | No update for 30 minutes | Yes |
| `awaiting_review` | Submitted, waiting for the donor to open the PR | Yes |
| `pr_opened` | A PR is open for the claim's work | No |
| `released` | The donor gave up, with a public reason | No |
| `expired` | 24 hours passed with no submit, or 7 days passed after the first submit with no PR | No |

**Time**

- The state machine takes times as whole milliseconds since the epoch, and
  `now` can't be before the claim was made.
- A new claim is `active`, and making it counts as its first update.
- An `active` claim with no update for 30 minutes is `paused`. A claim
  updated 1 ms under 30 minutes ago is still `active`.
- A claim with no submit 24 hours after it was made is `expired`, however
  recent its last update.
- A claim awaiting review expires 7 days after its first submit.
- `pr_opened`, `released`, and `expired` never change with time.
- Time is applied before any event. A claim past a deadline is expired first,
  so a late update is refused, and the claim frees its slot even when no
  timer has run.
- `claimDeadlines` gives the next time a claim's state would change, for a
  timer to wake at.

**Events**

- **Update.** Wakes a `paused` claim and restarts its 30 minutes. A claim
  awaiting review or with an open PR takes updates and keeps its state. An
  update stamped earlier than the last one never moves the last update back.
- **Submit.** Moves an `active` or `paused` claim to `awaiting_review`. In
  automatic mode the claim passes through `awaiting_review`, since opening
  the PR is its own event. Submitting again while awaiting review, or after
  the PR opened to answer a review, keeps the state. The 7 days still count
  from the first submit, so submitting again never extends a slot.
- **Open PR.** Moves `awaiting_review` to `pr_opened` and records the PR.
  Refused before a submit, and refused when the claim already has a PR.
- **Release.** Moves `active`, `paused`, or `awaiting_review` to `released`
  and records the public reason. Refused once a PR is open, because the claim
  holds no slot. To withdraw that work, close the PR on GitHub.
- A `released` or `expired` claim refuses every event. `pr_opened` is final.
- The state machine has no fact about whether the claim's PR is still open.
  Refusing updates and fixes once the PR merged or closed, with `pr_closed`,
  is left to the code that tracks PRs.
- A refusal carries the claim as of `now`, which is the one to store. A late
  update is refused and leaves the claim `expired`.
- A malformed claim, event, or time is refused as `invalid_input`, with the
  field named, like `claim.lastUpdateAt`, and nothing changes.

**Stored claims.** `claimRecordSchema` checks a stored claim: its ID, issue,
login, and agent, the commit its work starts from, and the facts its state
needs.

- `startCommit` is the full SHA `claim_issue` gave the agent. `submit_work`
  sends files relative to it, so a submit doesn't repeat it.
- `submittedAt` is set for `awaiting_review` and `pr_opened`, null for
  `active` and `paused`, and never before `claimedAt`.
- `releaseReason` is set for `released` and null in every other state.
- `pr` is set for `pr_opened` and null in every other state.
- `lastUpdateAt` is never before `claimedAt`.

The claim cap, the rule that a PR on the issue stops new claims, and who may
post to a claim depend on every claim on the issue, so they are outside this
function.

## Projects

- A project's status is `pending` while it waits for an admin, `approved`
  once listed, `rejected` with a reason, or `paused`.
- It got in one of two ways: `registered` by a maintainer, or listed from its
  written AI `policy` by an admin.
- A project listed from its policy has a tier, from what its docs say:
  `invites_agents` or `allows_with_conditions`. These are the only two tiers
  a listing can have.

## Project settings

| Setting | Field | What it takes | Default |
|---|---|---|---|
| Tags | `tags` | 1 to 20 labels | Required |
| Excluded tags | `excludedTags` | Up to 20 labels, none of them also a tag | None |
| Issue repo | `issueRepo` | `owner/name`, or null for the code repo | The code repo |
| PR mode | `prMode` | `automatic` or `reviewed` | `reviewed` |
| Who can claim | `whoCanClaim` | `anyone` or `vouched` | `anyone` |
| Disclosure | `disclosure` | `trailer`: a commit trailer name like `Assisted-by`, or null. `prBody`: text the PR body must carry, up to 1,000 characters, or null. At least one of the two. | The `Assisted-by` trailer, and "Written with a coding agent through Good First Token." in the PR body |
| Person-written PR description | `personWrittenDescription` | true or false | false |
| CLA | `claUrl` | An https link, or null | None |
| Notes for agents | `agentNotes` | Text up to 2,000 characters, with spaces trimmed from the ends | Empty |
| Claims per issue | `claimsPerIssue` | A whole number from 1 to 10 | 3 |
| Open PRs per donor | `openPrsPerDonor` | A whole number from 1 to 10 | 2 |

- Every cap in the table is our choice, so any of them can change.
- A label is 1 to 50 characters, GitHub's own limit, with spaces trimmed from
  the ends. Labels compare without case, the way GitHub does, so a list can't
  hold the same label twice.
- A trailer name starts with a letter and has up to 40 letters, digits, and
  hyphens, a cap we chose.
- Invalid settings are rejected, with each problem naming its field, like
  `claimsPerIssue: must be a whole number from 1 to 10`. An unknown setting
  is rejected by name, so a typo never passes quietly.
- A change sends only the settings it changes. The rest keep their values,
  and the result is checked as a whole. A setting sent as undefined keeps its
  value too.

## MCP tools

The input and output of every tool are defined in `packages/core`, each with
a description for agents. No tool is served yet.

| Who | Tools |
|---|---|
| Donors | `start_session`, `suggest_issues`, `claim_issue`, `post_update`, `submit_work`, `release_claim`, `my_work`, `open_pr`, `set_interests` |
| Maintainers | `register_project`, `update_project`, `project_status`, `pause_project` |
| Admins only | `admin_queue`, `admin_decide`, `admin_add_project`, `admin_block_donor`, `admin_pause_project` |

**Results**

- A result has the shape of MCP's `CallToolResult`: the data in
  `structuredContent`, and a plain-text rendering of it as the one `text`
  item in `content`. Terminal harnesses show only the text, so it stands on
  its own.
- Every ID a later call needs, a session, claim, or queue item, appears in
  the text as well as the data.
- Every tool's input and output is a JSON Schema object, which MCP needs to
  declare them.
- A result is checked against its tool's output schema before it goes out,
  and a result that breaks the schema is never sent. An extra field the
  schema doesn't list is dropped, except inside project settings, which take
  no unknown fields anywhere. There an extra field fails the check.
- A refusal is an MCP error result with text only, like
  `Refused (issue_full): ...`. It has no `structuredContent`, because clients
  check that against the output schema.
- Times in tool results and feed events are ISO 8601, in UTC.
- A suggestion names the project's code repo, which differs from the issue's
  repo when the project keeps issues elsewhere. It also carries the tag, the
  PR mode, the CLA link, the claimants and their agents, the slots, how many
  times it was claimed, and the tough badge.
- An item in the donor's review queue says why it waits for the donor, and
  names any PR already open on the issue, so the donor can decide whether a
  second PR helps.

**Inputs**

- `start_session` takes the harness name and the session's budget: a number
  of issues, a number of minutes, or `until_limit`.
- `suggest_issues` returns at most 3 issues, and takes the ones already shown
  to leave out.
- A release needs a public reason.
- A posted update is one line. Tabs and line breaks fold into single spaces.
  `post_update` takes an optional job, for a line a subagent posts.
- Submitted files are paths inside the repo: no leading slash, no empty, `.`,
  `..`, or `.git` parts, and no backslashes. No two paths in a submit can be
  the same, differ only in case, or be a file and a path under it. A file's
  content is its full new text, or null to delete it.
- `register_project` with no settings returns a proposal and saves nothing.
- Rejecting a queue item needs a reason, and so does an admin pause. An admin
  approving a crawler find can confirm or change its policy tier.

## Refusals

The codes are defined in `packages/core`. Today only `nextClaimState` returns
any: the first four and `invalid_input`.

| Code | When |
|---|---|
| `claim_expired` | The claim passed its 24 hours, or its 7 days awaiting review |
| `claim_released` | The claim was released |
| `pr_already_opened` | Opening a PR for, or releasing, a claim that already has a PR |
| `not_submitted` | Opening a PR before the work was submitted |
| `pr_closed` | The claim's PR merged or closed, so the claim takes no more updates or fixes |
| `project_not_open` | The project isn't approved, or is paused |
| `issue_not_eligible` | The issue is closed, has no project tag, has an excluded tag, or has an assignee |
| `pr_exists` | A PR is open on the issue, so it takes no new claims |
| `issue_full` | Every slot on the issue is taken |
| `donor_blocked` | An admin blocked the donor |
| `not_vouched` | The project takes vouched donors only, and the donor isn't on its list |
| `cla_required` | The project has a CLA the donor hasn't confirmed |
| `open_pr_cap` | The donor has as many open PRs in the project as it allows |
| `not_claim_owner` | Someone other than the claimant used the claim |
| `description_required` | The project wants a person-written PR description, and none came |
| `not_maintainer` | The caller isn't an admin or maintainer of the repo |
| `repo_not_eligible` | The repo is private or archived, or limits PRs to collaborators |
| `invalid_settings` | Settings failed their checks |
| `not_admin` | The caller isn't a Good First Token admin |
| `not_found` | The claim, issue, project, or queue item doesn't exist |
| `invalid_input` | A malformed claim, event, or time reached the claim state machine |

## Feed events

Each event has an ID, a time, the claimant's login and agent, the issue, the
claim ID, a kind, the text, and for a subagent's line, its job.

- `update` is a line the agent posted.
- `claimed`, `paused`, `submitted`, `pr_opened`, `released`, and `expired`
  mark a claim's state changes.
- `pr_merged` and `pr_closed` are the outcome of the claim's PR. They are PR
  facts, and the claim stays `pr_opened`.

## Limits

Each limit the schemas enforce, other than those under project settings:

| What | Limit | Set by |
|---|---|---|
| PR description | 65,536 characters | GitHub |
| Posted update | 200 characters | Us |
| Feed event text | 500 characters | Us |
| Subagent job name | 40 characters | Us |
| Release reason | 200 characters | Us |
| Files per submit | 1 to 300 | Us |
| Path of a submitted file | 4,096 characters | Us |
| Submit summary, and what was checked | 2,000 characters each | Us |
| Policy quote | 2,000 characters | Us |
| Pause, reject, and block reasons | 500 characters | Us |
| Interests | 20 per list, 50 characters each | Us |
| Session budget | 1 to 100 issues, or 1 to 1,440 minutes | Us |
| Suggestions left out with `exclude` | 100 | Us |
| Agent name | 1 to 40 lowercase letters, digits, dots, underscores, and hyphens, starting with a letter or digit | Us |
| Model name | 100 characters | Us |
| IDs the server gives out | 1 to 64 letters, digits, underscores, and hyphens | Us |

The limits we set are our choice, so any of them can change.
