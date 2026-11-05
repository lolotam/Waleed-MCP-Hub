# F04 plan — Connectors UI refresh, discovery progress, tray, export/import

Spec: `docs/specs/F04-hub-ui-refresh.md` (draft v3) · Branch:
`feat/hub-ui-refresh`

## Global constraints

1. Node 24 and npm 11 only. Add no runtime or dev dependency. The web app stays
   React-only with local assets; no CDN, web font or external image.
2. Keep every existing `data-testid`, every accessible button name, label text
   and ARIA attribute that `tests/e2e/*.spec.ts` uses. New elements may add test
   ids; none may be renamed or removed. Add no new element with role `radio`
   outside dialogs (`tests/e2e/packages.spec.ts` counts page radios).
3. Never read, log, return or export a secret value, OAuth token or credential
   file. Export reads only the registry state (`lifecycle.inventory()`), never
   the credential store.
4. Do not change discovery deadlines, the two-job concurrency limit, or approval
   and trust rules. Every import bound stays as it is (48 KiB source, 8,192
   nodes, depth 20, 32 entries, 32 per preview/selection/`create_connectors`,
   64 KiB HTTP body). In `normalize.ts` every existing accepted shape keeps its
   exact validation; the only importer changes allowed are the hub format branch
   and the hub-only deselection in `service.ts` defined in the spec (Feature 4).
5. CSS uses the existing tokens in `apps/web/src/styles.css` `:root`, logical
   properties, visible `:focus-visible` rings, AA contrast, and honours
   `prefers-reduced-motion: reduce`. No purple gradients, glass panels or glow.
6. The implementer does not commit, push, build installers, or touch
   `%LOCALAPPDATA%`, the Windows registry or any running hub. The orchestrator
   lands each task.
7. Formatting by Prettier (`npm run format`), lint by ESLint; TypeScript strict
   as configured.

## Gates (run after every task)

```
npm run typecheck
npx eslint apps packages tests scripts
npm test
npm run build
npm run format:check
```

Plus the Playwright specs named in the task (`npx playwright test <spec>`; they
need `npm run build` first).

---

## Task 1 — discovery progress bar

Files: new `apps/web/src/discoveryProgress.ts` (pure function, no JSX), new
`apps/web/src/DiscoveryProgress.tsx` (component), `apps/web/src/App.tsx`
(Connectors panel only), `apps/web/src/ConnectorList.tsx` (`check()` only),
`apps/web/src/styles.css`, new `tests/discovery-progress.test.ts`.

1. Export `discoveryProgress(connectors: ManagedConnector[], observations:
CapabilityObservation[])` returning `{ eligible, settled, loading,
needsAttention, tools, percent }` per the spec definitions (eligible =
   enabled and `trustApproval.revision === revision` and
   `trustApproval.definitionHash === executionHash`; an observation counts only
   if its `revision` and `definitionHash` match; `percent =
Math.floor(settled * 100 / eligible)`; `tools` sums `tools.length` of
   settled `connected` observations; failure states = `error`, `timed_out`,
   `auth_required`, `unsupported`, `unavailable`, `cancelled`).
2. Export a `DiscoveryProgress` component rendering nothing when `eligible ===
0`, otherwise the bar + text line from the spec with the ARIA attributes in
   the spec. Completion text appears when `settled === eligible`.
3. Render it in `App.tsx` at the top of the Connectors `list-panel`, above
   `ConnectorList`, passing `connectors` and `observations`.
4. Manual re-check in `ConnectorList.check()`: before starting, call the
   existing `observe` prop with the current observations where that
   connector's current-revision observation (if any) has `state: 'checking'`.
   Poll the job until it is no longer `running`, bounded at 150 s (was 65 s).
   In a `finally`, always `await refresh()`; if `refresh()` rejects or returns
   `false`, call `observe` with the observations as they were before the
   check. No other change to `ConnectorList` in this task.
5. Styles: track, fill with `transition: width 300ms ease`, loading sheen via a
   keyframe on a pseudo-element, success colour on completion, reduced-motion
   override.
6. Unit tests for `discoveryProgress`: none eligible; partial; all settled with
   two failures; stale observation (old revision) not settled; disabled and
   unapproved connectors excluded; a `checking` observation on a previously
   connected connector is not settled; `unavailable` counts as needing
   attention.

