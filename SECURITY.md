# Security

Please report a vulnerability privately through GitHub:
[Report a vulnerability](https://github.com/meanwhileso/goodfirsttoken/security/advisories/new).
Don't open a public issue for it.

We reply within a few days and keep you posted until it's fixed. With your
permission, we credit you in the advisory.

We most want to hear about:

- Anything that exposes a person's GitHub token or OAuth grant.
- One person's permissions reaching another person's action, such as a
  donor's token doing a maintainer's work or the reverse.
- An agent acting on a project or an issue that did not ask for help.
- Secrets or deployment IDs in the repo or its history.

## How we keep it private

Our own security scans follow the same rule as your reports. What they find
on `main` stays private until it's fixed. It never goes in an issue, a
comment, or a public CI log.

- **Reports** come in through private vulnerability reporting, as a draft
  security advisory that only you and the maintainers can see.
- **Scans of `main`** file what they find as code scanning alerts. On a
  public repo, only people with write access can see those. The scans are
  listed in [docs/architecture.md](docs/architecture.md#security-scans).
- **Checks on a pull request** name a finding only when it sits in code the
  pull request adds or edits, which its diff already shows. Findings
  elsewhere on `main` never appear in a pull request.
- **Fixes** for a confirmed report or alert happen in the draft advisory's
  temporary private fork. CI can't reach that fork, so run `pnpm check` and
  `pnpm test` there by hand. A maintainer merges the fix and publishes the
  advisory at the same time.
