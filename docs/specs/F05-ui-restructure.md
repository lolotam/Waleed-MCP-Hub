# F05 — UI restructure: sidebar with tabs, Harbor design system

Status: draft v2, open questions answered 2026-11-23, awaiting approval to build · Branch `claude/waleed-ui-restructure-5d53cd` ·
Follows F04 (`docs/specs/F04-hub-ui-refresh.md`)

This document describes the layout and the design system the owner chose from
nine clickable prototypes, and what it takes to build them. The design system
(tokens, dark mode, theme control) is implemented; the layout is not. The plan
tracks which steps have landed.

## Problem

Read from `apps/web/src` on this branch.

1. **Up to five blocks sit above every page's own content.** The safety notice
   and the "Copy MCPs from your agents" panel render before the loading and
   error branch; the update notice, "Environment discovery" and the recovery
   alert render before the page body (`App.tsx:452-509`). On Connectors the list
   comes after all of them.
2. **Four ways to add a tool live in four places.** Two header buttons, "Add
   Manual MCP" and "Add connector" (`App.tsx:396-424`), and two of the panels
   named in problem 1.
3. **An expanded connector row carries too much.** Inside `connector-panel`
   (`ConnectorList.tsx:471`) it holds up to ten buttons in three groups, a facts
   list of up to eight entries, the tool permission editor and the raw
   definition. `docs/SPECIFICATION.md` §6.3 asks for a detail drawer with five
   tabs; it was never built.
4. **Six dialogs are reachable from no menu**, and the package dialog from
   three different places (the import dialog, the manual dialog, row actions).
5. **Activity shows two unrelated logs on one page**, registry changes and
   security refusals (`App.tsx:924`). **Settings has no setting**: one action
   and a read-only list (`App.tsx:1004-1093`).
6. **The page is component state, not an address** (`App.tsx:143`). A reload
   always returns to Connectors and no page can be linked to.
7. **Finding, outside this spec's scope:** at window widths from 601 to 800 px
   the sidebar labels are hidden (`styles.css:1285-1299`) and the buttons have
   no accessible name.

## Fixed by the owner

Answers given on 2026-11-23:

| Question | Answer |
| --- | --- |
| Layout | A, sidebar with tabs |
| Palette | Harbor: colours, fonts and corner radius |
| Dark mode | Light and dark |
| Fonts | Bundled files were allowed; Harbor needs none |
| Devices | Desktop only |
| Languages | English only |
| Sizes and spacing | Unchanged from the app today |

## Target grouping

Sidebar entries keep today's names and order.

| Sidebar entry | Tab | Under the tab | Holds today's |
| --- | --- | --- | --- |
| Connectors | All connectors | Connector detail (five tabs) | Connector list; expanded row |
| Connectors | Add | Paste or import | "Add connector" dialog |
| Connectors | Add | Manual MCP | "Add Manual MCP" dialog |
| Connectors | Add | From your agents | "Copy MCPs from your agents" panel |
| Connectors | Add | Discover environment | "Environment discovery" panel |
| Agents | (none) | | Agents page |
| Profiles | (none) | Profile detail, Create a profile | Profiles page; profile dialog |
| Activity | Registry activity | | First Activity section |
| Activity | Security refusals | | Second Activity section |
| Settings | Runtime & safeguards | | Settings page; safety notice |
| Settings | Updates | | Update notice |
| Settings | Recovery | | Recovery alert |

Connector detail tabs: Overview, Configuration, Authentication, Tools &
permissions, Diagnostics. These are the five tabs of `SPECIFICATION.md` §6.3,
shown in the page instead of a drawer.

## The chosen option

A sidebar of five entries; an entry with more than one page shows a tab row
under the top bar; the Add tab shows four pills. Child pages (a connector, a
profile, a review step) show a breadcrumb back to their parent.

It was chosen because it answers problems 1 to 5 at the lowest cost: the five
sidebar names stay, so the 38 lookups of those names and of the header buttons
in `tests/e2e` can stay.

Rejected:

- **B, top bar with hubs** (Add, Manage, Review, System): renames the
  navigation and adds a menu to open on every jump between modules.
- **C, rail with a master-detail panel:** the strongest fit for connectors, but
  the highest cost and the least room for wide tables.

Rejected palettes: **Ledger** (ink on buff paper, serif headings, bundled
fonts) and **Console** (flat violet, IBM Plex, bundled fonts).