Acceptance: unit tests pass; `tests/e2e/lifecycle.spec.ts` passes; the bar is
visible during discovery and shows the completion line after it.

## Task 2 — button system and Connectors page redesign

Files: `apps/web/src/styles.css`, `apps/web/src/Icon.tsx`, `apps/web/src/App.tsx`
(Connectors page header, notice, panel toolbar), `apps/web/src/ConnectorList.tsx`
(row and panel markup, `ConnectorActions`).

1. Button system in CSS: base (secondary) style, `.primary` (keep the existing
   class), `.ghost`, `.danger`, `.small`; 36 px default height, 32 px small,
   8 px radius, icon gap 6 px, hover/active/disabled/`:focus-visible` states.
   Existing buttons elsewhere inherit the base and must still look coherent.
2. Add icons to `Icon.tsx` as needed (e.g. `play`, `edit`, `key`, `trash`,
   `power`, `download`, `upload`, `refresh`, `filter`); all `aria-hidden`.
3. Connectors header per spec: actions `Add Manual MCP`, `Add connector`
   (primary); leave a slot for `Export` that Task 4 fills. Safety notice becomes
   one slim info bar.
4. Toolbar: count, search (`aria-label="Search connectors"`), status filter as a
   `role="group"` (`aria-label="Filter connectors by status"`) of `<button
type="button" aria-pressed>` toggles labelled All, Ready, Loading, Needs
   attention, Disabled — never radios. Ready = connected; Loading = eligible and
   untested/checking; Needs attention = enabled and (not approved or failure
   state); Disabled = not enabled. Empty result state with `Clear filters`.
   Filtering happens in `App.tsx`; `ConnectorList` keeps receiving the full
   `connectors` for discovery eligibility and gets a new optional prop
   `visibleIds` that limits which rows render.
5. Rows and expanded panel per spec; `ConnectorActions` renders three groups
   (`role="group"` each with an `aria-label`: "Run", "Configure", "Danger") with
   the same buttons and labels as today. `Remove` uses `danger`; `Disable` uses
   `ghost`; `Test capabilities` uses `primary` when enabled.
6. Responsive at 1440/1024/768/390 px; no horizontal scroll.

Acceptance: every existing e2e spec passes unchanged (`foundation`,
`lifecycle`, `auth`, `packages`, `imports`, `cloning`, `integrations`,
`discovery`); visual check at four widths.

## Task 3 — export and import without secrets

Files: new `packages/hub-core/src/imports/export.ts`,
`packages/hub-core/src/imports/normalize.ts` (hub branch only),
`packages/hub-core/src/imports/service.ts` (hub-only deselection in
`preview`), `packages/hub-core/src/index.ts` (exports),
`packages/contracts/src/imports.ts` (format `hub`, `requiredCredentials`,
warnings `credentials_required` and `already_installed`, export response
schema), `packages/contracts/src/packages.ts` (optional proposal metadata and
install request fields), `packages/hub-core/src/packages/service.ts` (use the
new install request fields for the dry run and committed connector),
`apps/server/src/app.ts` (route `GET /api/connectors/export`, route-name table
entry `connectors_export`), `apps/web/src/App.tsx` (Export button; the
proposal → `PackageSeed` bridge), `apps/web/src/ImportDialog.tsx` (Load from
file, `requiredCredentials` display), `apps/web/src/PackageInstall.tsx`
(`PackageSeed` fields, pre-fill, pass-through), new
`tests/connector-export.test.ts`, new cases in `tests/e2e/imports.spec.ts`,
`docs/guides/adding-mcps.md`.

1. Read `normalize.ts`, `service.ts`, the `save-preview` route in `app.ts`,
   `auth/bindings.ts`, `packages/service.ts`, `runtime/registry.ts` (how a
   managed package connector is stored) and `PackageInstall.tsx` before writing
   code.
2. `exportConnectors(connectors: Connector[]): { parts: string[]; skipped:
Array<{ id: string; name: string; reason: 'too_large' }> }` per the spec.
   Managed package connectors (with `connector.package`) map to
   `executionMode: "package"` with `package.{name, version, entry, arguments}`
   where `arguments` are the stored arguments after the entry file; their
   executable and install path are never emitted. Bindings map to names only
   (`headerCredentials` keeps the header format). Greedy packing in registry
   order: a part closes when adding the next connector would exceed 32
   connectors or 40 × 1024 bytes of `JSON.stringify(part, null, 2)` (UTF-8);
   `part`/`parts` are filled in after packing (re-measure: the numbers must not
   push a part over 40 KiB).
