# Waleed MCP Hub — Acceptance and Release Gates

Date: 2026-10-29
Unchecked boxes are planned verification, not completed work.

## Planning deliverable

- [x] Specification saved in this project.
- [x] Ordered implementation plan saved in this project.
- [x] Design reference lock and decision ledger saved.
- [x] Known pilot limitations distinguished from proposed features.
- [x] At the P0 planning checkpoint, implementation was explicitly marked not started.
      P1 is now verified; current evidence and unfinished gates are in `STATUS.md`.

## Local server and security

### Verified P3 read-only baseline (not full adapter support)

- [x] Explicit discovery is session/Origin/CSRF protected and accepts no command/path/env input.
- [x] Eight agent products are distinct; aliases are not duplicate agents.
- [x] Version provenance, user-file scope, unknown/pending/invalid states remain visible.
- [x] No agent start, MCP list, gateway execution, image pull, or upstream tool call is used.
- [x] Selected JSONC/TOML inputs are read as data; no references, hooks, plugins or scripts are evaluated.
- [x] Remote Docker contexts and unsupported gateway schemas fail closed; stopped Docker is degraded.
- [x] Adoption preview is sanitized, revision-labelled, snapshot-only, and cannot apply changes.
- [x] Explicit real-environment verification found unchanged inspected file contents and pilot snapshot.
- [ ] Remaining native versions and Kilo/Kimi config scopes verified without unsafe fallback (Grok user scope: D026).

### Verified P4 safe import baseline (no save/apply)

- [x] Deterministic normalization covers supported JSON wrappers, single entries, Docker image/remote definitions, HTTPS and native forms.
- [x] Unsupported/ambiguous/malformed/oversized inputs fail visibly without reflection or code execution.
- [x] Case-sensitive arguments and shell metacharacters remain inert input; known inline interpreter programs are rejected.
- [x] Header/env values become memory-only private draft references, never preview/export values.
- [x] Credential-bearing URLs and known indirect credential projections are rejected/masked without network access.
- [x] Partial inputs, duplicate/existing names/IDs, stale revisions, recovery blocks and capacity limits are explicit.
- [x] Draft reads, selection and cancellation are owner scoped; mutations require local Origin/session/CSRF.
- [x] Cancel/replacement/expiry/logout/shutdown and stale revisions discard private drafts and zero retained Buffers.
- [x] Browser submission/error/cancel clears raw inputs; sanitized export and keyboard/responsive flows are tested.
- [x] Preview scope lists execution modes, future downloads/permissions, and actual zero files/agents/writes/process/network effects.
- [ ] Save/apply-time secret storage and cleanup verified with P5/P6 adapters; no apply exists in P4.

### P5 enabled subset (see STATUS.md for live verification evidence)

- [x] No-secret imports bridge to a separate revision-bound registry save; private values cannot be persisted.
- [x] Connector/profile CRUD, toggles and membership operations have distinct preview/apply semantics.
- [x] Approval binds exact connector revision/hash; editing/toggling invalidates it.
- [x] Disabled/unassigned/removed definitions retain credential values and independent owners.
- [x] Owned Docker snapshot/files have preview, CAS drift checks, read-back and tested compensation.
- [x] External interruptions cannot be reconciled from registry hashes; uncertain cleanup remains blocked.
- [x] Synthetic real HTTP/SSE/contained-stdio MCP discovery uses zero `tools/call`.
- [x] Pagination/version/auth/destination/output/cancellation limits fail closed; healthy results remain independent.
- [x] Native argv preserves spaces/Unicode/quotes/metacharacters; only absolute `.exe` execution is enabled.
- [x] Known Chrome MCP enforces `--isolated` and refuses personal attachment flags (argument tests, not a live Chrome run).
- [x] Opt-in real disposable Docker metadata create/read-back/update/removal and two independent generated native clients pass; owned artifacts removed, pilot fingerprint unchanged.
- [ ] Live Docker image MCP execution and cleanup verified against a disposable image; adapter fault tests alone are not this gate.
- [ ] Secret-backed execution and actual agent registration/reconnect verified in P6/P7.

### Full release checks

- [ ] Listens only on `127.0.0.1`.
- [ ] Exact Host/Origin policy rejects malicious/foreign/null origins.
- [ ] Inventory requires an authenticated local session.
- [ ] Bootstrap token is high-entropy, single-use, not logged or stored in browser storage.
- [ ] Mutations require CSRF protection and validated contracts.
- [ ] XSS payloads in connector metadata/diagnostics remain inert text.
- [ ] CSP and framing protections are applied.
- [ ] No arbitrary shell-execution or arbitrary file-write interface exists.
- [x] Internal Windows `.exe` runner timeouts/cancellation affect only its owned
      Job Object members; synthetic root/child and unrelated sentinel tests pass.
      P5 reuses this containment for approved `.exe` discovery/launchers; `.cmd`/`.bat` remain unsupported.