## Sizes

All values are the app's own today (`apps/web/src/styles.css`) except the rows
marked new.

| Part | Value |
| --- | --- |
| Sidebar | 232 px; 208 px at 1100 px and below |
| Top bar | 68 px |
| Tab row (new) | 44 px |
| Add pills (new) | 32 px, the segmented filter's height |
| Navigation item | 44 px |
| Button | 36 px; small 32 px |
| Input | 10 px 12 px padding |
| Page padding | 40 px; 24 px at 1100 px and below |
| Content width | up to 1536 px |
| Form-only page width (new) | up to 840 px |
| Base text | 14 px, line-height 1.5 |
| Page title | 28 px |
| Radius (new) | cards 10 px, controls 8 px, pills 999 px |
| Spacing | 4 px unit: 4, 8, 12, 16, 24, 32 |

## Route map

The app has no URLs today, so none change. "Place" is where the page sits in
the navigation.

| Page | Place today | Place in F05 |
| --- | --- | --- |
| Connector list | Connectors | Connectors › All connectors |
| Connector detail | Expanded row | Connectors › All connectors › {name} |
| Add connector (import) | Dialog from header | Connectors › Add › Paste or import |
| Add Manual MCP | Dialog from header | Connectors › Add › Manual MCP |
| Copy MCPs from your agents | Panel on every page | Connectors › Add › From your agents |
| Environment discovery | Panel on every page | Connectors › Add › Discover environment |
| Package install | Dialog from three places | Child of Connectors |
| Review change (all operations) | Dialog | Child of the page that opened it |
| Authentication | Dialog from row | Connector detail › Authentication |
| Agents | Agents | Agents |
| Profiles | Profiles | Profiles |
| Create a profile | Dialog | Profiles › Create a profile |
| Registry activity | Activity, first section | Activity › Registry activity |
| Security refusals | Activity, second section | Activity › Security refusals |
| Runtime & safeguards | Settings | Settings › Runtime & safeguards |
| Update notice | Notice on every page | Settings › Updates, plus a count on Settings |
| Recovery alert | Alert on every page when blocked | Above every page when blocked, and Settings › Recovery |

New pages: Connector detail, Profile detail, Updates, Recovery. No page is
removed.

## Page layout rules

| Template | Structure | Pages |
| --- | --- | --- |
| List | Header, one panel holding filter bar and rows | Connector list, Agents, Profiles, both Activity pages |
| Detail | Header, in-page tabs, the tab's panels | Connector detail |
| Two-column | Main column and a side column from 1024 px | Paste or import, Manual MCP, Review change, Profile detail, Runtime & safeguards, Updates |
| Form | Header, one panel of titled sections, action bar | Create a profile |

One primary button per page, at the end of the page header. A destructive
action is never the page's primary button.

## Design system: Harbor

The source of the values is
`F:\Dev\Projects\Waleed-MCP-Hub-ui-prototypes\palettes\harbor.css`, written in
`oklch()`. The hex values below are conversions for reading.

| Role | App variable today | Light | Dark |
| --- | --- | --- | --- |
| Page background | `--canvas` | `#f3f6fa` | `#0d131c` |
| Surface | `--surface` | `#ffffff` | `#171e2a` |
| Muted surface | `--muted-surface` | `#edf2f6` | `#1e242f` |
| Text | `--text` | `#192230` | `#ebeff4` |
| Secondary text | `--muted` | `#535f6f` | `#a3acb8` |
| Border | `--border` | `#d9dfe6` | `#2e3643` |
| Action, links | `--action` | `#1f53b8` | `#81aaf7` |
| Text on action | (literal `white`) | `#ffffff` | `#0c1628` |
| Danger | `--danger` | `#c2181d` | `#f47a79` |
| Selected item background | (literal `#e8f2f0`) | `#dbe9ff` | `#1f304f` |
| Selected item text | (uses `--action`) | `#0e3685` | `#bfd8ff` |
| Control outline | (uses `--border`) | `#758192` | `#6a7586` |
| Focus ring | (uses `--action`) | `#2d69de` | `#81aaf7` |
| Success text / background | (literals) | `#106c3e` / `#ddf6e4` | `#81d39f` / `#1a3424` |
| Warning text / background | (literals) | `#844b00` / `#feedc9` | `#eabc6e` / `#3e2d10` |
| Info text / background (reserved; no token until a rule uses it) | (none) | `#236b8f` / `#dff2fd` | `#8bbfde` / `#18313f` |
| Danger background | (colour-mix) | `#ffe7e4` | `#442322` |

