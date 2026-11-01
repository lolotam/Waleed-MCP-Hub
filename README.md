# Waleed MCP Hub

A local-first Windows application being built for managing MCP connectors used by
coding-agent CLIs through a professional browser interface.

**Current status: P1–P9 enabled subsets are implemented, including protected credentials,
nine Windows configuration adapters, scanner/manual-MCP UI and portable packaging.
Integration is configuration-only, not live agent/authentication verification.
Real agents, Edge/shortcut behavior and live-account OAuth still have release gates.
See `docs/STATUS.md` for evidence and limitations.**

Project location: `E:\Dev\Projects\Waleed-MCP-Hub`.

**New here?** Start with the [user guides](docs/guides/README.md): how to add every
kind of MCP server, connect your agents, and fix common problems. Planned work is
in the [roadmap](docs/ROADMAP.md).

## Planning documents

| Document                                           | Purpose                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Full specification](docs/SPECIFICATION.md)        | Product behavior, architecture, security, data model, authentication, and supported scope |
| [Implementation plan](docs/IMPLEMENTATION_PLAN.md) | Ordered work packages, dependencies, test gates, and rollout                              |
| [Design direction](docs/DESIGN.md)                 | Visual references, tokens, screen structure, and interaction decisions                    |
| [Acceptance criteria](docs/ACCEPTANCE.md)          | Functional/security/compatibility release checklist                                       |
| [Decision log](docs/DECISIONS.md)                  | Resolved decisions and remaining investigations                                           |
| [Project status](docs/STATUS.md)                   | Actual progress and known blockers                                                        |

## Run locally (PowerShell)

Requires Node.js 24 LTS and npm 11. Tested with Node 24.21.0 at
`E:\Dev\Tools_and_Utilities\nodejs24`. Use the latest patched Node 24 before
enabling real credentials or execution. No system runtime settings are changed.

```powershell
cd E:\Dev\Projects\Waleed-MCP-Hub
. .\scripts\Use-Node24.ps1
npm ci
npm run build
npm start
```

The server binds to `http://127.0.0.1:4177` and opens the default Windows browser
with a two-minute, single-use launch link. The browser erases the token from the
address bar and establishes an HttpOnly, SameSite=Strict session. Tokens are not
printed or saved to browser storage. Opening the bare address in an unauthenticated
browser does not grant access; restart the server for a new launch session.
The default-browser opener is implemented but not yet manually verified; automated
browser tests receive their launch link through private parent/child IPC instead.

Use **Ctrl+C** in the terminal to stop the manager. Existing agent gateways and
Docker workloads are independent. A port conflict fails rather than killing its
owner; set `$env:HUB_PORT = '4178'` before starting to select another port. Do not
expose or proxy the server to a LAN or public host.

For source-mode development, run `npm run dev`. It builds the UI and runs the
TypeScript backend at the same origin. Restart after edits; HMR and automatic
backend restarts are intentionally not enabled yet.

## What works now

- Responsive Connectors, Agents, Profiles, Activity, and Settings shell.
- Session-protected APIs, exact Host/Origin checks, CSRF, CSP, bounded requests.
- Creating **empty local profiles** through preview → explicit apply → job result.
- Revision/fingerprint conflicts, single-writer lock, atomic JSON replacement,
  five pre-change backups, and structural profile-change activity.
- Synthetic unit/integration fixtures and disposable browser tests.
- An internal Windows Job Object process runner with bounded time/output and
  owned-tree cancellation. This is tested infrastructure, not an execution endpoint.
- Persistent payload-free refusal auditing, fixed public error messages, and a
  defense-in-depth diagnostic redactor.
- Registry-save recovery journal: classify interrupted commits without replaying
  operations or overwriting drift. Uncertain saves block further changes visibly.
- Explicit read-only discovery of Docker, eight CLI targets, selected user config
  files, and the existing pilot; sanitized snapshot-only adoption previews.
- **Add connector** opens a safe paste/HTTPS/native preview with multi-entry
  selection, normalized definitions, reference-only secrets, and conflict checks.
- Separate revision-bound registry save/edit/toggle/remove operations, profile
  membership, exact execution approval, owned materialization and MCP checks.
- Nine Windows user-file integrations with private backups, comment-preserving
  atomic edits, owned-entry disconnect and configuration-only status.
- Manual Stdio/Docker/HTTP/SSE saving with protected env/headers, optional auto-sync
  and separate execution consent; partial saves return a connector ID to inspect.
- Portable-folder desktop packaging, Windows launchers and opt-in shortcut installer.

