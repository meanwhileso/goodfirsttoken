## The review queue

Work waits in the donor's review queue when the project reviews agent PRs,
wants a person-written description, or something else holds it, like a
change to a workflow file. Nothing in the queue opens until the donor says
so. In automatic mode, a submit with nothing to hold it skips the queue,
and you open its PR at once.

1. Call `my_work`. Under `readyToOpen` it lists each piece of work waiting
   to open as a PR: the issue, the claim, the lines added and removed, the
   agent and model, the summary and what was checked, why it waits, when it
   expires, and the link to its diff.
2. Show the donor each one, with its diff's link, and ask them to read the
   diff on GitHub. Open nothing they haven't read.
3. When `prOnIssue` names a PR, someone already opened one on the issue.
   Ask the donor whether a second PR helps.
4. When `personWrittenDescription` is true, the project wants the donor to
   write the PR description. Ask them for it. Never draft it, suggest
   words, or edit what they write. When the repo asks for a canary, tell
   them the marker has to be in it. Pass it to `open_pr` as `description`,
   word for word.
5. When the donor says to open one, like "open 2", call `open_pr` with its
   `claimId`, and `description` when they wrote one. When the answer names
   another PR open on the issue, tell them.
6. For work you pushed, `open_pr` opens nothing. It clears the work, and
   answers with `toOpen`, the PR to open. Write its body to a file, word
   for word, with a quoted heredoc like `cat > body.md <<'EOF'`, outside
   the repo. Then run the GitHub CLI command it gives, with that file on
   its standard input, like `<command> < body.md`. When the GitHub CLI
   refuses, give the donor the link to GitHub's form. When `bodyInLink` is
   true, the form has the title and body filled in. When it is false, the
   body is too long for the link, and the form has the title alone. Give
   the donor the body to paste. When the GitHub CLI says a PR already
   exists for the branch, that is the one to record. Then call `record_pr`
   with the PR's link, and tell the donor the link.
7. Cleared work stays under `readyToOpen`, waiting as `ready_to_open`,
   until its PR is recorded. Its `toOpen` is the PR to open, as `open_pr`
   gave it. Open it as in step 6. Its body is in a fenced block. Send what
   is between the fence lines.
8. When `prFromBranch` names a PR, the donor opened it from the claim's
   branch already. Call `record_pr` with its link, and open no other.
9. When `openable` is false, the PR can't open now. Its `reason` says why, and
   what to do.
10. Work in the queue expires 7 days after its first submit, unless its PR
    opens.

## Follow-ups

Once a PR is open, Good First Token reads its reviews. What a maintainer
wrote there comes back to the donor as a follow-up. `start_session` and
`my_work` list them under `followUps`, oldest first.

1. Each names the claim, the issue, the PR, the reviewer, the file a
   comment is on, its link on GitHub, when it was written, and the claim's
   `branch`.
2. The `comment` is the reviewer's own words from GitHub. Show it to the
   donor as theirs, and decide with the donor what to change.
3. To answer one, pull the claim's branch, make the change, post as you
   work, commit with the trailer, push, and call `submit_work` with the
   claim and the new head. The fix goes onto the PR. The follow-up clears
   once that submit lands.
4. `moreFollowUps` counts the follow-ups beyond the ones listed. They list
   as submits answer these.
5. Once the PR merges or closes, its follow-ups go, and the claim takes no
   more posts or submits. The next `start_session` tells the donor how it
   ended.

