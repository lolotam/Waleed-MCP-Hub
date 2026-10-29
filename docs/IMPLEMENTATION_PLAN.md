# Waleed MCP Hub — Implementation Plan

Version: 1.0  
Date: 2026-10-28  
Status: P1/local P2, P3 read-only discovery, and P4 safe import previews verified  
Project root: `E:\Dev\Projects\Waleed-MCP-Hub`

## 1. Delivery contract

Implement [SPECIFICATION.md](SPECIFICATION.md) in the same project directory.
Use [DESIGN.md](DESIGN.md) as the visual target and
[ACCEPTANCE.md](ACCEPTANCE.md) as the release checklist.

This plan is a sequence of independently verifiable work packages, not a promise
that every connector or OAuth provider works automatically. Record real progress
in [STATUS.md](STATUS.md). No milestone is complete on the strength of a screenshot
or a successful config-file write alone.

### Planning checkpoint — original P0 deliverable

- Full product/technical specification.
- Implementation plan with dependencies and verification gates.
- Reference-locked design direction and main interaction flows.
- Security, compatibility, migration, and acceptance checklists.
- Organized project scaffold and a README.
- No application installation, startup registration, or further agent changes.

## 2. Implementation principles

1. Preserve the existing pilot until adoption is explicitly approved.
2. Build a working backend before labelling interface actions functional.
3. Keep authentication, transport health, and agent registration separate.
4. Never execute pasted configuration while importing or previewing it.
5. Store secrets through dedicated adapters; never return them to the frontend.
6. Use the real interfaces of installed CLI versions; do not guess schemas.
7. Prefer a small lifecycle module that owns safety and sequencing over exposing
   low-level Docker commands to every route and UI view.
8. Ship staged capabilities honestly. Unsupported adapters and auth flows remain
   visibly unsupported until verified.
9. Keep maintained project files here. External Docker catalogs, agent configs,
   and OS secret stores remain external operational state with recorded ownership.
10. No production Postora fix is bundled into a local hub implementation.

## 3. Dependency order

```text
P0 planning
  -> P1 repository/runtime/contracts
  -> P2 secure local server + persistence + jobs
  -> P3 read-only discovery + pilot adoption preview
  -> P4 normalization + safe import preview
  -> P5 connector/profile lifecycle + Docker/native adapters
  -> P6 secrets + supported authentication
  -> P7 agent adapters + explicit apply
  -> P8 functional interface integration
  -> P9 Windows startup and recovery
  -> P10 end-to-end validation and staged rollout
```

The interface shell can start after P1 using explicitly labelled fixtures, but no
live health or execution action is considered delivered before its backend gate.

## 4. P0 — Specification and design baseline

### Files

- `README.md`
- `docs/SPECIFICATION.md`
- `docs/IMPLEMENTATION_PLAN.md`
- `docs/DESIGN.md`
- `docs/ACCEPTANCE.md`
- `docs/DECISIONS.md`
- `docs/STATUS.md`

### Tasks

- Record verified versions, installed agent paths, and the existing pilot.
- Separate R1 from follow-on scope and non-goals.
- Lock the proposed light utility design and shared-profile/native-exception
  architecture. The user's approval to implement can retain or revise this lock.
- Record Postora authentication and metadata compatibility as blockers, not fixes.
- Clarify that only two agents currently use the pilot.

### Exit gate

Documents agree on scope and status; internal links resolve; no real credentials
or copied inventories are in the project.

## 5. P1 — Project foundation, contracts, and test harness

### Deliverables

- Root npm workspace, lockfile, TypeScript configuration, formatting/lint rules.
- `apps/web`: React/Vite application with local assets.
- `apps/server`: Fastify server entry point and lifecycle composition.
- `packages/contracts`: browser-safe schemas/types.
- `packages/hub-core`: lifecycle module and internal runtime adapters.
- Unit test runner, integration test setup, and browser test setup.
- Development and production build/run scripts.

### Tasks

1. Check available Node 24 executable and choose a supported patch release.
2. Pin dependencies after checking their Windows/Node compatibility; commit the
   generated lockfile. Avoid assumptions based on globally installed packages.