On first authenticated opening, **Copy MCPs from your agents** scans known supported
user configuration files. Select source agents and individual MCPs, review their
definitions, and choose **Clone and connect**. Available credentials are copied through
the protected Hub store; values never appear in the browser. Source files stay
unchanged. Existing names require a different destination name. Disabled source
entries remain disabled. Missing credentials and failed connections remain repairable
in Connectors. Unsupported definitions are listed for manual setup. Package-based
`npx` entries require resolved package/command review and warning acknowledgement.
Dismiss or finish the first-run panel to stop automatic rescanning on later openings;
**Scan agents** is always available. Only this nonsecret preference uses browser storage.

**Discover environment** remains a separate bounded read-only Docker/pilot survey;
**Refresh** reloads its observations. Neither scan launches connector commands or calls
tools. MCP discovery after copying is a separate automatic approved-definition check.
No agent/connector command, gateway, image pull, package install, or upstream tool
is launched by environment discovery. Pilot adoption and startup registration remain
disabled/unimplemented. Agent integration is a separate explicit action in Agents.
Protected credential writes and supported
OAuth are separate explicit actions. Opening the connector list automatically
discovers capabilities for enabled, approved definitions. **Test capabilities**
remains available for explicit retries.

Versions come from installed package manifests where safely available; native or
wrapper versions without safe metadata remain unknown. P7 supports documented current
Kilo/Kimi user scopes, and D026 adds Grok's user `config.toml`; effective
project/account/plugin precedence remains unverified, not guessed.
OpenCode/Codex user-file pointers can match while runtime compatibility and actual
MCP verification are still pending. Postora authentication is not fixed by a scan.

Docker probes require a local Windows named-pipe context and the verified MCP
gateway 0.44.2/profile schema v1. Remote Docker contexts and unknown gateway versions
fail closed. A stopped Docker engine is shown as degraded, not as an empty healthy
inventory. Config/source/pilot metadata drift requires review; nothing is overwritten.
Set `HUB_PILOT_DIR` before starting only if the existing pilot directory moved.
Set `HUB_DISCOVERY_MODE=disabled` to run the foundation without the scan capability.

## Safe import previews (P4)

Choose **Add connector** to paste strict JSON, enter an HTTPS endpoint, or provide
a native executable and explicit JSON argument array. Guided npx/uvx inputs are
data only; no package is downloaded or command run. Accepted JSON shapes are a
single server, `mcpServers`, `servers`, OpenCode V2 `mcp.servers`, and supported Docker
image/remote definitions (including a single `server` wrapper). JSONC/TOML, full
Docker profile snapshots, and raw JavaScript/Python/PowerShell programs are not
import formats. Unknown fields and ambiguous transports block the affected entry.

All header/env values become write-only memory draft references. Credential-bearing
URLs and unresolved substitutions are rejected. Only explicitly safe-listed
`environmentLiterals` are public: NODE_ENV=production/development/test, NO_COLOR=1,
and the two Chrome MCP telemetry/update-disable flags=1. Nothing expands shell or
file/env expressions. Move command-line credentials into supported bindings before
previewing. Never paste account credential caches or real secrets into test fixtures.

Review exact normalized command/image/endpoint data, warnings, selected entries,
registry revision, future permissions/downloads, and current effects (no files,
agents, registry writes, credential-store writes or network/process activity).
Duplicate/existing names or IDs require renaming or deselection, never silent
replacement. Invalid entries require explicit deselection. Editing a selection
requires **Update preview** before sanitized export. **Apply import** stays disabled.

Raw browser input is cleared on submission or cancellation; no browser storage is
used. Private backend drafts are owner-scoped, expire after five minutes, and are
discarded on cancel, replacement, logout, stale revision, and shutdown. Known private
Buffers are zeroed on discard; secure erasure of all JavaScript/OS memory copies is
not claimed. Reopening/restarting requires fresh input. P4 never saves a connector
or secret, updates Docker/agent files, approves execution, or fixes upstream auth.

## Connector and profile lifecycle (P5)

1. Normalize with **Add connector**, then **Preview local save** and apply the
   separate registry preview. Private import values stay memory-only; save a
   value-free definition, then enter credentials in **Authentication**.
2. Review the exact executable/image/endpoint and **Approve execution**. Edits and
   toggles invalidate approval. While the connector list is open, approval makes
   enabled connectors eligible for automatic capability discovery.