3. `normalizeImport`: hub branch per spec, after `parseSource` (unchanged) and
   before the existing wrapper detection. Reuse the existing per-field
   validators; do not duplicate or loosen them; do not change any bound.
   Credential names: validate with `assertBinding` semantics for the location
   (catch its error → `invalid_bindings`), `isPackageEnvName` for package
   entries, ≤ 64 per location, case-insensitive duplicates and literal
   collisions → `invalid_bindings`. Bindings in the definition stay `{}`.
   `package` entries → proposal with the new optional metadata.
4. `service.ts` `preview`: when `normalized.format === 'hub'`, before
   `project`, set `selected = false` on every non-proposal entry whose id, or
   folded name, exists in `state.connectors`, and add warning
   `already_installed` to a proposal whose `connectorId` exists. No other
   service change.
5. Route `GET /api/connectors/export` with the same session and origin
   protection as other GET routes; body `{ parts, skipped }`.
6. Web: `Export` button (secondary, download icon) in the Connectors header with
   the caption "Secrets are never exported; credential names are." It fetches
   the route and downloads one Blob per part with the file names in the spec;
   shows "Exported M files" when M > 1 and lists skipped connectors.
7. `ImportDialog.tsx`: `Load from file…` button + hidden `<input type="file"
accept=".json,application/json">`; files over 48 KiB get an inline error;
   content fills the existing Configuration JSON field and follows that field's
   existing clearing behaviour (no extra retained copy). Each entry with
   `requiredCredentials` lists the names ("Needs credentials after saving:
   …").
8. `App.tsx` proposal → `PackageSeed` bridge and `PackageInstall.tsx`: carry
   `connectorName`, `connectorId`, `description`, `entry`, `enabled`,
   `environmentLiterals`; the form's connector-name field is pre-filled from
   `connectorName` (not the package name) and entry from `entry`; the install
   request sends the new fields. `packages/service.ts` uses them, falling back
   to today's defaults when absent.
9. Tests: round trip (spec fixture set incl. a connector named `constructor`)
   → `exportConnectors` → each part → `normalizeImport` → no issues, matching
   definitions and proposal metadata; serialized export contains none of the
   fixture secret values, install paths or the node path; 33 connectors → 2
   parts; no part over 32 connectors or 40 KiB; the largest generated part
   wrapped as `JSON.stringify({ source, expectedRevision: 0 })` is under 64 KiB;
   an oversize connector lands in `skipped`; invalid credential names
   (`NODE_OPTIONS`, header `Host`, duplicates) give `invalid_bindings`;
   `preview` deselects existing ids/names for the hub format only; package
   install with metadata commits the given name, id, description, enabled and
   literals. E2E: export, load the part file, save in the isolated test
   registry, load the same file again and see saved entries deselected.

Acceptance: tests pass; every existing `tests/import*.test.ts`,
`tests/package*.test.ts` and `tests/e2e/imports.spec.ts` /
`tests/e2e/packages.spec.ts` case passes unchanged; export of the real-shaped
fixtures contains no secret value.

## Task 4 — tray icon and start with Windows

Files: `scripts/desktop-runtime.mjs`, `scripts/desktop.mjs`,
`scripts/WaleedMcpHub.cs`, `scripts/build-launcher.mjs`,
`apps/web/src/App.tsx` (Settings startup line only), new test
`tests/desktop-control.test.ts`, `docs/guides/windows-installer.md`.

1. `desktop-runtime.mjs`: `attach\n` and `quit\n` per spec; attached-socket set
   (≤ 8) destroyed only immediately before the **final** `control.close` on
   every final path; `stop()` reordered per spec (set closing, send shutdown,
   keep listener and attachments until backend exit, busy replies meanwhile);
   `startDesktop({ attach })`; exported `requestQuit({ root, directory })` with
   the five outcomes and 5 s timeout from the spec.
2. `desktop.mjs`: argument forms none / `--attach` / `--quit` per spec with the
   spec's exit codes; any other argument exits 2. No stdin reading. Call
   `unref()` on the spawned Edge child.
3. `build-launcher.mjs`: add `/reference:System.Drawing.dll` and
   `/win32icon:<root>\apps\web\public\brand\favicon.ico`.
4. `WaleedMcpHub.cs` per spec: `--startup`; child `desktop.mjs --attach`; mutex
   `Local\WaleedMcpHub.Tray` with 2 s retry timer; `ApplicationContext` message
   loop; child exit via `Exited` marshalled to the UI thread; Open and Quit via
   hidden `node desktop.mjs` / `node desktop.mjs --quit` from the same root with
   the same PATH tweak; non-blocking 15 s quit timer that keeps the icon and
   shows the retry balloon; preference file as source of truth with two-way
   reconciliation on every start (path rewrite after 10 s of child life); menu
   toggle writes file then Run value, then shows the actual Run state; every
   file/registry failure is a balloon, never a crash; existing error MessageBox
   and exit codes kept.
5. Settings startup line text per spec.
6. Unit tests (real named pipe in a temp directory, like the existing desktop
   tests): attach `closed` resolves when the manager stops; the final close is
   not blocked by an attached socket; an attachment stays open while a stalled
   backend is shutting down; `quit` stops the manager and replies
   `wmh-desktop-quitting`; `attach`/`quit` answer busy while closing; ninth
   attach is busy; `requestQuit` returns `absent` without a pipe,
   `unsupported` when the pipe closes silently, `failed` on timeout or an
   unknown reply; a `desktop.mjs --attach` child process stays alive while
   attached and exits promptly after the manager stops, with a long-lived
   opener child standing in for Edge.
7. Guide: tray menu, Start with Windows, the preference file, and how to remove
   the Run value manually.

Acceptance: `node scripts/build-launcher.mjs` compiles; `WaleedMcpHub.exe
--self-test` exits 0; `npm run test:windows-integrations` passes; existing
desktop tests pass; manual tray checklist in the spec passes (orchestrator runs
it).

## Task 5 — docs

Files: `README.md` ("What works now"), `docs/ROADMAP.md` (items 14 and 16
status), `docs/STATUS.md`, guides touched in tasks 3 and 4.

Acceptance: `docs-guard` clean; every documented button, route and file name
exists.

## Order

1 → 2 → 3 → 4 → 5. Task 2 changes markup Task 1 renders into, so 1 lands first;
Task 3's Export button needs Task 2's header slot. Task 4 is independent of the
web tasks except the one Settings line, and runs after them to keep one
implementer busy at a time.

---

## Debate round 1 — Codex `gpt-6.1-sol` (high, read-only relay)

| #   | Finding                                                                                                            | Verdict | Reason                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `${NAME}` placeholders are rejected (`normalize.ts` `reference()` → `unresolved_reference`); round trip impossible | accept  | Verified. Feature 4 now uses a dedicated hub format with empty bindings and `requiredCredentials` names; constraint 4 relaxed to "one new shape, existing shapes unchanged".                    |
| 2   | stdin reader keeps `desktop.mjs` alive and blocks tray handoff                                                     | accept  | Verified the process ends on an empty event loop. stdin channel removed; lifetime and quit move to the existing control pipe (`attach`, `quit`).                                                |
| 3   | `npx` entries become proposals that lose id/name/description/enabled/entry                                         | accept  | Verified (`definition = null`, proposal has only name/version/arguments/envNames). Proposal and install request gain optional metadata.                                                         |
| 4   | Export of > 32 connectors / > 48 KiB is not importable                                                             | accept  | Verified limits at `parseSource` and the `entries.length > 32` check. Hub format gets 512 KiB / 256 entries; `create_connectors` 32-per-save handled by batch preselection and auto re-preview. |
| 5   | Docker `portBindings` lost (not a supported import key)                                                            | accept  | Verified the supported-key list. Hub format carries `portBindings`, validated by `PortBindingsSchema`.                                                                                          |
| 6   | Plain `env` values become secret drafts and block save                                                             | accept  | Verified (`extract` captures every value; save-preview refuses any secret reference). Hub format separates `environmentLiterals` from credential names.                                         |
| 7   | Package install bumps revision and discards the rest of a mixed-file review                                        | accept  | Verified `current()` discards on revision change. Dialog re-previews the same text once automatically; order-independent.                                                                       |
| 8   | Names like `constructor`/`__proto__` cannot be JSON keys                                                           | accept  | Verified `parseSource` rejects them. Hub format is an array with `name` fields.                                                                                                                 |
| 9   | Launcher shows no tray for a manager started elsewhere (`reused` returns at once)                                  | accept  | Verified `reused: true, closed: Promise.resolve()`. `--attach` keeps the child alive for the manager's lifetime.                                                                                |
| 10  | Quit timeout removes the icon while the backend may still run                                                      | accept  | Icon stays, retry balloon, non-blocking timer.                                                                                                                                                  |
| 11  | No reconciliation between preference file and Run value                                                            | accept  | Preference file is source of truth; two-way reconcile every start; path rewrite after 10 s of child life.                                                                                       |
| 12  | New status radios break `packages.spec.ts` radio count of 2                                                        | accept  | Verified `getByRole('radio')` count. Filter uses `aria-pressed` buttons; constraint 2 forbids new page radios.                                                                                  |
| 13  | Manual re-check leaves the bar at 100 %                                                                            | accept  | Verified observations only refresh at the end. Local `checking` observation on start.                                                                                                           |
| 14  | Settings says "Not implemented · no startup entry"                                                                 | partial | Text changes to point at the tray menu; `BootstrapSchema.startup` stays, because the server does not manage or read the launcher's state and must not claim it.                                 |

## Debate round 2 — Codex `gpt-6.1-sol` (high, read-only relay)

Tree verified unchanged against the dispatch baseline (`f03b17a`, same
untracked files) after the run.

| #   | Finding                                                                                                    | Verdict | Reason                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Edge child keeps the manager's Node process alive after `closed`                                           | accept  | Verified the referenced `spawn` in `desktop.mjs`. Spec requires `unref()` on the Edge child; test uses a long-lived opener.                                                                   |
| 2   | `stop()` closes the listener first, so destroying attachments at close drops the tray before shutdown ends | accept  | Verified `stop()` order. `stop()` now sends shutdown first and keeps listener + attachments until backend exit; final close only.                                                             |
| 3   | 512 KiB request never reaches the importer (Fastify 64 KiB body)                                           | accept  | Verified `bodyLimit`. Design changed: all bounds unchanged; export splits into ≤ 40 KiB / ≤ 32-connector parts; test asserts the request body stays under 64 KiB.                             |
| 4   | Preview/selection contracts cap at 32 entries                                                              | accept  | Resolved by the same change: one part never exceeds 32 entries.                                                                                                                               |
| 5   | Browser-only preselection cannot produce a valid preview                                                   | accept  | Hub-only deselection of existing ids/names moved to `service.ts preview`, before projection.                                                                                                  |
| 6   | Successful save unmounts the dialog; no continuation                                                       | accept  | Continuation is "load the same file again"; server-side deselection makes it converge with no browser state.                                                                                  |
| 7   | Proposal metadata dropped at the App → `PackageSeed` bridge                                                | accept  | Verified the manual bridge. Bridge, seed type, form and request named in the task.                                                                                                            |
| 8   | Package `environmentLiterals` lost; example used `NODE_ENV` which packages reject                          | accept  | Verified `{}` literals in the install path and `isPackageEnvName`. Literals carried through; example uses `NO_COLOR`.                                                                         |
| 9   | Synthetic `checking` can stick; 65 s poll shorter than 140 s deadlines                                     | accept  | Verified. Poll until not running (≤ 150 s); always refresh; restore on refresh failure.                                                                                                       |
| 10  | Depth check runs after recursive `parseTree`                                                               | partial | The design no longer raises any bound, so this change introduces no new exposure. The existing ordering is pre-existing behaviour outside F04; recorded as a follow-up issue, not fixed here. |
| 11  | Export can produce files its importer refuses                                                              | accept  | Part splitting by exact serialized bytes; an oversize single connector is listed in `skipped`.                                                                                                |
| 12  | Generic binding regex accepts names Authentication refuses                                                 | accept  | Verified `assertBinding`. Hub names validated with `assertBinding` per location, `isPackageEnvName`, counts and case-insensitive duplicates.                                                  |
| 13  | Retained file text has no confidentiality boundary                                                         | accept  | Removed: no retained copy; the field keeps its existing clearing behaviour.                                                                                                                   |
| 14  | `requestQuit` outcomes undefined for legacy/silent/timeout cases                                           | accept  | Five outcomes with a 5 s timeout, `absent` only on `ENOENT`, exit codes and tray messages per outcome.                                                                                        |
| 15  | Attachment acceptance test contradicts the lifetime requirement                                            | accept  | Acceptance rewritten: alive while attached, exits promptly after the attachment closes.                                                                                                       |
