# Waleed MCP Hub

A local-first Windows application being built for managing MCP connectors used by
coding-agent CLIs through a professional browser interface.

**Current status: Tasks 1–19 are implemented in their documented scope, including
protected credentials, seventeen agent configuration adapters, managed MCP workflows,
loopback HTTP transport, platform-readiness seams and verified Windows portable packaging.
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
- Seventeen Windows user-file integrations with private backups, comment-preserving
  atomic edits, owned-entry disconnect and configuration-only status.
- Manual Stdio/Docker/HTTP/SSE saving with protected env/headers, optional auto-sync
  and separate execution consent; partial saves return a connector ID to inspect.
- Portable-folder desktop packaging, Windows launchers and opt-in shortcut installer.

Opening the manager does **not** inspect agent configs or run dependency probes.
Choose **Discover environment** to start a bounded read-only job; cancellation and
progress are available. **Refresh** reloads the last observations without starting
another scan. The preview shows saved definitions/pointers, not live MCP health.
No agent/connector command, gateway, image pull, package install, or upstream tool
is launched by environment discovery. Legacy Docker-pilot adoption remains disabled;
current-user startup registration is an explicit Settings action (Task 13).
Agent integration is a separate explicit action.
Protected credential writes and supported
OAuth are separate explicit actions. Explicit
**Test capabilities** is a different action that can start an approved connector.

Versions come from installed package manifests where safely available; native or
wrapper versions without safe metadata remain unknown. P7 supports documented current
Kilo/Kimi user scopes; Grok and effective project/account/plugin precedence remain
unverified, not guessed.
OpenCode/Codex user-file pointers can match while runtime compatibility and actual
MCP verification are still pending. Postora authentication is not fixed by a scan.

Docker probes require a local Windows named-pipe context and the verified MCP
gateway 0.44.2/profile schema v1. Remote Docker contexts and unknown gateway versions
fail closed. A stopped Docker engine is shown as degraded, not as an empty healthy
inventory. Config/source/pilot metadata drift requires review; nothing is overwritten.
Set `HUB_PILOT_DIR` before starting only if the existing pilot directory moved.
Set `HUB_DISCOVERY_MODE=disabled` to run the foundation without the scan capability.

## Safe import previews (P4)

Choose **Add connector** to paste strict JSON, enter a remote endpoint, or provide
a native executable and explicit JSON argument array. Guided npx/uvx inputs are
data only; no package is downloaded or command run. Accepted JSON shapes are a
single server, `mcpServers`, `servers`, OpenCode V2 `mcp.servers`, and supported Docker
image/remote definitions (including a single `server` wrapper). For pasted input, JSONC/TOML, full
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
requires **Update preview** before sanitized export. When DPAPI is configured,
**Apply protected import** can save reviewed packages/native/remote definitions,
credentials and enabled-profile membership in one journaled operation. No execution
approval, package installation or authentication verification is implied.

Raw browser input is cleared on submission or cancellation; no browser storage is
used. Private backend drafts are owner-scoped, expire after five minutes, and are
discarded on cancel, replacement, logout, stale revision, and shutdown. Known private
Buffers are zeroed on discard; secure erasure of all JavaScript/OS memory copies is
not claimed. Reopening/restarting requires fresh input. Preview alone never saves
a connector or secret, updates Docker/agent files, approves execution or fixes auth.

### Local HTTP and Smart Paste (Task 6)

**Add Manual MCP** and **Add connector** include a single **Smart paste** box. It
recognizes HTTPS/loopback URLs, simple quoted `npx`/`uvx` commands, Docker image/run
commands and supported JSON objects. Detection runs locally with sanitized feedback;
**Review detected input** transfers data into the editable form or private import
preview. It never invokes a shell, installs packages, contacts an MCP endpoint or
grants execution approval. Exact package pins and bin names still require review.
Docker `-e NAME=value` values move into protected fields, and published ports are
restricted to loopback. Shell operators, command/env expansion, inherited Docker
env vars, mounts/env-files/privileged/network/TTY options are not silently imported.

Local HTTP is limited to literal `http://127.0.0.1:<port>` or
`http://localhost:<port>`, with an explicit port (1–65535). No credentials, query,
fragment, IP aliases, alternate loopback hosts or plain LAN/public HTTP is accepted.
Check the separate local HTTP opt-in before saving; changing the endpoint clears
that checkbox and execution approval. Imports warn with `local_http_opt_in` and
`local_http_opt_in_required` and expose **no normalized definition** until explicit
selection confirmation and **Update preview**. This consent is stored as
`localHttpOptIn: true` and is part of the approved execution definition.

The host bridge revalidates/pins DNS on each request: `localhost` may resolve only
to exact `127.0.0.1`/`::1`, never mixed LAN/public/metadata addresses. Redirects and
cross-origin SSE endpoints remain blocked. Persistent MCP sessions retain their
idle/lifetime/approval limits; quiet established SSE streams are not killed by the
short connection/header timeout. This opt-in does not weaken OAuth/registry HTTPS
discovery rules or enable Docker-container loopback snapshots. HTTP is unencrypted;
only opt in to a local service and port you trust.

### Agent configuration adoption and official registry (Task 5)

**Agents → Scan Installed Agents → Import agent configs** reads known Claude
Desktop, Cursor, VS Code, Codex TOML and OpenCode JSONC scopes. Confirm an exact
package pin, select enabled Hub profiles, and approve replacing selected source
entries with the managed bridge. AST edits preserve unrelated settings/comments.
Extracted env/header values and source recovery chunks/manifest go through DPAPI;
adoption never calls the ordinary plaintext agent-backup path. Unselected entries
and previously existing backups are not changed. Source drift, unknown fields,
unsafe bindings and ambiguous scopes fail closed. Interrupted external writes keep
a blocking recovery journal; plaintext credentials are never automatically restored.
Docker-pilot adoption is still a separate, disabled flow.

**Connectors → Browse MCP Registry** searches bounded, active listings from the
fixed official `https://registry.modelcontextprotocol.io/v0.1/servers` endpoint.
HTTPS remotes and exact npm/PyPI packages pre-fill Add MCP, with env/header
requirements and manual-setup warnings. Publisher values/defaults, alternate
registries, runtime flags and URL templates are not blindly imported. No execution
approval is granted by registry presence. Package executable names and unresolved
arguments still need review; enter credentials only in protected write-only fields.

Session/Origin/CSRF-protected APIs: `POST /api/adoption/agents/:agentId/preview`
with `expectedRevision`; `POST /api/imports/:id/apply` with `expectedRevision`,
`profileIds`, `confirmImport: true`, and (for agent files)
`confirmAgentConfigChange: true`. The same selection/expiry/owner checks apply to
agent and pasted drafts. Session-protected `GET /api/registry/servers` accepts only
`search`, `cursor` and `limit` (1–50); it cannot accept an arbitrary registry URL.

## Connector and profile lifecycle (P5)

1. Normalize with **Add connector**, then **Preview local save** and apply the
   separate registry preview for value-free definitions. Alternatively use
   **Apply protected import** with selected enabled profiles to persist private
   values directly through DPAPI. **Authentication** remains available for later
   credential changes.
