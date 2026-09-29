## Refusals

A refusal reads `Refused (code): message`. Tell the donor the message,
then:

- `not_found`: The session, claim, or issue doesn't exist on Good First
  Token, or no pick is left in the session's queue. For a session, start
  one with `start_session`. For an issue, pick another with
  `suggest_issues`.
- `not_claim_owner`: The claim is someone else's. Use only the donor's own
  claims, from `start_session` or `my_work`.
- `donor_blocked`: Good First Token's admins blocked the donor, so they get
  no suggestions and no claims. Tell them, and stop.
- `project_not_open`: The project takes no work now. It isn't approved, is
  paused, its maintainers asked to be removed, the sync delisted it, or
  GitHub shows the donor no repo or no commit to start from. The message
  says which. For a new claim, pick another issue. For a claim in
  progress, release it with `release_claim`.
- `claim_released`: The claim was released. To go on, claim the issue
  again.
- `claim_expired`: The claim passed its 24 hours with no submit, or its 7
  days in the review queue with no PR. To go on, claim the issue again,
  when it still takes claims.
- `pr_closed`: The claim's PR merged or closed, so the claim takes no more
  posts or work. After a close without merging, the issue takes claims
  again while it is open and tagged, and the donor can claim it again.
- `issue_not_eligible`: GitHub shows the issue closed, without the
  project's tag, with a label the project keeps for people, assigned, or
  gone, or it is a pull request. Pick another issue. For a claim in
  progress, nothing was written: tell the donor, and release the claim.
- `pr_exists`: A PR is open on the issue, so it takes no new claims. Pick
  another issue.
- `issue_full`: Every slot on the issue is taken. Pick another issue.
- `open_pr_cap`: The donor has as many open PRs in the project as it
  allows. Pick an issue in another project. Work waiting in the review
  queue opens once one of their PRs there merges or closes.
- `not_vouched`: The project takes only donors its vouch file vouches for,
  or the file denounces the donor. Pick an issue in another project.
- `cla_required`: The project has a CLA. Show the donor the link in the
  message, and ask them to confirm they signed it. Then call `claim_issue`
  again with `claConfirmed` set to that link. Never confirm it for them.
- `budget_spent`: The session's budget is spent. Finish or release the
  claims in progress. To spend more, the donor starts a new session.
- `no_changes`: The files leave the claim's branch as it is, so nothing was
  committed. Send every file changed from the start commit, or from the
  head `onto` named, with its full new text.
- `file_mode`: The submit would change, delete, or put back an executable
  file, a symbolic link, or a submodule, or add a path under a link or a
  submodule. A commit through GitHub's API would break it, so nothing was
  committed. Leave the path the message names out, and tell the donor to
  make that change with Git themselves.
- `path_conflict`: A path is a folder, goes under a file, or differs only
  in case or accents from a path on the branch, so nothing was committed.
  Fix the path the message names, then submit again.
- `fork_not_ready`: GitHub is still making the donor's fork, so nothing was
  committed. Wait a minute, then call `submit_work` again with the same
  files.
- `branch_moved`: Someone pushed to the claim's branch, so nothing was
  committed. Follow step 5 of Submit. When the message says there is no
  branch for `onto` to name, submit again without `onto`.
- `github_refused`: GitHub refused the fork, the branch, the commit, or the
  PR, and the message gives GitHub's reason. For a change under
  .github/workflows/, leave it out, and tell the donor to make it on
  GitHub. Otherwise tell the donor the reason. The claim stays as it was.
- `not_submitted`: The claim has no submitted work yet. Submit it with
  `submit_work` first.
- `pr_already_opened`: The claim already has a PR. Fixes go onto it with
  `submit_work`. A claim with a PR can't be released. To withdraw the
  work, the donor closes the PR on GitHub.
- `description_required`: The project wants the donor to write the PR
  description. Ask them for it, and pass it as `description`, word for
  word. Never draft it.

Other errors:

- An error that names a field, like
  `files.0.path: must be a path inside the repo, like src/index.ts, with no empty, ., or .. part`,
  means the call broke the tool's input rules. Fix that field, then call
  again.
- `GitHub no longer accepts this connection's token`: reconnect the MCP
  server, then call again.
- Too many calls: wait a minute, then try again.
- Anything else: tell the donor what it says, and stop.