3. Automatic discovery (or **Test capabilities** for a retry) performs real MCP initialize and tools/resources/prompts
   listing, never `tools/call`, resource reads or prompt execution. Results show
   timestamps, protocol, verification level and per-connector failure status.
4. Create a profile and **Edit membership** using connector IDs. **Apply profile**
   previews/writes only generated `wmh-*` catalogs/native entries and an isolated
   Docker profile, then reads them back. No agent settings change and no connector
   starts on materialization. Complete image snapshots avoid implicit image pulls.
5. Disabling/unassigning/removing updates desired state, not already-running agent
   sessions. Reapply stale profiles and reconnect clients. Dematerialize owned
   artifacts before removing a profile. Credentials are retained by all these actions.

Native execution requires an absolute local `.exe`, explicit argv and an isolated
environment. `.cmd`/`.bat`, npx/uvx shims and scripts remain data-only. Each generated
`.mjs` entry starts a fresh contained process per client, revalidates registry,
approval and recovery state, and rejects stale/disabled/unassigned definitions.
Known Chrome MCP launch arguments force `--isolated`; personal-browser attachment
flags are rejected. Generated sessions currently have a 120-second/1-MiB bound and
require reconnect after that limit; they are not unrestricted long-lived gateways.

Capability jobs have a 20-second deadline (scoped cleanup may take longer), two-job
concurrency limit, 1-MiB aggregate output, eight pages and 256 items per category.
HTTP/SSE requires public HTTPS, pinned validated DNS addresses and normal TLS;
redirects and cookies are not forwarded. Only explicit declared credential bindings
are resolved for approved checks. Docker runs approved
images with unique ownership labels; failed/unprovable scoped cleanup blocks
mutations for recovery. Image execution can pull an absent approved image; only
materialization is guaranteed not to pull. Direct keychain-backed image checks remain
unavailable; the Docker adapter has no undocumented plaintext secret-read method.

## Protected credentials and supported authentication (P6)

Open a connector's **Authentication** dialog. Enter a new credential into its
write-only password field; choose the provider's documented header and exact/raw,
Bearer or Basic format. Basic expects pre-encoded `user:password`. Native environment
bindings must use ordinary credential names, not PATH, NODE_OPTIONS or runtime hooks.
No show/copy/export/read-value endpoint exists. Inputs clear on submission/error/close;
values never enter browser storage or the registry. A save rotates to a fresh random
reference, invalidates execution approval, and is **not** authentication success.
Close the dialog, approve the updated definition and run **Test capabilities**.

- Native/remote credentials use Windows DPAPI `CurrentUser`, per-vault/reference
  entropy and a current-user/SYSTEM-only directory DACL. Ciphertext lives under
  the chosen runtime's `credentials/` folder; no plaintext fallback exists.
- Docker image credentials use the documented OS-keychain `mcp secret set` stdin
  interface. Snapshots contain name/env references only. Direct secret-backed image
  checks remain unavailable. The P7 independent tools bridge supports Windows-backed
  remote connectors without plaintext Docker headers; live provider/agent compatibility
  is not established by its synthetic native bridge smoke.
- Only declared owned bindings are decrypted for a launch/check. Mutable byte
  buffers and leases are zeroed. Immutable JavaScript/.NET strings and OS copies
  cannot be guaranteed securely erased; they are never logged or persisted as plaintext.
- Updates preserve old references. **Unused local credential references** offers
  separately confirmed deletion only when no current/materialized consumer remains.
  Deleting locally never revokes provider authorization. Provider revocation is
  not currently implemented; use the provider's own controls.

The supported production OAuth recipe is **Linear read-only**, for the exact URL
`https://mcp.linear.app/mcp/readonly`, scope `read`. Approve that definition first,
review provider/scope in Authentication, then **Sign in and verify** and **Continue
to verified provider**. PKCE/DCR/state/issuer-bound consent runs through a bounded
loopback callback; tokens are protected locally. The job cannot report success
until MCP initialization/list discovery passes. Real-account consent still needs a
user verification step; fixture success is not a live Linear account claim.

Expired tokens, denial, cancellation, timeout and failed refresh remain distinct.
Refresh is explicit for the supported recipe, not a universal promise. Jobs time out
after two minutes; logout/close cancels them. Cancellation after a provider grant or
credential save may leave authorization/protected data intact for explicit cleanup.
Unsupported endpoints show no invented sign-in flow. Postora remains unresolved;
no Claude account credentials or existing pilot values are exported or copied.

