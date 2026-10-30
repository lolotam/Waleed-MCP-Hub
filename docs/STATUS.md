# Waleed MCP Hub — Actual Project Status

Updated: 2026-10-30

## Completed in this project

- Full specification saved.
- Implementation plan saved.
- Design reference lock and decision ledger saved.
- Acceptance/release checklist saved.
- README and source-directory scaffold saved.
- P1 npm workspace, exact dependency lockfile, browser-safe Zod contracts, and build.
- React/Vite shell, Fastify server, lifecycle module, and internal adapter seams.
- Loopback bootstrap/session, exact Host/Origin policy, CSRF and security headers.
- Versioned JSON store, writer lock, atomic replacement, revision/fingerprint
  conflicts, and bounded backups.
- Real local-only profile preview/apply/jobs, queued cancellation, and structural activity.
- Synthetic process/secret/persistence fakes and disposable browser test harness.
- Internal Windows process runner with approved absolute executables, explicit
  argument/environment data, bounded time/output/concurrency, and atomic Job
  Object containment. HTTP exposes no generic process interface; P3 uses it only
  for fixed read-only Docker queries; P5 additionally uses it for approved checks.
- Windows tests cover real synthetic process trees and verify that an unrelated
  process remains alive when the owned tree times out or is cancelled.
- Fixed public error messages and a bounded defense-in-depth diagnostic redactor.
- Persistent refusal audit with closed metadata schemas; failed audit storage is
  explicit HTTP 503 rather than silently claimed success.
- Durable prepared/committed/aborted/review-required journal records for local
  profile saves, with exact-hash startup reconciliation and no automatic replay.
- Read-only audit/recovery APIs, Activity refusal list, and mutation-blocking
  recovery warnings. Journal/audit persistence contains no raw input payloads.
- P3 manually triggered read-only discovery jobs, sanitized dependency/agent/pilot
  snapshots, source metadata comparison, and non-applicable adoption preview.
- Known agent user-file inspection with JSONC/TOML parsers, environment overrides,
  alias grouping, and installed-manifest version observations. No agent is started.
- Native Chrome recipe/isolation metadata inspection without executing its launcher.
- Discovery controls, owner-scoped progress/cancellation, degraded Docker guidance,
  actual user-file observations on Agents, and a clearly labelled fixture harness.
- P4 deterministic strict-JSON normalization for single entries, mcpServers,
  servers, OpenCode V2 mcp.servers, and the supported Docker image/remote subset.
- Safe import-preview/read/selection/cancel APIs, revision checks, visible unsupported
  fields and entry errors, and duplicate/existing name/ID conflict decisions.
- Write-only memory draft extraction of header/env values into references, with
  bounded retention, zeroed private Buffers and cleanup on cancel/replacement,
  stale revisions, expiry, logout and shutdown. No import apply route exists.
- Add connector paste/HTTPS/native forms, multi-entry selection, inert argument
  review, permission/download warnings and sanitized export. Direct import apply
  stays disabled; P5 provides a separate no-secret registry-save preview.
- P5 journaled connector/profile CRUD, toggles, assign/unassign and no-secret import
  save bridge; exact revision/hash execution approval is separate from save/test.
- Owned Docker catalogs/profile snapshots and independent native launchers with CAS
  drift detection, exact read-back, scoped compensation and blocking recovery for
  unknown external outcomes. Startup never infers external success from registry hashes.
- Real SDK MCP HTTP/SSE/contained-stdio initialization and tools/resources/prompts
  discovery; bounded jobs/output/pagination and zero `tools/call`. Observations retain
  timestamps/protocol/verification level and invalidate on definition changes.
- P5 UI separates save/approval/apply/check, desired membership, stale snapshots,
  upstream versus gateway tools, and reconnect requirements. No agent settings change.
- P6 immutable, generated credential references, stdin-only Docker keychain adapter
  and same-user DPAPI-backed native store with a restricted current-user/SYSTEM DACL.
