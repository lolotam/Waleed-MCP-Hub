# Waleed MCP Hub — Actual Project Status

Updated: 2026-10-30

## Completed in this project

- Task 20: final native launcher and portable distribution verification.
  `node scripts/build-launcher.mjs` rebuilt root `WaleedMcpHub.exe` (16,896 bytes,
  2026-10-30 01:34:21 UTC); its tray self-test exited 0 with exactly
  `wmh-tray-v1:Open Waleed MCP Hub|Check Health|Exit`.
  Root executable SHA-256:
  `09B20A82CA08225BF411618519FFC37BD9089B782902BBE010A476C06D015DA4`.
  The old running desktop was closed through its Settings shutdown control before
  replacement, without force-killing it or changing startup registration. It was
  not automatically restarted.
  Final portable folder:
  `desktop-builds/Waleed-MCP-Hub-2026-10-30T01-58-57-852Z-12be17d4/`.
  Its `desktop-integrity.json` covers 7,841 files; inventory SHA-256:
  `A7D1B3E19EF34482A096802F46F82E38E09E0126F2855205F3260CBFDF4E6E8C`.
  `node scripts/verify-desktop-package.mjs <that-folder>` passes full inventory/
  byte/hash checks before and after disposable copying, launcher/source manifest
  checks, bundled Node/compiled JobObject tree cancellation and timeout with an
  unrelated process surviving, unauthenticated refusal/authenticated bootstrap,
  UI serving, tray self-test, read-only startup status and graceful lock release.
  No personal agent configuration, pilot, shortcut or startup setting was changed.
  Generated executables, identity manifests and portable folders remain ignored
  artifacts; maintained source, tests and evidence are committed instead.
  The approved OpenCode helpers now take explicit session/prompt-file/CLI inputs;
  synthetic boundary checks passed without contacting a live session. Inspection
  defaults to metadata and requires an explicit content opt-in. Four new inventory
  regression cases reject modified, extra, missing and linked portable artifacts.
  The initial full browser gate passed 65/66: a speculative TCP connection and
  keep-alive connection becoming idle during drain could retain writer locks
  beyond the unchanged five-second desktop assertion. A real-socket reproduction
  confirmed the delay. Shutdown now drops only pre-request connections and reaps
  newly idle connections after response completion; active requests still drain.
  The regression verifies both prompt closure and completion of an accepted
  response. The unchanged desktop browser test then passed three consecutive runs.
  This final portable folder was rebuilt and reverified with that fix.
  The post-fix `npm run check` passes 1,039 tests across 86 files, typecheck/lint,
  browser/data-only boundaries, credential scan, production build and compiled
  Windows process/DPAPI smokes. `npm run format:check` and `git diff --check` pass.
  Vite retains its non-blocking advisory for the 503.82 kB main browser chunk;
  the bundle gate passes.
  These checks are not code signing, live Edge/shortcut verification, real-account
  provider/agent certification, deployment or native macOS/Linux release verification.

- Task 19: macOS/Linux readiness interfaces and adapters. The lazy platform
  credential factory selects DPAPI/Keychain/libsecret, uses distinct persisted
  references, and refuses inaccessible keyrings without a plaintext/ephemeral
  fallback. Keychain/libsecret commands use scoped IDs and stdin values, bounded
  buffers, write/delete verification and metadata-only diagnostics. The existing
  Windows DPAPI scope/entropy/ciphertext implementation is unchanged. Platform
  runtime/config/cache roots and all 17 agent targets are resolved with native
  path semantics; Windows locations remain compatible. ProcessRunner now has a
  platform factory: Windows still uses ProcessHost/JobObject; POSIX uses detached
  process-group cleanup with negative-pid termination. Settings exposes selected
  storage, probe health and the containment distinction. Native macOS/Linux
  verification and release packaging remain pending; POSIX installers and OAuth
  rotation are not enabled by readiness abstractions.
  Verified with `npm run check`: 1,034 tests across 85 files, build/boundary/secret
  checks, and compiled Windows process/DPAPI smokes. `npm run test:e2e`: 66 passed,
  including 1440px/390px storage diagnostics for all three selected backends.
  The separate 17-scope Windows integration/private-backup/DPAPI bridge smoke and
  `git diff --check` pass. Keychain/libsecret/process-group tests simulate OS
  responses; the byte-for-byte existing-vault DPAPI test runs natively on Windows.