After build, the opt-in `npm run test:disposable-profile` verifies real local Docker
metadata creation/read-back/update/removal plus two synthetic native clients. It
uses fresh owned IDs/files, no image pulls or upstream requests, and hashes the
existing pilot snapshot without printing it. On failure it retains its own recovery
directory for inspection; never delete or repair the existing pilot to make it pass.

## Windows agent integration and manual MCP (P7/P8)

Open **Agents → Scan Installed Agents**, review the paths and approve user-file
changes/private backups, then choose **1-Click Integrate**. Scanning starts no agent
or model turn. **Disconnect** removes only the owned `waleed-mcp-hub` entry; unrelated
connectors, comments, Codex `node_repl`, Claude plugins and denylist remain intact.
Unknown/conflicted scopes require review, never overwrite-by-force.

| Target            | Default user file                                                                | Managed map   |
| ----------------- | -------------------------------------------------------------------------------- | ------------- |
| OpenCode V2       | `~/.config/opencode/opencode.json` (or sole `.jsonc`)                            | `mcp.servers` |
| Codex             | `~/.codex/config.toml` (`CODEX_HOME` supported)                                  | `mcp_servers` |
| Claude Desktop    | Store: `%LOCALAPPDATA%/Claude-Data/claude_<id>/…`; classic: `%APPDATA%/Claude/…` | `mcpServers`  |
| Claude Code       | `~/.claude.json`                                                                 | `mcpServers`  |
| Antigravity       | `~/.gemini/antigravity/mcp_config.json`                                          | `mcpServers`  |
| VS Code           | `%APPDATA%/Code/User/mcp.json`                                                   | `servers`     |
| Cursor            | `~/.cursor/mcp.json`                                                             | `mcpServers`  |
| Current Kimi Code | `~/.kimi-code/mcp.json` (`KIMI_CODE_HOME` supported)                             | `mcpServers`  |
| Kilo CLI          | `~/.config/kilo/kilo.json` (sole `kilo.jsonc`/`config.json` supported)           | `mcp`         |
| Grok CLI          | `~/.grok/config.toml` (`GROK_HOME` supported)                                    | `mcp_servers` |

VS Code uses its documented current `mcp.json`, **not** legacy `settings.json →
mcp.servers`. Legacy Kimi `~/.kimi` is not modified. Multiple supported files and
custom `CLAUDE_CONFIG_DIR` are refused as ambiguous. No account/plugin/project
configuration is rewritten. Unknown native versions stay unknown.

**Integrated** means the owned file entry was read back, not that an installed
agent connected or authenticated. Follow its reconnect/trust guidance. The bridge
exposes approved enabled registry connectors as tools; discovery invokes no tools,
and actual tool calls are forwarded only on explicit agent requests. It is tools-only:
no resource/prompt forwarding. Two simultaneous requests, 256 tools, eight pages per
peer and bounded contained sessions apply; native peers are restarted per request.
Secretless Docker transport exists, but live image compatibility/cleanup is unverified;
keychain-backed Docker bridge execution is unsupported.

Choose **Connectors → Add Manual MCP** for Stdio (absolute `.exe` and JSON args),
Docker (image/JSON args/loopback ports), or public HTTPS HTTP/SSE (URL/headers).
Environment/header objects are write-only JSON; include the provider's exact prefix
in Authorization. Never place credentials in names, args or URLs. Storage uses P6,
not agent files. Save does not approve execution or authenticate. The separate trust
checkbox approves the saved definition only after credential writes complete.
Auto-sync verifies existing owned bridge entries; dynamic registry reads and tool-list
notifications avoid unnecessary file rewrites. Agents can still require reconnect.
If the receipt says **partially saved**, inspect that connector/recovery instead of
adding it again. No whole-file automatic rollback overwrites newer unrelated settings.

Protected routes: `POST /api/agents/scan`, `POST /api/agents/:agentId/integrate`,
`POST /api/agents/:agentId/disconnect`, `GET /api/agents/:agentId/status`,
`POST /api/agents/sync`, and `POST /api/connectors/manual`. Integrate/disconnect
require the current registry revision, scanned file fingerprint and explicit consent;
all mutations retain Origin/session/CSRF protection.

## Windows desktop and portable folder (P9)

After building, launch `scripts\start-desktop.bat` or
`powershell -NoProfile -File scripts\start-desktop.ps1`. The source launcher uses
`HUB_NODE_PATH` or `node.exe` on PATH; portable builds prefer bundled Node 24.
Microsoft Edge is required for `--app` mode. Launch tokens use `#launch=...`, never
query parameters. Real Edge window/shortcut behavior remains manually unverified.

