# F04 — Connectors UI refresh, discovery progress, tray, export/import

Status: draft v3 (after debate rounds 1 and 2) · Roadmap items 14 (tray, start with
Windows) and 16 (export/import without secrets) · Branch `feat/hub-ui-refresh`

## Problem

1. Tool discovery runs in the background after the window opens, but nothing on
   the Connectors page shows how far it has got. Rows say "Loading tools…" one
   by one and the user cannot tell whether the hub is still working or stuck.
2. The Connectors page is functional but dense: every row panel shows eight
   same-weight buttons in a wrapping line, the page header repeats safety copy,
   and destructive actions sit next to routine ones.
3. The desktop app stops being reachable once its Edge window is closed (the
   backend keeps running with no visible handle), and it never starts with
   Windows.
4. A working setup cannot be moved to another machine or shared without
   re-entering every connector by hand.

## Goal

- A progress bar with a percentage above the connector list that tracks
  capability discovery across every eligible connector.
- A modern, Refero-guided redesign of the Connectors page and its buttons that
  keeps the "light technical control panel" direction of `docs/DESIGN.md`.
- A Windows tray icon that keeps the hub reachable after its window closes, and
  an opt-out "Start with Windows" registration.
- Export of every connector definition to a file that contains no secret value,
  and import of that file through the existing reviewed import flow.

## Non-goals

- Exporting profiles, tool permissions, agent integrations, credentials, OAuth
  tokens, trust approvals or capability observations (follow-up; roadmap 16 stays
  partially open).
- A new import pipeline or a new save path. Import reuses `/api/imports/*`, the
  Add connector dialog, preview, conflict checks, `create_connectors` and
  separate execution approval.
- Changing discovery deadlines, concurrency (two jobs) or approval rules.
- macOS/Linux tray support. An uninstaller.
- Visual changes to Agents, Profiles, Activity and Settings beyond shared button
  styles they inherit and the one Settings startup line named in Feature 3.

## Already on this branch (not part of the delegated work)

- Package verification has its own 120 s deadline before the 20 s MCP handshake
  deadline (`packages/hub-core/src/runtime/checks.ts`), so large managed installs
  such as `ssh-mcp@2.1.0` (13,584 files) no longer time out during automatic
  discovery.
- Registry activity rows are one line.
- The top bar shows the real installed version from `/api/bootstrap`.

## Feature 1 — discovery progress bar

**Eligible connector:** enabled, and its `trustApproval` matches its current
revision and `executionHash` (the rule `ConnectorList` already uses for automatic
discovery).

**Settled:** an eligible connector whose observation for its current revision and
hash has a state other than `untested` or `checking`.

- Rendered at the top of the "Your connectors" panel, above the rows, whenever at
  least one connector is eligible.
- Shows `settled / eligible` as a percentage (rounded down; 100 % only when every
  eligible connector is settled), a text line such as
  `Loading tools · 9 of 22 connectors · 41 %`, and once complete
  `Tools loaded · 22 connectors · 467 tools` plus a count of connectors that
  ended in a failure state (`error`, `timed_out`, `auth_required`,
  `unsupported`, `cancelled`, `unavailable`) as "N need attention".
- Determinate bar width animates with a CSS transition; while loading, a subtle
  moving sheen runs over the filled part. Both stop under
  `prefers-reduced-motion: reduce`.
- Accessible: `role="progressbar"`, `aria-valuemin=0`, `aria-valuemax=100`,
  `aria-valuenow`, `aria-label="Tool loading progress"`; the text line is not a
  live region that announces every tick (announce only start and completion).
- Pure computation in a function `discoveryProgress(connectors, observations)`,
  unit-testable (file location below).
- No new polling: it reads the `observations` state `App` already holds and that
  `ConnectorList` refreshes every second while discovery runs.