2. Review the exact executable/image/endpoint and **Approve execution**. Edits and
   toggles invalidate approval; approval never starts the connector.
3. **Test capabilities** performs real MCP initialize and tools/resources/prompts
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
- Manual credential updates preserve old references. **Unused local credential references** offers
  separately confirmed deletion only when no current/materialized consumer remains.
  Deleting locally never revokes provider authorization. OAuth accounts additionally
  offer **Revoke and disconnect** (RFC 7009, when advertised) and explicitly separate
  **Disconnect locally only**. Failed provider revocation is not reported as success.

The curated production OAuth recipe is **Linear read-only**, for the exact URL
`https://mcp.linear.app/mcp/readonly`, scope `read`. Approve that definition first,
review provider/scope in Authentication, then **Sign in and verify** and **Continue
to verified provider**. PKCE/DCR/state/issuer-bound consent runs through a bounded
loopback callback; tokens are protected locally. The job cannot report success
until MCP initialization/list discovery passes. Real-account consent still needs a
user verification step; fixture success is not a live Linear account claim.

Other remote servers can use **Authentication → Discover OAuth provider**. The Hub
reads RFC 9728 protected-resource metadata (including a Bearer challenge), RFC 8414
or OpenID authority metadata, and requires PKCE S256 and a public-client flow.
Review the discovered issuer/resource and selected scopes before starting sign-in.
The reviewed discovery fingerprint is owner-scoped, expires after five minutes,
and is rechecked before registration. DCR is supported; Client ID metadata documents
are also supported when a deployment configures a suitable public native-client
document through the construction-time discovery adapter. No such hosted document
or confidential-client secret is bundled. Providers requiring static registration,
nonstandard login, or unsupported metadata fail explicitly; this is not a claim
that Notion, GitHub, Google, Atlassian or Sentry live accounts have been verified.

Persistent SSE/Streamable HTTP bridge requests revalidate approval and refresh
expiring OAuth tokens before sending a request. Refresh-token rotation is serialized
by a per-account cross-process vault lock; replacement files contain only DPAPI
ciphertext. Normal refresh preserves the account reference and MCP session. Tool
calls are never replayed after authentication failures. A crash-held `.dpapi.lock`
fails closed: inspect the exact account/runtime before removing a stale lock; never
delete a lock while another Hub or bridge may be refreshing that account.

Account management endpoints (all require a Hub session; POST also needs Origin/CSRF):
`POST /api/connectors/:id/oauth/discover`, `POST /api/connectors/:id/oauth`,
`POST /api/connectors/:id/oauth/refresh`, `GET /api/oauth/accounts`, and
`POST /api/connectors/:id/oauth/disconnect`. Discovery requires current revisions,
definition hash and `approveDiscovery: true`; generic sign-in additionally requires
the returned `discoveryHash` and explicit `scopes`. Disconnect requires current
revisions, `confirmDisconnect: true`, and explicit `revokeProvider` true/false.
Account listings return provider/scope/presence metadata, never token values.
Other credential consumers/materialized snapshots must be removed before revocation.

Expired tokens, denial, cancellation, timeout and failed refresh remain distinct.
Jobs time out
after two minutes; logout/close cancels them. Cancellation after a provider grant or
credential save may leave authorization/protected data intact for explicit cleanup.
Unsupported endpoints show no invented sign-in flow. Postora remains unverified;
no Claude account credentials or existing pilot values are exported or copied.

After build, the opt-in `npm run test:disposable-profile` verifies real local Docker
metadata creation/read-back/update/removal plus two synthetic native clients. It
uses fresh owned IDs/files, no image pulls or upstream requests, and hashes the
existing pilot snapshot without printing it. On failure it retains its own recovery
directory for inspection; never delete or repair the existing pilot to make it pass.

## First-run onboarding and local Help & Guides (Task 16)

New and upgraded workspaces with incomplete onboarding show a four-step tour on
**Connectors**: safety → agent discovery/integration → first MCP → All set.
The inline tour does not block the rest of the app. **Next** and **Back** only
move between steps. Scanning, connecting agents and opening MCP review flows are
explicit clicks; agent configuration changes still require the existing consent,
fingerprint and recovery checks. Choosing Registry, Smart Paste or Managed Packages
does not create, install, run or approve a connector. All set links to Playground,
the connector Tools & Permissions area and Help; it does not claim live verification.

**Finish** and **Skip Tour** save `onboardingCompleted: true` in the existing atomic
`lifecycle.json` preference store. Completion is authoritative even with zero
connectors, so an empty Hub does not create a reopening loop. Older preference
files migrate to incomplete on read without changing background/tray options.
Use **Settings → Re-run Onboarding** to explicitly reset and reopen the tour.
No onboarding state is stored in browser local/session storage or setup exports.
`GET/POST /api/settings/onboarding` query/update only that preference; updates need
the shared settings revision, local session, exact Origin, CSRF and writable recovery
status. Other lifecycle updates preserve onboarding when their request omits it.

The header's **Help & Guides** opens a keyboard-accessible drawer with categorized
search and source links for [Connecting Agents](docs/guides/connecting-agents.md),
[Adding MCPs](docs/guides/adding-mcps.md),
[Security & Privacy](docs/guides/security-privacy.md) and
[Troubleshooting](docs/guides/troubleshooting.md). Sources are bundled at build time,
with section topics derived from the Markdown rather than a separate copied help
database. No provider/network search, local-file-serving endpoint or telemetry is
introduced. Help loads a local chunk only on demand; failed chunk loading leaves
the workspace usable and offers refresh/restart guidance.

Guide rendering uses an escaped, deliberately small Markdown subset: headings,
paragraphs, lists, tables, code and checked links. Raw HTML/scripts/images never
become executable DOM. Only known guide destinations and explicit HTTPS links
are clickable; file/data/javascript schemes and arbitrary local paths stay text.
Escape/Close dismisses the drawer and returns focus; mobile stacks the topic list
above the independently scrollable guide. Native runtime/security controls are
unchanged by either the tour or help.

## Share and restore secret-free setups (Task 15)

Open **Settings → Share & restore setups**. **Export Configuration** downloads
`setup.json`, a strict version 1 bundle containing connector definitions, profile
membership, original-name policies, tool overrides and agent-profile assignments.
The banner reads **Exported configs contain zero secrets**. Export explicitly
projects portable fields: no secret IDs, protected values, DPAPI ciphertexts,
OAuth accounts, execution approvals, local installation receipts, agent files or
runtime logs. Only four existing allowlisted non-sensitive environment literals
can travel; other environment values and bound headers become required fields.
OAuth Authorization bindings become fresh bearer-token fields, not token bundles.

Upload/drop one JSON file (maximum **512 KiB**), choose **Skip existing** or
**Overwrite existing**, review the connector/profile actions and expand **Review
commands, policies, overrides & agent assignments**. Enter required credentials
in the password fields, confirm review, then click **Apply Setup**. Uploading,
previewing and applying never execute providers, install packages or edit agent
files. Imported connectors require separate execution approval and discovery.
Local executable paths and MCPB installation files are not copied: reinstall or
review paths on the destination before approving native execution.

- **Skip existing** preserves matching connector/profile IDs and local tool
  overrides; it prompts only for new connectors' credentials. Existing agent
  assignments are preserved. New profiles may reference the preserved local
  connector with the same ID.