3. Define schemas for connector definitions, secret references, profiles, agent
   observations, operation previews, jobs, and health results.
4. Set strict TypeScript rules and prevent frontend imports of backend modules.
5. Establish fake process/secret/persistence adapters for safe tests.
6. Use synthetic fixtures only; do not copy personal CLI configs into fixtures.
7. Add scripts such as `dev`, `build`, `typecheck`, `lint`, `test`, and `test:e2e`.

### Tests

- Workspace installs and builds on Windows with the selected Node runtime.
- Contract validation rejects malformed and oversized inputs.
- Browser bundles contain no Node process or secret-store implementation.
- Source/fixture secret scan passes.

### Exit gate

A fresh checkout can install, typecheck, test, build, and serve a minimal local
page without changing Docker profiles or agent configurations.

## 6. P2 — Local security, persistence, operations, and jobs

### Deliverables

- Loopback-only server with exact Host/Origin policy.
- One-time launch bootstrap, session management, and CSRF protection.
- Atomic local state adapter with revisions, backups, and active-writer lock.
- Operation preview/apply lifecycle and bounded cancellable jobs.
- Redacted audit/event collection.

### Tasks

1. Bind only to `127.0.0.1`; check the proposed port without killing its owner.
2. Define a single exact browser origin and reject wildcard CORS behavior.
3. Bootstrap via a single-use high-entropy token, consumed once and removed from
   the address bar. Never log it or persist it in browser storage.
4. Require an authenticated local session for inventory and management endpoints.
5. Require CSRF protection for mutations and install restrictive security headers.
6. Make all externally supplied descriptions/diagnostics text, not rendered HTML.
7. Implement explicit JSON schema versions and migrations.
8. Write via temporary files and atomic replacement with bounded Windows retries;
   keep pre-change backups and detect revision/fingerprint conflicts.
9. Define process runner timeouts, output caps, cancellation, and same-user owned
   process-tree cleanup. Verify `.cmd`/`.bat` handling separately on Windows.
10. Redact before logs/events are stored. Do not record raw import bodies or stdin.
11. Journal partial applies across local state, Docker, secrets, and agent files.

### Tests

- Missing/expired/reused bootstrap tokens fail.
- Disallowed Host, foreign Origin, null Origin, and missing mutation CSRF fail.
- Unauthenticated clients cannot list connectors or submit operations.
- Injected connector markup is displayed literally.
- Stale revisions and concurrent writers cannot overwrite newer state.
- Timeouts/cancellation stop only the test-owned process tree.
- Operation errors are not represented as empty successful reads.
- Secrets, token fragments, and imported secret fields do not appear in logs.

### Exit gate

Security and persistence negative tests pass before any real secret is entered or
any real CLI configuration is written.

## 7. P3 — Dependency discovery and read-only adoption

Implemented as a verified read-only baseline. Native versions without safe metadata,
Grok/Kilo/Kimi config scopes, and effective project/account/plugin bindings remain
explicitly pending. The adoption view is a metadata/revision/conflict preview, not
a complete normalized desired-state or managed-file diff; that work continues in
P4 and the version-specific adapters. See `STATUS.md` and decision D015.

### Deliverables

- Docker/gateway/runtime capability detection.
- Agent executable/version discovery, including aliases and environment paths.
- Sanitized existing-pilot inventory.
- Adoption preview and drift detection, with no automatic migration.

### Tasks

1. Read the pilot profile through documented Docker commands.
2. Normalize its snapshots without treating source JSON as live profile state.
3. Detect native Chrome launcher behavior and explain isolated browser sessions.
4. Discover all eight agents; distinguish present, compatible, configured, and
   verified. Respect `CODEX_HOME` and other relevant supported overrides.
5. Read existing settings with format-aware parsers and redact secret fields.
6. Present an adoption diff: imported desired state, managed files, references,
   unaffected configs, and any unresolved conflicts.
7. Show unavailable Docker as degraded state, not a server crash.
8. Do not read private Claude-account credential caches to clone tokens.

### Tests

- Read-only discovery produces no filesystem/profile changes.
- Docker stopped, missing executable, unexpected version, invalid config, and
  inaccessible file all produce specific diagnosable states.
