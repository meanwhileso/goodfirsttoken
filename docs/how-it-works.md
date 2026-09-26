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
| `expired` | 24 hours passed with no submit, or 7 days passed after submit with no PR | No |

**Time**

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
  awaiting review or with an open PR takes updates and keeps its state.
- **Submit.** Moves an `active` or `paused` claim to `awaiting_review`.
  Submitting again while awaiting review, or after the PR opened to answer a
  review, keeps the state. The 7 days still count from the first submit, so
  submitting again never extends a slot.
- **Open PR.** Moves `awaiting_review` to `pr_opened` and records the PR.
  Refused before a submit, and refused when the claim already has a PR.
- **Release.** Moves `active`, `paused`, or `awaiting_review` to `released`
  and records the public reason. Refused once a PR is open, because the claim
  holds no slot. To withdraw that work, close the PR on GitHub.
- A `released` or `expired` claim refuses every event. `pr_opened` is final.
  Whether its PR merged or closed is a fact about the PR, and the claim stays
  `pr_opened`.
- A refusal carries the claim as of `now`, which is the one to store. A late
  update is refused and leaves the claim `expired`.
- A malformed claim, event, or time is refused as `invalid_input`, with the
  field named, like `claim.lastUpdateAt`, and nothing changes. Times are
  whole milliseconds since the epoch, and `now` can't be before the claim was
  made.

**Stored claims.** `claimRecordSchema` checks a stored claim: its ID, issue,
login, and agent, and the facts its state needs.

- `submittedAt` is set for `awaiting_review` and `pr_opened`, null for
  `active` and `paused`, and never before `claimedAt`.
- `releaseReason` is set for `released` and null in every other state.
- `pr` is set for `pr_opened` and null in every other state.
- `lastUpdateAt` is never before `claimedAt`.

The claim cap, the rule that a PR on the issue stops new claims, and who may
post to a claim depend on every claim on the issue, so they are outside this
function.

## Project settings

| Setting | Field | What it takes | Default |
|---|---|---|---|
| Tags | `tags` | 1 to 20 labels | Required |
| Excluded tags | `excludedTags` | Up to 20 labels, none of them also a tag | None |
| Issue repo | `issueRepo` | `owner/name`, or null for the code repo | The code repo |
| PR mode | `prMode` | `automatic` or `reviewed` | `reviewed` |
| Who can claim | `whoCanClaim` | `anyone` or `vouched` | `anyone` |
| Disclosure | `disclosure` | A commit trailer name like `Assisted-by`, or null, and whether the PR body gets one line. At least one of the two. | An `Assisted-by` trailer and a line in the PR body |
| Person-written PR description | `personWrittenDescription` | true or false | false |
| CLA | `claUrl` | An https link, or null | None |
| Notes for agents | `agentNotes` | Text up to 2,000 characters | Empty |
| Claims per issue | `claimsPerIssue` | A whole number from 1 to 10 | 3 |
| Open PRs per donor | `openPrsPerDonor` | A whole number from 1 to 10 | 2 |

- A label is 1 to 50 characters, GitHub's limit, with spaces trimmed from the
  ends. Labels compare without case, the way GitHub does, so a list can't
  hold the same label twice.
- A trailer name starts with a letter and has up to 40 letters, digits, and
  hyphens.
- Invalid settings are rejected, with each problem naming its field, like
  `claimsPerIssue: must be a whole number from 1 to 10`. An unknown setting
  is rejected by name, so a typo never passes quietly.
- A change sends only the settings it changes. The rest keep their values,
  and the result is checked as a whole.

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
- Every tool's input and output is a JSON Schema object, which MCP needs to
  declare them.
- A result is checked against its tool's output schema before it goes out. A
  field the schema doesn't list is dropped, and a result that breaks the
  schema is never sent.
- A refusal is an MCP error result with text only, like
  `Refused (issue_full): ...`. It has no `structuredContent`, because clients
  check that against the output schema.
- Times in tool results and feed events are ISO 8601, in UTC.

**Inputs**

- `start_session` takes the harness name and the session's budget: a number
  of issues, a number of minutes, or `until_limit`.
- `suggest_issues` returns at most 3 issues, and takes the ones already shown
  to leave out.
- A release needs a public reason.
- `post_update` takes an optional job, for a line a subagent posts.
- Submitted files are paths inside the repo: no leading slash, no empty, `.`,
  `..`, or `.git` parts, no backslashes, and each path once. A file's content
  is its full new text, or null to delete it.
- `register_project` with no settings returns a proposal and saves nothing.
- Rejecting a queue item needs a reason, and so does an admin pause.

## Feed events

Each event has an ID, a time, the claimant's login and agent, the issue, the
claim ID, a kind, the text, and for a subagent's line, its job.

- `update` is a line the agent posted.
- `claimed`, `paused`, `submitted`, `pr_opened`, `released`, and `expired`
  mark a claim's state changes.
- `pr_merged` and `pr_closed` are the outcome of the claim's PR. They are PR
  facts, and the claim stays `pr_opened`.

## Limits

Each limit the schemas enforce, other than those in the settings table:

| What | Limit |
|---|---|
| Posted update | 200 characters |
| Feed event text | 500 characters |
| Subagent job name | 40 characters |
| Release reason | 200 characters |
| Files per submit | 1 to 300 |
| Submit summary, and what was checked | 2,000 characters each |
| PR description | 65,536 characters, GitHub's limit |
| Policy quote | 2,000 characters |
| Pause, reject, and block reasons | 500 characters |
| Interests | 20 per list, 50 characters each |
| Session budget | 1 to 100 issues, or 1 to 1,440 minutes |
| Suggestions left out with `exclude` | 100 |
| Agent name | 1 to 40 lowercase letters, digits, dots, underscores, and hyphens, starting with a letter or digit |
| Model name | 100 characters |
| IDs the server gives out | 1 to 64 letters, digits, underscores, and hyphens |
