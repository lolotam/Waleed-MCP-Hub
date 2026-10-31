# Waleed MCP Hub — Product and Technical Specification

Version: 1.0 — planning baseline  
Date: 2026-10-28  
Owner: Waleed  
Status: Specification baseline; P1 implemented and P2 in progress (see STATUS.md)  
Project root: `E:\Dev\Projects\Waleed-MCP-Hub`

## 1. Product definition

Waleed MCP Hub is a local-first Windows application that gives one person a
professional browser interface for managing Model Context Protocol servers used
by multiple coding-agent CLIs. It extends the existing Docker MCP Gateway pilot
rather than replacing working infrastructure without a migration.

The application consists of a local web interface and a same-user Windows
backend. It is not a standalone `file://` HTML page, a cloud account, a generic
shell console, or a replacement for each agent's permissions system.

Primary promise: **configure a supported connector once, authenticate it through
a supported mechanism, and make it available to selected compatible agents.**

This promise does not imply universal OAuth compatibility, sharing Claude-account
credentials, instant refresh in every agent, or one shared browser session.

## 2. User goals

1. Add an MCP by pasting its configuration, entering its endpoint, or configuring
   a local launch command without hand-editing eight different config files.
2. See a clear distinction between saved configuration, verified connection,
   authentication required, disabled state, and an unsupported integration.
3. Enter secrets locally and sign in through the provider's own supported flow.
4. Choose which agents and project profiles may access a connector.
5. Diagnose failures with useful explanations, not a wall of terminal output.
6. Start the manager at Windows sign-in and open it from a shortcut.
7. Keep existing working connectors and recover safely from unsuccessful changes.

## 3. Verified starting position

These facts describe the existing installation, not completed new-app features.

### 3.1 Existing pilot

- Pilot files: `E:\Dev\Tools_and_Utilities\mcp-hub`.
- Docker MCP Gateway version checked: `0.44.2`.
- Docker profile: `waleed-mcp-hub-pilot`.
- Connected agents: OpenCode and Codex.
- Each client starts its own local stdio gateway process from the same profile.
- `hub-pilot` exposes 11 Contabo SSH tools plus eight Docker management tools.
- `hub-chrome` exposes 32 native Chrome DevTools tools using isolated temporary
  browser profiles; it is not routed through Docker.
- Two concurrent protocol clients discovered matching tool lists.
- Actual OpenCode connections and Codex app-server discovery were verified.
- No SSH command, file transfer, browser navigation, or provider write was tested.
- Postora returned HTTP 401: `Invalid or expired access token.` The source header
  and the same value with a Bearer prefix were both rejected.
- Docker rejected Postora OAuth metadata discovery because the advertised
  metadata URL used `postora.cloud`, while the MCP endpoint used
  `api.postora.cloud`. This is an observed Docker compatibility/security check;
  its appropriate resolution has not been investigated.
- Rube and Byterover were absent from other local configs checked and globally
  denied in Claude Code. They were not deleted from the Claude account.

### 3.2 Agent inventory

| Agent        | Command        | Last checked version | Current pilot relationship                        |
| ------------ | -------------- | -------------------- | ------------------------------------------------- |
| OpenCode     | `opencode`     | 2.1.4                | Both pilot entries configured                     |
| Antigravity  | `agy`          | 1.3.5                | Not changed                                       |
| Kilo Code    | `kilo`         | 7.8.18               | Not changed                                       |
| Kimi Code    | `kimi`         | 2.3.2                | Not changed                                       |
| Codex        | `codex`        | 0.164.0              | Both pilot entries; existing `node_repl` retained |
| Grok         | `grok`         | 1.0.46 / 1.0.70      | Hub target since D026                             |
| Claude Code  | `claude`       | 2.1.311              | Has account/plugin connectors; preserve them      |
| Cursor Agent | `cursor-agent` | 2026.10.01-e373342   | Not changed                                       |

`opencode2` and `kilocode` are aliases, not extra agents. Re-detect versions and
paths during setup; do not hardcode this inventory as permanently current.

### 3.3 Migration constraints

