# Waleed MCP Hub — Design Direction

Date: 2026-10-29
Status: Reference lock retained; P7/P8 scanner/manual workflows rendered at four widths.
Full release accessibility and installed-agent validation remain pending.

## 1. Brief

Designing a Windows-local connector manager for Waleed, primarily on desktop.
The goal is to add, authenticate, inspect, and distribute supported MCP connectors
without repeatedly editing agent configuration files.

Tone: precise, professional, trustworthy, and operational rather than decorative.
Primary risk: the interface could falsely suggest that a saved setting or a
connected gateway proves every upstream server is authenticated.

Memorable detail: an **Available to** agent strip on each connector, separating
configured access from verified connection and reconnect-required states.

Constraints: local assets, no cloud dependency, accessible forms, honest runtime
states, and explicit review before installing or executing imported commands.

## 2. Research provenance

Requested skill names were mapped to available skills:

- `refero-design`: primary research/design methodology.
- `ui-ux-pro-max`: supplemental implementation/accessibility guidance.

Live Refero MCP tools were not available. No claim is made that live Refero
styles, screenshots, or flows were searched or reviewed.

Bundled references actually reviewed:

- Refero Design `references/anti-ai-slop.md`: light utility default, purposeful
  grouping rather than decorative card grids, semantic status color, no default
  indigo/violet or ornamental serif treatment.
- Refero Design `references/craft-details.md`: visible keyboard focus, explicit
  labels, useful inline errors, submit/loading states, and unsaved-change handling.
- UI/UX Pro Max `references/templates-dashboard.md`: app shell, persistent sidebar,
  practical data-table layout, and useful empty states.
- The user's connector-management brief: central Add action, authentication,
  agent availability, and startup management.

If live Refero becomes available later, use it to strengthen the evidence before
a major visual redesign; do not retrospectively label this research as live.

## 3. Primary reference lock

Direction: **light technical control panel**, grounded in the Refero bundled
utility guidance rather than a marketing-page visual language.

Preserve:

1. Light neutral canvas and high-contrast compact text.
2. A persistent desktop sidebar and a list/detail working area.
3. Teal reserved for primary actions, selection, and focus.
4. Separate semantic colors with text/icons for health, warning, and failure.
5. Connector rows and a detail drawer instead of a decorative grid of cards.

Borrow only:

- App-shell/table structure from the UI/UX dashboard reference.
- Form, focus, and error behaviors from Refero craft guidance.

Reject:

- Purple gradients, glass panels, animated glow, and decorative charts.
- A giant marketing hero or fake usage/revenue statistics.
- Uniform green status for configured-but-untested services.
- Presenting native Chrome as if it were routed through Docker.
- Claiming all eight agents are connected before actual verification.

Media strategy: code-native interface, locally bundled icons, real status data.
No generated photography, bitmap hero artwork, or external image dependency.

## 4. Proposed design tokens

These are product-specific commitments derived from the chosen utility direction,
not claimed as exact tokens extracted from a live Refero style.

| Role                               | Token     |
| ---------------------------------- | --------- |
| Canvas                             | `#F6F8FA` |
| Primary surface                    | `#FFFFFF` |
| Muted surface                      | `#EEF2F5` |
| Primary text                       | `#17212B` |
| Secondary text                     | `#52606D` |
| Border                             | `#D8E0E6` |
| Primary action / selection / focus | `#0D766E` |
| Success text/icon                  | `#166534` |
| Warning text/icon                  | `#92400E` |
| Error text/icon                    | `#B42318` |
| Unverified/disabled text           | `#52606D` |

Verify AA contrast on actual component pairings before shipping. Do not use a
status color as a decorative page background or interchange action and health
roles simply because they appear similar.

Typography:

- Windows system UI stack, led by Segoe UI, to avoid font downloads.
- 14–16 px primary interface text, 12–13 px metadata, 24–28 px page titles.
- Monospace only for endpoints, command previews, versions, and identifiers.
- English first; use logical CSS properties so later RTL does not require a rewrite.

Spacing: 4/8/12/16/24/32 px. Radius: 6–8 px controls, 10–12 px dialogs/drawers.
Use borders for structure and restrained shadow only for true overlay elevation.
Motion: approximately 120–180 ms for state transitions; respect reduced motion.

## 5. Main screen structure

```text
┌───────────────────┬────────────────────────────────────────────────┐
│ Waleed MCP Hub    │ Connectors                       Add connector │
│ Local · Windows   │ Search…              Type / Status / Profile   │
│                   ├────────────────────────────────────────────────┤
│ Connectors        │ Connector       Status          Available to   │
│ Agents            │ Contabo SSH     Verified tools  [OC] [Codex]   │
│ Profiles          │ Postora         Needs auth      [OC] [Codex]   │
│ Activity          │ Chrome DevTools Native · Tested [OC] [Codex]   │
│                   │                                                │
│ Settings          │ Selecting a row opens a right-side drawer      │
│ Docker status     │ with configuration, auth, tools, diagnostics   │
└───────────────────┴────────────────────────────────────────────────┘
```