- [x] Enabled import previews launch no processes and install nothing (static boundary gate and synthetic tests).
- [ ] Config/path traversal and symlink-escape attempts are rejected.
- [ ] Unsafe upstream destinations/redirects fail without globally disabling validation.

## Secrets and authentication

### P6 enabled subset (live account consent is a separate gate)

- [x] Docker set uses stdin; metadata presence and scoped deletion have no plaintext read seam.
- [x] Windows DPAPI CurrentUser protects immutable per-reference blobs; plaintext is absent from vault files.
- [x] Mutable input/decrypted Buffers and leases are zeroed; immutable/runtime copies are not claimed securely erased.
- [x] Wrong vault scope, tampered ciphertext, unsafe IDs, junctions and duplicate writes fail closed.
- [x] One-way HTTP writes return reference/presence metadata, never credential values or provider diagnostics.
- [x] Registry revision/hash approval is invalidated by binding updates; credential-save success is not connected status.
- [x] Only declared owned references resolve; runtime injection/cookie/transport header bindings are rejected.
- [x] Rotation preserves shared/old values; referenced/materialized consumers block local deletion.
- [x] Curated Linear read-only OAuth metadata/DCR/S256/state/issuer flow and explicit refresh exist.
- [x] Synthetic provider end-to-end discovery succeeds; denial, cancellation, timeout, stale definitions and refresh failures remain isolated.
- [ ] Real-account Linear consent and MCP discovery verified with the user's chosen account.
- [ ] A second Windows login independently attempts decryption; CurrentUser OS scope is used, not a fabricated second-user test.
- [ ] Live Docker secret-backed image discovery and remote Windows-secret agent proxy paths verified.
- [ ] Provider-side revocation verified; local deletion explicitly does not claim revocation.

The unchecked live/provider/agent gates are not silently promoted by passing a
synthetic OAuth fixture, metadata-only Docker check, or same-user wrong-scope test.

### Full release checks

- [ ] Actual values are absent from source, configs, previews, exports, logs, and localStorage.
- [ ] Secret inputs are cleared after apply/cancel.
- [ ] Docker secrets are supplied through stdin, not command-line values.
- [ ] Native secrets use a verified same-user Windows-backed mechanism.
- [ ] Frontend secret operations are write-only.
- [ ] Only declared bindings are resolved for a connector.
- [ ] Supported OAuth displays provider/scopes and handles cancellation/timeout/failure.
- [ ] Unsupported OAuth does not produce a fake connected state.
- [ ] Credential-save success is separate from upstream auth verification.
- [ ] Claude-account credentials are not exported or copied.
- [ ] Postora remains attention-required until its actual auth flow passes verification.

## Connector lifecycle

- [x] Supported P4 URL, JSON-wrapper, Docker-image, and native command inputs normalize correctly (D016 subset).
- [x] Unsupported fields/shapes are visible and not silently discarded by enabled imports.
- [ ] Create/edit/enable/disable/profile-unassign/remove semantics are distinct.
- [ ] Material execution changes invalidate prior trust approval.
- [ ] Apply has preview, backup, revision check, read-back, and recoverable failure handling.
- [ ] External changes produce drift/conflict instead of silent overwrite.
- [ ] MCP checks initialize/list capabilities without default tool execution.
- [ ] Tool pagination and protocol/transport errors are handled.
- [ ] One failed upstream does not hide healthy connector results.
- [ ] Connected status includes time and verification level.
- [ ] Gateway-management tools are distinguished from upstream connector tools.
- [ ] Chrome defaults to isolated per-client sessions.
- [ ] Profile snapshots and reconnect-required behavior are accurately surfaced.

## Agent adapters

### P7 configuration-only enabled subset

- [x] Nine disposable Windows scopes integrate/disconnect with private timestamped backups, atomic writes and exact read-back.
- [x] OpenCode V2 `mcp.servers`; Codex TOML/comments/`node_repl`; Claude Desktop/Code `mcpServers`; Antigravity; VS Code user `mcp.json`/`servers`; Cursor; current Kimi Code; Kilo CLI shapes tested.
- [x] JSONC comments, plugins, denylist and newer unrelated settings/comments survive managed-entry changes.
- [x] Duplicate keys, foreign entries, ambiguous layers, stale revisions/fingerprints and links fail closed.
- [x] Protected scan/integrate/disconnect/status/sync routes share session/Origin/CSRF policy.
- [x] Journal precedes external effects; uncertain writes retain backups and block for recovery.
- [x] Independent compiled DPAPI-backed native bridge lists with zero tool calls, forwards one explicit synthetic call and refuses disabled routing.
- [x] Bridge enforces request/page/tool bounds; secret-echo refusal and cleanup diagnostic isolation have regression tests.
- [ ] Each actual installed agent reconnects/trusts the bridge and lists tools in its effective scope.
- [ ] Remote DPAPI-backed provider/installed-agent path is live-verified (synthetic native bridge evidence is not this gate).
- [ ] Live secretless Docker image bridge execution and scoped cleanup are verified.