- Source inventory: `%USERPROFILE%\.config\opencode\mcp.json`.
- Its mixed `servers` and `mcpServers` shape requires normalization.
- It contains plaintext secrets. Never copy it wholesale into this repository.
- Codex uses `CODEX_HOME=E:\Dev\Runtimes\codex` in the checked environment.
- Docker definitions must live under its permitted catalog directory.
- Docker profiles store snapshots; editing source JSON does not update the
  active profile automatically. Existing profile-backed clients need reconnects.
- Do not alter the pilot, configure the other agents, or install startup behavior
  merely by opening the new application.

## 4. Scope and release boundaries

### 4.1 First usable release: R1

- A real backend and functional responsive interface, not a decorative mockup.
- Inventory and adoption preview for the existing pilot.
- Remote Streamable HTTP connector form and configuration import.
- Docker-image connectors using reviewed definitions.
- Native Windows stdio connectors through isolated per-client launchers.
- Safe import of common JSON entry shapes, plus guided fields for commands.
- API-key/custom-header secret storage through the selected secret adapter.
- Guided OAuth only where Docker/provider support has been verified.
- Connection tests that initialize MCP and enumerate capabilities without tool
  execution.
- Non-destructive agent discovery for all eight agents.
- Config preview, backup, and explicit apply for supported agent adapters.
- Connector enable/disable/edit/remove and redacted diagnostics.
- Basic profiles, audit history, and a reconnect-required agent indicator.
- Manual start/stop plus optional same-user sign-in startup.
- Static app assets served locally without CDN dependencies.

### 4.2 Follow-on release: R2

- Additional verified OAuth recipes and provider-specific compatibility fixes.
- Expanded import formats where real source fixtures are available.
- More granular read-only/administration tool-selection controls.
- Optional tray integration, additional language support, and richer scheduling.
- Carefully reviewed live-refresh features if agent/gateway versions support them.
- Optional local MCP usage metrics by connector, project, and agent/CLI client;
  see section 11.1. This is follow-on work, not part of the current foundation.

### 4.3 Non-goals

- Execute arbitrary source code pasted into the browser.
- Automatically install or execute commands while parsing pasted input.
- Copy private Claude-account OAuth credentials into other products.
- Fix the Postora production endpoint during a local manager installation.
- Public hosting, LAN access, multiple users, or running as Windows SYSTEM.
- Disable TLS validation, bypass OAuth origin checks, or silently request admin.
- Treat an advertised tool list as proof that every remote operation works.
- Automatically overwrite every server in every CLI.

## 5. Product terminology and state model

### 5.1 Configuration versus health

Enabled/disabled is a desired configuration state, not a health result.

Health states:

- `untested`: definition saved; no successful recent verification.
- `checking`: a bounded discovery job is running.
- `connected`: initialization and capability listing succeeded at a recorded time.
- `auth_required`: an authentication failure or sign-in requirement was observed.
- `error`: connection, launch, transport, schema, or discovery failure.
- `unsupported`: no verified adapter or provider flow exists for this input.
- `unavailable`: dependency such as Docker is not running.

Every health result records `checkedAt`, method, tool count where available, and
a redacted explanation. A historical success must not look like a live check.
After material config or secret changes, invalidate the previous verification.

### 5.2 Agent status

Separate these facts:

- CLI executable discovered.
- Installed version observed.
- Adapter compatibility verified or pending.
- Hub entries present in effective configuration.
- Connection/tool discovery last verified.
- Configuration revision is current or reconnect required.

Never show all eight agents as connected merely because their executables exist.

### 5.3 Verification levels

1. Definition validated.
2. Agent configuration applied.
3. MCP initialization and capability discovery passed.
4. Specific tool operation verified with separate explicit authorization.

R1 default health checks stop at level 3. They never execute an SSH command or
open a browser page merely to make a status green.

## 6. Information architecture

### 6.1 Navigation

1. **Connectors** — primary daily workspace.
2. **Agents** — discovery, compatibility, config previews, apply/reconnect state.
3. **Profiles** — connector membership and intended use.
4. **Activity** — redacted lifecycle and authentication events.
5. **Settings** — paths, dependencies, startup, backup and recovery information.

No meaningless usage chart or revenue-style dashboard is required.

### 6.2 Connectors workspace

- Product name and local-only indicator.
- Search by name, endpoint host, and connector type.
- Filters: all, connected, needs attention, disabled, untested.
- One primary **Add connector** action.
- Compact rows with icon, name, execution mode, health label, last check, and
  an **Available to** agent strip.