- **Manual re-check (debate r1 #13):** when the user starts `Test capabilities`
  on a connector, the observation `App` holds for that connector becomes
  `checking` immediately (local state through the existing `observe` prop, same
  revision and hash), so the bar leaves 100 % for the duration of the manual
  check. The manual check keeps polling its job until the job is no longer
  `running` (bounded at 150 s, which covers the 120 s verification plus the 20 s
  handshake deadlines), then refreshes. If starting the job or polling fails, it
  still calls `refresh()` (and, if that fails too, restores the observation it
  replaced), so a synthetic `checking` never outlives the check (debate r2 #9).
- Failure states for "need attention" also include `unavailable`.
- The pure function lives in `apps/web/src/discoveryProgress.ts` (no JSX) so the
  node test runner imports it without React; `DiscoveryProgress.tsx` renders.

## Feature 2 — Connectors page redesign

Design source: `docs/DESIGN.md` (Refero bundled guidance: light utility canvas,
purposeful grouping, semantic status colour, visible focus, no decorative
gradients/glass). Live Refero MCP is not available; no live reference claims.

- **Header:** title, one-line description, and actions on the right: `Export`
  (secondary), `Add Manual MCP` (secondary), `Add connector` (primary). The
  helper caption stays but sits under the actions in muted 12 px.
- **Safety notice:** collapses to a single slim info bar (icon + one sentence +
  "Explicit actions only" tag) instead of a multi-line block. Same wording,
  shortened to one sentence per capability branch.
- **Toolbar:** count, search box (by name, id, target) and a segmented status
  filter: All · Ready · Loading · Needs attention · Disabled. The filter is a
  `role="group"` of toggle **buttons** with `aria-pressed` — not radios, because
  `tests/e2e/packages.spec.ts` counts every `radio` on the page (debate r1 #12).
  Filters are client-side and default to All. An empty filter result shows "No
  connectors match" with a "Clear filters" button.
- **Rows:** status dot, name with target as secondary text (ellipsis), runtime
  chip, status pill, approval pill, tool count, chevron. Hover and selected states
  use the muted surface; focus ring uses the action colour.
- **Expanded panel:** actions grouped into a toolbar with visible separators:
  1. primary group — `Test capabilities`, `Approve execution`;
  2. configure group — `Authentication`, `Edit`, and the managed-package actions
     (`Verify files`, `Check for update` / `Update to x`, `Reinstall`);
  3. danger group, pushed to the end — `Disable`/`Enable`, `Remove` (Remove uses
     the danger variant).
     Facts render as a two-column definition grid; notices as one compact callout
     list.
- **Buttons (global):** variants `primary`, `secondary` (default), `ghost`,
  `danger`; sizes default 36 px and `small` 32 px; 8 px radius; optional leading
  icon from `Icon.tsx`; consistent disabled, hover, active and
  `:focus-visible` states. Existing `className="primary"` keeps working.
- Must keep working at 1440, 1024, 768 and 390 px widths without horizontal
  scroll.

## Feature 3 — tray icon and start with Windows

Owners: `scripts/WaleedMcpHub.cs` (launcher, tray, Run value) and the existing
desktop control pipe in `scripts/desktop-runtime.mjs` (lifetime and quit). There
is **no stdin channel** (debate r1 #2: a stdin reader keeps Node alive).

### Control pipe additions (`desktop-runtime.mjs`)

The manager's pipe already accepts `open\n`, `open:<rootId>\n` and the handoff
request, bounded to 64 bytes and a 2 s socket timeout. Two requests are added:

- `attach\n` — reply `wmh-desktop-attached\n` and keep the connection open with
  the socket timeout disabled. The manager keeps attached sockets in a set (at
  most 8; further attaches get `wmh-desktop-busy\n`). Attached sockets are
  destroyed only at the **final** close of the control server, immediately
  before `control.close(...)` (because `net.Server.close` waits for open
  connections), on every final path: backend exit, handoff reply flushed,
  restart failure, backend error. A closing manager answers `attach\n` with
  `wmh-desktop-busy\n`.
- `quit\n` — if closing, reply `wmh-desktop-busy\n`; otherwise reply
  `wmh-desktop-quitting\n` and then call `stop()`.
- **`stop()` ordering changes (debate r2 #2):** today `stop()` closes the
  listener before asking the backend to shut down. It becomes: set `closing`,
  send `shutdown` to the backend, and keep the listener and attached sockets
  open until the backend exits; while closing, every request is answered with
  `wmh-desktop-busy\n`. The existing backend `exit` handler then performs the
  final close (destroy attachments, close server, resolve `closed`). An attached
  tray therefore stays attached exactly as long as the backend runs, and a hung
  shutdown keeps the tray icon so the 15 s Quit safeguard can act.
- **Edge window lifetime (debate r2 #1):** `desktop.mjs` spawns Edge with
  ignored stdio; it must call `unref()` on that child so an open Edge window
  never keeps the manager's Node process alive after `closed` resolves (Quit,
  handoff).

`startDesktop` gains an option `attach` (default false). When it is true and
another manager owns the pipe (the `reused` path after a successful
`open:<rootId>\n`/`open\n`), it opens one more connection, sends `attach\n`, and
returns `{ reused: true, closed, stop() {} }` where `closed` resolves when that
connection closes for any reason. A legacy manager that closes `attach\n`
without a reply resolves `closed` immediately and logs that the tray cannot
attach. A new exported helper `requestQuit({ root, directory })` sends `quit\n`
with a 5 s timeout and resolves to exactly one of (debate r2 #14): `'quitting'`
(reply `wmh-desktop-quitting\n`), `'busy'` (reply `wmh-desktop-busy\n`),
`'absent'` (connect fails with `ENOENT` only: no pipe), `'unsupported'` (the
pipe closed without any reply: a legacy manager), or `'failed'` (timeout, a
reply longer than 64 bytes or not one of the known lines, or any other connect
or transport error).

`desktop.mjs` accepts exactly these argument forms: none (today's behaviour),
`--attach` (pass `attach: true`; the process lives as long as the manager it
owns or attached to), and `--quit` (call `requestQuit`, never open a window;
exit 0 on `quitting`, 3 on `absent`, 4 on `busy`, 5 on `unsupported`, 1 on
`failed`). Any other argument exits 2.

### Launcher (`WaleedMcpHub.cs`)

- Starts `runtime\node.exe scripts\desktop.mjs --attach` hidden (was: no
  argument) and waits for it, as today. The child is therefore alive exactly as
  long as a manager for this installation is alive — whether this launcher
  started it, it was started from a terminal (`npm run desktop`), or an older
  launcher started it (debate r1 #9).
- **Tray:** while its child runs, the launcher that holds the per-user mutex
  `Local\WaleedMcpHub.Tray` shows one `NotifyIcon` (the app icon, tooltip
  "Waleed MCP Hub"). A launcher that cannot take the mutex keeps waiting on its
  child, retries the mutex every 2 s on a WinForms timer, and shows the icon once
  it holds it (this covers the version-handoff case: the old manager exits, so
  the old launcher's child exits, so the old launcher exits and releases the
  mutex).
- The launcher runs a WinForms message loop (`Application.Run` with an
  `ApplicationContext`) and learns about child exit through
  `Process.EnableRaisingEvents`/`Exited`, marshalled to the UI thread. Nothing on
  the UI thread blocks.
- Tray menu: **Open Waleed MCP Hub** (default, also on double-click),
  **Start with Windows** (checkable), separator, **Quit**.
  - Open: starts another hidden `node desktop.mjs` (no argument) from the same
    root; the existing pipe reuses the running backend and reopens the window.
  - Quit: starts hidden `node desktop.mjs --quit`. The menu item shows
    "Stopping…" and is disabled. When the main child exits, the icon is removed
    and the launcher exits. If the main child has not exited 15 s after the quit
    request, the icon **stays**, Quit is re-enabled, and a balloon says "Waleed
    MCP Hub is still stopping. Choose Quit again to retry." (debate r1 #10).
    Quit helper exit codes: 3 (`absent`) is treated as already stopped; 4
    (`busy`) keeps waiting on the same 15 s timer; 5 (`unsupported`) shows "This
    hub version cannot be stopped from the tray. Use Settings to stop the
    desktop manager." and re-enables Quit; 1 or any other code shows "Could not
    reach the hub to stop it." and re-enables Quit.
- **Closing the Edge window** leaves the backend and the tray icon running.
- **Start with Windows:** value `WaleedMcpHub` under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, data
  `"<launcher path>" --startup`. The preference file
  `%LOCALAPPDATA%\WaleedMcpHub\launcher-settings.json`
  (`{"startWithWindows": true|false}`) is the **source of truth** (debate r1
  #11):
  - Absent file → preference `true`; the launcher writes the file (temp file +
    `File.Replace`/move).
  - **Every start reconciles both directions**: preference `true` → ensure the
    Run value exists and points at this launcher; preference `false` → ensure the
    Run value is absent. The path rewrite for `true` happens only after the main
    child has stayed alive for 10 s, so a broken new install does not take over
    startup.
  - Toggling from the menu writes the preference file first, then reconciles
    the Run value, then re-reads both and sets the menu check from the actual
    Run value state. Any failure (file or registry) leaves the check showing the
    real Run state and shows a balloon naming which step failed. Nothing is
    thrown out of the message loop.
- `--startup` behaves like a normal launch (opens the window). `--self-test`
  keeps its current meaning. Any other argument still exits with code 2.
- Icon: compiled into the exe with `/win32icon:apps\web\public\brand\favicon.ico`
  (requires `/reference:System.Drawing.dll`); the tray uses
  `Icon.ExtractAssociatedIcon` of the exe.
- **Settings page (debate r1 #14):** the startup row's text changes from
  "Not implemented · no startup entry installed" to "Managed by the tray icon ·
  right-click the Waleed MCP Hub icon and use Start with Windows". The server does
  not read or claim the launcher's state; `BootstrapSchema.startup` keeps its
  current value and meaning (the server itself installs no startup entry).

## Feature 4 — export and import without secrets

The existing importer cannot round-trip hub connectors: it turns every `env` and
`headers` value into a captured secret, rejects `${NAME}` placeholders, drops
docker `portBindings`, turns `npx` entries into package proposals without the
connector's metadata, and refuses names such as `constructor` as keys (debate r1
#1, #3, #5, #6, #8). Feature 4 therefore uses a **dedicated, versioned hub
export format** and one new branch in `normalizeImport`.

**Every existing import bound stays exactly as it is** (debate r2 #3, #4, #5,
#6, #10, #13): 48 KiB source, 8,192 JSON nodes, depth 20, 32 entries per
document, 32 entries in `ImportPreview`/`ImportSelection`, 32 definitions per
`create_connectors`, and Fastify's 64 KiB body limit. Instead of a bigger
import, a large registry exports to several **part files**.

### Export format `waleed-mcp-hub/connectors@1`

```json
{
  "format": "waleed-mcp-hub/connectors",
  "version": 1,
  "part": 1,
  "parts": 1,
  "connectors": [
    {
      "id": "context7",
      "name": "Context7",
      "description": "…",
      "enabled": true,
      "executionMode": "remote",
      "transport": "streamable_http",
      "endpoint": "https://…",
      "headerCredentials": [{ "name": "Authorization", "format": "bearer" }]
    },
    {
      "id": "ssh-curemed-mcp",
      "name": "ssh-curemed-mcp",
      "description": "",
      "enabled": true,
      "executionMode": "package",
      "package": {
        "name": "ssh-mcp",
        "version": "2.1.0",
        "entry": "ssh-mcp",
        "arguments": ["--host=…"]
      },
      "environmentLiterals": { "NO_COLOR": "1" },
      "environmentCredentials": ["SSH_KEY"]
    }
  ]
}
```

- Top level: exactly the keys `format`, `version`, `part`, `parts`,
  `connectors`. `connectors` is an array of 1–32 entries — not a name-keyed map —
  so any legal connector name, including `constructor` or `__proto__`, is carried
  in a `name` field.
- Per connector: `id`, `name`, `description`, `enabled`, `executionMode` (one of
  `remote`, `native`, `docker`, `package`), and the mode's fields:
  - `remote`: `transport`, `endpoint`, `headerCredentials` (array of `{name,
format}` — names and header format only).
  - `native`: `executable`, `arguments`, `environmentLiterals`,
    `environmentCredentials` (array of names).
  - `docker`: `image`, `command`, `arguments`, `portBindings`,
    `environmentLiterals`, `environmentCredentials`.
  - `package` (a managed package connector, i.e. one with `connector.package`):
    `package.name`, `package.version` (exact), `package.entry`,
    `package.arguments` (the arguments after the entry file),
    `environmentLiterals`, `environmentCredentials`. Never the install path or
    the hub's `node.exe`.
- Never included: secret values, OAuth tokens, trust approvals, observations,
  install paths, profiles, permissions.
- **Part files (debate r1 #4, r2 #11):** `exportConnectors` packs connectors in
  registry order into parts. A part holds at most 32 connectors and its
  serialized text (2-space indented JSON, UTF-8) is at most **40 KiB**, which
  leaves room under the importer's 48 KiB source limit and, once JSON-escaped
  inside the preview request body, under the 64 KiB HTTP limit (a test asserts
  the largest generated part's request body stays under 64 KiB). A single
  connector whose own part would exceed 40 KiB is **not exported**; the export
  response lists it in `skipped: [{id, name, reason: "too_large"}]` and the UI
  shows that list. There is no aggregate limit: 256 connectors give up to 8+
  parts.
- `GET /api/connectors/export` (session- and origin-protected like every API)
  returns `{ parts: string[], skipped: [...] }` — each part already serialized —
  built from `lifecycle.inventory()` (registry state only; never the credential
  store). The response is far below Fastify's reply limits (it is not bounded by
  the 64 KiB request limit). The web UI saves each part as
  `waleed-mcp-hub-connectors-YYYY-MM-DD.json` (one part) or
  `waleed-mcp-hub-connectors-YYYY-MM-DD-part-N-of-M.json`, and shows "Exported
  M files" when M > 1.

### Import of the hub format

- `normalizeImport` detects the hub format when the document's top-level keys
  are exactly `format`, `version`, `part`, `parts`, `connectors` with
  `format === "waleed-mcp-hub/connectors"`; `version !== 1`, a non-integer
  `part`/`parts`, `part > parts`, or 0 or more than 32 connectors is `invalid`.
  The hub branch is mutually exclusive with every existing wrapper.
  `ImportPreview.format` gains `"hub"`. `parseSource` and every bound are
  unchanged.
- Each hub connector becomes one `ImportEntry` using the **same validators and
  issue codes** as today (name, id, description, endpoint, transport,
  executable shape, argument and inline-program checks, credential-in-definition
  checks, literal whitelist, image shape) plus `PortBindingsSchema` for docker
  ports.
- **Credentials (debate r2 #12):** bindings are **empty** in the imported
  definition. Names are surfaced on the entry as `requiredCredentials: {
environment: string[], header: Array<{name, format}> }` and a new warning
  `credentials_required`. Each name is validated with the **same rule the
  Authentication dialog enforces** for that location (`assertBinding` in
  `packages/hub-core/src/auth/bindings.ts`, including its forbidden environment
  and header names), plus `isPackageEnvName` refusal for `package` entries; at
  most 64 names per location; a case-insensitive duplicate, or an environment
  credential that collides with an `environmentLiterals` key, is an
  `invalid_bindings` issue. Nothing is captured into `draft.secrets`, so the
  save path's "no private values" rule is unchanged. After saving, the user
  adds values with the existing Authentication dialog, which already takes a
  binding name.
- **Package entries (debate r1 #3, r2 #7, #8):** `package` connectors become
  package proposals as today (`definition: null`, `selected: false`). The
  proposal carries the hub metadata: `PackageProposalSchema` gains optional
  `connectorName`, `connectorId`, `description`, `entry`, `enabled` and
  `environmentLiterals` (validated by the same schemas a manual install uses,
  literals by the importer whitelist and `isPackageEnvName`). The bridge in
  `App.tsx` that builds a `PackageSeed` from a proposal, the `PackageSeed`
  type, the install form and the install request all carry these fields;
  `PackageInstallRequest` gains optional `connectorId`, `description`,
  `enabled` and `environmentLiterals` (it already has `connectorName` and
  `entry`). The package service uses them for the dry run and the committed
  connector instead of its defaults (`enabled: true`, fixed description, `{}`
  literals). The connector name pre-filled in the form is `connectorName`, not
  the package name.
- **Already-present entries (debate r2 #5):** for the hub format only,
  `imports.preview` deselects (`selected: false`) every non-proposal entry
  whose id, or whose name under the existing folding (`NFKC`, trim, lower
  case), already exists in the inventory, before projection; it also marks a
  proposal whose `connectorId` already exists with a new warning
  `already_installed`. So loading the same part file again after a save
  continues with what is left, without any state kept in the browser.
- **Mixed files (debate r1 #7):** saving definitions and installing packages are
  separate actions, as today. After either changes the inventory, the user loads
  the same file again (`Load from file…`) to continue; the deselection rule
  above makes that converge. The dialog keeps **no** copy of file text beyond
  today's behaviour (debate r2 #13).

### Load from file

The Add connector dialog gains `Load from file…` (accepts `.json`, ≤ 48 KiB —
the importer's own limit — read with `FileReader` into the existing
Configuration JSON field, with the same clearing behaviour that field has
today). Everything after that is the existing preview → save flow.

### Round trip is the acceptance test

Exporting a registry with one connector of every kind (remote with a header
credential, native with an environment credential and a whitelisted literal,
docker with two port bindings, managed package with arguments, a literal and a
credential, a disabled one, and one named `constructor`) and importing the part
yields entries with no issues whose definitions match the originals minus
binding values, approvals and install paths, and a proposal whose metadata
matches the package connector; the export text contains none of the fixture's
secret values, install paths or the hub `node.exe` path.

## Acceptance

- Progress bar values match the definition above in unit tests, including 0
  eligible (hidden), partial, all settled with failures, stale observations
  (old revision counts as not settled), and a manual re-check moving the bar off
  100 % and never leaving a synthetic `checking` behind on failure.
- All existing unit and e2e tests pass unchanged; any e2e selector change is a
  defect unless it only adds coverage.
- Redesign renders at four widths without horizontal scroll (Playwright
  screenshots attached to the PR).
- Control pipe: unit tests for `attach` (closed resolves when the manager stops;
  attached sockets do not block the final `control.close`; an attachment stays
  open while a stalled backend is shutting down), `quit` (stops the manager),
  busy answers while closing, every `requestQuit` outcome, and a
  `desktop.mjs --attach` process that **stays alive while attached and exits
  promptly once the attachment closes**, with no stdin reader and with a
  long-lived opener child standing in for Edge (debate r2 #15).
- Tray: manual verification on Windows — icon appears, closing the window keeps
  it, Open reopens, Quit stops backend and icon, Quit timeout keeps the icon,
  Start with Windows toggles the Run value and reconciles on next start; tray
  shows for a manager started with `npm run desktop`; recorded in the PR.
- Export round-trip test passes; part splitting holds at the bounds (33
  connectors make two parts; a part never exceeds 32 connectors or 40 KiB; the
  largest part's preview request body is under 64 KiB; an oversize connector is
  listed in `skipped`); export contains no secret value; every existing import
  limit test still passes unchanged. E2E: export, load the part in the Add
  connector dialog, save in the isolated test registry, load the same file again
  and see the saved entries deselected.
- `npm run typecheck`, `npx eslint apps packages tests scripts`, `npm test`,
  `npm run build`, relevant `npx playwright test` specs and
  `npm run format:check` pass.