- Aliases do not become duplicate agents.
- Existing `node_repl`, Claude account/plugin connectors, and denylist remain intact.
- Different source/profile snapshots are reported as drift.

### Exit gate

The dashboard can truthfully show the installed environment and existing pilot
without modifying it. Initial adoption still requires explicit user approval.

## 8. P4 — Safe import and configuration preview

Implemented as a data-only preview lifecycle; see decision D016 for the precise
accepted JSON subset, bounds, credential handling, and unsupported shapes. Current
files/agent changes and writes are explicitly none. Draft references are not stored
credential IDs and cannot be applied through the local-profile operation endpoint.
Save/apply and apply-time secret cleanup remain gated on P5/P6 rather than being
simulated. The enabled cancellation/expiry/replacement/logout paths clear private
draft memory; browser inputs are cleared on submit/error/cancel.

### Deliverables

- Deterministic normalizer for supported configuration shapes.
- Import-preview endpoint and multi-entry selection.
- Secret extraction in memory with redacted previews.
- Native executable/argument forms with explicit trust warnings.

### Tasks

1. Implement fixtures for `mcpServers`, the source's `servers`, OpenCode V2
   `mcp.servers`, Docker definitions, and single-entry inputs.
2. Reject ambiguous transport/executable shapes; report unsupported fields.
3. Preserve case-sensitive arguments and avoid interpreting shell metacharacters.
4. Reject raw JavaScript/Python/PowerShell programs as importable configuration.
5. Extract header/env credentials into write-only in-memory draft fields.
6. Reject credential-bearing URLs or convert only supported cases into references.
7. Produce a revision-bound operation preview with scope, files, downloads,
   execution mode, permissions, and affected agents.
8. Clear secret-bearing browser draft state after apply/cancel.

### Tests

- Malformed, conflicting, oversized, and partial configurations fail clearly.
- Importing `npx`/`uvx` or a command causes zero process launches.
- Shell expansion and argument injection attempts remain inert input.
- Preview/export responses contain references, never credential values.
- Duplicate connector names/IDs require a conflict decision.
- Unsupported fields are visible rather than silently lost.

### Exit gate

Users can paste supported configs and understand the exact proposed changes, but
nothing executes or persists before approval.

## 9. P5 — Connector lifecycle, profiles, and runtime adapters

### Deliverables

- Desired connector/profile registry and lifecycle operations.
- Docker catalog/profile materialization adapter.
- Native launcher generation with isolated per-client processes.
- Real MCP initialization and capability-discovery jobs.

### Tasks

1. Implement create/edit/enable/disable/unassign/remove semantics.
2. Validate managed Docker filenames and restrict writes to permitted catalog paths.
3. Apply Docker profile snapshots through supported commands, then read back.
4. Detect external edits and require a new preview instead of overwriting them.
5. Generate native launchers from explicit executable/argument arrays.
6. Bind execution approval to the normalized command/image/config revision.
7. Use dedicated browser profiles by default; do not attach to personal Chrome
   unless separately configured and approved.
8. Implement discovery of tools/resources/prompts with time/output limits and
   protocol-version compatibility checks.
9. Record timestamps and verification level; invalidate stale health on changes.
10. Treat gateway-management tools separately from upstream tools.
11. Mark affected agent bindings reconnect-required; do not fake live reload.
12. Retain a successful connector's status when a different connector fails.

### Tests

- Local fake HTTP and stdio MCP fixtures initialize and enumerate capabilities.
- Zero `tools/call` requests are issued by default discovery.
- Failed upstream auth does not erase healthy results.
- Edited definitions do not execute until reapproved.
- Windows path spaces, Unicode, argument quotes, and cancellation are exercised.
- Disabling retains credentials; unassigning does not delete a connector.
- Shared secret references prevent accidental credential deletion.
- Snapshot updates and reconnect flags are verified against a disposable profile.

### Exit gate

Create/test/disable/remove works against disposable connectors and profiles with
reliable rollback. The existing pilot remains untouched unless adopted.

## 10. P6 — Secrets and supported authentication

### Deliverables

