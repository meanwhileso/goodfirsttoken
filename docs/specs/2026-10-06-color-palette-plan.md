# Secondary color implementation plan

> For agentic workers: use the subagent-driven-development workflow for the
> source update, then review the spec and code before completing the branch.

**Goal:** Apply the approved purple, blue, neutral, and green roles from
`brand/design.md` to the rendered site and agent views.

**Architecture:** Keep the existing layout and shared components. Split
interaction and metadata tokens from identity. Add a submitted chip so
pending states remain distinct from agent names and interests.

**Tech stack:** React, CSS custom properties, Cloudflare Workers, Playwright,
Vitest, and the existing share-card renderer.

## Tasks

- [x] Add browser checks to `apps/web/e2e/design.spec.ts` for the approved
  identity, link, metadata, submitted, open PR, slot, chart, and live roles.
  Add a dark-link check to `apps/web/e2e/mcp-apps.spec.ts`. Run them against
  the current build and confirm the existing purple functional roles fail.
- [x] Update `apps/web/src/styles/tokens.css` and the YAML in
  `brand/design.md` together. Add `accent: #0969DA`,
  `accent-ink: #0550AE`, `accent-tint: #DDF4FF`, `metadata: #EEF1F4`,
  `metadata-ink: #57606A`. Set `code-accent: #A5D6FF` and the light focus
  ring to `0 0 0 2px #FBFBF9, 0 0 0 5px #0969DA`.
- [x] Apply blue links, slots, activity levels, and chart bars in
  `apps/web/src/styles/`. Keep logo, headline label, and real-label fallback
  purple. Make markers, metadata chips, badges, avatars, and ranks neutral.
  Set `.chip--submitted, .chip--opened` to the blue tint and dark blue text.
  Give closed slots a gray slash. Use green for live timeline nodes.
- [x] Update `apps/web/src/components/Chip.tsx` to include `submitted`.
  Use it for submitted work in the issue and person routes. Remove the
  `label` marker variant and its callers. Remove `InlineLabel` from
  projects, leaderboard, and the design page title. Keep its component
  example and the marketing headlines. Update component comments.
- [x] In `apps/web/src/mcp/views/view.css`, use blue for links, checks,
  notes, and focus. Dark views map `accent` and `accent-ink` to
  `code-accent`, mix blue and neutral surfaces with `code-surface`, and use
  light blue focus. Give prompts their own light blue focus ring.
- [x] Make agent chips neutral in `apps/web/src/cards/cards.ts`. Keep the
  purple logo and marketing headline, green merged pill, and ink names.
  Verify with the existing card measurement and rendering tests.
- [x] Update the `/design` swatches and examples in
  `apps/web/src/routes/design.tsx`. Promote the approved color guidance into
  the current reference, remove the staged wording, and update
  `brand/brand.md`, `brand/brief-website.md`, and the design-system section
  of `docs/how-it-works.md`.
- [ ] Run `pnpm check`, relevant Workers tests, and browser tests. Review
  the site at 390 and 1280 pixels, and check dark agent-view contrast.
  Obtain Linux screenshot baselines from the CI Playwright run, as
  `CONTRIBUTING.md` requires. Review every changed baseline before accepting.
- [x] Have a different agent review adversarially, prove and triage each
  finding, fix confirmed bugs with a failing test, and record the results
  in the PR disclosure and review section. The reviews found a green
  PR-opened notice and an outdated JSON token reference. Both were fixed;
  no findings were dropped.

## Done when

- Purple remains on identity and real GitHub labels.
- Functional blue and neutral metadata follow the approved mapping.
- Submitted and open PR states are distinct from metadata.
- Light and dark focus and text pass the existing contrast checks.
- Brand tokens and component specifications agree with `/design`.
- Responsive browser checks and the relevant unit tests pass.
- Reviewed Linux screenshots cover the changed pages.
- The independent review has no unresolved material finding.

This is the implementation checklist for the approved visual change. It
does not add routes, change workflow behavior, or publish a deployment.
