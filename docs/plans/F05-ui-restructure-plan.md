# F05 plan — UI restructure: sidebar with tabs, Harbor design system

Spec: `docs/specs/F05-ui-restructure.md` (draft v2) · Branch:
`claude/waleed-ui-restructure-5d53cd`

Steps 0, 1 and 2 are implemented (pull request #42); steps 3 to 9 have not
started. Not yet verified for steps 1 and 2: every page looked at in dark mode
by eye. The spec's six questions were answered on
2026-11-23; where the "Depends on" column names a question, the step follows
that answer in the spec's "Answered questions" section.

## Global constraints

1. Node 24 and npm 11 only. Add no runtime or dev dependency and no font file.
   The web app stays React-only with local assets.
2. Keep every existing `data-testid`, accessible button name, label text and
   ARIA attribute that `tests/e2e/*.spec.ts` uses. A test may gain navigation
   steps to reach a moved panel; no assertion is removed.
3. No change to the data model, API routes, capability flags, approval or trust
   rules, discovery deadlines or import bounds.
4. Sizes, spacing and control heights stay as they are, except the tab row, the
   Add pills and the radius listed in the spec.
5. CSS uses tokens only, logical properties, visible `:focus-visible` rings and
   AA contrast in light and dark, and honours `prefers-reduced-motion: reduce`.
6. A decision is recorded in `docs/DECISIONS.md` before code depends on it.

## Gates (after every step)

```
npm run check
npm run format:check
npm run test:e2e
```

`npm run check` does not run the browser tests or the format check, so all
three are needed.

## Steps

| # | Step | Touches | Depends on | Done when |
| --- | --- | --- | --- | --- |
| 0 | Record D028, D029, D030 | `docs/DECISIONS.md` | Spec approved | Three dated entries exist |
| 1 | Tokens: Harbor values on the eight existing variables; a token for every colour literal; dark values under `prefers-color-scheme` and under `[data-theme='dark']`; radius; font stacks; `theme-color` | `apps/web/src/styles.css`, `apps/web/index.html` | 0 | No colour literal outside the token blocks; the 33 contrast pairs pass in both themes; no browser test changes |
| 2 | Theme control: Light, Dark, System | `apps/web/src/App.tsx` (Settings), a small `theme.ts`, a unit test | 1, answer 5 | The choice survives a reload; System follows Windows |
| 3 | Navigation as data: one typed tree of sidebar entries, tabs and sub-pages, each with label, icon and the capability that shows it | new `apps/web/src/navigation.ts`, new `tests/navigation.test.ts` | Answer 4 | The test proves every view appears exactly once and every capability-hidden view has a visible sibling |
| 4 | Shell: tab row and pills; `page` state becomes entry + tab + sub-page; breadcrumb for child pages | `apps/web/src/App.tsx`, `styles.css` | 3 | Exactly one sidebar entry is current on every view; sidebar button names unchanged |
| 5 | Move the global blocks: Copy MCPs and Environment discovery to Connectors › Add; update notice to Settings › Updates with a count on Settings; recovery and safety notice per the answers | `App.tsx`, `AgentCloning.tsx`, `DiscoveryPanel.tsx`, `UpdateNotice.tsx` | 4, answers 2, 3, 6 | Acceptance criterion 4 holds; `cloning.spec.ts` and `discovery.spec.ts` pass with added navigation steps only |
| 6 | Add area: Paste or import and Manual MCP become pages under the Add tab; the other four dialogs stay dialogs | `App.tsx`, `ImportDialog.tsx`, `ManualMcpDialog.tsx` | 4, answer 1 | "Add connector" and "Add Manual MCP" keep their names; `imports.spec.ts` passes |
| 7 | Connector detail: the expanded row becomes a page with five tabs; every button keeps its name and its disabled rule; Authentication and the review steps still open their dialogs | `ConnectorList.tsx`, new `ConnectorDetail.tsx`, `styles.css` | 4, answer 1 | `lifecycle.spec.ts`, `packages.spec.ts` and `auth.spec.ts` pass; each of the ten row actions is on exactly one tab |
| 8 | Activity as two tabs; Settings as three tabs | `App.tsx` | 4 | `foundation.spec.ts` and `desktop.spec.ts` pass |
| 9 | Documents: `SPECIFICATION.md` §6.1 to §6.3, the token table and decision ledger in `DESIGN.md`, `STATUS.md`, `ROADMAP.md` | `docs/` | 1 to 8 | Each changed statement cites the code that makes it true |

Steps 1 and 2 are independent of steps 3 to 8 and can land first as their own
pull request. Steps 5 to 8 each touch `App.tsx` and run one at a time.

## Rules for every step

- Colours come from tokens. A new colour is a new token with a light and a dark
  value and a contrast check.
- Strings stay in the JSX in English, as today; no translation layer is added.
- A moved panel keeps its component and its behaviour. Only where it renders
  changes.
- Tests assert behaviour, not markup: reach a panel through its navigation, then
  run the existing assertions.

## Overlap with work in flight

- Pull request #41 (`docs/delivery-tiers-publish-20261120`) adds `AGENTS.md`,
  `CLAUDE.md` and a `DECISIONS.md` entry. It adds a tier card before new
  implementation work and describes product implementation as frozen. It
  touches no file in `apps/web`. Its `DECISIONS.md` entry is dated, not
  numbered, so D028 to D030 stay free. If it merges first, its tier card
  applies before step 1.
- Pull request #33 bumps TypeScript from 5.9.3 to 7.0.2. If it merges first,
  rerun the gates before starting.
- No open pull request touches `apps/web/src`.

## Risks

| Risk | Mitigation |
| --- | --- |
| A capability flag hides every page under a tab or an entry | The navigation test in step 3 fails on a visible group with no visible page |
| Browser tests find elements that moved behind a tab | Add the navigation step in the same change; constraint 2 forbids removing the assertion |
| `packages.spec.ts` counts page radios | Add no element with role `radio` outside dialogs; tabs use `role="tab"`, pills are buttons |
| Dark mode exposes literals that were tuned for a white surface | Step 1's "no literal" rule; look at every page in dark before step 2 lands |
| The recovery alert becomes easy to miss | Answer 3 keeps it above every page while changes are blocked |
| Segoe UI Variable is missing on an older Windows | The stack falls back to Segoe UI; no layout depends on the Variable widths |
| Page addresses collide with the launch token read from the hash | Answer 4: the router reads the hash only after `api.ts` has erased the launch token; a unit test covers the order |

## Reference

The prototypes this plan follows, and their sources:

- `scratch/ui-restructure/index.html` in this worktree (not tracked by git).
- `F:\Dev\Projects\Waleed-MCP-Hub-ui-prototypes\`: `pack/` (page data,
  navigation, overrides), `palettes/harbor.css`, and `build-all.mjs`.
- Layout A in Harbor: `harbor/mcp-hub-a.html`.

The prototypes approximate the app's components with a prototype engine's
markup. They show structure, colour and type; they are not a pixel reference
for the React components.

## Deferred from the review of pull request #42

Raised by review bots, judged real, and left out of that pull request:

- **Saved theme can flash on a cold load.** The module script that applies the
  saved choice may run after the first paint. A fix needs a small classic
  script in `<head>` served from the app itself (the content security policy
  allows no inline script). Do it with step 4, which already changes startup.
- **`theme-color` follows Windows, not an explicit Light or Dark choice.** The
  Edge app window can show a title bar that does not match the page. Sync the
  two `theme-color` tags from `theme.ts` when the choice changes.
- **Appearance is unreachable while the hub fails to load.** The error branch
  replaces every page body. Step 8 (Settings as three tabs) renders local-only
  settings outside that branch.