- **Overwrite existing** replaces matching definitions, policies and overrides,
  merges supplied agent assignments, resets approval and requests fresh credentials
  for every imported binding. Unsupplied entries/assignments remain unchanged.
  Old protected credentials remain stored; ownership is recalculated, not deleted.
- Duplicate IDs, dangling references, name/alias collisions, unknown fields,
  duplicate/prototype JSON keys, unsafe paths, credential-bearing URLs and
  unsupported commands fail closed. Direct snapshots affected by overwrite must
  be dematerialized first. Preview ownership, a five-minute expiry, registry hash
  and revision checks prevent stale or cross-session apply. Previews are single-use,
  cancellable and revoked on logout; at most eight are retained in memory.
- Credentials go directly to Windows DPAPI, not state, browser storage, logs or
  plaintext backup files. New values use generated immutable IDs, read-back checks
  and one mutation-locked atomic registry commit with the existing backup/journal
  mechanism. A proven pre-commit failure removes only newly attempted credentials.
  A proven post-commit failure does not replay. Uncertain state, failed compensation
  or interrupted external writes require blocking recovery review.

**Conservative compatibility limits:** export compares public fields against all
known present credentials (including OAuth tokens and encoded echoes), and refuses
when their protected backend cannot be read. Existing Docker-managed secrets are
write-only, so those setups cannot currently be exported. Credential-free Docker
definitions are portable; importing Docker required-secret fields is refused
because DPAPI bindings cannot safely replace the reference-only Docker gateway.
Import Docker definitions without those fields and bind Docker credentials through
the existing Docker path separately. No Docker security invariant is relaxed.

Export is not a general-purpose secret detector for arbitrary prose. Keep unknown
credentials out of names, descriptions, arguments and annotations; recognized token
formats, sensitive annotation keys and known credential copies cause refusal,
rather than exporting a partially redacted executable definition.

The protected API is `GET /api/setup/export`, `POST /api/setup/import/preview`
(`source`, `conflictStrategy`), `POST /api/setup/import/apply` (`previewId`,
`expectedRevision`, `conflictStrategy`, `credentials`), and owner-only
`POST /api/setup/import/:id/cancel`. Credential keys come from preview `inputKey`
(`connectorId/target/key`); override record keys are `connectorId/originalToolName`.
Records are identifiers, never filesystem paths. Responses use no-store; mutations
retain exact Origin/session/CSRF checks and metadata-only refusal auditing.

## Tool overrides: aliases, descriptions and annotations (Task 14)

Expand a connector, open **Tools & Permissions**, and click **Customize** next to
an original tool name. Set an optional **Custom Alias**, a custom description
(up to 2,000 characters), and/or JSON annotations. **Save override** persists
revision-checked Hub metadata; **Reset to Default** removes that tool's override.
Customized rows show **Overridden** and the agent-facing alias. Saving/resetting
does not execute a tool, edit an agent config, grant approval or restart its peer.

Aliases are exact, case-sensitive exposed names, matching
`^[a-zA-Z0-9_-]{1,64}$`. `search_tools` and `call_tool` (including case variants)
are reserved. The normal generated names retain their existing 40-character
bound; explicit aliases may use all 64 characters, although some agents impose
shorter limits after adding their own MCP prefixes. Use the exact returned name.

The managed bridge replaces the displayed name/description and merges annotation
keys over the provider's annotations. Missing fields preserve provider defaults;
an API description of `""` deliberately clears the description, while a blank UI
field uses the provider default. Annotations are inert bounded JSON: MCP hint
fields must be booleans, and unsafe prototype keys/non-JSON values are rejected.
Hints such as `readOnlyHint` are **never permission to bypass Allow/Ask/Block**.
Clients may ignore nonstandard annotation keys.

All dispatch remains keyed by **original connector/tool identity**. Aliases and
existing generated Hub handles resolve through the same profile, policy,
one-call Ask confirmation, approval, DPAPI lease and JobObject/Docker boundary.
An unambiguous raw original name is also accepted for a customized, discovered
tool; duplicate raw names never choose an arbitrary connector. Search matches
aliases, original names and custom descriptions, and `call_tool` invokes the same
secured target. Tool request records retain the original provider name, not custom
aliases, descriptions, annotations or arguments. Playground still selects original
provider names and enforces its own explicit confirmation.

Aliases must be unique across Hub overrides (Default agents can see all eligible
connectors). Saving rejects collisions with known original/generated names without
starting providers. Later discovery rechecks live catalogs: newly revealed alias
collisions are withheld/refused, not silently routed to a different tool. Alias
ownership is never recycled to another target within one live bridge; choosing a
previously used alias for another tool can require reconnecting. Choose a fresh
alias when possible. Cached metadata changes fail as `tool_override_stale`;
ambiguous names fail as `tool_alias_conflict`. Refresh catalogs before retrying;
calls are never replayed automatically. Pending confirmations, queued dispatch and
in-flight results are rechecked when overrides change.

Overrides live in optional `HubState.toolOverrides` (at most 512 rows / 256 KiB
serialized metadata; annotations at most 8 KiB per override). They are deliberately
persisted in the local state/backups, **not a secret store**—do not put credentials
or argument values in descriptions/annotations. Execution definitions/approvals,
credentials and discovery observations are unchanged. Direct profile snapshots
cannot apply overrides and are refused; dematerialize before customizing and use
the managed agent bridge. Removing a connector removes its override rows, not its
protected credentials. All override APIs retain session/Origin/CSRF enforcement
and expected registry/connector revision checks.

## Health, Windows startup and tray (Task 13)

Connector health is `healthy`, `degraded`, `needs_reauth` or `untested`.
**Needs Re-auth** is visible on collapsed connector rows, with a one-click
**Re-authenticate** action opening the existing OAuth/credentials dialog. Expired
or malformed OAuth bundles, failed renewal, missing credentials and MCP 401/403
responses require attention; network/protocol/storage failures are degraded,
not falsely described as revoked credentials. Health is observational, not proof
that every upstream operation will succeed.

**Check Health** queues a bounded re-test of enabled, execution-approved connectors.
It only initializes MCP and enumerates capabilities: no tools/call, resources/read
or prompts/get, and no package installation. Existing approval, DPAPI, JobObject,
timeouts, per-connector checks and recovery gates still apply. Disabled/unapproved
connectors are skipped, failures are isolated, and shutdown cancels owned checks.
Health inspection may read declared OAuth bundles through DPAPI to obtain expiry
metadata; buffers are zeroed and no tokens/provider errors enter the response.
Token metadata is briefly cached; health badges/observations refresh while the
Connectors view is open. Large inventories use bounded concurrent metadata reads.

In **Settings → Health & Windows lifecycle**:

- **Automatic background health checks** is **off by default**. Opting in re-tests
  approved connectors every five minutes while the manager is running. This may
  start their contained processes. It never silently installs packages or grants
  approval, opens sign-in, or executes an upstream tool.