- Row selection opens a detail drawer; keyboard navigation must work.
- Actions: Test connection, Authenticate/Update credential, Edit, Disable/Enable,
  Assign profile, and Remove.
- Removal dialog distinguishes removing a definition, unassigning a profile,
  deleting a stored credential, and provider-side OAuth revocation.
- No secret value appears in a detail response. Show reference name and whether
  storage exists, not recoverable values or secret fragments.

### 6.3 Connector detail drawer

Tabs: Overview, Configuration, Authentication, Tools, Diagnostics.

- Overview shows last verification, affected profiles/agents, and dependencies.
- Configuration shows a sanitized normalized definition and a revision.
- Authentication shows mechanism and provider-specific next actions.
- Tools shows names/descriptions after discovery; no default Execute button.
- Diagnostics explains the failure and safe next step, with expandable redacted
  detail for advanced users.

### 6.4 Agent page

Each agent row shows executable/version, configuration location, compatibility,
hub entries, last verification, and required follow-up. **Preview changes** must
precede **Apply**. Conflicts require an explicit choice; no name-based silent
replacement. Preserve unrelated and inherited connectors.

## 7. User journeys

### 7.1 First run

1. Start through the supplied launcher.
2. Open the local dashboard through a one-time bootstrap session.
3. Detect Node, Docker, gateway version, and known CLI executables.
4. Offer an **Adopt existing pilot** preview, read-only by default.
5. Show existing Postora authentication failure as attention required.
6. Show two configured pilot agents and six not yet configured, based on actual
   discovery rather than a baked-in count.
7. Let the user choose whether to import/adopt and apply changes.

### 7.2 Add by endpoint

1. Enter name and HTTP/SSE endpoint.
2. Validate endpoint and transport; flag private-network destinations for explicit
   review under a restricted policy.
3. Select no authentication, API key/header, or supported OAuth.
4. Choose profiles and an execution mode appropriate to the adapter.
5. Review normalized settings, permissions, downloads, and affected agents.
6. Save the definition/secrets and apply the profile update as a tracked job.
7. Test discovery and show an honest result.
8. Mark agents needing reconnects.

### 7.3 Add by pasted JSON

Accepted R1 inputs:

- A server entry object with `url` or `command`.
- A wrapper with `mcpServers`.
- The original source's wrapper with `servers`.
- OpenCode V2's `mcp.servers` shape.
- A supported Docker server definition.

The parser normalizes only documented supported fields and reports unsupported
fields rather than silently dropping them. Multiple entries produce a selectable
preview. Invalid JSON produces inline errors. Non-JSON code is not evaluated.

Secrets found in pasted headers or environment fields are extracted into
write-only secret inputs in memory and masked in previews. They are not saved in
draft files, telemetry, logs, browser storage, exports, or the registry.

### 7.4 Add a native command

1. Choose Native Windows stdio.
2. Specify executable and an argument array; offer guided `npx`/`uvx` entry forms.
3. Parse a pasted command only when unambiguous; shell syntax requires a warning
   and correction to explicit fields, not automatic evaluation.
4. Identify package installation/download behavior and version pinning.
5. Collect environment secret references and approved non-secret literals.
6. Display the exact executable/arguments and file/network access implications.
7. Require execution approval bound to the definition revision before testing.
8. Generate an isolated launcher used by selected agents.

Host-aware tools such as Chrome can remain native. A new native connector may
require agent configuration updates; it is not promised to appear through the
Docker entry without an additional supported proxy.

### 7.5 Authenticate

- API key: browser submits the value once to the authenticated local backend;
  backend writes it to the selected secret store and returns only a reference.
- OAuth: determine the verified provider/app identifier and flow. Show scopes,
  run the supported OAuth adapter, and open the actual provider authorization
  URL. Wait for a bounded callback/completion, then verify MCP discovery.
- An arbitrary auth-page URL is not sufficient to implement OAuth.
- Cancel, denied consent, missing registration, refresh failure, and unsupported
  metadata all have distinct guidance.
- Do not promise universal automatic refresh. Surface provider behavior.
- Existing Claude-account connectors stay managed by Claude unless an independent
  supported upstream connection is configured.

### 7.6 Change or remove