- Task 18: Bearer-authenticated loopback `/mcp` with SDK Streamable HTTP sessions,
  POST/GET SSE/DELETE, per-request token/session ownership checks, and the existing
  bridge for tools/resources/prompts, policy, profiles/search and logs. Token profiles
  narrow live agent scope. Private atomic `http-tokens.json` stores SHA-256 hashes
  and metadata only; browser APIs retain session/Origin/CSRF. Settings provides
  one-time token/config copy, optional expiry, masked listing and revocation.
  Sessions are bounded (64 total/8 per token), close on expiry/revoke/shutdown, and
  suppress pending results. A failed revocation write remains denied in-process but
  requires a successful retry for durable revocation. No tool effects are undone.
  Verification: `npm run check` passes 1,002 tests across 80 files plus compiled
  Windows process/DPAPI smokes; `npm run test:e2e` passes 63 tests, including
  1440px/390px HTTP settings and a live SDK client. The stale-window tool-search
  browser test uses a click rather than check(): refusal can roll back the
  controlled checkbox before Playwright's checked-state assertion. Its refusal,
  disabled-state and final persisted-state checks remain intact.

- Task 17: 17 Windows configuration targets, adding Windsurf/Cline/Roo Code/Zed/
  Gemini CLI/Goose/JetBrains AI/Warp; 24-row contract bounds and all-agent profile/
  search/log identities. Scoped JSONC and bounded YAML range edits retain unrelated
  settings; path+content fingerprints refuse stale relocations. Responsive agent
  cards, per-client scope/reconnect guidance, all-eight API/bridge/policy tests and
  expanded disposable protected-file smoke. Actual client connections remain
  client-controlled, not inferred from configuration. JetBrains is an existing
  shared-JSON compatibility scope; Goose protected adoption remains unsupported.

- Task 16: four-step inline first-run tour, explicit scan/integration/MCP entry
  points, persisted revision-checked completion/skip/reset with legacy preference
  migration, and Settings rerun. Searchable local help drawer derives categorized
  topics from the shipped guides and safely renders Markdown without HTML/script
  execution or arbitrary file endpoints. Existing guide inaccuracies were updated;
  Security & Privacy, exit-code and re-auth guidance added. Responsive keyboard,
  preference persistence/CAS, source-integrity and malicious-link coverage included.

- Task 15: strict bounded setup bundles, secret-placeholder export, known-credential
  echo refusal, owner-scoped expiring import review, skip/overwrite semantics and
  DPAPI credential entry with read-back, journaled rollback and exact state checks.
  Responsive Settings download/upload/drop/review/apply UI, real atomic-state/DPAPI
  confidentiality and rollback/API/browser coverage. Unreadable protected backends
  fail export; Docker credential conversion is deliberately unsupported rather than
  weakening the reference-only gateway. Credential-free Docker definitions transfer.

- Task 14: bounded Hub tool overrides, revision-checked/journaled saves/resets,
  agent aliases/custom descriptions/merged annotations and search ranking across
  alias/original/custom text. Original tool identity still drives scope, Ask/Block,
  credentials, containment and metadata-only logs. Runtime collision/tombstone
  guards and metadata rechecks prevent stale or retargeted alias dispatch. Responsive
  Customize/reset UI, live HTTP MCP and real DPAPI/JobObject alias coverage included.