- **Contrast:** 33 text and background pairs pass WCAG AA in light and in dark
  (the engine's `contrast.mjs`, 15 pairs, and
  `palettes/extra-contrast.mjs`, 18 pairs).
- **Action and health stay apart** (`docs/DESIGN.md:96-98`): the action colour is
  blue; green, amber and red are used for status only, always with a word.
- **Type:** `'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif` for
  text and `'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif` for
  headings, weight 600, letter-spacing -0.015em. Monospace stays
  `Consolas, monospace`. No font file is added. Both Variable families were
  found installed on the owner's machine; on a Windows without them the stack
  falls back to Segoe UI.
- **Buttons:** the four variants stay (secondary as the base, primary, ghost,
  danger) at the same sizes; only colour and radius change.
- **States:** hover, pressed and disabled keep today's rules with the new
  tokens. Focus is a 2 px ring in the focus colour.
- **Motion:** unchanged (150 ms state transitions; `prefers-reduced-motion`
  turns motion off).

## Languages

English only. Logical CSS properties stay the rule so right-to-left remains
possible later (`docs/SPECIFICATION.md:717`, `docs/DESIGN.md:105`).

## Acceptance criteria

1. Every page in the target grouping is reachable in at most three clicks from
   any other page.
2. Exactly one sidebar entry is marked current on every page, child pages
   included.
3. At 1440 px and 1024 px window width no page scrolls sideways.
4. No block other than a blocking recovery alert appears above a page's own
   header; the safety notice shows only on Settings › Runtime & safeguards and
   the four Add pages.
5. Every existing `data-testid`, accessible button name, label text and ARIA
   attribute used by `tests/e2e/*.spec.ts` still exists. A test may gain
   navigation steps; it may not lose an assertion.
6. `styles.css` contains no colour literal outside the token blocks.
7. Light and dark both pass AA on the pairs listed above.
8. `npm run check`, `npm run format:check` and `npm run test:e2e` pass.

## What does not change

- Data model, registry, API routes, permissions, capability flags: none.
- What each page does: none. Pages move; their behaviour stays.
- Sizes, spacing and control heights, except the two new rows in Sizes.
- The tray menu and the installer.

## Baseline decisions to record

`docs/DECISIONS.md` requires a dated entry before code depends on a changed
baseline. If this spec is approved, append:

- **D028 — Harbor replaces the teal palette.** Reverses "Teal reserved for
  primary actions, selection, and focus" (`docs/DESIGN.md:57`, token table at
  `:82-94`).
- **D029 — Dark mode.** Reverses "Light unless dark is deliberately required"
  (`docs/DESIGN.md:177`).
- **D030 — Sidebar entries gain tabs; the connector drawer becomes a page.**
  Amends `docs/SPECIFICATION.md` §6.1 to §6.3.

Follow-ups those entries should name: the logo and favicon gradients, and
`<meta name="theme-color" content="#0d766e">` in `apps/web/index.html`.

## Answered questions

Answered by the owner on 2026-11-23, who accepted the recommendation on each.

1. **Dialogs.** The two Add dialogs become the pages Connectors › Add › Paste or
   import and Connectors › Add › Manual MCP. The package, review, authentication
   and profile dialogs stay dialogs. In the route map, read "Child of" and
   "Connector detail › Authentication" as the place a dialog opens from.
2. **Safety notice.** Shown on Settings › Runtime & safeguards and on the four
   Add pages. Removed from every other page.
3. **Blocking recovery alert.** Shown above every page while changes are
   blocked, and on Settings › Recovery.
4. **Page addresses.** Each page gets a hash so a reload stays on it. Condition:
   `apps/web/src/api.ts` reads the launch token from the hash and erases it
   (lines 21 to 25) before the page router reads the hash.
5. **Theme control.** Light, Dark and System on Settings › Runtime &
   safeguards. System follows Windows.
6. **Bell.** Not built in F05. Sidebar entries carry counts; the only count in
   this feature is "update available" on Settings.

Rejected alternatives: keep every dialog or turn all six into pages (1); notice
on every page or on Settings only (2); alert on the Recovery page only (3); no
addresses (4); follow Windows with no control (5); a bell (6).
