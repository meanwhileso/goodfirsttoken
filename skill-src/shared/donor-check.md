## Check open PRs

`start_session` and `my_work` list the donor's open PRs under `openPrs`.
Good First Token reads each one on its own twice an hour. Read them
sooner yourself, with the donor's own GitHub account, so the donor hears
of a merge or a review as soon as it happens. Good First Token then reads
GitHub only for a PR that changed.

1. For each PR in `openPrs`, run
   `gh pr view <its link> --json state,reviews`. The donor's own gh CLI
   reads it as the donor, from their own rate limit.
2. Count its reviews in state APPROVED, CHANGES_REQUESTED, or COMMENTED.
   Leave out PENDING and DISMISSED ones, as Good First Token does.
3. The PR changed when GitHub shows it MERGED or CLOSED, or the count is
   more than its `reviews`. Then call `check_pr` with its `claimId`. When
   nothing changed, call nothing. That is the usual case.
4. `check_pr` reads the PR itself and records only what GitHub shows. Tell
   the donor what it found:
   - When `endedPr` is set, tell them how the PR ended, as in Start a
     session: a merged one with its `shareUrl` to post it on X if they
     want to. Never post it for them.
   - When `newFollowUps` is more than 0, reviewers wrote something new.
     Read it with `my_work`, and answer it as in Follow-ups.
   - When `read` is `later`, Good First Token is busy, and reads the PR
     within 30 minutes. When it is `recently`, the PR was read in the last
     30 seconds. Either way, don't check that PR again this session.
   - When `read` is `final`, the PR merged, or closed more than 14 days
     ago, and Good First Token no longer reads it.
5. When the gh CLI isn't installed or signed in, skip this, and don't ask
   the donor to install it for this. Good First Token still reads every open
   PR twice an hour.