- Save changes against an expected revision; stale editors receive a conflict.
- Preview profile and agent impact before applying.
- Disabling retains settings and secret references.
- Removing profile membership is different from deleting the connector.
- Do not delete secrets while another connector/profile still references them.
- Provider revocation is a separate confirmed action when supported.

## 8. Technical architecture

### 8.1 Stack decision

- Node.js 24 LTS, TypeScript, npm workspaces.
- React + Vite for the interface, compiled and served locally.
- Fastify for the local management interface.
- Shared schema/contracts with runtime validation.
- An official MCP client SDK for bounded capability discovery where appropriate.
- Local versioned JSON state initially; SQLite is not required for a single-user,
  small-inventory R1. Preserve a persistence seam so this can change later.
- No hosted database, cloud backend, or external frontend CDN.
- Exact dependency versions and lockfile will be selected and committed during
  implementation, after checking Node/Windows compatibility.

### 8.2 Project structure

```text
Waleed-MCP-Hub/
  README.md
  docs/
    SPECIFICATION.md
    IMPLEMENTATION_PLAN.md
    DESIGN.md
    ACCEPTANCE.md
    DECISIONS.md
    STATUS.md
  apps/
    web/                    # React interface
    server/                 # Fastify, session security, HTTP/job orchestration
  packages/
    contracts/              # Browser-safe schemas/types
    hub-core/               # Lifecycle module and internal adapters
      src/
        adapters/
          docker/
          native/
          secrets/
          agents/
  tests/
    fixtures/               # Synthetic/sanitized configs only
    integration/
    e2e/
  scripts/                  # Start/stop, diagnostics, startup registration
  runtime/                  # Ignored local runtime state if explicitly selected
```

All maintained source, docs, test fixtures, and launch scripts belong in this
project folder. Docker's required catalog/database locations and OS secret stores
are operational external state, not copies of source to check into the project.

### 8.3 Modules and seams

- The browser calls a small lifecycle interface: preview an operation, approve and
  apply it, inspect its job, and read sanitized inventory/status.
- The lifecycle module owns validation, revisions, safety checks, and operation
  ordering. UI callers do not assemble Docker commands themselves.
- Docker and native execution are real separate adapters behind a connector
  runtime seam; do not create speculative abstractions for unimplemented vendors.
- Agent adapters own version/config discovery, merging, and reconnect guidance.
- A process-runner seam owns executable resolution, argument passing, deadlines,
  process-tree cancellation, output limits, and log redaction.
- A secret-store seam is write-only to the UI. Upstream launch code may resolve a
  credential internally, but no frontend-facing method returns it.
- Persistence owns atomic writes, backups, migrations, revisions, and a single
  active-writer lock.

### 8.4 Dependency direction

```text
web -> contracts
server -> contracts + hub-core
hub-core -> contracts + runtime adapters
runtime adapters -> OS / Docker / documented CLI interfaces
```

The frontend must not import Node modules, process execution, or secret adapters.
Untrusted connector metadata never becomes executable UI markup.

### 8.5 Sources of truth

- Hub registry: desired connector definitions, native exceptions, profiles,
  assignments, revisions, and secret references.
- Docker adapter: materializes/updates required catalog definitions and the
  active profile snapshot. Observed external changes are shown as drift; do not
  silently overwrite them.
- Native adapter: generates launchers from approved definitions with per-client
  process/session isolation.
- Agent configs: generated/merged connection pointers only, not duplicated
  upstream credentials.
- Secret stores: actual credential values.
- Observation store: last-check results and agent capabilities, not desired state.

Adoption must explicitly reconcile the existing Docker pilot with the new desired
registry. There must not be two competing editable copies with no drift handling.

### 8.6 Process lifetime

- Dashboard backend is a same-user process, bound only to IPv4 loopback.
- Agent gateways/native MCPs remain independent of the dashboard process.
- Closing a browser tab does not stop gateways.
- Stopping the manager does not stop unrelated Docker applications or agents.
- Startup registration, when enabled, runs at the current user's sign-in, without
  administrator elevation. Docker readiness is reported, not assumed.
- No Windows SYSTEM service and no automatic machine-level startup changes.

## 9. Supported connector capability matrix