- **Start with Windows** registers only
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\WaleedMcpHub` as
  `"<this installation>\WaleedMcpHub.exe" --background`. It does not install a service
  or require elevation. The launcher derives its own path; the API accepts only
  a boolean and expected prior state, never a path, key, script or shell command.
  Another installation's/conflicting value is not overwritten or deleted.
- **Keep running in tray when the app window closes** defaults to on. Tray menu:
  **Open Waleed MCP Hub**, **Check Health**, **Exit**; double-click opens a fresh
  fragment launch. With it off, a positively observed owned Edge window closing
  triggers graceful shutdown. An unobserved Edge handoff is not treated as a
  closed window—use tray Exit or **Stop desktop manager** in that case. Exit stops
  the manager/owned work, not independent agent bridges or unrelated browser
  processes. An existing Edge window may be closed separately after Exit.

Build the compiled tray launcher explicitly with `npm run build:launcher` after
`npm run build`, or use `npm run package:desktop` (which compiles it into the
portable folder). Run **WaleedMcpHub.exe** for tray support. Source-only `npm run
desktop` remains useful but cannot provide a C# tray icon. Startup controls stay
unavailable if the launcher/build-identity manifest is missing, stale or unsafe.
The manifest checks build identity, not code signing against hostile same-user
file replacement. Moving a registered installation requires explicitly disabling
its startup entry before registering the new location.

Secret-free preferences live in the fixed, revision-checked `lifecycle.json`
under the Hub runtime directory. Corrupt preferences are not overwritten and never
enable background execution. Session/Origin/CSRF protection covers lifecycle and
health mutations. Startup status is queried live; a failed change must be refreshed
before retrying. Tests mutate only a disposable fixed HKCU test subtree; the real
HKCU Run check is read-only. No personal startup entry is installed by the gates.

## Managed resources and prompts (Task 12)

The managed agent bridge also advertises resources and prompts. From your MCP
client, use `resources/list`, `resources/templates/list`, `resources/read`,
`prompts/list` and `prompts/get`. Enumeration never performs reads, gets or tool
calls. Only enabled, execution-approved connectors in that agent's current
profile are eligible; Default uses all eligible connectors. Missing capabilities,
unsupported methods and unavailable connectors are omitted independently.

Resource URIs are opaque `wmh-resource://…` handles, unique to the bridge session.
Identical upstream URIs from different connectors cannot collide. Prompts use
connector-prefixed, collision-safe names. **Use the exact returned URI/name**:
raw upstream identifiers, guesses, another bridge's handles and stale routes are
refused. Resource links and embedded resources inside prompt results are also
namespaced to their owning connector. Hub URIs are routing handles, not browser
URLs; they never cause the Hub to fetch an arbitrary caller-supplied URL.

Templates expose an opaque URI with query variables, for example
`wmh-resource://t-…/{?key,format}`. Expand it normally with your MCP client's URI
template support. The Hub expands the original upstream template internally;
upstream URI literals are not exposed in the advertised template. String variables
and the SDK's simple/reserved/path/query operators are supported. Prefix-length,
exploded/associative expressions, unsupported variable names and oversized
templates are omitted and mark the catalog incomplete, rather than being guessed.
Duplicate or unknown query variables are refused.

Reads and prompt gets reuse the existing managed peer pool, DPAPI leases, safe
HTTP transport and native/Docker containment. Approval, credential metadata,
profile membership and route freshness are rechecked after startup/queueing and
before returning content. Credential echoes in metadata, text and decoded binary
resource/image/audio payloads are withheld. Provider errors are replaced by fixed
Hub messages, never forwarded with their error data. Prompt arguments and content
are not cached or written to the tool request log. Provider text remains untrusted
data, not Hub instructions. Tool Allow/Ask/Block settings still govern tool calls;
they are not a separate resource/prompt permission system.

Each catalog is bounded to 256 entries, eight upstream pages per connector and
1 MiB of metadata. `result._meta["wmh/truncated"]` indicates an incomplete catalog.
Hub pagination cursors are not supported or forwarded upstream. Routing metadata
is bounded to 4,096 lifetime handles across these catalogs and linked resources;
reconnect if that pool is exhausted. Content responses retain the 1 MiB public
response bound and existing native session output limits. Lists share the bridge's
two-request limit and per-connector queue with tools. Registry changes and scoped
upstream list-change notices invalidate affected catalogs and emit static resource/
prompt list-change notifications. Rediscover before using invalidated handles.

Resource subscriptions are **disabled** (`subscribe: false`). Direct
`resources/subscribe` and `resources/unsubscribe` requests are rejected without
contacting a connector; resource-update notification streams are not forwarded.
Client-side resource/prompt support and reconnect/trust behavior remain controlled
by the agent. No new UI, log ingestion endpoint or agent configuration rewrite is
needed to use these MCP methods.

## Tool playground and live request log (Task 11)

Open **Playground & Logs** to select an enabled, execution-approved connector,
**Load tools**, review its untrusted input schema, and enter a JSON argument
object. Loading schemas can start an approved connector but never calls a tool.
Check the one-call confirmation and click **Run Tool** to execute once. Editing
arguments or changing the selection clears confirmation; submitted arguments are
cleared from the form. Nothing is saved in browser storage.

Playground uses the same production managed-peer factory as agent bridges:
approval/credential rechecks, DPAPI leases, safe remote transport, and native
JobObject/Docker containment. Block always refuses execution; Ask requires the
explicit one-call Playground confirmation. The Hub acts as `hub_playground`, not
as an assigned agent, so per-agent profile restrictions do not redefine the Hub
owner's connector selection. UI runs carry registry/connector/definition/schema
fingerprints and refuse stale reviews. Metadata discovery is bounded to eight
pages, 4,096 tools and 8 MiB, with incomplete catalogs clearly marked.

Results are temporary, owner-session scoped and rendered as inert text. Known
credential echoes and provider errors are withheld; submitted string values and
common encodings are redacted. Short strings, excessive redaction sets and large
output can cause output to be withheld entirely. Redaction is not a guarantee
against arbitrary provider transformations; do not submit sensitive values unless
needed. Output jobs expire two minutes after completion, clear on logout/close,
and are bounded to 32 retained jobs/two simultaneous operations. **Clear output**
or leaving the view discards displayed output. Cancellation stops owned work but
cannot undo external effects; failed/uncertain calls are never automatically
replayed.

The live table polls once per second and retains only a strict, in-memory ring of
the newest **500** records, pruned after 24 hours and cleared on Hub exit:
UUID, timestamp, agent/Playground ID, known connector/tool identity, monotonic
duration in milliseconds, serialized UTF-8 result byte size and
`success | error | blocked | declined`. No arguments, result bodies, provider
errors, session IDs or credential values are retained. Unknown requested names
use static placeholders instead of echoing caller input. Agent byte sizes measure
the returned MCP response; Playground sizes measure the received MCP response
before display redaction. Startup/confirmation/cleanup can be included in duration.

Separate agent bridge processes report validated metadata through a bounded
local OS pipe/socket, not an HTTP ingestion endpoint or a log file. Collection
accepts only registered agent IDs; messages, connections and pending work are
bounded. Logging failure never replays or changes a call. The UI reports when
collection is unavailable or not configured. Calls while the Hub is offline,
disconnected bridges, or dropped IPC messages are not backfilled. This is an
**observational request log, not a complete or tamper-proof security audit**;
same-user programs are not an adversarial audit boundary.

