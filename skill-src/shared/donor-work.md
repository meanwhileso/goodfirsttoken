## Work the claim

`claim_issue` answers with the claim, the issue's link and live page, the
issue's text on GitHub, the project's settings and notes for agents, the
repo to clone, the commit to start from, and the claim's branch.

1. Clone the repo it names, and check out the commit it gives. That is the
   claim's start commit. Make the claim's branch there, with the name in
   `branch.name`, like `git switch -c <branch.name>`. Work from it, however
   far the default branch has moved since. When you resume a claim whose
   branch you pushed before, fetch that branch from where you pushed it,
   and work on it.
2. Read the repo's AGENTS.md and CONTRIBUTING, and the notes from the
   maintainers in the answer. Follow them within the Rules, and do what
   any canary asks, as the Rules say.
3. Post as you go with `post_update`, `claimId`, and `text`: one line,
   lowercase, past tense, what you did and where, under 80 characters, like
   `fixed off-by-one in parseRange (src/range.ts)`,
   `wrote failing test: /docs/ keeps its trailing slash`, or
   `tests: 214 passing`. Post after each code change, test run, or
   decision, and at least every 10 minutes. A subagent posts under the same
   claim, with `job` set to its job, like tests.
4. When the project names a commit trailer, end each commit's message
   with it, in a last paragraph of its own, as
   `<trailer>: <agent> (<model>)`, like
   `git commit -m "Keep the slash" -m "Assisted-by: claude-code (claude-opus-5-5)"`. The server adds the
   disclosure text to the PR's body. Keep the donor's git name, email, and
   signing setup as they are, and never turn signing off. Follow any other
   rule the repo has for AI help.
5. Run the repo's tests and checks the way its docs say, and post what
   they gave.
6. When `post_update` answers with `prOnIssue`, someone else opened a PR on
   the issue. Tell the donor. Stop with `release_claim`, or finish and
   submit.
7. A claim with no post for 30 minutes pauses, and the next post wakes it.
   A claim with no submit expires 24 hours after it was made, at its
   `expiresAt`.
8. When you are stuck, or the donor wants to stop, call `release_claim`
   with `claimId` and a short public `reason`, like
   `Can't reproduce it on the start commit`. A claim whose PR is open can't
   be released. To withdraw that work, the donor closes the PR on GitHub.

## Submit

1. Commit the work on the claim's branch, with the trailer, as above.
2. Push the branch with the donor's git. When `branch.canPush` is true,
   push it to the code repo. Otherwise run `gh repo fork --remote`, which
   finds the donor's fork or makes one, and sets it as the origin remote, then
   `git push -u origin <branch.name>`. A new fork can take a minute to
   take a push. An organization may refuse the GitHub CLI's token, so a
   push over SSH is the other way.
3. When you can't push with the donor's credentials, as in a harness on
   its own computer, make a patch with `git format-patch` from the start
   commit. Give it to the donor, with the commands to apply it with
   `git am` on the claim's branch and push it from their own terminal.
   Wait for them, then read the head they pushed with `git ls-remote`, or
   ask them for it.
4. Call `submit_work` with:
   - `claimId`.
   - `branch`: the repo you pushed to, the branch's name, and its head,
     like `{"repo": "priya/sample-app", "name": "goodfirsttoken/issue-12-c_1",
     "head": "<git rev-parse HEAD>"}`.
   - `summary`: what the change does. It starts the PR description.
   - `checks`: what you checked, like the tests and linters you ran, in
     your own words.
   - `agent` and `model`: your harness's name and the model you ran.
   - `title`, only when the repo's rules want a certain form for it.
     Otherwise leave it out, and the PR takes the issue's title.
   - `tokenEstimate`, when your harness can estimate the tokens spent on
     the claim since its last submit, or since it was made. It is always
     an estimate. In Claude Code, the goodfirsttoken plugin's hook fills
     it in from the session's transcript, so leave it out there.
5. The server checks the branch on GitHub and writes nothing there. The
   answer says what comes next. Tell the donor.
   - In automatic mode with nothing to hold the work, the answer has
     `toOpen`, the PR to open. Open it now, as in The review queue's step
     6, and record it.
   - Otherwise the work waits in the donor's review queue, with the reason
     it waits and the diff's link.
6. To change submitted work, commit and push to the same branch, then
   submit again with the new head. A submit ends a clearance. In reviewed
   mode, ask the donor to read the new diff, then call `open_pr`. In
   automatic mode, the submit's answer has the PR to open.
7. After the PR opens, fixes go the same way, onto the PR's branch.
   Maintainers can push to it too, so pull the branch before you commit.
   Add new commits, and never rewrite the history of an open PR's branch.
8. GitHub takes a change under .github/workflows/ only over SSH, or from a
   token with the workflow scope. When the push is refused for it, tell
   the donor. The work waits for the donor's review either way.
