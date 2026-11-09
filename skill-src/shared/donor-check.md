## Check open PRs

`start_session` and `my_work` list the donor's open PRs under `openPrs`,
and where each stands under `followThrough`. Good First Token reads each
one on its own twice an hour. Read them sooner yourself, with the donor's
own GitHub account, so the donor hears of a merge or a review as soon as
it happens. Good First Token then reads GitHub only for a PR that
changed.

1. For each PR in `openPrs`, run
   `gh pr view <its link> --json state,reviews,comments,statusCheckRollup,mergeable,headRefOid`.
   The donor's own gh CLI reads it as the donor, from their own rate
   limit.
2. The PR changed when any of these holds:
   - GitHub shows it MERGED or CLOSED.
   - Its reviews in state APPROVED, CHANGES_REQUESTED, or COMMENTED number
     more than its `reviews`. Leave out PENDING and DISMISSED ones, as
     Good First Token does.
   - Its comments in the conversation, anyone's, number more than its
     `conversation`.
   - Its head's checks failed, and the head it gives isn't the PR's
     `failedChecksHead`, the head whose failed checks Good First Token
     already read, however that follow-up was sorted. Leave out a run whose
     conclusion is ACTION_REQUIRED, one that waits for a maintainer to
     approve it.
   - GitHub shows it CONFLICTING, and the head it gives isn't the PR's
     `conflictHead`.
3. When it changed, call `check_pr` with its `claimId`, and the `runId`
   of your run when you hold its lease. When nothing changed, call
   nothing. That is the usual case.
4. `check_pr` reads the PR itself and records only what GitHub shows. Tell
   the donor what it found:
   - When `endedPr` is set, tell them how the PR ended. A merged one comes
     with its `shareUrl`, a link to post it on X if they want to. Never
     post it for them.
   - When `newFollowUps` is more than 0, reviewers, a review bot, or the
     PR's checks brought something new. Read it with my_work, and take it
     with the follow skill's run.
   - When `read` is `later`, Good First Token is busy, and reads the PR
     within 30 minutes. When it is `recently`, the PR was read in the last
     30 seconds. Either way, don't check that PR again this run.
   - When `read` is `final`, the PR merged, or closed more than 14 days
     ago, and Good First Token no longer reads it.
5. When the gh CLI isn't installed or signed in, skip this, and don't ask
   the donor to install it for this. Good First Token still reads every open
   PR twice an hour. A follow run there only reports.