Playground/catalog/job and log-read APIs require the existing local session;
mutations also require exact Origin and CSRF checks. There is no HTTP log-write
API. Existing protected credential recovery and private integration backups are
unchanged; request arguments/output create no new persistent files.

## Tool-search mode for big catalogs (Task 10)

In **Agents**, scan integrations and enable **Tool Search Mode (search_tools +
call_tool)** for the desired agent. It is **off by default** and independent of
profile assignment. Changes are journaled with `expectedRevision` protection,
write no agent files/backups and do not change execution approval or credentials.
The setting survives disconnect/reintegration. Refresh the agent's tool list when
notified; its own trust prompts still apply to the new meta-tool names.

When enabled, `tools/list` exposes exactly **two** compact tools without discovering
or starting upstream connectors:

- `search_tools({ query, limit? })`: literal, case-insensitive, Unicode-normalized
  matching against tool names, descriptions, titles and keywords. Multiple terms
  must all match; exact names rank before prefixes/substrings and descriptive
  matches. Provider keywords use `_meta.keywords` (a string or string array).
  Empty queries browse available tools. `query` is at most 256 characters; `limit`
  defaults to 10 and accepts 1–50. Results contain `{ tools, hasMore, truncated }`,
  including each matching tool's exact Hub name and input/output schemas.
- `call_tool({ name, arguments? })`: use the **exact name returned by search**, not
  an agent-added MCP prefix. It returns the underlying MCP result through the same
  approved runtime, DPAPI credential lease, JobObject and persistent-session path
  as direct calls. An unknown handle may trigger bounded metadata discovery, never
  blind forwarding. Recursive meta-calls are refused.

Searching issues MCP initialization/catalog requests only, never `tools/call`.
It can start an approved connector to discover its metadata. Queries are matched
locally, not sent to providers or written to activity/journal data. Schemas and
descriptions remain untrusted provider data; the Hub does not evaluate them.

Both operations enforce the connecting agent's current profile and per-tool
permissions. Blocked/out-of-profile schemas are never returned. Cached calls are
rechecked before/after confirmation and at dispatch; Ask requires a new explicit
elicitation approval for each call, with unsupported clients failing closed.
`tool_blocked` and `tool_scope_denied` refuse forbidden targets without invoking
them. Old direct calls while search mode is enabled, obsolete meta-calls after it
is disabled, and calls whose mode changes while waiting are refused rather than
silently reinterpreted. Empty/disabled profiles still advertise the meta pair but
search returns no connector tools.

Discovery is bounded to 4,096 handles, eight pages per connector, 8 MiB of catalog
metadata and existing bridge request/session limits. Search results are limited
to 256 KiB of schema data (also returned as JSON text for older clients).
`hasMore` indicates additional matching results; `truncated` indicates incomplete
discovery/results, including unavailable peers. Narrow the query or reconnect if
the bounded lifetime handle pool is exhausted. Missing results in a truncated
catalog are not proof that a tool does not exist. Counts in the UI describe
eligible connectors and discovered underlying tools, not the two meta schemas.
With the mode off, the existing bounded full catalog and direct calls are unchanged.

## Per-agent profiles / tool sets (Task 9)

In **Agents**, run **Scan Installed Agents**, then use an integrated agent's
**Profile / Tool Set** selector. Choose an existing Hub profile or **All Connectors
(Default)**. Each agent has at most one assignment; different agents can share a
profile or use independent sets. Changes use the existing journaled registry path
with `expectedRevision` protection, without editing agent files, making backups,
running agents or granting execution approval.

Unassigned agents retain access to all enabled, approved connectors. An assigned
agent sees only the enabled, approved members of its profile, further restricted by
per-tool Ask/Block policies. Empty or disabled profiles expose no connectors—never
an automatic fallback to All. Reassign all affected agents, or explicitly select
All Connectors, before deleting an assigned profile. Assignments survive agent
disconnect/reintegration so reconnecting cannot silently widen access.

The managed launcher passes its validated integration agent ID to the bridge.
`tools/list` filters before contacting excluded connectors and filters again after
discovery. `tools/call` rechecks scope before confirmation, after confirmation and
at dispatch; peer startup/queues also recheck their scope fingerprint. Removed or
out-of-profile cached handles fail closed with no forwarded call. Existing process
containment, credential isolation and per-tool permissions remain in force.
Registry changes trigger bridge tool-list-change notifications; clients may need
to refresh their catalog or reconnect. Already dispatched side effects cannot be
undone, and already-seen tool descriptions cannot be erased from agent context.

The Agents badges show **eligible connectors** and policy-aware **discovered tools
(estimate)** from current capability observations, bounded by the bridge catalog
limit. Unchecked connectors are labelled explicitly. Counts contact no endpoints
and are not live agent/authentication verification. A stale selector save cannot
overwrite a newer assignment; use **Refresh tool sets** before retrying.

Mappings live in the optional, bounded `agentProfileBindings` state dictionary,
keyed by the supported `IntegrationAgentId` values and referencing existing profile
IDs. Missing mappings preserve old-state behavior. Missing/invalid assigned profiles
are rejected or fail closed rather than widening scope. This controls managed Hub
bridge connections, not direct MCP connections configured outside the Hub.

## Per-tool permissions (Task 8)

Expand a connector, then **Tools & Permissions**, to set **Allow**, **Ask** or
**Block** for discovered tools. Changes save immediately through the journaled
registry mutation path with inventory and connector revision checks. A stale window
cannot overwrite newer permissions: refresh before retrying. Existing connectors
and unconfigured tools retain Allow, including read-only tools. Upstream read-only
annotations are hints, never authority to override an explicit Ask or Block.

- **Allow:** forwards explicit calls through the existing managed runtime. Native,
  package and bundle processes retain Windows JobObject containment.
- **Ask:** requires the connected MCP client to present a form elicitation request
  for that exact tool and arguments. Only `accept` with `approve: true` permits one
  call. Decline, cancel, timeout, malformed responses, oversized confirmation data,
  or unsupported clients execute nothing. Approval is never remembered for the next
  call. The Hub rechecks inventory and authorization after confirmation and when
  dispatching queued calls. Any intervening inventory mutation invalidates approval.
  A client without form elicitation receives `tool_approval_required`; there is no
  Hub-window approval queue or implicit Allow fallback.
- **Block:** omits the tool's name, description and schema from `tools/list` and
  rejects known/previously advertised handles with `tool_blocked`. Blocked tools
  remain visible to the human in the Hub so their policy can be changed back.

Policies use original upstream tool names, not prefixed bridge aliases. Supported
names contain 1–64 ASCII letters, digits, `_` or `-`, excluding `constructor`,
`prototype` and `__proto__`. Unmanageable tool names are omitted by the bridge;
policy records are bounded to 256 entries. Bridge handles are not reassigned to
different tools during a connection, preventing stale-name collision bypasses.

Policy-only saves preserve execution approval and capability observations for
unchanged code; the bridge independently fingerprints policy changes and retires
stale sessions. Direct Docker/profile snapshots cannot enforce bridge policies:
dematerialize affected snapshots before adding Ask/Block, and use the managed agent
bridge. Creation of restrictive snapshots and direct native launches with restrictive
policies are refused. These controls govern Hub-forwarded tool calls, not direct
connections made outside the Hub, and cannot undo side effects already dispatched.
Tool arguments and confirmation answers are not persisted in activity/journal data.