- Task 13: health/auth metadata evaluation, discovery-only on-demand and opt-in
  periodic checks, live Needs Re-auth badges/actions and revision-checked lifecycle
  preferences. Strict own-launcher HKCU Run registration, fixed tray commands and
  background/no-window desktop startup reuse graceful shutdown. Compiled launcher
  tests exercise NotifyIcon/menu construction and disposable HKCU mutations; the
  real HKCU Run query is read-only. Real Edge window/tray interaction across Windows
  shells remains a manual compatibility check, not a claim from synthetic tests.

- Task 12: managed resources/list, resources/read, resources/templates/list,
  prompts/list and prompts/get with strict per-agent scope, opaque resource and
  template handles, collision-safe prompt names and embedded-resource routing.
  Startup/queue/result revalidation, decoded binary credential-echo refusal and
  fixed provider-error suppression preserve existing execution boundaries.
  Scoped list-change notifications invalidate catalogs; subscriptions are disabled.

- Task 11: confirmed Playground with schema review, stale-review checks, the
  shared managed execution/DPAPI/JobObject boundary, and temporary owner-scoped
  redacted output. Strict metadata-only 500-record ring and bounded local IPC
  aggregate agent calls into a responsive live request table. Observational logs
  are memory-only, not a tamper-proof audit; unavailable collection is explicit.

- Task 10: optional per-agent tool-search mode, lean two-meta-tool catalogs,
  bounded ranked discovery and schema-bearing results, and secured meta-call
  dispatch. Revision-safe toggle/status UI and real production bridge coverage
  verify DPAPI injection, lazy startup and JobObject process-tree cleanup.

- Task 9: per-agent profile/tool-set assignments with strict bounded contracts,
  journaled revision-safe writes, scoped catalogs/calls and session invalidation.
  Unassigned agents retain all enabled approved connectors; assigned empty/disabled
  profiles fail closed. Agents UI selectors/counts, stale-window recovery and real
  argv-target bridge notification coverage are included. Mappings survive disconnect.

- Task 8: journaled, revision-checked per-tool Allow / Ask / Block settings;
  blocked catalog omission and stale-call denial, one-call MCP form confirmation,
  post-confirmation/dispatch revalidation, and responsive Tools & Permissions UI.
  Unsupported elicitation clients fail closed; a Hub-window approval queue is not
  implemented. Unchanged runtime approvals/discovery remain valid after policy saves.

- Task 7: bounded, inert `.mcpb` review and installation, typed configuration forms,
  DPAPI-only environment values, journaled rollback/recovery, bundle integrity
  receipts, separately approved contained execution and persistent bridge support.
  Supports the documented strict Windows manifest subset; no package/runtime
  download, setup hooks, platform overrides or sensitive command-line arguments.

## Foundation checkpoint (historical)

The P1–P9 notes below describe the original baseline. Tasks 1–19 above and the
dated task evidence below supersede its original limitations (including import
apply, persistent sessions, resources/prompts and the original nine-agent scope).

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

## Remaining release limitations

- No real-account Linear OAuth consent verification yet. Protocol/DCR/PKCE, denial,
  timeout and refresh are exercised with a disposable local provider, not a user account.
- Docker keychain has no documented plaintext read. Docker secret references can
  materialize into image snapshots, but direct secret-backed image checks remain
  unavailable pending a verified gateway execution/cleanup adapter.
- The P7 bridge supports Windows-secret-backed remote connectors without copying
  credentials into agent files or Docker profile headers. Live remote-provider/agent
  compatibility remains unverified; Docker profile materialization is unchanged.
- The process runner deliberately rejects
  `.cmd`/`.bat` shims until a dedicated safe adapter is verified.
- Protected agent import/apply is implemented in Task 5. Legacy Docker-pilot
  adoption remains separate and disabled; import never grants runtime approval.
- P3 adoption preview remains metadata-only, not an approved executable definition
  or a claim of complete source/profile equivalence. It is not silently fed into P4.