- One-way credential write/update/local-delete controls, revision checks, ownership
  and materialized-reference guards, external journaling, compensation and blocking
  recovery for ambiguous writes. Values never enter registry or response DTOs.
- Declared Windows-backed environment/header resolution for real native/HTTP/SSE
  checks and native launchers; mutable leases/Buffers are zeroed on cleanup.
- Curated Linear read-only OAuth recipe, metadata pinning, public DCR, S256 PKCE,
  one-time loopback callback/state/issuer validation, bounded owner-scoped jobs,
  cancellation/denial/timeout handling, explicit refresh and discovery-before-success.
- Authentication dialog with uncontrolled write-only input, explicit header format,
  provider/scope consent, supported/unsupported states and separate local deletion.
- P7 nine Windows user-file adapters, explicit scan/integrate/disconnect/status,
  ownership/fingerprint checks, comment-preserving edits, private timestamped backups,
  atomic replacement/read-back and external-effect recovery checkpoints.
- Tools-only dynamic agent bridge: approved registry definitions, declared DPAPI
  credentials, explicit tool forwarding, bounded sessions and tool-list notifications.
- P8 agent scanner/actions and manual Stdio/Docker/HTTP/SSE dialog with protected
  env/headers, loopback Docker ports, explicit execution consent and optional sync.
- P9 portable-folder packaging with bundled Node 24/production dependencies,
  Windows launchers/shortcut installer, named-pipe single instance and protected shutdown.
