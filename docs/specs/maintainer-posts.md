# List a repo from its maintainer's post

Status: approved on November 5, 2026, by the project's owner. This changes
the listing rule in [v1 section 4](v1.md#4-projects-maintainers-and-admins)
and the line in [crawler-priority](crawler-priority.md) that every listing
needs the project's written AI policy.

## Why

Many maintainers who want agent contributions say so on X and never write
it into their repo. Good First Token could list none of these repos, though
the people who can merge the pull requests asked for them in public.

## The rule

An admin can list a repo whose docs have no AI policy from a post on X in
which one of its maintainers welcomes AI or agent contributions. The post
stands in for the written policy.

- The quote is the maintainer's own words in the post. The link is the
  post.
- The listing keeps evidence beside the policy: the poster's GitHub login,
  their role (owner, creator, or maintainer), a public source for that
  role, their X handle, a public source tying the account to them, when the
  post was published, whether it is authored or a quote post, and when the
  admin's agent checked it. The server records which admin made the call.
  These are the checks [crawler-priority](crawler-priority.md) set for
  seed evidence. A repost or an unknown role doesn't count.
- The link must be a numeric status URL on X by the named handle.
- Every other blocker still applies. The repo must be public, not archived,
  and take pull requests from anyone. The do-not-list, a waiting request to
  be removed, and a registration refuse it.
- The admin skill doesn't list a repo whose docs ban or restrict AI help,
  take no pull requests, or forbid the disclosure every Good First Token
  pull request carries. Docs outrank a post.

## What people see

The project page and its markdown quote the post, link to it, and say who
posted it, with links to both sources. The projects list says "listed from
a maintainer's post". The JSON data carries the same facts. The verifying
admin, their note, and the check time stay on admin surfaces.

## Keeping it current

The first weekly read leaves the listing alone while the docs name no AI,
and a ban then pauses it. Docs that name AI at the first read, and any later
change to them, go back to the admin queue as a policy change, as for any
listing, so a restriction on agents reaches an admin. Docs outrank a post.
Approving a change with a docs policy lists the repo from the docs and
drops the post. A link to a post on X without the evidence is refused, so
an admin who relists to change a setting can't drop it by accident. A maintainer who
takes the listing over drops it too.

## Not in this change

- The admin page's form keeps listing from docs only. Post listings go
  through `admin_add_project`.
- Nothing reads X. The Worker stores the sources and never fetches them.
- No other site than X.

## Done when

- `admin_add_project` lists a repo from a post with its evidence, stamps
  the admin, and refuses a link that isn't the named account's post, a
  repost, an unknown role, or a time after the call.
- Pull requests limited to collaborators and the do-not-list still refuse a
  post listing.
- The first weekly read sends nothing to the queue for a post listing
  while its docs name no AI, and pauses it on a ban. Docs that name AI, or
  later change, queue a policy change.
- The page, markdown, list, and JSON show the post and its sources, and
  none of what only admins read.
- The admin skill says how to check a post, and which blockers stop a
  listing.