The following original broad agent gates intentionally remain unchecked: the nine
requested configuration adapters are not evidence of full live eight-CLI support.
Grok was not one of the nine requested P7 targets; Claude Desktop and VS Code were.
D026 later adds Grok as a tenth configuration target.

For each checked agent: verify discovery, exact scope/schema, preservation,
preview/apply/read-back, real MCP discovery, reconnect guidance, and scoped rollback.

- [ ] OpenCode V2.
- [ ] Codex, including `CODEX_HOME` and existing `node_repl` preservation.
- [ ] Antigravity.
- [ ] Grok.
- [ ] Claude Code, including account/plugin connectors and denylist preservation.
- [ ] Kilo Code.
- [ ] Kimi Code, not an assumed legacy CLI format.
- [ ] Cursor Agent, including its actual approval model.
- [ ] Aliases are deduplicated.
- [ ] No LLM/model turn is needed merely to verify MCP discovery.
- [ ] Full eight-agent support is claimed only when all eight pass.

## Interface and accessibility

### P8 scanner/manual-MCP enabled subset

- [x] Prominent Scan Installed Agents, path/status/reconnect rows, explicit consent and Integrate/Disconnect actions.
- [x] Manual Stdio/Docker/HTTP/SSE fields validate JSON args/ports, protected env/headers and HTTPS endpoints.
- [x] Save, exact execution approval, authentication and auto-sync are distinct.
- [x] Partial-save receipts retain the saved connector ID; transient inputs clear on success/error/close.
- [x] Scanner/integrate/manual-auto-sync/disconnect browser journey passes with no private response/DOM value or localStorage retention.
- [x] Scanner screenshots at 1440/1024/768/390 px show no horizontal overflow; manual-save mobile state inspected.

- [ ] Connectors, Agents, Profiles, Activity, and Settings are functional.
- [ ] Add/import wizard follows review/approval before execution.
- [ ] Detail drawer shows sanitized config, auth, capabilities, and diagnostics.
- [ ] Available-to strip accurately distinguishes configured/verified/stale access.
- [ ] Search/filter, empty, loading, error, unavailable, conflict, and cancellation states work.
- [ ] Visible actions work or are disabled with an explanation.
- [ ] Every input is labelled; error/focus/dialog behavior works by keyboard.
- [ ] Status is not communicated by color alone.
- [ ] AA contrast and usable touch targets are verified.
- [ ] Screenshots at 1440/1024/768/390 px match the design lock.
- [ ] Production assets are local; no external CDN or analytics is required.

## Windows and operations

### P9 portable/desktop enabled subset

- [x] Portable production folder starts outside the workspace using bundled Node 24 with empty PATH; serves local UI, enforces sessions and releases locks.
- [x] Single-instance Windows pipe reopens the same owned backend with a fresh fragment token; no token is returned on the control pipe.
- [x] Protected Settings shutdown releases writer locks; no unrelated process is terminated.
- [x] Port-conflict startup releases owned locks and exits nonzero while the unrelated port owner remains alive.
- [x] PowerShell/batch launchers and opt-in shortcut installer are provided; no service/startup task is installed.
- [ ] Real Microsoft Edge App Mode launch/close/reopen is manually exercised.
- [ ] Shortcut creation/launch and explicit replacement are manually exercised on the user's Desktop.
- [ ] Fresh copied runtime startup reliability is established across Windows machines; an earlier 20-second isolated timeout remains recorded despite passing rerun.

- [ ] Start/stop/open scripts work outside the developer terminal.
- [ ] Node 24 and project paths resolve reliably, including spaces/Unicode.
- [ ] Port conflicts and duplicate instances fail/recover safely.
- [ ] Docker unavailable produces a useful degraded dashboard.
- [ ] Startup registration is opt-in, current-user, non-elevated, and reversible.
- [ ] Closing the dashboard does not terminate agent MCPs.
- [ ] Stopping/uninstalling the manager leaves unrelated workloads/settings intact.
- [ ] Backups and restore previews preserve newer unrelated user changes.
- [ ] Fresh install/build/typecheck/lint/tests succeed with the lockfile.
- [ ] Final report includes actual capabilities, unresolved issues, and authentication next steps.

### Latest automated evidence (2026-10-29)

`npm run check`: 309 tests / 35 files, typecheck/lint/boundary/credential/build gates
and compiled process/secret smokes. Separate compiled nine-scope integration smoke:
passed. Complete Playwright suite: 22 passed. Final portable folder isolated
startup/session/UI/shutdown: passed; PowerShell parsing passed. See STATUS.md for
the exact folder, earlier failures and remaining manual gates. These results do not
check off the broad live-agent/provider/full-release boxes above.

## Release rule

A staged release can explicitly mark unimplemented providers/adapters as unsupported.
It cannot claim complete eight-agent support or fixed Postora authentication until
the corresponding checks pass. No production deployment is part of this local-app
release unless separately authorized.