- Docker secret adapter using stdin, never secret command-line arguments.
- Verified same-user Windows-backed store for native connectors.
- Guided auth state machine and supported provider recipe registry.
- Bounded OAuth jobs and credential-update controls.

### Tasks

1. Verify the installed Docker secret interface and error handling.
2. Implement native secret storage with a reviewed same-user mechanism such as
   DPAPI; do not invent an undocumented Docker plaintext-read interface.
3. Resolve only the specific bindings required by the launched connector.
4. Make frontend secret writes one-way; return identifiers/presence only.
5. Support provider-specific header formats without guessing Bearer for every API.
6. Detect supported OAuth app/recipe from documented capabilities.
7. Show requested scopes and open only an actual verified authorization URL.
8. Handle user denial, timeout, callback failure, unsupported registration,
   expired token, and refresh failures distinctly.
9. After storing/signing in, run discovery before declaring authentication fixed.
10. Record Postora's failure separately. Investigate its auth contract/metadata in
    a separately authorized task before claiming a fix.

### Tests

- Secrets never appear in command arguments, inventory, logs, exports, localStorage,
  config previews, or the Git tree.
- Credential-save success does not imply upstream authentication success.
- Cancelling sign-in leaves recoverable configuration and no fake connected state.
- Invalid/foreign auth URLs, state mismatch, and unsupported flows fail safely.
- DPAPI/native secrets are usable only through the intended same-user path.
- Provider revocation and local deletion are distinct confirmed operations.

### Exit gate

At least one secret-backed disposable connector and one verified supported OAuth
flow pass end-to-end checks. Other providers retain an explicit unsupported state.

## 11. P7 — Agent adapters and explicit synchronization

User direction recorded after P6 implementation began (2026-10-28): next deliver
P7 as the Windows agent adapter/one-click integration engine, P8 as the desktop UI
with **Scan Agents**, **1-Click Integrate**, and **Add Manual MCP**, then P9 Windows
desktop application packaging. Preserve the safety/preservation gates below and
fold the earlier startup/recovery work into that packaging plan; none is implemented
or silently authorized as a side effect of P6.

### Delivery sequence

1. OpenCode and Codex, using the pilot's verified patterns.
2. Antigravity and Grok after config-scope/read-back verification.
3. Claude Code with preservation and deduplication of account/plugin connectors.
4. Kilo, Kimi Code, and Cursor after version-specific schema/approval discovery.

### Per-agent implementation checklist

- Discover actual executable/version and effective user config scope.
- Build parser/merge fixtures, including unrelated settings and same-name conflicts.
- Preview only managed hub-entry changes.
- Back up the target file, apply narrowly, and read back.
- Keep credentials in the hub secret store, not repeated agent settings.
- Verify registration separately from live MCP discovery.
- Explain exact reconnect/approval actions supported by that CLI.
- Provide entry-scoped rollback that preserves newer unrelated changes.

### Special requirements

- OpenCode: emit V2 `mcp.servers`, preserve JSONC/comments, use hot reload correctly.
- Codex: respect `CODEX_HOME`; preserve TOML and `node_repl`; verify through an
  app-server check that starts no model turn.
- Claude: do not export account tokens; preserve Rube/Byterover denylist and
  inherited connectors; avoid silent duplicate endpoints.
- Cursor: do not assume an MCP-add command exists; verify config-file and approval
  semantics before implementing apply.
- Kimi: do not apply legacy Python Kimi CLI configuration to current Kimi Code.

### Tests

- Fixture round trips preserve unrelated settings, comments where supported,
  exact argument values, and secret references.
- Same-name conflicts fail rather than silently replacing an existing entry.
- Failed writes/read-backs trigger journaled recovery and clear status.
- Effective config and tool discovery are verified on actual installed versions.
- No new LLM turn or paid model request is needed for connection verification.

### Exit gate

Claim an agent supported only after its preservation, apply, and discovery checks
pass. Full eight-agent rollout requires eight passing adapters; missing adapters
are release-visible limitations, not hidden fallback behavior.

## 12. P8 — Professional frontend and interaction integration

### Deliverables

- Reference-locked app shell and token system from `DESIGN.md`.
- Connectors workspace, detail drawer, add/import wizard.
- Agents/profile/activity/settings views.
- Functional authentication and job progress interfaces.
- Responsive and keyboard-accessible states.