- Native/wrapper version metadata may be unknown. P7 documents current Kilo/Kimi
  user scopes; Grok and effective project/account/plugin precedence remain unverified.
- No distributed transaction or automated repair across Docker/files/agent/secret
  stores. P5 tests compensate known Docker/file states only; uncertainty blocks.
- No verified live Docker image MCP execution or real Chrome launch. Synthetic
  protocol peers and ownership/cleanup fault tests do not claim provider compatibility.
- Direct materialized native sessions keep their 120-second/1 MiB bounds. Task 2
  managed peers use bounded persistent sessions, not unlimited gateways.
  Shell/shim recipes and real installed-agent reconnect remain unverified.
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
| P2 local security/persistence/jobs      | Enabled local-only subset verified                                                            |
| P3 read-only discovery/adoption preview | Verified read-only baseline; explicit version/config scope gaps remain                        |
| P4 safe import/normalization            | Verified data-only normalization; P5 adds separate no-secret registry saves                   |
| P5 connector/profile/runtime lifecycle  | Verified enabled no-secret subset; live image execution remains unverified                    |
| P6 secrets/supported authentication     | Implemented and verified enabled subset; real-account OAuth consent exit gate remains pending |
| P7 agent adapters/synchronization       | Implemented; disposable 17-scope and independent DPAPI bridge verified; real agents pending   |
| P8 functional frontend                  | Scanner/manual-MCP workflows implemented; full release UI gate remains pending                |
| P9 Windows startup/recovery             | Portable folder/launchers implemented; real Edge/shortcut manual gates remain pending         |
| P10 final validation/rollout            | Task 20 automated build/package gates; manual rollout limits remain                           |

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
project/agent usage metrics stay R2. Source is maintained in Git; automated local
release verification does not imply deployment or live-account certification.

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

- The integration contract now has seventeen targets (nine from P7 plus eight in
  Task 17), separate from P3's eight
  legacy discovery observations. VS Code uses current user `mcp.json` / `servers`,
  not legacy `settings.json`. Kimi uses `.kimi-code/mcp.json` / `KIMI_CODE_HOME`;
  Kilo uses `.config/kilo/kilo.json` / `mcp`. Ambiguous layers and custom
  `CLAUDE_CONFIG_DIR` fail closed; legacy Kimi is not edited.
- Integration means owned configuration read-back, not agent connection/authentication.
  One `waleed-mcp-hub` launcher dynamically reads approved definitions. Sync checks
  ownership without rewriting unchanged files; reconnect/trust may still be needed.
- Manual save uses P6 one-way storage. A partial credential/approval/sync failure
  returns `partially_saved` and its saved connector ID, never a retry-as-new prompt.
- Compiled `test:windows-integrations` now passes seventeen disposable file scopes, private
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
- At this historical checkpoint the bridge supported tools only, at most two simultaneous requests, 256 aggregated
  tools/eight pages per peer, bounded HTTP/native/Docker sessions, secret-echo refusal
  and isolated cleanup diagnostics. Secretless Docker transport exists but live
  image execution/cleanup was unverified; resource/prompt forwarding was unsupported
  until Task 12 above.
  The subsequent Task 1 work below adds a reference-only keychain-backed bridge path.

## Task 1 — Docker-secret-backed bridge (2026-10-29)

- Docker binding resolution validates generated IDs, ownership, presence, adapter,
  environment names and actual secret metadata without introducing a plaintext-read
  seam. Header bindings, OAuth bundles and literal/credential overrides fail closed.
- The bridge skips Windows credential initialization for Docker peers and delegates
  reference resolution to Docker Gateway 0.44.2. Each peer uses an owned temporary
  catalog containing exactly one approved image, with dynamic management disabled,
  tool-call logging disabled and gateway secret filtering enabled. No existing
  profile, agent config, registry definition or credential is rewritten.
- Cleanup selects only the per-launch gateway server nonce, verifies Docker's exact
  labels on immutable container IDs and checks absence. Changed catalog files and
  uncertain cleanup are preserved for recovery. Port-published secret-backed images
  and gateway-interpreted templates/variables remain refused.