- F01 managed npm packages (D024): Look up and Install from a frozen lock with
  the bundled, repacked npm behind a registry-only proxy; a provenance-bound
  approval; file verification before every launch; Verify files, Check for
  update, Update and Reinstall; reconciliation of install folders; `npx` import
  entries offered as package proposals; and the web UI for all of it (PR #3 back
  end, PR #4 UI).

## Not implemented

- No real-account Linear OAuth consent verification yet. Protocol/DCR/PKCE, denial,
  timeout and refresh are exercised with a disposable local provider, not a user account.
- Docker keychain has no documented plaintext read. Docker secret references can
  materialize into image snapshots, but direct secret-backed image checks remain
  unavailable pending a verified gateway execution/cleanup adapter.
- The P7 bridge supports Windows-secret-backed remote connectors without copying
  credentials into agent files or Docker profile headers. Live remote-provider/agent
  compatibility remains unverified; Docker profile materialization is unchanged.
- The process runner deliberately rejects
  `.cmd`/`.bat` shims until a dedicated safe adapter is verified. npm packages go
  through the managed install instead (D024); Python packages (`uvx`, F01b) do not
  have one yet.
- The F01 live acceptance smoke (install `@modelcontextprotocol/server-filesystem`
  from the real registry, approve it and run it from an agent) has not been run,
  and the planned `scripts/smoke-packages.mjs` does not exist yet. Automated tests
  use a loopback fixture registry.
- No secret-backed import save or adoption apply. P4 normalization stays data-only;
  P5 no-secret saving is a distinct registry operation, not runtime approval.
- P3 adoption preview remains metadata-only, not an approved executable definition
  or a claim of complete source/profile equivalence. It is not silently fed into P4.
- Native/wrapper version metadata may be unknown. P7 documents current Kilo/Kimi
  user scopes; Grok and effective project/account/plugin precedence remain unverified.
- No distributed transaction or automated repair across Docker/files/agent/secret
  stores. P5 tests compensate known Docker/file states only; uncertainty blocks.
- No verified live Docker image MCP execution or real Chrome launch. Synthetic
  protocol peers and ownership/cleanup fault tests do not claim provider compatibility.
- Generated native sessions are bounded to 120 seconds/1 MiB, not unlimited persistent
  gateways. Shell/shim recipes and real installed-agent reconnect remain unverified.
- No automatic job replay/resumption, recovery override, or guided stale-lock/backup
  restore interface. Ambiguous changes deliberately stay blocked for inspection.
- No MCP usage metrics. Per-project/per-agent/CLI traffic accounting is recorded
  as follow-on R2 work in specification section 11.1 and the implementation backlog.
- No real agent registration, Desktop shortcut installation or startup entry has
  been performed. Real Edge App Mode window launch remains a manual gate.
- No migration of the existing pilot.

## Work packages

| Package                                 | Status                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| P0 specification/design/planning        | Complete                                                                                      |
| P1 foundation/contracts/test harness    | Verified                                                                                      |
| P2 local security/persistence/jobs      | In progress — local-only subset verified                                                      |
| P3 read-only discovery/adoption preview | Verified read-only baseline; explicit version/config scope gaps remain                        |
| P4 safe import/normalization            | Verified data-only normalization; P5 adds separate no-secret registry saves                   |
| P5 connector/profile/runtime lifecycle  | Verified enabled no-secret subset; live image execution remains unverified                    |
| P6 secrets/supported authentication     | Implemented and verified enabled subset; real-account OAuth consent exit gate remains pending |
| P7 agent adapters/synchronization       | Implemented; disposable nine-scope and independent DPAPI bridge verified; real agents pending |
| P8 functional frontend                  | Scanner/manual-MCP workflows implemented; full release UI gate remains pending                |
| P9 Windows startup/recovery             | Portable folder/launchers implemented; real Edge/shortcut manual gates remain pending         |
| P10 final validation/rollout            | Not started                                                                                   |
| F01 managed npm packages                | Merged (PR #3, #4); automated gates verified; live registry smoke pending                     |

## Existing pilot — separate from this project's completion

OpenCode and Codex already use the previous pilot at
`E:\Dev\Tools_and_Utilities\mcp-hub`. SSH and Chrome tool discovery passed there;
no SSH operation/browser navigation was performed by those checks.

Postora authentication remains unresolved. The other six CLIs were not changed
by the pilot. This implementation does not change those facts.

## Next release gates

Verify each installed agent's effective scope, trust/reconnect and MCP tool discovery
only with explicit configuration-change consent. Exercise real Edge App Mode and the
shortcut installer. Retain live-account OAuth, second-login DPAPI and live Docker
image cleanup gates. No pilot adoption apply or automated recovery is enabled;
project/agent usage metrics stay R2. Changes land through reviewed GitHub pull
requests; nothing is deployed.

## F01 verification evidence (2026-10-30)

- PR #3 (T1–T8, back end) and PR #4 (T9, web UI) were squash-merged only after
  `main`'s required checks passed: Windows typecheck/lint/test/build, CodeQL,
  gitleaks over the full history, dependency audit and dependency review. Every
  review thread was resolved first.
- Before each PR #4 push, all 13 local gates passed: audit, format, typecheck,
  lint, boundaries, secrets, bundle, test, build, three Windows gates and e2e.
  Local gitleaks found no leaks. The final run had 688 unit tests and 24
  Playwright tests.
- `npm run check:npm-bundle` proves the vendored npm tarball holds exactly the
  official npm 12.2.1 files, with the bundled `undici` and `ip-address` replaced
  by the official `undici@6.29.1` and `ip-address@10.7.4`;
  `npm audit --audit-level=moderate` passes without exceptions.
- Not yet exercised: the live registry smoke above. The residual risks are listed
  in D024.

## P7–P9 scope and verification evidence (2026-10-28–29)

- Final enabled-subset verification: `npm run check` passes **309 tests across
  35 files**, typecheck/lint/boundary/credential gates, production build and both
  original compiled Windows smokes. Separate `test:windows-integrations` passes.
  The complete separate `npm run test:e2e` passes **22/22 Playwright tests**.
- Final portable folder:
  `desktop-builds/Waleed-MCP-Hub-2026-10-28T20-59-12-601Z-540576cd/`.
  Its isolated bundled-runtime/session/UI/graceful-shutdown verification passes
  on the first attempt for this final build, within the unchanged readiness bound.
  Start its `scripts/start-desktop.bat`; no real window/shortcut is claimed verified.

- The integration contract has nine requested targets, separate from P3's eight
  legacy discovery observations. VS Code uses current user `mcp.json` / `servers`,
  not legacy `settings.json`. Kimi uses `.kimi-code/mcp.json` / `KIMI_CODE_HOME`;
  Kilo uses `.config/kilo/kilo.json` / `mcp`. Ambiguous layers and custom
  `CLAUDE_CONFIG_DIR` fail closed; legacy Kimi is not edited.
- Integration means owned configuration read-back, not agent connection/authentication.
  One `waleed-mcp-hub` launcher dynamically reads approved definitions. Sync checks
  ownership without rewriting unchanged files; reconnect/trust may still be needed.
- Manual save uses P6 one-way storage. A partial credential/approval/sync failure
  returns `partially_saved` and its saved connector ID, never a retry-as-new prompt.
- Compiled `test:windows-integrations` passes nine disposable file scopes, private
  backups/read-back/disconnect and an independent DPAPI-backed native MCP bridge:
  zero tool calls during listing, one explicit synthetic call, environment isolation
  and rejection after disabling. No real config/pilot was changed.
- Focused scanner/manual-auto-sync and desktop reopen/fresh-fragment/shutdown browser
  tests pass. Scanner screenshots at 1440/1024/768/390 and manual-save mobile state
  were inspected; no horizontal overflow or retained synthetic private values.
- Repeated backup-DACL persistence initially requested `SeSecurityPrivilege` via
  `Set-Acl`. DACL-only .NET persistence fixed it without elevation or machine changes.
- Packaging initially duplicated nested dependencies and misresolved the SDK's
  wildcard package manifest. Package copies now exclude nested `node_modules` and
  locate roots by manifest name. An isolated startup then hit the unchanged
  20-second limit; the same package passed on rerun. Cause is unproven, not silently
  classified as dependency failure or fixed by increasing the deadline.
- Portable verification copies outside the workspace and runs bundled Node with an
  empty PATH, authenticates a session, serves UI and checks graceful lock release.
  It does not open a real Edge window, install a shortcut, or verify an installed agent.
- PowerShell parser checks pass for the desktop launcher, shortcut installer and
  private-path helper; parser checks do not claim those user-facing actions ran.
- Review tightened nested cleanup so Docker cleanup and lease disposal still run
  if SDK close fails. Agent-facing cleanup/parser errors are fixed public messages;
  JSON-escaped/prefixed/encoded credential echoes and partial-save input clearing
  have regression coverage. Request cancellation is passed to SDK list/call requests.
- Startup adapter-construction failures now share lock cleanup; failed IPC startup
  disconnects instead of waiting indefinitely. The desktop port-conflict browser
  test proves lock release, nonzero exit and survival of the unrelated port owner.
- An intermediate full browser run passed 21/22 and exposed an obsolete foundation
  assertion expecting eight pending adapters. It now asserts the Windows scanner's
  unscanned state and zero automatically scanned rows. The full rerun passes with
  original deadlines and no skips added on Windows.
- An intermediate credential scan correctly flagged a token-shaped synthetic
  browser fixture. It now uses a visibly synthetic spaced value; generated
  `desktop-builds/` joins other generated-output exclusions. Maintained source and
  fixtures continue through the unchanged credential signatures.
- Bridge supports tools only, at most two simultaneous requests, 256 aggregated
  tools/eight pages per peer, bounded HTTP/native/Docker sessions, secret-echo refusal
  and isolated cleanup diagnostics. Secretless Docker transport exists but live
  image execution/cleanup is unverified; keychain-backed Docker execution and
  resource/prompt forwarding remain unsupported.

## P6 verification evidence (2026-10-28)

- Focused P6 run: 31 passing credential/OAuth/DPAPI/secret-discovery tests, including
  real Windows CurrentUser protection and authenticated real MCP protocol exchanges.
- Subsequent full run: new P6 suites passed, but two existing Windows process tests
  encountered deadline/contention and transient EBUSY cleanup failures. Windows
  fixtures now run in one worker with bounded directory-removal retries; runtime
  deadlines, process-tree assertions and negative gates were not weakened.
- A later combined core/browser run exceeded its shell deadline; the recorded
  browser failures were authentication-fixture and source-server startup timeouts,
  not authentication assertions. Vault initialization is now deferred until explicit
  credential/auth preflight, and browser teardown reaps only its exact owned fork
  if graceful shutdown cannot complete. No unrelated process was killed.
- OAuth protection preflight is registered as cancellable job work before provider
  registration. Regression tests prove unavailable storage causes no provider
  registration/grant and dashboard construction creates no vault. One intermediate
  verification was invalidated by editing executable source while it ran; final
  verification uses unchanged source and separate core/browser commands.
- Post-cleanup focused verification exposed a repeatable deadline failure for a
  newly copied Node executable. A standalone launch of the fresh copy took about
  six seconds before the contained host's startup overhead. The Unicode/spaced-path
  fixture now hard-links the same reviewed executable on the same volume (copy
  fallback only for cross-volume placement), avoiding fresh-copy startup overhead.
  The exact path/argv assertions, 8-second runtime deadline and containment gates
  remain unchanged; no antivirus or machine security setting was changed.
- The final unchanged-source `npm run check` passes **289 unit/integration tests
  across 31 files**,
  typecheck, lint, browser/data-only/credential/bundle gates, production build and
  both compiled Windows process-host and protected-secret/native-launcher smokes.
  The separate final `npm run test:e2e` passes **all 19 Playwright tests**, including
  write-only save/reapproval/authenticated discovery, OAuth consent/verification and
  cancellation, empty callback queries, lazy source startup and delayed-refresh
  keyboard focus. The post-cleanup focused process/DPAPI/native-secret/OAuth run
  also passes all 31 tests. Source and changed-document formatting checks pass.
- An intermediate browser run passed 18/19 tests and exposed a real profile-dialog
  focus race: Done was available before inventory refresh re-enabled its opener.
  Completion now waits for refresh, and the browser test explicitly holds that
  refresh to assert premature close is unavailable. The final 19-test run passes
  without deadline changes or skipped assertions.
- Real DPAPI tests cover encrypted round-trip/read-only reopening, scope isolation,
  tampering, immutable IDs, unsafe paths/junctions and selected local deletion.
  A real disposable DPAPI-backed native MCP receives only its declared value,
  initializes/lists capabilities, records boolean evidence and is cleaned up.
- `npm run test:windows-secrets` passes against the compiled modules and copied
  DPAPI helper: real protected credential write, authenticated MCP discovery,
  generated reference-only native launcher, explicit environment isolation, zero
  `tools/call`, and complete owned credential/profile/file cleanup.
- `npm run test:disposable-secret` passes against the real installed Docker
  keychain: fresh synthetic ID, stdin set, metadata presence, scoped removal and
  absence read-back. Zero value-in-argv, plaintext values returned to the hub,
  explicit upstream MCP requests, image
  runs or writes to existing secrets. No existing pilot/profile was modified.
- Initial live metadata failed because Docker invokes its own credential helper by
  name. The adapter now supplies only reviewed Docker-bin/System32 PATH entries,
  never inherited user PATH. An earlier cleanup CLI failure left an uncertain result;
  exact owned-ID metadata rechecks subsequently confirmed absence. Deletion now
  accepts a failed CLI exit only when absence read-back proves the requested result.
- The final compiled Docker smoke recheck twice reported unavailable during
  preflight, before any secret write was attempted. A sanitized read-only diagnostic
  then verified context/version/metadata successfully, and the unchanged smoke
  passed stdin set/presence/scoped-delete/absence on rerun. Runtime deadlines were
  retained; no provider diagnostics, existing names or values were printed.
- Credential saved/auth-required/awaiting consent/verified dialog screenshots were
  inspected; saved credential states cover 1440/1024/768/390 px without overflow.
  Browser tests check empty localStorage, cleared password fields and response bodies
  free of synthetic private values. Fixtures use memory storage, not a real account.
  Refreshed consent/verified/mobile screenshots were inspected after the final run;
  the unrelated credential form stays hidden during active OAuth.
- No real provider sign-in or account authorization has been performed; the Linear
  recipe's metadata is inspected and its full protocol is fixture-verified, but live
  user consent remains an explicit release gate. Postora is not claimed fixed.

## P5 verification evidence (2026-10-28)

- `npm run check` passes: typecheck, lint, source/data-only boundaries, credential
  signature scan, **247 unit/integration tests across 25 files**, production build,
  browser bundle boundaries and compiled Windows process-host smoke.
- **16 Playwright tests** pass, including P5 save/approval/check/membership/apply/
  disable/dematerialize/removal and independent healthy/auth-required flows. P5
  connector screenshots at 1440/1024/768/390 px have no horizontal overflow;
  desktop/mobile connector, auth and applied-profile screenshots were inspected.
- Final post-change `npm run check`, `npm run test:e2e`, `npm run format:check`
  and the changed-document formatting check all pass.
- Real synthetic HTTP, SSE and contained stdio peers negotiate and enumerate tools,
  resources and prompts with zero `tools/call`; tests cover auth/version/redirect/
  pagination/output/cancellation failures and denied private/metadata addresses.
- Fault injection covers observed file/profile drift, post-write errors, registry
  commit failure, exact compensation, foreign-state rollback refusal, journal
  finalization and uncertain owned-container cleanup. Shared credentials are retained.
- Vitest parallelism is capped at two workers: the unbounded SDK-heavy run timed
  out first API tests under contention. Focused and full bounded reruns pass without
  increasing deadlines or skipping gates. A connector-order assertion now selects by ID.
- The first opt-in live disposable-profile run created/read back its Docker snapshot
  and four owned files, and successfully connected two independent generated native
  launchers with exact argv/environment isolation. A later Docker read failed before
  update preview; state was retained rather than repaired blindly. Its owned profile
  and four files were subsequently dematerialized/removed through exact-state lifecycle
  operations; the synthetic evidence directory remains at
  `E:\Dev\Temp\opencode\hub-p5-verify-3dryQq` (no remaining external artifacts).
- The complete `npm run test:disposable-profile` rerun **passes**: real isolated
  Docker snapshot create/read-back/update/removal, four owned files removed, two
  independent native clients, exact Unicode/quotes/metacharacter argv and declared
  environment isolation, **zero tool calls/pulls/upstream requests**, and an unchanged
  existing-pilot fingerprint. Its successful temporary directory was removed.
- No live image was executed/pulled and no upstream provider was contacted by P5
  verification. No pilot, personal agent configuration or credential store was written.

## P1–P4 verification evidence (2026-10-28 historical baseline)

- Node 24.21.0 / npm 11.19.0 on Windows; dependencies in `package-lock.json`.
- Clean `npm ci` and `npm run format:check` pass.
- `npm run check`: typecheck, lint, browser source boundaries, credential signature
  scan, 187 passing unit/integration tests, production build and bundle boundaries.
- The 12 Windows runner tests cover exact arguments, spaces/Unicode executable
  paths, explicit environment isolation, bounded stdin separated from control,
  malformed/unsupported launches, output flooding, concurrency, timeout/cancellation,
  normal-root descendant cleanup, and host-crash cleanup. Only synthetic test
  programs and an unrelated test-owned sentinel process are launched.
- `npm run test:windows-runtime` also passes against the compiled core and copied
  PowerShell/C# assets (no development/source-resolution condition).
- All 14 Playwright tests pass, covering bootstrap/token removal, protected inventory, real local
  profile preview/apply/persistence, literal markup rendering, dialog focus/escape,
  session reload, source-mode startup/clean shutdown, four responsive widths,
  payload-free refusal persistence/display, and drifted-state restart blocking.
- P3 tests distinguish unsupported configuration layers and malformed TOML tables
  from absent bindings, and preserve healthy observations on Docker lookup errors.
- P3 browser tests exercise explicit discovery, sanitized/non-applicable previews,
  pending versus found agent states, stopped Docker, scan cancellation, and four
  viewport widths. Fixture observations are visibly labelled synthetic.
- P4 adds 91 unit/integration tests for normalization, private draft lifecycle and
  authenticated APIs. They cover sorted/deterministic projection, exact case-sensitive
  arguments, malformed/null/oversized/deep/duplicate-key inputs, ambiguous shapes,
  visible unsupported fields, references (not values), URL credential rejection and
  indirect metadata leaks, inline program rejection, package pinning warnings,
  partial-buffer zeroing, bounded retention, expiry and revision/conflict decisions.
- Seven P4 browser tests cover paste/HTTPS/native input, multi-entry deselection and
  renaming, inert markup, secret-input clearing, reference-only export, keyboard
  focus/Escape, stale previews, explicit failed-discard retry and browser expiry.
  Import reviews were checked at 1440/1024/768/390 px with no horizontal overflow.
- A dedicated AST boundary gate restricts the import module to reviewed data-only
  dependencies and rejects filesystem/process/network imports and effectful globals.
  API tests also confirm zero registry writes, no import jobs or generic apply path,
  payload-free refusal records, owner isolation and no original source in responses.
- `npm run discovery:read-only` passed on the actual Windows installation. All
  eight target CLIs were present; five package-manifest versions were observed.
  OpenCode/Codex saved pilot pointers matched. Docker CLI/engine 29.9.2 and MCP
  gateway 0.44.2 were read; three adoption candidates were observed. Source/profile
  metadata drift was flagged, not repaired. All 15 observed file contents and the
  retrieved pilot snapshot matched their verification re-read fingerprints.
- Recovery fault injection covers failed preparation (zero registry writes),
  pre-commit failure, post-commit errors, failed journal finalization, exact-hash
  restart classification, and uncertain state without rollback/duplicate creation.
- Refusal audit tests cover ownership locks, strict metadata validation, queue and
  retention limits, corruption/oversize, junction rejection, external drift, and
  explicit audit-storage failure. Diagnostic tests cover registered secrets and
  variants/fragments, credential fields, auth headers, URLs, keys, and exception text.
- Desktop/mobile screenshots inspected against `DESIGN.md`; ignored artifacts in
  `test-results/`, including Activity, recovery, discovery/adoption preview, agent
  observations, degraded-Docker, and sanitized import review/error/conflict screenshots. This
  verifies the enabled shell paths, not the full P8 release gate.
- Dependency install audit reported zero known vulnerabilities. Credential scanning
  is signature-based, not a guarantee against every possible leak.
- Normal automated tests use synthetic state and dedicated temporary directories;
  no real Docker/personal-agent inventory is read by CI. The separate explicitly run
  live discovery check issues only documented local Docker read queries and bounded
  selected-file reads. No personal config/profile writes, secret-store reads,
  provider requests, startup entry, connector/agent startup, or migration occurred.
- P4 verification used synthetic import fixtures only; it did not re-read or import
  the real pilot, run live dependency discovery, or contact upstream endpoints.
- One intermediate full run encountered an existing Windows process-test temporary
  directory cleanup lock (`EBUSY`); the final full rerun passed without changes to
  the runner or weakening its tests.
- Default Windows browser opening and manual Ctrl+C need a manual smoke check;
  automated startup/shutdown tests use private IPC and Playwright.
