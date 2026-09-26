# Contributing to Good First Token

Thanks for helping. People and agents are both welcome, and the project is
built in public from the first commit.

## Where things are

| To work on | Start from |
|---|---|
| The idea and the audience | `brand/brand.md` |
| Pages and components | `brand/design.md`, `brand/brief-website.md`, and `prototype/` |
| Words on the site | `brand/voice.md` |
| The launch video | `video/README.md` |
| What gets built next | [`ROADMAP.md`](ROADMAP.md) and [`docs/specs/v1.md`](docs/specs/v1.md) |

## Getting set up

You need Node 24. pnpm comes through corepack.

```bash
corepack enable
pnpm install
pnpm dev         # the site, at http://localhost:5173, and a fake GitHub
pnpm seed        # reset the fake GitHub to the sample data
pnpm prototype   # the clickable prototype, at http://localhost:8943
pnpm check       # lint and typecheck
pnpm test        # unit tests, the Worker's inside the Workers runtime
pnpm test:e2e    # browser tests against a production build
```

Before the first `pnpm test:e2e`, run `pnpm exec playwright install chromium`.
No accounts are needed for any of it. How the pieces fit is in
[docs/architecture.md](docs/architecture.md).

## Making a change

- For a small fix, open a pull request.
- For anything bigger, open an issue first, or a PR that adds a spec to
  `docs/specs/` saying what changes and why. `ROADMAP.md` orders the planned
  work, and each item links to its spec or issue.
- Keep a PR to one change, and say how you checked it. For a page change,
  add screenshots at phone and desktop widths.
- Write commit messages in the imperative, and say why as well as what.

## AI help is welcome

Good First Token exists so agents can do real work on open source. AI-assisted
and agent-written pull requests are welcome here:

- **Disclose it.** Add a trailer naming the agent and model, like
  `Assisted-by: Claude Code (claude-opus-5-5)`, and fill in the disclosure
  section of the PR template. Leave out links to the agent's session, which
  are private.
- **Reading it is up to you.** You don't have to read the code your agent
  wrote. CI and a maintainer's review check every PR. If you did read it,
  tick the box in the PR template so the reviewer knows.
- **Check for company.** If someone already has an open PR for the issue,
  help on that PR or pick another issue.

## Tests

Tests have to earn their place.

- Test behavior at the boundaries: inputs and outputs, HTTP responses, stored
  state, and calls to GitHub. Leave private helpers alone.
- A test that would still pass if the code under it were wrong gets deleted.
  So does one that re-implements the function it checks, mirrors a constant,
  or snapshots code.
- Every product rule that can break gets a test named for the rule, like "a
  fourth claim on a 3-claim issue is refused."
- Every bug fix starts with a failing test that reproduces the bug.
- Coverage is reported for information, with no percentage gate.

## Writing

Words on the site and in docs, issues, PRs, and commits follow
[`brand/voice.md`](brand/voice.md). Short sentences, GitHub's own words, and
no em dashes.

## Keeping the repo public-safe

Secrets, Cloudflare account and resource IDs, and the names of deployed
resources never go in a file, and deployment domains never go in config.
They come from the environment. `pnpm install` turns on a pre-commit hook
that scans staged changes with
[gitleaks](https://github.com/gitleaks/gitleaks) when you have it installed.
CI scans the full history on every PR.

## Security and conduct

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Everyone here follows the [code of conduct](CODE_OF_CONDUCT.md).

## License

Contributions are licensed under the [MIT License](LICENSE), the same as the
project. There is no CLA.
