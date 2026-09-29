## The review queue

Work waits in the donor's review queue when the project reviews agent PRs,
wants a person-written description, or the PR couldn't open by itself.
Nothing opens until the donor says so.

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
   `claimId`, and `description` when they wrote one. Tell them the PR's
   link. When the answer names another PR open on the issue, tell them
   that too.
6. When `openable` is false, the PR can't open now. Its `reason` says why, and
   what to do.
7. Work in the queue expires 7 days after its first submit, unless its PR
   opens.

## Follow-ups

Once a PR is open, Good First Token reads its reviews. What a maintainer
wrote there comes back to the donor as a follow-up. `start_session` and
`my_work` list them under `followUps`, oldest first.

1. Each names the claim, the issue, the PR, the reviewer, the file a
   comment is on, its link on GitHub, when it was written, the claim's
   `branch`, and `base`, the commit to send every changed file from.
2. The `comment` is the reviewer's own words from GitHub. Show it to the
   donor as theirs, and decide with the donor what to change.
3. To answer one, fetch the claim's branch, make the change, post as you
   work, and call `submit_work` with the claim. Send every file changed
   from `base`, which is the start commit, or the head a submit last named
   with `onto`. The commit goes onto the PR. The follow-up clears once
   that submit lands.
4. `moreFollowUps` counts the follow-ups beyond the ones listed. They list
   as submits answer these.
5. Once the PR merges or closes, its follow-ups go, and the claim takes no
   more posts or submits. The next `start_session` tells the donor how it
   ended.

