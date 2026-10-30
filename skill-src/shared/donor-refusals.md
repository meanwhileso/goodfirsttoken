## Refusals

A refusal reads `Refused (code): message`. Tell the donor the message.
When the donor named a project, keep that choice as in Find a named
project. Ask before switching projects, including when an entry below
offers another project. Then:

- `not_found`: The session, claim, or issue doesn't exist on Good First
  Token, or no pick is left in the session's queue. For a session, start
  one with `start_session`. For an issue, pick another with
  `suggest_issues`. From `set_interests`, Good First Token has no record of
  the donor yet: call `start_session` first, then save the interests again.
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
- `no_changes`: The pushed branch changes no file from the default
  branch, or a fix names the last submit's head. Commit the work, push the
  branch, and submit its new head.
- `file_mode`: Only a submit with files gets this. Push the claim's branch
  and submit with `branch` instead.
- `path_conflict`: Only a submit with files gets this. Push the claim's
  branch and submit with `branch` instead.
- `fork_not_ready`: Only a submit with files gets this. Push the claim's
  branch and submit with `branch` instead.
- `branch_moved`: From `open_pr`, the pushed branch moved since its
  submit. Submit it again, then open the PR. From a submit with files,
  push the claim's branch and submit with `branch` instead.
- `github_refused`: GitHub refused a read, or a write a submit with files
  made, and the message gives GitHub's reason. Tell the donor the reason.
  The claim stays as it was.
- `branch_not_found`: The pushed branch doesn't have the claim's name, or
  GitHub doesn't show it at the head you named. Push the branch
  `claim_issue` named, and submit with the head the message gives.
- `branch_elsewhere`: The pushed branch is in a repo that isn't the code
  repo or a fork of it, or isn't where the claim's branch already is. Push
  it to the repo the message names, and submit again.
- `not_from_start`: The pushed branch doesn't build on the start commit.
  Build it on the start commit, push it, and submit again.
- `trailer_missing`: A commit on the pushed branch lacks the project's
  trailer. Before the PR opens, add the line the message gives to each
  commit it names, with `git rebase -i` and `git commit --amend`, then
  push with `--force-with-lease` and submit again. After the PR opens, add
  a new commit instead, and ask the donor what to do about the old one.
- `branch_pushed`: The claim's branch was pushed, so a submit with files
  would write over it. Push your work to the branch, and submit with
  `branch`.
- `not_cleared`: `record_pr` found the work not cleared to open. Submit
  the pushed branch, clear it with `open_pr`, open the PR, and record it.
- `pr_mismatch`: `record_pr` found the PR isn't the cleared one, and the
  message says how. Fix it on GitHub, like with `gh pr edit <link>
  --body-file body.md`, then call `record_pr` again. When the branch moved, submit it again and
  clear it again first.
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
  `branch.head: must be a full 40-character commit SHA`,
  means the call broke the tool's input rules. Fix that field, then call
  again.
- `GitHub no longer accepts this connection's token`: reconnect the MCP
  server, then call again.
- Too many calls: wait a minute, then try again.
- Anything else: tell the donor what it says, and stop.