### Tasks

1. Build the light utility shell, sidebar, page header, and search/filter controls.
2. Use real sanitized inventory from the backend; clearly label any development
   fixture mode and exclude it from normal startup.
3. Implement list/detail navigation, status labels, last-check timestamps, and
   the Available-to agent strip.
4. Build wizard steps: Input -> Normalize -> Authentication -> Scope -> Review ->
   Apply/Test. Native execution approval is explicit.
5. Integrate asynchronous jobs with progress, cancellation, and recoverable errors.
6. Implement agent change previews, profile assignment, and reconnect indicators.
7. Make removal dialogs distinguish definition/profile/credential/provider impact.
8. Design loading, empty, offline, invalid, conflict, stale, unsupported, and
   cancelled states with real corrective copy.
9. Keep all scripts, fonts/icons, and assets local in production.
10. Compare rendered desktop/mobile views to the design lock and correct drift.

### Tests

- Browser tests cover normal and failure journeys with a disposable backend.
- Keyboard-only add/edit/cancel/auth/remove flows work.
- Dialog focus entry/return, input labels, errors, and status announcements work.
- Layout works at 1440, 1024, 768, and 390 px widths.
- No fake green statuses, inert primary buttons, or unreachable loading states.
- Secret inputs clear after submit/cancel and do not leak to diagnostics/storage.

### Exit gate

Every visible action either works through the real backend or is explicitly
disabled with a reason. Visual validation and accessibility checks pass.

## 13. P9 — Windows operation, startup, and recovery

### Deliverables

- Start/stop/open/diagnostics launchers in `scripts/`.
- Optional current-user sign-in startup registration and removal.
- Version/path/dependency diagnostics and recovery instructions.
- Backup retention and safe uninstall documentation.

### Tasks

1. Resolve Node 24 and absolute project paths without relying on an IDE's shell.
2. Start one manager instance per user; open a new dashboard session if already
   running rather than launching duplicate listeners.
3. Add Windows startup only after the user chooses Enable startup.
4. Use a documented same-user mechanism; avoid elevation and SYSTEM services.
5. Handle Docker not yet ready by reporting degraded status with retry guidance.
6. Stop only manager-owned processes; leave agent gateways and unrelated apps alone.
7. Implement bounded backup retention and drift-aware restore previews.
8. Keep uninstall of the manager separate from deleting upstream credentials or
   agent connector entries.

### Tests

- Project path with spaces, runtime discovery failure, port conflict, duplicate
  startup, and Docker unavailable cases are exercised.
- Startup enable/disable is reversible and accurately shown in Settings.
- Closing a tab or stopping the manager leaves agent MCPs unaffected.
- Recovery does not overwrite newer unrelated config changes.
- No login-time package installation or silent image pull occurs.

### Exit gate

Normal use works without a developer terminal. Startup behavior is opt-in,
same-user, reversible, and validated on the target Windows installation.

## 14. P10 — Final validation and staged rollout

### Rollout sequence

1. Run all unit, contract, negative-security, adapter, and browser checks.
2. Verify read-only discovery with the actual local environment.
3. Ask for explicit adoption of the existing pilot.
4. Apply to OpenCode and Codex with fresh scoped backups and verify both.
5. Test supported secret/OAuth flows locally; leave Postora unresolved until its
   auth issue is separately corrected.
6. Add the remaining agents one at a time after compatibility passes.
7. Verify concurrent clients and per-client stateful-tool isolation.
8. Enable startup only if requested through Settings.
9. Produce a final capability matrix: configured, discovery-verified,
   auth-required, unsupported, or reconnect-required for every connector/agent.

### Release evidence

- Exact dependency/runtime versions and a successful clean build.
- Test results and redacted integration reports.
- Screenshots of desktop/mobile normal and error states.
- Configuration diffs and backup locations, without secrets.
- Known limitations and provider-specific auth instructions.
- Confirmation that unrelated Docker workloads and CLI settings remain intact.

### Exit gate

R1 is released only when its declared supported capabilities pass
`ACCEPTANCE.md`. Any incomplete agent/provider remains explicitly labelled.