Labels above are an illustrative layout, not live state. In implementation,
Chrome must say discovery verified until browser operation has actually been
tested, and SSH must not imply remote-command authentication was verified.

## 6. Main interactions

### Add connector

Choose URL / Paste JSON / Local command / Docker image, then:

Input -> Normalize -> Authentication -> Profiles/agents -> Review -> Apply/Test.

- Parsing never runs the pasted command.
- Unsupported fields and compatibility gaps are visible.
- Secret values stay hidden and are not persisted in drafts.
- Review shows target files, downloads, execution risk, and affected agents.
- Completion distinguishes saved, registered, discovery passed, and auth failed.

### Authentication

- OAuth: show provider, scopes, and a real Sign in action only when supported.
- API key: labelled hidden input, provider-specific header help, Store and test.
- Unsupported flow: explain the missing capability instead of a non-working button.
- Postora: show the token rejection and metadata compatibility issue separately.

### Editing and destructive actions

- Warn about unsaved changes.
- Reconfirm execution approval after a material command/image change.
- Show conflicts when a revision changed in another session.
- Distinguish Disable, Remove from profile, Delete connector, Delete credential,
  and Revoke provider access.

## 7. Responsive and accessible behavior

- At desktop widths, use a fixed-width sidebar and flexible main workspace.
- At tablet widths, condense metadata and allow a full-width detail panel.
- At narrow widths, use a compact navigation control, stacked rows, and full-screen
  drawers/wizard steps. Do not shrink controls below usable target sizes.
- Keyboard users can reach search, filters, rows, drawer tabs, and all actions.
- Dialogs trap focus appropriately and restore focus on close.
- Every input has a persistent label; errors are inline and programmatically linked.
- Status always combines text with icon/shape; color alone is insufficient.
- Asynchronous job progress is announced without flooding assistive technology.

## 8. Decision ledger

| Decision                        | Source                                                  | Role/rule preserved                        | Reason                                             |
| ------------------------------- | ------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------- |
| Light neutral utility canvas    | Refero anti-AI-slop guidance                            | Light unless dark is deliberately required | Management clarity without arbitrary dark styling  |
| Sidebar + list/detail workspace | Dashboard reference + user brief                        | Navigation versus operational content      | More useful than a landing-page/card-grid layout   |
| Teal action/focus accent        | User-approved recommendation + Refero accent discipline | Action/selection only                      | Clear primary actions without decorative gradients |
| Semantic status text/icons      | Refero craft + accessibility guidance                   | Meaning, not decoration                    | Avoid false success and color-only interpretation  |
| Available-to agent strip        | User's cross-agent goal                                 | Access and freshness evidence              | Makes the product's shared-hub purpose visible     |
| Review-before-run wizard        | Security requirements + form guidance                   | Explicit user control                      | Pasted configuration can launch privileged tools   |
| Local system typography/assets  | Offline/local-first constraint                          | No external asset requirement              | Fast reliable Windows startup                      |
| Native/Docker mode badge        | Verified pilot behavior                                 | Accurate execution model                   | Do not hide the native browser exception           |

## 9. Visual implementation gate

Before calling the frontend complete:

- Render normal, empty, unavailable, auth-required, failed, stale, and conflict views.
- Compare screenshots at 1440/1024/768/390 px against this lock.
- Validate actual contrast and keyboard behavior.
- Remove decorative UI that obscures health, agent access, or the next action.
- Verify every primary action uses a real backend operation or clearly explains
  why it is unavailable.

## 10. P4 import flow reference lock

The existing light utility direction remains primary. Live Refero tools were not
available for this slice. Reviewed sources: this document's Add flow, the existing
ProfileDialog interaction, and Refero `craft-details.md` (focus, labelled forms,
inline errors, submit states, unsaved input). UI/UX Pro Max contributes only mobile
hit-target/accessibility guidance, not a competing visual theme.

| Decision                                                 | Reference/rule                                    | Reason                                                            |
| -------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| Use Add connector to open a native dialog                | Existing profile dialog + section 6               | Keep one entry point and familiar focus trapping/restoration      |
| Paste / HTTPS / Native input choices, followed by review | Section 6 + specification 7                       | No shell splitting; arguments are an explicit JSON array          |
| Clear source before showing normalized definitions       | Security brief + form guidance                    | Credentials must not remain in a hidden browser draft             |
| Stacked selectable entries with visible issues/conflicts | Compact utility hierarchy + explicit review brief | Partial inputs require an informed selection decision             |
| Separate edit versus server-checked preview state        | Form submit/loading guidance                      | Prevent export of an unvalidated rename or selection              |
| Explicit zero-effect scope and disabled Apply            | Honest status rule                                | A successful parse is not execution approval or a saved connector |
| Same neutral/teal tokens; monospace for JSON only        | Primary reference lock                            | No new theme, decorative metrics or misleading success color      |