```powershell
npm run package:desktop
# Use the generated desktop-builds\Waleed-MCP-Hub-... folder:
#   scripts\start-desktop.bat
# Optional, explicitly installs one Desktop shortcut:
#   powershell -NoProfile -File scripts\install-desktop-shortcut.ps1
```

Keep the generated folder intact and at a stable path: integrated agents reference
its bundled Node/bridge by absolute path. Disconnect and reintegrate after a reviewed
move/upgrade. No installer, service, startup task or execution-policy bypass is used.
Shortcut installation refuses an existing shortcut unless `-Replace` is explicit.
The runtime directory remains `%LOCALAPPDATA%\WaleedMcpHub` unless `HUB_DATA_DIR`
is set; packaging does not copy credentials, personal configs or the pilot.

Reopening uses a same-user/runtime-bound pipe to ask the existing backend for a
fresh launch; the pipe returns only an acknowledgement. **Closing the window leaves
the manager running. Settings → Stop desktop manager** performs protected graceful
shutdown and releases locks. Independent agent bridges remain agent-owned. A port
conflict never kills its owner. Never remove active locks to start another instance.

## Verification

```powershell
npm run check
npm run test:windows-integrations
npm run test:e2e
npm run format:check
# After packaging, independently verify a chosen generated folder:
# node scripts/verify-desktop-package.mjs 'desktop-builds\Waleed-MCP-Hub-...'
```

`check` runs typechecking, lint, browser dependency boundaries, credential signature
scanning, unit/integration tests, production build/bundle checks, and a compiled
Windows process-host smoke test and a compiled DPAPI/authenticated native-launcher
smoke test with owned cleanup. Browser tests
need Chromium (`npm exec playwright -- install chromium` if not already installed).
They use isolated runtime directories and do not read personal configs or contact
MCP providers. Screenshots at 1440/1024/768/390 px are saved in ignored `test-results/`.
`test:windows-integrations` uses ten disposable Windows configs and a synthetic
DPAPI-backed independent client; it does not edit real agent settings. The portable
check copies outside the workspace, uses bundled Node with empty PATH and checks
session/UI/shutdown, not real Edge/shortcut execution.

For a separately requested check of your **real** local installation, after build:

```powershell
npm run discovery:read-only
```

This explicit command uses the same read-only discovery module, prints only a
sanitized metadata summary, and compares observed file contents and any retrieved
pilot snapshot before/after. It does not adopt or repair anything. It is deliberately
excluded from normal CI and `npm run check`. Synthetic browser fixtures are labelled
as such and cannot be enabled through the normal application's discovery endpoint.

`npm run test:disposable-secret` is a separate opt-in real Docker keychain check:
it sets a synthetic value through stdin under a fresh owned ID, checks metadata
presence and removes only that ID. No existing secret value is returned to the hub
or modified. Docker's own CLI/keychain/provider internals are outside that claim;
the hub consumes only the documented name/provider metadata projection.
Normal tests include real disposable Windows DPAPI/native MCP checks and synthetic
local OAuth/HTTP peers; they do not authorize a real provider account.

## Runtime data and recovery

State defaults to `%LOCALAPPDATA%\WaleedMcpHub`, outside the source tree. For an
isolated/portable run, explicitly set `$env:HUB_DATA_DIR` to a dedicated directory.
Never select an existing agent config or pilot directory.

- `state.json`: version-1 registry and structural local activity.
- `writer.lock`: lifetime writer lock with PID/time, not a credential.
- `safety.json`: version-1 refusal metadata and local/external operation-journal hashes.
- `safety.lock`: independent lifetime lock for that ledger.
- `backup-*.json`: up to five pre-change registry snapshots; treat them as private.
- `credentials/`: CurrentUser DPAPI ciphertext and non-secret vault-scope metadata;
  do not copy it as a portable credential export or remove it to bypass recovery.
- `agent-backups/`: private timestamped `.bak` copies of changed agent files. These
  can contain existing private settings; do not publish them or restore whole files
  over newer unrelated changes. No automatic retention/restore UI is provided yet.

A crash can leave `writer.lock` and/or `safety.lock`. Verify that each recorded
process is no longer running and no hub uses the directory **before** manually
removing only its stale lock.
Do not remove it merely because a second start was rejected. Invalid or externally
edited state fails closed; it is not replaced by an empty registry. Stop the hub
before inspecting/restoring state. Guided restore is not implemented.
Jobs/previews/sessions are memory-only; prepared operation metadata is durable.
On restart, an exact canonical pre-state hash marks a save aborted, and an exact
post-state hash marks it committed **for registry-only operations**. External
checkpoints always require review after interruption, regardless of registry hash.
A different state stays **needs review** and
blocks preview/apply. No process, operation, backup restore, or external write is
automatically replayed. A proven saved profile with failed journal finalization
shows a warning rather than falsely claiming the save failed.