## 15. Cross-cutting test strategy

### Unit/contract

- State transitions, schema normalization, profile membership, secret references,
  revision conflicts, redaction, naming/path rules, and agent merge behavior.
- Test through the lifecycle interface; fake external effects at actual seams.
- Test observable behavior rather than duplicating implementation internals.

### Integration

- Local HTTP/stdio MCP fixtures with success, auth failure, timeout, malformed
  response, pagination, and incompatible protocol cases.
- Disposable Docker profiles and catalog definitions.
- Fake-provider OAuth flows for negative tests, plus explicit opt-in real-provider
  sign-in where supported.
- Native Windows launcher argument and process cleanup behavior.

### End-to-end

- Add/import/review/approve/test/edit/disable/remove.
- Authentication states, profile assignment, agent apply/reconnect, startup toggle.
- XSS/CSRF/Host/Origin and secret-storage negative cases.

### Real-environment tests

Read-only by default. Any provider write, SSH command, file transfer, personal
browser attachment, agent config change, or startup registration requires explicit
authorization and a narrowly scoped test plan.

## 16. Risk register

| Risk                                            | Mitigation                                                              | Blocks                   |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ------------------------ |
| Agent config formats differ                     | Versioned adapters, fixtures, preview/apply/read-back                   | Full eight-agent claim   |
| OAuth varies by provider                        | Recipe registry; unsupported state; no universal promise                | Provider auth support    |
| Postora source token/metadata fail              | Separate investigation; preserve failure evidence                       | Postora connected status |
| Browser sessions mix                            | Native isolated per-client launchers                                    | Browser support          |
| Management app becomes arbitrary command runner | No shell endpoint; revision-bound approval; constrained process adapter | All execution features   |
| Secrets leak through diagnostics/imports        | Redact before persistence; write-only UI; source scans                  | All releases             |
| Docker profiles do not auto-refresh             | Explicit materialization/read-back/reconnect state                      | Automatic-update claims  |
| Localhost attacked by websites                  | Exact host/origin, bootstrap/session, CSRF, CSP                         | Real credentials         |
| Distributed partial applies                     | Operation journal, backups, recovery, revision checks                   | Config writes            |
| Windows startup races Docker                    | Degraded mode; no silent installation                                   | Auto-start               |
| Runtime dependencies move                       | Pin/lock versions; test upgrade before applying                         | Reproducibility          |

## 17. Work tracking and handoff

- Work package state: not started, in progress, blocked, verified.
- Each completed package updates `STATUS.md` with files, tests, and limitations.
- Decisions that alter this baseline are recorded in `DECISIONS.md` before code
  depends on them.
- Follow-up tasks must not silently expand into production infrastructure fixes.
- Never mark the planning scaffold as a completed working application.

## 18. Follow-on backlog — local MCP usage metrics

Requested after implementation began (2026-10-28); deferred to R2, not implemented.
See specification section 11.1. Add counting at verified per-client runtime paths,
with explicit project/client attribution, bounded private local aggregates, and
separate tool-call/discovery/retry units. Agent and CLI are one dimension unless
individual agent instances are explicitly identified. Test multiple projects and
clients, unknown attribution, errors/cancellation, and bypass coverage without
recording payloads. Do not build a decorative metrics dashboard before real
traffic instrumentation and attribution are verified.

## 19. Immediate next implementation task

P1 is verified. P2 local storage/session foundations, the internal Windows bounded
runner, refusal audit/redaction, and registry-only recovery journal are implemented.
The P3 read-only baseline is verified, with native-version/effective-agent scope
gaps explicitly pending rather than guessed. External Docker/secret/agent checkpoint
and recovery gates remain unimplemented; see `STATUS.md` for evidence/limitations.
P4 safe import/normalization is verified as preview-only, with memory-only private
drafts and no apply capability. Next is **P5 connector/profile/runtime lifecycle**.
Do not enable adoption/import apply or external
writes before their corresponding P5/P6/P7 safeguards and negative tests exist.

Do not begin by registering startup, migrating all eight agents, importing real
secrets into browser fixtures, or presenting a mock dashboard as operational.