## MCPB bundle installation (Task 7)

Open **Install a .mcpb bundle** in **Add Manual MCP** or **Add connector**, choose
or drop one file, review its self-reported metadata and configuration, then confirm
**Install reviewed bundle**. Inspection runs no bundled code, writes no files and
contacts no endpoints. Installation extracts only into the Hub data directory's
`packages/bundles/<generated-id>/`; no bundled installer or dependency manager runs.
Saving does **not** approve execution, test the server, or change any agent settings.
Approve the exact connector separately before testing or using the managed bridge.

Supported manifests use versions `0.1`–`0.3` and direct `node`, `python`, or bundled
Windows `.exe` entry points. Node uses the Hub's Node runtime; Python requires an
existing non-Store `.exe` on PATH. Bundled dependencies must already be present.
Only `${__dirname}` and declared `${user_config.KEY}` substitutions are supported.
`configuration` is accepted as an alternative to `user_config`, not alongside it.
Typed string/number/boolean/directory/file fields support required values, defaults
and numeric bounds. Directory/file values are absolute Windows paths, not uploads.
`sensitive` and `secret` mark protected values; protected defaults or argument
substitution are refused. All resolved environment values (including nonsecret
settings) go directly to DPAPI and are leased only for approved contained execution.
Runtime-control environment variables remain forbidden. Mutable credential buffers
are cleared, and configuration is never saved to the bundle or plaintext backups.

The strict ZIP subset allows stored/deflated, unencrypted, single-disk non-ZIP64
archives up to **25 MiB compressed**, **50 MiB uncompressed**, **500 entries** and a
64 KiB manifest. Traversal (`..`), absolute/drive paths, Windows device/ADS aliases,
links, case collisions, conflicting headers and malformed sizes/CRCs are rejected.
Unknown manifest fields, platform overrides, alternate commands, runtime downloads
and other unsupported execution-affecting features are refused rather than ignored.
Preview data expires after five minutes, on discard/logout or shutdown; at most two
bundle previews are retained. Install consumes the preview even on failure.

The integrity receipt is part of execution approval. Every launch rechecks all
installed files for size/hash/link changes and rejects untracked files. Keep mutable
server data outside the bundle directory. JobObjects contain process lifetimes,
**not** filesystem or network permissions; only approve code you trust. Installation
uses the shared mutation lock and durable external-effect journal. Uncertain
rollback blocks further writes for recovery review; do not reinstall blindly.

## Platform readiness: credentials, paths and containment (Task 19)

Windows remains the natively verified deployment. The platform seams prepare macOS
and Linux without changing existing DPAPI ciphertext, `scope.json`, entropy, or
the persisted `windows` secret-reference ID. No migration or re-encryption runs at
startup. A copied Windows reference is never silently read from another OS vault.

| Platform | Native credential adapter                  | Default runtime data                              | Execution cleanup                           |
| -------- | ------------------------------------------ | ------------------------------------------------- | ------------------------------------------- |
| Windows  | `dpapi` (persisted reference ID `windows`) | `%LOCALAPPDATA%/WaleedMcpHub`                     | Existing `ProcessHost.cs` Windows JobObject |
| macOS    | `keychain`                                 | `~/Library/Application Support/WaleedMcpHub`      | Detached POSIX process group                |
| Linux    | `libsecret`                                | `${XDG_DATA_HOME:-~/.local/share}/waleed-mcp-hub` | Detached POSIX process group                |

`HUB_DATA_DIR` overrides runtime data with an absolute path. The historical Windows
fallback without `LOCALAPPDATA` remains `~/.local/share/WaleedMcpHub` so existing
vaults do not move. Config roots use Windows `APPDATA`, macOS Application Support
for GUI clients and `~/.config`/absolute `XDG_CONFIG_HOME` for CLI clients, and
Linux `XDG_CONFIG_HOME`/`~/.config`. Relative XDG overrides are ignored. All 17
target definitions use the platform path implementation, including Windows
case-insensitive deduplication and case-preserving POSIX scope fingerprints.
Linux Claude Desktop and JetBrains shared JSON are existing-file compatibility
scopes, not assertions that an official client consumes them.

`platformDirectories` also resolves OS cache roots (`LOCALAPPDATA`, macOS
`~/Library/Caches`, Linux `XDG_CACHE_HOME`/`~/.cache`). Reviewed package receipts
remain isolated under `<runtime>/packages` via `runtimePackageDirectory`, preserving
the Windows cache/receipt location instead of silently sharing a global cache.

The internal `SecretBackend` interface owns `put`/`has`/`read`/`delete`; mutable
read buffers belong to the caller and are zeroed by lease disposal. The platform
factory is lazy: dashboard/status reads never unlock or initialize a vault.

- Keychain uses `/usr/bin/security` add/find/delete-generic-password with service
  `WaleedMcpHub` and a runtime-scoped account. The add command goes through bounded
  non-TTY stdin (`security -q -i -p ''`), not secret-bearing process argv. Its
  encoded command must fit Apple's 4096-byte interactive line buffer; oversized
  credentials are refused before a store command, never truncated.
- Linux uses `/usr/bin/secret-tool` store/lookup/clear with attributes
  `application=waleed-mcp-hub`, runtime scope and generated secret ID. Store values
  go through stdin. The current-user Secret Service/session bus must be accessible.
- Both keyring adapters use a versioned base64 envelope to preserve UTF-8/newlines,
  verify writes by reading them back, and verify deletions. This encoding is **not
  encryption**; the OS keyring owns persistence. The Hub never writes these values
  to disk. Its only keyring file is private nonsecret `credentials/keyring-scope.json`
  (0700 directory/0600 atomic file). This namespace is not included in setup exports.
- Locked, missing, denied or malformed keyrings produce a capability error; no
  plaintext file or automatic ephemeral fallback is enabled. Explicit environments,
  deadlines, I/O limits and buffer zeroing apply to CLI calls. Native CLI error text
  and output never enter public diagnostics.

Open **Settings → Credential storage & containment** to see the selected backend,
last probe state and cleanup mechanism. **Check credential storage** is protected
by the browser's session/Origin/CSRF checks and may trigger OS UI. It probes an
absent generated ID without adding a credential; availability is the last operation's
result, not a promise that every item is unlocked. Failed access remains explicit.

`createPlatformProcessRunner` selects the unchanged Windows implementation or the
POSIX runner. POSIX uses `shell: false`, explicit environments and `detached: true`;
normal exit, cancellation, deadlines and output limits clean up the owned `-pid`
group with SIGTERM/SIGKILL as appropriate. **Process groups are not a sandbox or
JobObject equivalent:** descendants can escape via a new session/group, and abrupt
manager SIGKILL cannot run application cleanup. There is no ordinary-spawn fallback.

Native credential writes, bindings and protected import/setup references understand
`keychain`/`libsecret` without aliasing Windows references. POSIX npm/uv installer
validation, OAuth stable-reference rotation, bundle/desktop lifecycle and live
agent compatibility are not certified by this work; unsupported paths remain
unavailable. macOS/Linux CLI and process behavior is tested with simulated system
responses on Windows, not represented as native OS verification.