- Synthetic tests cover the seven SSH connector names exposing 77 tools, discovery
  without tool invocation, explicit forwarding/revocation, reference-only artifacts,
  missing/foreign/unsafe secrets, cancellation, drift and scoped cleanup. These do
  not claim live Docker-image or remote-account verification. The seven local SSH
  definitions observed during this task are native launchers; they are not migrated.
- Direct keychain-backed **Test capabilities** remains a separate adapter limitation.
- A real opt-in `test:disposable-docker-bridge` smoke passes against the compiled
  bridge: a pinned cached Node image receives a fresh synthetic Docker secret,
  exposes one tool and accepts an explicit call after discovery/reconnect. Scoped
  container/file cleanup and secret absence are checked; no image pull, personal
  connector migration, existing-secret change or remote SSH request is performed.
- This smoke exposed a Windows environment snapshot bug: `ProgramFiles` and
  `ProgramData` were lost by case-sensitive lookup after converting `process.env`
  to a plain object. The Docker command adapter now handles allowlisted keys
  case-insensitively, with regression coverage. SDK smoke clients explicitly pass
  the reviewed OS allowlist because SDK defaults omit `ProgramData`.
- Final `npm run check` passes: **327 tests across 36 files**, typecheck, lint,
  browser/data-only boundaries, credential scan, production build/bundle checks
  and compiled Windows process-host and DPAPI/native-launcher smokes. Changed
  executable-source formatting and `git diff --check` also pass.

## Task 2 — Persistent connector sessions (2026-10-29)

- A bridge-scoped peer pool reuses native, HTTP/SSE and Docker connections across
  discovery and sequential calls. Connector operations are serialized; separate
  bridge/MCP sessions never share peers or credential leases. Defaults are 32 peers,
  five-minute idle expiry and a one-hour hard lifetime, with earlier OAuth expiry.
- Approval, definition and declared credential metadata are revalidated after
  startup/queueing, before each operation. Registry and safety-ledger changes retire
  stale peers without waiting for another call. Cancellations, transport/protocol
  failures and secret echoes retire uncertain sessions; calls are never replayed.
- Native bridge processes opt into a bounded duplex session mode without extending
  ordinary command deadlines. Graceful stdin EOF precedes owned-job cancellation;
  the Windows host still reaps descendants after root exit. Stream output is no
  longer retained a second time, and transient duplex buffers are zeroed. Legacy
  native profile launchers explicitly copy asynchronous output before it is zeroed.
- Secret-backed Docker gateways use long-lived server mode and permit multiple
  active owned peers in the same bridge. Foreign/stale Docker artifacts still fail
  closed; cleanup never adopts or deletes another bridge's artifacts. Uncertain
  cleanup retains evidence. Force-killing a bridge is not a guarantee that the Docker
  daemon has removed its containers; inspect retained recovery markers in that case.
- Streamable HTTP teardown sends session DELETE before closing transport. One-shot
  checks and direct materialized native profile launchers keep their existing bounds.
- Regression tests cover state preservation, isolation, idle/lifetime expiry, queued
  calls, cancellation, revocation, provider/credential error sanitization, startup
  during shutdown and cache bounds. Real local fixtures verify HTTP session reuse
  and DELETE, native graceful EOF plus complete descendant cleanup, and state retained
  across two calls through the compiled Docker-secret-backed bridge. These fixtures
  use synthetic credentials/programs, not personal SSH sessions or browser sign-ins.
- Final unchanged-source verification passes **353 tests across 39 files**,
  typecheck, lint, browser/data-only boundaries, credential scan, production build
  and both compiled Windows runtime/DPAPI smokes (`npm run check`). The separate
  compiled Docker-secret smoke also passes retained state across two calls and
  owned cleanup. Changed-source formatting and `git diff --check` pass.

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