QA includes sanitized review/error/conflict flows at 1440/1024/768/390 px, inert
markup, focus/Escape, secret-input clearing, stale revision handling and export.

## 11. P5 lifecycle reference lock

Retain the primary light technical direction, existing profile/import dialogs,
section 6's explicit review/approval journey, and Refero `craft-details.md` form,
focus and error guidance. UI/UX Pro Max supplements touch targets only. No new
theme or invented dashboard metrics; no live Refero tools were available.

| Decision                                                               | Reference/rule                                 | Reason                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| Save, approval, profile apply and capability test are separate actions | Section 6 + specification 8                    | Saved is not running, authenticated, or registered                         |
| Show desired memberships and snapshot stale/reconnect labels           | Honest status rule                             | No false live reload or agent verification                                 |
| Reuse native revision-bound review dialogs                             | Existing P4/profile flow + craft form guidance | Familiar keyboard focus, inline errors and explicit consequences           |
| Expand exact definition and bounded capability metadata on demand      | Compact technical utility direction            | Preserve scan hierarchy without hiding execution risk                      |
| Stack actions at narrow widths with 44px mobile hit targets            | Responsive lock + accessibility supplement     | All enabled lifecycle actions remain usable at 390px                       |
| Replace obsolete “no external writes” claims with explicit-action copy | Actual P5 adapter behavior                     | Profile apply can write owned external files; environment discovery cannot |

P5 browser QA covers all four locked widths, approval invalidation, healthy/auth
independence, apply/stale/dematerialize states, literal text rendering and zero
horizontal overflow. Screenshots are ignored under `test-results/`.

## 12. P6 authentication reference lock

Retain the existing light technical direction and P5 dialogs as the primary
reference. Section 6's authentication journey and Refero `craft-details.md` form,
focus and error guidance govern the flow. UI/UX Pro Max supplements mobile hit
targets only; there is no new theme or decorative imagery.

| Decision                                                 | Source / role                 | Reason                                                    |
| -------------------------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| One Authentication dialog per connector                  | P5 dialogs + section 6        | Keep credential updates scoped and revision-bound         |
| Uncontrolled password input cleared before awaiting save | Security brief + craft forms  | No secret values in React state or restored hidden drafts |
| Explicit exact/Bearer/Basic choice and store label       | Provider-specific auth brief  | Never assume all APIs use Bearer                          |
| Provider, scopes, consent, pending/denied/timeout states | Section 6 OAuth journey       | A stored token is not verified authentication             |
| Separate local deletion and provider revocation copy     | Section 6 destructive actions | Never imply deleting local data revokes remote access     |

Validate focus/Escape, cancellation, cleared input, saved-versus-verified copy and
responsive layouts at the four locked widths. No arbitrary authorization URL or
credential show/copy/export control is offered.

## 13. P7/P8 scanner and manual-MCP reference lock

Retain the primary light technical direction, existing lifecycle dialogs and
Refero craft form/focus/error guidance reviewed before implementation. Live Refero
tools were unavailable. UI/UX Pro Max supplies only responsive/touch guidance.

| Decision                                               | Reference / role                        | Reason                                                               |
| ------------------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------- |
| Prominent Scan Installed Agents action                 | Agents brief + existing utility list    | Explicit discovery, never automatic config edits                     |
| Name/path/status/reconnect/action rows                 | Technical list hierarchy                | Configuration evidence is not live authentication                    |
| User-file consent before one-click changes             | Review-before-run rule                  | Make backup/external-write scope explicit                            |
| Native dialog with typed Stdio/Docker/HTTP/SSE fields  | Existing dialogs + craft labelled forms | Args/ports are JSON, not shell text                                  |
| Write-only env/headers and separate execution checkbox | P6 security + explicit approval journey | Save, approval and authentication remain distinct                    |
| Persistent status/error announcements                  | Honest status + craft error guidance    | Completion and partial saves are visible without disappearing toasts |

Inspected agent screenshots at 1440/1024/768/390 px and the mobile manual-save state.
Browser QA checks overflow, required file-change consent, integration/disconnection,
manual save/auto-sync, private-value absence, empty localStorage and JS errors.
These do not establish complete AA contrast/accessibility or real-agent trust behavior.

Final UI corrections keep consent checkbox geometry consistent with existing forms
and replace obsolete agent-apply-pending copy with configuration-only guidance.
Manual validation now checks argument/port shapes as well as JSON syntax; completion
shows sync conflict counts and partial receipts identify the saved connector.