## Hub Streamable HTTP endpoint (Task 18)

For clients that connect by URL rather than stdio, open **Settings → HTTP endpoint**.
The local URL is `http://127.0.0.1:4177/mcp` (or your configured `HUB_PORT`). Generate
a separate token per client, choose an optional agent identity/profile restriction,
and copy the one-time token or HTTP config. Dismissing the dialog, leaving Settings,
reloading, or five minutes of disclosure removes the plaintext from the UI. The
clipboard and any config you copy are outside the Hub; protect them yourself.

```json
{
  "mcpServers": {
    "waleed-mcp-hub": {
      "url": "http://127.0.0.1:4177/mcp",
      "headers": { "Authorization": "Bearer <YOUR_ONE_TIME_CLIENT_TOKEN>" }
    }
  }
}
```

This config is for Cursor/custom clients supporting URL + Bearer headers, not a
stdio launcher. Verify your client's HTTP support; clients without it need their
own reviewed adapter. No installed-agent configuration is modified by generating
a token. Do not put tokens in URLs. A session ID alone is never authentication.

| Route                         | Authentication                        | Behavior                                                                                                             |
| ----------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `POST /mcp`                   | Bearer on every request               | MCP initialize/messages; returns an SDK-generated `Mcp-Session-Id` on initialization                                 |
| `GET /mcp`                    | Same Bearer + owned session ID        | SSE notifications (one open stream per session)                                                                      |
| `DELETE /mcp`                 | Same Bearer + owned session ID        | Close the session; keep the token usable                                                                             |
| `GET /api/http-tokens`        | Browser session                       | Revision + active/revoked metadata, masked previews only                                                             |
| `POST /api/http-tokens`       | Browser session + exact Origin + CSRF | Create with `expectedRevision`, `label`, optional `agentId`, `profileId`, `expiresAt`; returns `plaintextToken` once |
| `DELETE /api/http-tokens/:id` | Browser session + exact Origin + CSRF | Revoke with JSON `{ "expectedRevision": N }`; closes all token-owned sessions                                        |

Missing/revoked/expired credentials return 401; non-loopback peers or foreign
Host/Origin return 403. A missing or other token's session returns 404; reinitialize
with the correct token instead of replaying a tool call whose effects are unknown.
Stale management revisions return 409: refresh before retrying. Failed storage
operations do not return a token. A failed revocation write denies it for this
process, but permanent revocation is **not confirmed**: retry successfully before
restarting. Revocation/expiry/shutdown close streams and pending responses, abort
bridge work, and suppress delayed results; already-dispatched side effects cannot
be undone.

HTTP clients use `createAgentBridge`, not a separate dispatcher. Token profiles
intersect with live agent restrictions; missing/disabled profiles expose no
connectors. Allow/Ask/Block, tool-search, resources/prompts, credential checks,
JobObject/Docker containment and metadata-only request logging are shared with
stdio. `http-client` is a log/bridge identity, not an eighteenth installed agent.

Tokens contain 32 random bytes, prefixed `wmh_live_`. Only SHA-256 hashes and masked
metadata are stored in private atomic `http-tokens.json` under the runtime data
directory, outside registry/setup exports. Validation compares every fixed-length
hash with `crypto.timingSafeEqual`. No plaintext/token/session ID is added to logs
or audits. The store retains at most 256 records, including revoked ones; capacity
exhaustion refuses new tokens. Sessions are in memory only: at most 64 globally,
8 per token and 16 concurrent requests per session; idle expiry is 5 minutes and
maximum lifetime is 1 hour, also bounded by token expiry. No event replay store is
enabled. Restarted/expired sessions must initialize again. The server remains
bound to `127.0.0.1`; socket peer checks do not trust proxy headers, and exact
Host/Origin checks still apply. Do not expose it through a reverse proxy or tunnel.

## Windows agent integration and manual MCP (P7/P8)

Open **Agents → Scan Installed Agents**, review the paths and approve user-file
changes/private backups, then choose **1-Click Integrate**. Scanning starts no agent
or model turn. **Disconnect** removes only the owned `waleed-mcp-hub` entry; unrelated
connectors, comments, Codex `node_repl`, Claude plugins and denylist remain intact.
Unknown/conflicted scopes require review, never overwrite-by-force.

| Target             | Default user file                                                                                                            | Managed map                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| OpenCode V2        | `~/.config/opencode/opencode.json` (or sole `.jsonc`)                                                                        | `mcp.servers`                                                   |
| Codex              | `~/.codex/config.toml` (`CODEX_HOME` supported)                                                                              | `mcp_servers`                                                   |
| Claude Desktop     | Store: `%LOCALAPPDATA%/Claude-Data/claude_<id>/…`; classic: `%APPDATA%/Claude/…`                                             | `mcpServers`                                                    |
| Claude Code        | `~/.claude.json`                                                                                                             | `mcpServers`                                                    |
| Antigravity        | `~/.gemini/antigravity/mcp_config.json`                                                                                      | `mcpServers`                                                    |
| VS Code            | `%APPDATA%/Code/User/mcp.json`                                                                                               | `servers`                                                       |
| Cursor             | `~/.cursor/mcp.json`                                                                                                         | `mcpServers`                                                    |
| Current Kimi Code  | `~/.kimi-code/mcp.json` (`KIMI_CODE_HOME` supported)                                                                         | `mcpServers`                                                    |
| Kilo CLI           | `~/.config/kilo/kilo.json` (sole `kilo.jsonc`/`config.json` supported)                                                       | `mcp`                                                           |
| Windsurf (Cascade) | `~/.codeium/windsurf/mcp_config.json`                                                                                        | `mcpServers`                                                    |
| Cline (VS Code)    | `%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` (existing file required)         | `mcpServers`                                                    |
| Roo Code (VS Code) | `%APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json` (existing file required)     | `mcpServers`                                                    |
| Zed                | `%APPDATA%/Zed/settings.json` or sole `~/.config/zed/settings.json`                                                          | `context_servers`; sole existing `mcpServers` compatibility map |
| Gemini CLI         | `~/.gemini/settings.json` or sole existing `~/.gemini/mcp.json` compatibility scope                                          | `mcpServers`                                                    |
| Goose              | `%APPDATA%/Block/goose/config/config.yaml`, or sole `%LOCALAPPDATA%/Block/Goose/config.yaml` / `~/.config/goose/config.yaml` | YAML `extensions`                                               |
| JetBrains AI       | Existing `%APPDATA%/JetBrains/mcp.json` shared compatibility file only; verify/import in the IDE                             | `mcpServers`                                                    |
| Warp               | `~/.warp/.mcp.json`, or sole existing `%LOCALAPPDATA%/warp/mcp.json` / `~/.warp/mcp.json`                                    | `mcpServers`                                                    |

### Additional agent scopes (Task 17)

Agent-profile mappings, tool-search preferences, request-log identities and stored
integration records now accept all **17** IDs, with collection limits of 24. Every
generated launcher carries the exact agent ID, so new clients use the same profile,
Allow/Ask/Block, approval, credential and JobObject/Docker boundaries. Disconnect
preserves profile/search preferences. The Agents view uses responsive cards with
client-type icons, local detection badges, configuration-only feedback and selectors.