Inspect the session-protected **Inspect recovery metadata** link when a warning
appears, then stop the manager before comparing private state/backups. Do not erase
`safety.json`, edit its hashes, or delete active locks just to clear a warning.
Ambiguous repairs require a separately reviewed, scoped recovery decision; there
is no generic override/restore endpoint. Never restore a whole old agent config
over unrelated newer changes. Docker/file apply uses exact-state compensation and
read-back, not distributed atomicity. Unknown outcomes block rather than replay.
Credential effects use the same prepared/external recovery rule; failed or unknown
deletions require review rather than pretending to restore plaintext. Agent changes
use the external journal too; uncertain partial writes require manual review, not replay.

Refusal auditing retains the latest 200 closed metadata events and the journal
retains 100 terminal operations; unfinished operations are not evicted. A full
32-write audit queue, disk failure, or external audit-file drift returns explicit
HTTP 503 (`audit_unavailable`), not a false record-success claim. Raw request
bodies/headers/tokens, paths/query strings, names, and subprocess stdin/output are
not audit fields. The redactor does not guarantee discovery of unknown unlabeled
credentials and must never be used as permission to log arbitrary payloads.
These are management-request security records, **not** the later per-project MCP
usage metrics.

## Project structure

- `apps/web/` — local browser interface.
- `apps/server/` — same-user Windows management backend.
- `packages/contracts/` — shared validated schemas.
- `packages/hub-core/` — local lifecycle, state persistence, internal adapter seams.
- `tests/` — synthetic fixtures, integration tests, and browser tests.
- `scripts/` — development/runtime selection and boundary/credential/bundle checks.

Agent adapters and non-developer launchers are implemented in the documented subset;
optional Windows sign-in startup management remains later work.

The internal runner supports approved absolute local `.exe` paths only; `.cmd`
and `.bat` shims are intentionally unsupported. Its fixed local PowerShell/.NET
host requires permitted Add-Type and Windows job-list process creation. It does
not bypass machine execution policy or fall back to an unrestricted shell.

## Existing pilot

The existing working pilot remains separate and unchanged at
`E:\Dev\Tools_and_Utilities\mcp-hub`. Its profile is
`waleed-mcp-hub-pilot`; OpenCode and Codex are configured for that pilot.

The new application will adopt it only through an explicit preview/apply flow.
Postora authentication remains unresolved. No additional agents or Windows startup
entries have been configured by this implementation's disposable verification.

## Source and operational data

Keep all maintained project source, plans, tests, and scripts in this folder.
Docker's required catalog paths, agent config files, and OS secret stores are
external operational state; they cannot safely all be moved into the source tree.

Never copy real API keys, SSH passwords, personal configuration inventories,
OAuth credentials, logs, or backups into version control.

### Per-tool permissions

Open a connector and expand **Tools & Permissions**. **Full permission** is the
default; **Always ask** requires one-time MCP form elicitation approval for the
exact arguments; clients without that capability are refused. **Closed** hides
the tool from the managed bridge catalog and rejects stale calls. Calls recheck
permissions after startup and queue waits. A CLI may impose additional approvals.
Permission changes preserve execution approval and capability observations.
Restricted tools cannot be exported as direct profile snapshots; dematerialize
existing snapshots first and use the managed agent bridge.

## GitHub releases and update notices

Successful main-branch CI and Security workflows automatically publish a stable patch
release for that verified commit. PR/fork/scheduled/failed runs cannot publish. The
release job skips superseded heads and completed commits, builds the Windows x64
installer with its release version, verifies the installer checksum, uploads the
installer, SHA256SUMS.txt and release.json to an owned draft, then publishes it.
A failed upload leaves a draft that a later successful run can resume. The first
release advances the root package version by one patch; later releases advance the
highest root/published stable version. Published commits are not released twice.

The desktop app checks the fixed public GitHub repository on opening and hourly while
open, with a cached manual Check updates action. Newer stable releases show version,
download and release-note links. Checks send no Hub credentials and accept only
links belonging to this repository. Network/rate/metadata failures do not block local
MCP management. Downloading, running the installer and restarting remain user actions.