| Input                        | Planned route                     | R1 support rule                                                    |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| Public HTTPS Streamable HTTP | Docker remote definition          | Supported after validation and auth compatibility check            |
| Legacy SSE endpoint          | Docker remote adapter             | Explicit transport; verify server and gateway behavior             |
| Docker image                 | Docker image definition           | Reviewed definition and explicit image execution/download approval |
| `npx` local stdio            | Native launcher or reviewed image | Pin version; no execution during import                            |
| `uvx` local stdio            | Native launcher or reviewed image | Check runtime; pin package version where supported                 |
| Local executable/script      | Native launcher                   | Explicit executable/args; user trust approval                      |
| SSH MCP                      | Local/container preset            | Credentials secret-backed; no default remote command test          |
| Chrome DevTools              | Native Windows launcher           | Isolated browser profiles by default                               |
| Generic OAuth webpage        | None                              | Unsupported without a real provider flow                           |
| Claude-account connector     | Preserve native connection        | Independent setup required outside Claude                          |
| In-process SDK MCP           | Host application                  | Not exportable as a generic remote/local server                    |
| Arbitrary pasted program     | None                              | Not evaluated or installed automatically                           |

## 10. Agent integration requirements

Every adapter must be developed against the installed version's documented or
observed supported interface. Prefer the official add command if it preserves
unrelated settings; otherwise use a validated format-aware merge.

### 10.1 OpenCode

- V2 global config uses `mcp.servers`; do not emit deprecated V1 shape.
- Use actual detected paths and preserve JSONC comments where present.
- Reuse verified CLI add support for initial pointers, with a diff and backup.
- Changes hot-reload; `/mcps` or `/reload` can force reconnection when needed.

### 10.2 Codex

- Respect `CODEX_HOME` and preserve TOML, including existing `node_repl`.
- Use supported global MCP add operations for pointers.
- Verify with app-server capability discovery without starting a model turn.
- New/reloaded agent sessions may be needed after updates.

### 10.3 Antigravity and Grok

- Installed MCP-add commands were inspected; global path, overwrite semantics,
  and read-back behavior still require fixture and real-version verification.
- Do not mark these adapters ready until preservation and rollback tests pass.
- Grok (D026): the hub writes its marked `[mcp_servers.waleed-mcp-hub]` table to
  `GROK_HOME/config.toml` (default `~/.grok/config.toml`), in the Codex TOML
  shape. Grok 1.0.46 and 1.0.70 both read the generated table back through
  `grok mcp list --json`.

### 10.4 Claude Code

- Preserve account connectors, plugins, user settings, and existing denylist.
- Deduplicate by normalized endpoint and intent, not name alone.
- Do not add a redundant Postora account connection silently.
- Never try to export private account OAuth credentials.

### 10.5 Kilo, Kimi, and Cursor

- Discover and verify native schema, scope, effective config, and approval model.
- Cursor's installed MCP commands include list/login/enable/disable; do not assume
  an add command exists.
- Kimi's current install is Kimi Code; do not apply legacy Kimi CLI config blindly.
- If unsupported, show a safe manual recipe and `adapter pending`, not success.

### 10.6 Cross-agent rules

- Existing entries with the same name produce a conflict preview.
- Agent synchronization is explicit and records the applied revision.
- Changing hub configuration does not imply agent reload succeeded.
- All eight must be supported and verified before claiming full eight-agent
  availability; staged releases may show adapters as pending.

## 11. Data model

### Connector

`id`, `name`, `description`, `executionMode`, `transport`, `endpoint` or
`executable`/`arguments` or `image`, `environmentLiterals`, `secretBindings`,
`headerBindings`, `enabled`, `revision`, `trustApproval`, `createdAt`, `updatedAt`.

`trustApproval` records the approved normalized revision and capability risk.
Changing a command, image, endpoint, or sensitive binding invalidates approval.
Endpoint credentials in URL userinfo/query strings are rejected or explicitly
extracted into supported secret bindings, never exposed in summaries.

### Profile

`id`, `name`, `description`, `connectorIds`, optional approved tool selection,
`revision`, `dockerProfileId`, `updatedAt`.

### Agent binding

`agentId`, `profileId`, managed entry names, applied revision, config fingerprint,
last discovery, compatibility result, and reconnect-required flag.

### Secret reference

Store identifier, adapter, owner/reference relationships, and presence metadata.
Never store the value in the hub registry.

### Job