Only one candidate file may exist. Windows case-equivalent paths are deduplicated;
multiple real candidates are ambiguous, even if their bytes match. Scan handles
fingerprint both the selected normalized path and the content, so relocation with
identical bytes cannot turn a stale click into permission to edit another scope.
JSONC edits insert/remove the owned AST node without reformatting unrelated lines.
Private timestamped backups, exact file CAS/read-back, recovery journaling and
restricted path publication remain shared across all clients.

Goose writes its documented `cmd`/`args` stdio extension under `extensions`, not a
generic JSON MCP object. Its YAML 1.2 parser rejects duplicate/non-string/prototype
keys, aliases, anchors, merge keys, custom tags, multiple documents and non-finite
scalars. Range edits touch only the owned extension in a block mapping (or an empty
parent). Nonempty flow-style extension/root maps are refused rather than serialized
lossily. Provider/model/permission settings and `secrets.yaml` are never edited.
Protected adoption of existing Goose extensions is not yet supported; its import
button is disabled, while normal integrate/disconnect/profile/search are supported.

**Client compatibility is explicit, not guessed:** current Gemini docs specify
`settings.json`, current Warp docs specify `.warp/.mcp.json`, and current Goose
Windows docs specify the Roaming path above. Requested historical paths remain
candidates when they are the only existing scope. Cline/Roo require the existing
default VS Code extension file (open the extension once); Cline CLI/remote/alternate
profiles are not silently substituted. Windsurf targets legacy Cascade, not a
rebranded client with a different config path. Custom Gemini/Goose home overrides
are blocked for review. JetBrains documents Add/Import JSON through IDE settings,
not a guaranteed shared file: the Hub never creates an absent shared JSON file or
edits versioned IDE XML/project settings. Verify or manually import the reviewed
shared entry through AI Assistant MCP settings. No real-client/live compatibility
is claimed from synthetic installations or successful file read-back.

VS Code uses its documented current `mcp.json`, **not** legacy `settings.json →
mcp.servers`. Legacy Kimi `~/.kimi` is not modified. Multiple supported files and
custom `CLAUDE_CONFIG_DIR` are refused as ambiguous. No account/plugin/project
configuration is rewritten. Unknown native versions stay unknown.

**Integrated** means the owned file entry was read back, not that an installed
agent connected or authenticated. Follow its reconnect/trust guidance. The bridge
exposes approved enabled registry connectors as tools, resources and prompts;
discovery invokes no tools, reads or prompt gets. Actual operations are forwarded
only on explicit agent requests within the agent's current profile. Two simultaneous
requests, bounded catalogs and eight pages per peer apply. Each bridge/MCP session
owns a separate pool of up to 32 peers;
discovery and sequential tool calls reuse the same connector connection. Operations
on one connector are serialized, so SSH sessions, browser tabs and transactions
survive between calls. Peers expire after five idle minutes or a one-hour hard
lifetime (earlier for expiring OAuth credentials). Native/Docker I/O remains bounded
to 1 MiB per contained session; HTTP keeps its bounded request/response budget.
Idle, lifetime, disconnect, shutdown, transport failure, registry/recovery errors,
or changed approval/credential metadata tear down affected peers and clear leases.
Failures are never automatically replayed. Registry/safety changes are watched and
approval is rechecked after startup/queueing, immediately before each operation.
Shutdown attempts graceful stdin EOF or HTTP session DELETE, then closes transports
and contained process trees. Direct materialized native profile launchers still
have their separate 120-second bound; capability checks remain one-shot.
Secretless Docker transport remains direct. Docker-secret-backed images use the
version-verified Docker MCP Gateway with a temporary, single-server catalog and
metadata-checked owned secret references; the Hub never reads Docker secret values.
Gateway management tools are disabled, tool-call logging is off, and Docker's secret
filtering remains on. Secret-backed gateways use long-lived server mode. Per-launch
nonce labels scope container cleanup; catalog drift
or uncertain cleanup retains recovery evidence and blocks further Docker launches.
Secret-backed images with published ports or gateway template/environment expansion
are refused rather than silently changing their approved definition. Direct
**Test capabilities** for keychain-backed images is still unavailable. Synthetic
bridge tests are not evidence of real-image compatibility or remote SSH login.
After building, the separate opt-in `npm run test:disposable-docker-bridge` checks
the real gateway with an already-cached `node:24-bookworm-slim` image (pinned to its
local ID), a fresh synthetic secret and an isolated registry. It lists a synthetic
tool, calls it twice to verify in-container credential delivery and retained state,
then removes
only its owned secret/files/containers. It does not pull images, migrate connectors,
edit agent configs or contact SSH hosts. Docker's reviewed Windows OS environment
must reach the bridge; SDK clients need to preserve `ProgramData` as well as
`ProgramFiles` for Docker plugin discovery.

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
# Pass the exact folder printed by packaging; the verifier has no default:
node scripts/verify-desktop-package.mjs 'desktop-builds\Waleed-MCP-Hub-<generated-build-id>'
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
`test:windows-integrations` uses seventeen disposable Windows configs and a synthetic
DPAPI-backed independent client; it does not edit real agent settings. The portable
check verifies the complete `desktop-integrity.json` file inventory (size and SHA-256),
rejects missing/extra/modified files and links, and checks launcher/source hashes.
It copies outside the workspace, uses bundled Node with empty PATH and no inherited
Node options/module path, and tests real JobObject cancellation/timeout of synthetic
process trees while an unrelated process survives. It also checks session refusal,
authenticated UI/bootstrap, tray self-test and graceful lock release. It does not
verify real Edge/shortcut execution. The inventory detects changed artifacts, not
malicious replacement of both artifacts and inventory; it is not a signature.
Generated executables/manifests and `desktop-builds/` remain ignored release artifacts.

### Optional OpenCode V2 developer helpers

These source-only helpers never select a saved local session implicitly:

```powershell
node scripts/dispatch.mjs --session ses_ID --prompt-file .\prompt.txt
node scripts/inspect-session.mjs --session ses_ID
# Equivalent PowerShell prompt wrapper:
.\scripts\send-prompt.ps1 -SessionId ses_ID -PromptFile .\prompt.txt
```

`--bin` (PowerShell `-OpenCodeBin`), then `OPENCODE_BIN`, then `opencode` on PATH
selects the CLI. Prompt submission changes the selected session; use it only when
intended. UTF-8 prompt files are bounded to 16 KiB and 24,000 serialized characters
for Windows argv limits. Inspection prints up to four message metadata records;
`--limit 1` through `--limit 100` changes that bound and `--include-content`
explicitly opts into private message/tool content. Prompts travel in CLI argv;
do not use these developer helpers for secrets. Failures suppress raw CLI output;
confirm session state before retrying an unconfirmed submission. See the
[OpenCode V2 API reference](https://opencode.ai/v2/docs/api).

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
optional current-user Windows startup and tray lifecycle are implemented in Task 13.

The Windows runner supports approved absolute local `.exe` paths only; `.cmd`
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