`id`, operation, target, sanitized input summary, expected revision, state,
timestamps, cancellation status, redacted events, result, and recoverability.

States: queued, running, awaiting user action, succeeded, failed, cancelled.

### Audit event

Time, operation, target IDs, prior/new revision, result, and redacted reason.
No secrets, command stdin, complete imported raw payload, or OAuth tokens.

### 11.1 Follow-on MCP usage metrics (requested 2026-10-28)

Goal: answer how often each connector is used by each project and agent/CLI.
This is MCP traffic accounting, not LLM token, model-request, billing, or cost accounting.

- Count actual MCP `tools/call` requests separately from initialization, capability
  discovery/listing, resource/prompt requests, notifications, and transport retries.
  An HTTP request, SSE message, and MCP logical request are not equivalent units.
- Report request/tool-call counts, success/error/cancellation counts, and duration
  summaries over selectable time ranges. Separate retries/attempts from logical
  calls; distinguish automatic discovery from user/agent tool use.
- Dimensions: connector ID, optional tool name, project ID, CLI product ID,
  optional client/session ID, and time bucket. In this product, "agent" normally
  means the CLI product; an individual subagent needs a distinct explicit label.
- A shared hub profile or an MCP request does not reliably identify a project.
  Project-aware launchers/bindings must attach an explicit local project ID and
  client ID. Unknown attribution stays unknown; never infer it from tool prose,
  an active dashboard tab, or a shared Docker profile.
- Instrument the actual per-client gateway/proxy/native-launcher path, not just
  the dashboard backend: agent MCP traffic continues when the dashboard is closed.
  Coverage depends on each verified runtime adapter. Connections bypassing the
  instrumented path are not counted and must not look like zero-usage certainty.
- Collect bounded local metadata/aggregates only. Do not store tool arguments,
  results, credentials, raw request bodies, or full project paths in metrics.
  Provide retention, clear/reset, and collection controls. Treat tool/project
  identifiers as potentially sensitive local metadata too.

Implementation is deferred until runtime adapters exist. Verify attribution,
concurrent clients/projects, unknown clients, retries, failures, and both native
and Docker routes with synthetic fixtures before claiming accurate coverage.

## 12. Local management interface

Route names are a planned contract, to be frozen with schema tests in phase 1.

| Interface                                | Responsibility                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /health`                            | Minimal process readiness; no sensitive inventory                                                             |
| `POST /api/session`                      | Consume a one-time launch token and establish a local session                                                 |
| `GET /api/bootstrap`                     | Sanitized capabilities, dependency status, preferences                                                        |
| `GET /api/connectors`                    | Sanitized desired state and last observations                                                                 |
| `POST /api/imports/preview`              | Normalize strict JSON into a private five-minute owner-scoped preview; no execution or persistence            |
| `GET /api/imports/:id`                   | Sanitized revision-bound draft only; no secret values or original source                                      |
| `POST /api/imports/:id/selection`        | Recheck full multi-entry selection/names/IDs and conflicts without applying                                   |
| `POST /api/imports/:id/cancel`           | Discard the owner's memory-only private draft                                                                 |
| `POST /api/imports/:id/save-preview`     | P5 no-secret bridge to a separate registry preview; discard the import draft, never execute                   |
| `POST /api/operations/preview`           | Validate proposed mutation and show impact                                                                    |
| `POST /api/operations/apply`             | Apply an approved, revision-bound preview                                                                     |
| `POST /api/connectors/:id/check`         | Start an approved, bounded discovery job                                                                      |
| `GET /api/runtime/jobs/:id`              | Owner-scoped P5 capability job result                                                                         |
| `POST /api/runtime/jobs/:id/cancel`      | Cancel the owner's capability job and its contained process/connection                                        |
| `POST /api/connectors/:id/credentials`   | Write a credential; never return its value                                                                    |
| `POST /api/connectors/:id/oauth`         | Start only a supported provider flow                                                                          |
| `GET /api/connectors/:id/auth`           | Reference/presence status, supported recipe IDs/scopes and last verification state; no values                 |
| `GET /api/credentials`                   | Owned reference metadata for explicit unused-value cleanup; no plaintext reads                                |
| `POST /api/credentials/:id/delete`       | Revision-bound confirmed local deletion, only with no current/materialized consumers; not provider revocation |
| `POST /api/connectors/:id/oauth/refresh` | Explicit refresh for the bound supported recipe; verify discovery before success                              |
| `GET /api/auth/jobs/:id`                 | Owner-scoped bounded auth job/provider/scopes; ephemeral authorization URL only while awaiting consent        |
| `POST /api/auth/jobs/:id/cancel`         | Cancel the owner's sign-in/refresh listener and network work; no implied remote revocation                    |
| `GET /api/agents`                        | Detected executables, adapters, and effective bindings                                                        |
| `GET /api/discovery`                     | Last sanitized observation snapshot; does not start a scan                                                    |
| `POST /api/discovery`                    | Start a bounded, owner-scoped read-only scan; accepts only an empty object                                    |
| `GET /api/discovery/jobs/:id`            | Owner-scoped scan progress without raw command output                                                         |
| `POST /api/discovery/jobs/:id/cancel`    | Cancel only that session's scan and owned probes                                                              |
| `GET /api/adoption/preview`              | Snapshot-only metadata/revision/conflict preview; apply remains unsupported                                   |
| `GET /api/profiles`                      | Profile definitions and observed materialization                                                              |
| `GET /api/jobs/:id`                      | Redacted progress and result                                                                                  |
| `POST /api/jobs/:id/cancel`              | Cancel the job and its owned subprocesses                                                                     |
| `GET /api/activity`                      | Bounded redacted audit history                                                                                |
| `GET /api/security-activity`             | Bounded payload-free refusal metadata; session required                                                       |
| `GET /api/recovery`                      | Read-only operation-journal status; session required; no automatic replay/rollback                            |
| `GET /api/settings`                      | Sanitized local preferences and startup state                                                                 |

All non-health inventory endpoints require a session. Mutations require exact
origin validation, CSRF protection, schema validation, and bounded request size.
No endpoint accepts an arbitrary shell string or a free-form filesystem path to
write. Large operations return a job ID rather than holding HTTP indefinitely.

P5 enabled operation kinds are create/edit/remove/toggle connector or profile,
batch connector creation, assign/unassign connector, approve connector, and
materialize/dematerialize profile. All use `expectedRevision`; approval additionally
requires `expectedConnectorRevision`, exact `definitionHash`, and explicit consent.
`GET /api/connectors` includes execution hashes plus revision-bound observations.
`GET /api/profiles` includes materialization fingerprints/stale flags and recorded
reconnect bindings. These are desired/snapshot state, not live agent registration.
P6 credential writes additionally require `expectedConnectorRevision`, location,
binding name, explicit raw/Bearer/Basic format, adapter and a one-way value. The
response contains only reference/presence/revision/approval metadata. Updating a
binding invalidates approval; a save is not an authentication check. OAuth jobs
require the current execution hash/revision and explicit sign-in/discovery consent;
only curated recipes match. The initial production recipe is Linear read-only.
Private pasted import values are not automatically promoted: a value-free registry
definition and a separate Authentication action keep saves explicit. Provider
revocation and Windows-backed remote agent proxy materialization remain unsupported.

## 13. Security requirements

### 13.1 Threat model

Assets: root SSH credentials, provider tokens, local files, agent configuration,
and the authority to launch local processes.

Threats: malicious websites targeting localhost, DNS rebinding, CSRF, pasted
untrusted commands/configs, injected connector descriptions, stolen browser
storage, log disclosure, malicious packages, accidental wrong-server actions,
and competing writers corrupting configuration.

### 13.2 Local access

- Bind only to `127.0.0.1`; do not listen on `0.0.0.0`.
- Validate the exact configured Host and Origin. No wildcard CORS.
- Bootstrap with a high-entropy single-use token supplied through a local launch
  flow, not a reusable credential in a URL query or access log.
- Recommended bootstrap transport: URL fragment consumed by frontend memory,
  removed from browser history, then posted once to the session endpoint.
- Session cookie: HttpOnly and SameSite=Strict. Never put tokens in localStorage.
- Mutations additionally require a CSRF token/session binding.
- Deny framing and apply a restrictive Content Security Policy.
- Serve all application scripts/styles locally; no third-party analytics.

### 13.3 Execution

- Do not use `eval`, `Function`, or shell interpolation on imported material.
- Use executable plus argument arrays and default to `shell:false`.
- Windows `.cmd`/`.bat` launches require a tested, narrowly scoped adapter. Do not
  turn them into unrestricted concatenated `cmd /c` strings.
- A command/image test is execution and requires prior revision-bound approval.
- Bound time, memory/output collection where available, and concurrency.
- Cancel only owned process trees; never broad `taskkill` or container deletes.
- Image/tag/digest and package version changes invalidate trust approval.
- No native process receives all secrets; resolve only declared bindings.

### 13.4 Remote destinations and OAuth

- Default to public HTTPS; reject userinfo, non-network schemes, metadata service
  addresses, and unsafe redirects.
- Private/local network endpoints need an explicit restricted exception and
  adapter support; do not globally bypass Docker's URL security checks.
- OAuth URLs originate from a verified flow, not arbitrary connector prose.
- Use state and PKCE when implementing a flow directly; prefer existing supported
  provider handling over a universal homegrown OAuth implementation.
- Never forward the dashboard session token to an upstream MCP.

### 13.5 Secrets and files

- Docker-compatible connectors use Docker's secret store.
- Native connectors need a verified same-user Windows-backed secret adapter,
  such as a DPAPI-protected store. Do not pretend Docker offers plaintext secret
  resolution for native launchers without verifying a supported interface.
- Secret values are write-only to the UI; no reveal/export endpoint in R1.
- Redact credentials before persistence, not just when rendering logs.
- Exports contain references and definitions only.
- Restrict operational file writes to managed paths, normalize names, and reject
  traversal/symlink escape. CLI config targets come from verified agent adapters.
- Use atomic writes, backups, checksums, and explicit conflict detection.
- Never commit `.env`, real source inventories, runtime state, logs, or backups.

## 14. Failure handling and consistency

- Every refused operation returns an actionable reason and a redacted audit event.
- Failed reads are errors, not empty inventories.
- Apply is an ordered operation: validate -> lock -> backup -> store secret
  references/values as needed -> materialize -> read back -> record result.
- OS secrets and Docker/agent files cannot share one database transaction. Use an
  operation journal and explicit partial-failure recovery rather than claiming
  distributed atomicity.
- A failed connector must not hide healthy connector results.
- Jobs report timeout, cancellation, auth-required, and unsupported distinctly.
- Gateway-generated management tools are identified separately from upstream
  connector tools; broad reconfiguration authority must be visible.
- External config changes invalidate stale previews; never restore an entire old
  config over unrelated user edits.

## 15. Operational requirements

- Default management port: proposed `127.0.0.1:4177`, subject to availability check.
- On port conflict, fail clearly or offer an alternate port; do not terminate its
  owner.
- Startup launchers use the detected Node 24 executable and absolute project path.
- Runtime data defaults to a user-specific application-data directory; a portable
  project-local mode can be offered explicitly. Neither belongs in source control.
- Backups retain a bounded history and clearly indicate possible sensitive data.
- No package updates or image pulls happen silently at application startup.
- Diagnostics include version/path/capability summaries, with opt-in detailed
  exports that remain redacted.
- The application must start in degraded read-only mode when Docker is stopped,
  so the user can see what is wrong.

## 16. Accessibility, responsiveness, and design

The visual target and reference lock are in [DESIGN.md](DESIGN.md).

- Desktop-first management layout, usable at 390 px and 768 px widths.
- WCAG AA contrast, visible keyboard focus, logical tab order, labelled inputs,
  accessible dialogs/drawers, and non-color-only status.
- At least 44 px touch targets on compact layouts.
- English first; architecture must permit Arabic/RTL without hardcoded direction
  assumptions. Bilingual content is not silently added to R1 scope.
- No external imagery or generated art is required for this utility application.
- Missing, loading, disconnected, stale, empty, conflict, and error states are
  first-class designs.

## 17. Acceptance and implementation handoff

- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) defines ordered work packages.
- [ACCEPTANCE.md](ACCEPTANCE.md) defines verification and release gates.
- [DECISIONS.md](DECISIONS.md) records resolved decisions and open investigations.
- [STATUS.md](STATUS.md) records actual progress and must not describe planned
  features as delivered.

The planning checkpoint ends with these documents and the project scaffold.
Implementation proceeds in this same folder, beginning with the local security
foundation and read-only adoption; it does not begin with a misleading dashboard
that fabricates healthy connectors.
