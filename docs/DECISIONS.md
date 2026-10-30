# Waleed MCP Hub — Decision Log

Date: 2026-10-28

## D001 — Build a local application, not a standalone HTML file

Accepted planning baseline. HTML handles the interface; a local same-user backend
handles Docker, secret storage, supported OAuth, jobs, agent configs, and startup.
A plain `file://` page cannot safely provide those capabilities alone.

## D002 — Extend and explicitly adopt the existing pilot

Accepted. Existing pilot files remain at
`E:\Dev\Tools_and_Utilities\mcp-hub`. No silent move/delete/migration occurs.
Read-only discovery and an adoption preview precede changes.

## D003 — Keep source in the new project folder

Accepted. All maintained specification, plans, source, tests, and launch scripts
belong in `E:\Dev\Projects\Waleed-MCP-Hub`.
Docker-required catalogs/databases, OS secret stores, and agent configurations
remain external operational state with explicit adapters and ownership.

## D004 — Preserve native stateful-tool exceptions

Accepted. Native Chrome launchers use isolated per-client sessions. Do not force
Windows browser tools into Docker or claim one shared browser session is safe.
The UI exposes the execution mode and resulting agent-update requirements.

## D005 — Proposed implementation stack

Proposed baseline: Node 24 LTS, TypeScript, npm workspaces, Fastify, React/Vite,
shared runtime schemas, and an official MCP client SDK where appropriate.
Use versioned JSON persistence for R1 behind a persistence seam; no hosted database.
Exact dependency versions and a lockfile are selected during implementation.

## D006 — Local security is a prerequisite

Accepted. Exact loopback Host/Origin policy, authenticated local session, CSRF
protection, write-only secret UI, and explicit command/image execution approval
must exist before real credentials and configuration writes are enabled.

## D007 — Separate configuration, health, and authentication

Accepted. Executable installed, configuration saved, gateway connected, upstream
discovery passed, and a real tool operation verified are different facts.
Never use one green badge to imply all of them.

## D008 — Start at Windows sign-in only when enabled

Accepted. Offer optional current-user startup. Do not register a SYSTEM service,
request admin automatically, or change sign-in behavior during planning/first run.

## D009 — Light utility design

Recommended planning lock: professional light list/detail interface, teal actions,
semantic status labels, restrained surfaces, and Available-to agent strips.
Evidence and scope are documented in `DESIGN.md`. Live Refero tools were unavailable;
bundled references were used, not fabricated live style research.

## D010 — Eight-agent support requires eight verified adapters

Accepted. OpenCode/Codex are the current pilot integrations. Other agents must pass
version-specific discovery, config-preservation, apply, and runtime checks before
being labelled supported. A manual recipe is not a successful automatic adapter.

## D011 — Foundation implementation boundary (2026-10-28)

P1 is implemented directly in the project folder. No Git repository was
initialized and no commit is claimed. Dependencies are exact-pinned and locked.
Windows verification uses installed Node 24.21.0 / npm 11.19.0, TypeScript 5.9.3
(within typescript-eslint's supported range), React 19.3.1, Vite 8.3.5,
Fastify 5.12.7, Zod 4.6.7, Vitest 5.0.5, and Playwright 1.64.1.
The MCP client SDK is deferred until protocol discovery is implemented.

Only empty **local** profiles can be created. They are not Docker profiles or
agent assignments. This real operation exercises preview/revision/apply/jobs and
persistence without external effects. Execution, credentials, import, discovery,
startup, and adoption remain disabled until their safety gates pass.

Development builds and serves the UI at production's exact origin. There is no
permissive proxy/CORS exception, HMR, or automatic backend restart while a state
writer may be active. Restart development manually.

Tokens, previews, and jobs are memory-only. Local writes use atomic replacement;
there is no distributed-effect journal yet. A crash leaves a conservative lock
for manual inspection instead of unsafe PID-based lock theft. Initial persistence
is schema version 1; unknown versions fail rather than being silently migrated.
The full P2 gate is **not complete**. Do not enter real secrets into this build.

## D012 — Usage metrics are attributable MCP traffic, not guessed usage (2026-10-28)

The user requested later per-project and per-agent/CLI request metrics. Record
them in R2, without interrupting the safety-first implementation order. CLI product
and agent product are normally the same dimension; instances/subagents require
explicit labels. Project IDs must be attached by client launchers/bindings rather
than assumed to exist in MCP payloads. Count tool calls separately from discovery,
transport traffic, and retries. Only instrumented traffic can be measured; do not
claim coverage for direct/bypassing connections or derive LLM costs from MCP counts.
Store bounded local metadata/aggregates, never tool arguments/results or secrets.
No metrics collector or new traffic proxy is implemented by this decision.

## D013 — Windows process containment before execution (2026-10-28)

The internal process runner uses a fixed PowerShell/.NET host with a reviewed C#
Win32 interop implementation. It creates a non-breakaway Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and attaches the target atomically using
`PROC_THREAD_ATTRIBUTE_JOB_LIST` in `CreateProcessW`. Attachment after ordinary
process start is deliberately avoided: it would leave a race where code could
spawn an unowned child. Only the three intended standard-stream handles are
inherited; the job handle itself is not inherited.

Targets are approved canonical local absolute `.exe` files. Arguments use Windows
CRT quoting, not shell interpolation. `.cmd`/`.bat` shims, relative executables,
UNC paths, and unapproved binaries fail closed. No permissive `cmd /c`, generic
shell fallback, PID scan, or `taskkill` command exists. Script/interpreter trust
approval remains the responsibility of the future revision-bound lifecycle.

Requests and explicitly declared environment values travel to the fixed host over
stdin, never as command-line credentials. The host gets a minimal environment,
not every provider secret in the manager environment. Target stdin is a separate
bounded UTF-8 pipe (EOF when absent), never the host's cancellation/control channel.
Base64-framed output is
bounded in both host and parent; host/compiler exceptions are discarded rather
than returned or logged. Returned target stdout/stderr remain internal, untrusted,
possibly sensitive data: do not expose/persist them without the P2 redaction gate.

The runner bounds elapsed time (including host startup), combined output, and
concurrency. Explicit cancellation, timeout, output flooding, normal root exit,
and host death all reap that invocation's contained descendants. A wedged host is
terminated through its exact child handle; closing its job handle provides cleanup.
This requires a supported Windows Job Object implementation and permitted local
PowerShell/Add-Type capability. Machine policy is not bypassed; unavailable
capabilities produce an error with no uncontained fallback.

The host assets are maintained in the core package and copied into its compiled
output by the build script. No process runner is wired into HTTP routes, no
connector execution is enabled, and the pilot/agent configurations are untouched.
Tests run synthetic programs only. General redaction/refusal auditing and the
external-operation journal still block completion of the overall P2 gate.

## D014 — Payload-free audit and conservative registry recovery (2026-10-28)

P2 now has a separate version-1 `safety.json` ledger and lifetime `safety.lock`.
It uses bounded reads, atomic synced-file replacement, revisioned serial writes,
fingerprint drift checks, a 32-write queue limit, 200 refusal events, and 100
terminal-operation records. Unresolved operations are never evicted. Corrupt,
unsupported, externally changed, oversized, or symlinked safety data fails closed.
The original desired-state schema remains version 1; no P1 registry migration is
required. The safety file does not contain a second copy of the desired registry.

Audit accepts closed reason/route/method/status enums and server-generated IDs/time
only. It records routed HTTP refusals before returning their response. Incoming
paths/query strings, headers/cookies, tokens, session IDs, bodies, names, process
stdin/output, and arbitrary exception messages are not audit fields. Queue or disk
failure returns explicit `audit_unavailable` / HTTP 503, not a false successful
audit claim. Older events are intentionally removed by bounded retention; rejected
writes during storage failure/saturation cannot be claimed as durably recorded.

Public errors use fixed corrective messages even for typed HubError exceptions.
The diagnostic redactor additionally masks registered values/encoded variants,
common prefix/suffix fragments, credential fields, auth headers, private keys,
and URL path/query/userinfo details. Oversized diagnostics are omitted, not cut
through potentially secret-bearing data. This is defense in depth, not permission
to log arbitrary payloads or a guarantee of finding unknown unlabeled credentials.

Local profile operations journal a prepared record BEFORE registry writes. Records
contain only operation/target UUIDs, expected revision, canonical pre/post-state
hashes, phase, fixed reason, and timestamps. On startup, exact pre-state means an
aborted operation; exact post-state means a committed operation. Any other state
is `needs_review` and blocks preview/apply. Recovery NEVER executes a command,
replays an operation, restores a backup, or rewrites desired/agent/Docker/secret
state. If finalization fails after a proven registry commit, the job reports the
save with a warning; it does not encourage a duplicate save.

The Activity page displays structural refusal metadata; the recovery endpoint is
session-protected and read-only. A blocked registry remains readable with a visible
warning and disabled creation controls. There is no generic recovery-override or
filesystem-write endpoint. External Docker/secret/agent partial-apply recovery is
still unimplemented and must be integrated/tested as those adapters arrive.

## D015 — Explicit read-only discovery, never agent startup (2026-10-28)

P3 adds a manually triggered, session/Origin/CSRF-protected discovery job and
sanitized in-memory observations. Server startup and inventory GET requests do not
scan personal configurations or invoke Docker. The POST action accepts only `{}`;
no client-provided executable, argument, environment, or filesystem path is used.
Jobs have owner-scoped reads/cancellation, a 60-second deadline, a five-second
refresh floor, bounded retained jobs, and retain the previous successful snapshot
when cancelled/failed. Dependency failures remain explicit degraded observations.

Only fixed Docker read queries run: CLI version, local context metadata, MCP
version, engine version, profile list, and the selected pilot's JSON snapshot.
Daemon/profile queries require a verified local Windows named-pipe endpoint;
SSH/TCP/remote contexts are not contacted. Only gateway 0.44.2/profile schema v1
is presently accepted. Standard Windows program-directory variables are explicitly
forwarded so Docker can find its plugin; provider/API secrets are not forwarded.
No pull, gateway run, MCP list, capability/tool call, agent startup, install hook,
native launcher, OAuth command, or secret-read command is issued.

Agent presence is resolved from bounded local PATH candidates. Known aliases map
to one of the eight products, not extra agents. Versions come from verified
installed package manifests where available; unsupported native/wrapper versions
remain unknown rather than launching a potentially stateful CLI. Adapter support,
effective configuration, live MCP discovery, and reconnect state remain pending.
OpenCode V2 `mcp.servers` is read as JSONC; Codex TOML respects `CODEX_HOME`.
Known Claude/Cursor/Antigravity user files are observed narrowly. Grok/Kilo/Kimi
configuration scopes and unsupported overrides remain pending instead of guessing
legacy formats. Account/plugin/project layers are not claimed as effective state.

Known-file reads are bounded to 1 MiB, reject relative/UNC paths, credential-cache
basenames and symlink/junction traversals, and never expand `{file:...}` or
`{env:...}` references. MCP fields are projected into closed metadata DTOs; raw
headers, arguments, environment values, OAuth/account fields and source documents
are not returned or persisted. The mixed source inventory is read only through the
pilot's exact expected original source pointer, not arbitrary JSON file pointers.
JSONC/TOML parsers are exact-pinned in the lockfile.

The native Chrome exception is observed separately. A narrow seven-statement
recipe recognizer checks the existing launcher as data; any changed/extra command
becomes unknown. It never evaluates PowerShell or starts npx/Chrome. Its configured
isolation/version pinning is not a claim of live browser behavior or execution
approval. Existing fixed Start-Pilot/Start-Chrome configuration pointers are
recognized without executing their scripts.

Adoption remains a **snapshot-only metadata preview**, bound to the current hub
registry revision, with no apply capability. Known endpoint/image/explicit-command
differences are reported; credential URLs, unmatched conversions, unknown native
recipes, managed-name conflicts, and recovery blocks require review. Comparisons
do not establish authentication or credential equivalence. The desired registry,
pilot, source inventory, secret stores, agent configs, denylist and node_repl are
not rewritten. Full normalization/execution approval belongs to P4/P5/P7.

The explicit `discovery:read-only` verification script hashes observed file contents
before/after and rechecks a retrieved pilot snapshot. It prints only a metadata
summary, not private inventories or raw diagnostics. This proves the checked
contents stayed unchanged; it is not a claim that a third-party CLI has no OS cache
or filesystem side effects anywhere. Normal CI uses clearly labelled synthetic
fixtures and never invokes the real personal-environment scan.

## D016 — Preview-only, owner-scoped safe import drafts (2026-10-28)

P4 adds deterministic normalization and a private import-preview lifecycle, not
connector creation or execution. The module has no filesystem, process, network,
Docker, or secret-store adapter. The existing local-profile apply endpoint cannot
consume an import preview ID. `applySupported` is always false; no import apply
route exists. Safe import does not automatically adopt the discovered pilot.

Supported input is strict JSON: a single server, `mcpServers`, the source's
`servers`, OpenCode V2 `mcp.servers`, or a single Docker `server` wrapper. Docker
definitions support an explicit `image`, optional command/argument arrays and env,
or a `remote` object with url/transport_type/headers. Full Docker profile snapshots,
catalog DSLs, account credentials and arbitrary programs are not treated as server
definitions. JSONC/TOML remain discovery inputs, not pasted-import formats. Duplicate
JSON keys, dangerous prototype keys, mixed wrappers, non-object roots, excessive
depth/size and more than 32 entries are rejected. Map keys and bindings are sorted;
identifiers derive only from non-secret names, never credential hashes. Arguments
are preserved verbatim and are never shell-split or interpolated.

Unsupported root/entry fields produce visible blocking issues rather than silently
disappearing. A partially valid multi-entry input is not implicitly accepted: the
user must explicitly deselect invalid entries. Ambiguous remote/native/image or
transport fields, implicit command strings with shell syntax, known interpreter
inline programs, and credential-bearing endpoint URLs are rejected. HTTPS endpoints
have no userinfo/query/fragment; imports perform no DNS/redirect/network checks.
All endpoints still require destination review before any future execution.

All header and environment values are conservatively private, not just names that
look like tokens. They become internal Buffer values and opaque draft references;
unresolved env/file substitutions are rejected, never expanded or fetched. Explicit
`environmentLiterals` accepts only a short documented non-secret name/value list
(NODE_ENV production/development/test, NO_COLOR=1, Chrome MCP telemetry/update flags=1).
PATH and other arbitrary literals are not approved through this escape hatch.
Known credential repetitions (including rejected URL credentials) in names/descriptions/commands and common credential
argument forms block the entry instead of returning a misleading altered command.
Unknown unlabeled secrets in arbitrary metadata cannot be universally identified;
do not log raw requests or use import as a general-purpose credential scrubber.

The backend retains one private draft per session, at most 20 drafts globally,
48 KiB UTF-8 source per request, at most 256 extracted values per draft, and a fixed
five-minute lifetime. Buffers are zeroed and references dropped on cancellation,
replacement attempts, stale revisions, logout, expiry timer and shutdown. No API
returns private values. JavaScript/HTTP/browser strings are transient and garbage
collected; secure erasure of all runtime/OS memory copies is not claimed. Session
expiry does not extend a draft's short independent deadline.

Draft reads, selection updates and cancellation are owner-scoped and all writes
are session/Origin/CSRF protected. Responses are no-store closed DTOs with references
only. Selection names/IDs are checked against each other and the registry; name
comparison uses trim/NFKC/case folding. Conflicts require rename/new ID or explicit
deselection. Overwrite/merge decisions are deliberately unavailable. Stale registry
revisions destroy the draft; preview selection is never silently rebased.

Operation scope lists selected normalized definitions/modes, future download and
permission risks, and current files/agents/writes/processes/network effects. Current
effects are explicitly none; no runtime paths or agent updates are fabricated.
Package-version warnings recognize only simple pinned npx/uvx invocations, and
Docker tag mutability is flagged unless an explicit digest is supplied. Pinning
does not imply compatibility or trust approval. Script/shim execution stays pending
the verified adapter even when its inert configuration is importable.

The browser clears raw pasted and guided-form values on submit/error/cancel and
unmount, shows only sanitized preview definitions, and never uses browser storage.
Closing/Escape cancels the private draft; failed cancellation is explicit and TTL
remains the backstop. Preview export contains the same sanitized DTO, never source
JSON or credentials. There is no apply path yet to claim an apply-time secret write
or cleanup. That lifecycle must be added and tested alongside P5/P6.

Import draft routes use the `/api/imports` namespace (preview/read/selection/cancel)
to keep this private, non-applicable lifecycle separate from registry mutation
previews. This refines the initially proposed singular preview URL in the spec.

## D017 — Revision-bound lifecycle and owned materialization (2026-10-28)

P5 separates definition save, execution approval, profile materialization and live
capability checks. The P4 normalizer stays data-only; `/api/imports/:id/save-preview`
creates a distinct registry preview for no-secret definitions and discards the
private import draft. Secret-backed saves/execution await P6; disabling, unassigning
or removing never deletes credential values. Approval binds the connector revision
and canonical execution-definition hash. Edits/toggles invalidate it. Profiles are
desired state, not promises of live agent reload. Existing affected bindings become
reconnect-required; P7 still owns actual agent synchronization.

Generated `wmh-*` files live only in configured managed/runtime and Docker catalog
roots; link/junction/hardlink checks and content fingerprints reject observed drift.
Docker IDs hash the profile ID and never target the pilot. Gateway 0.44.2/local
named-pipe context is required. Profile import supplies complete `snapshot.server`
definitions (`server`/`remote`, env name/value arrays, `tools: null`) so metadata
apply cannot implicitly resolve/pull images. Successful writes require read-back.
Preparation is durable before effects; exact known state permits compensating
rollback. Unknown outcomes/foreign changes remain recovery-blocking, never replayed
or overwritten. Startup cannot classify external outcomes from registry hashes.
This is optimistic drift detection, not atomic transactions across Docker/files,
or protection from a malicious same-user filesystem race.

Native manifests preserve executable/argv data; generated entries use the compiled
launcher module and create independent Windows Job Object trees for each client.
Only absolute local `.exe` launches are enabled. Known Chrome MCP forces isolation
and rejects personal attachment flags. Each launcher rechecks registry/approval and
the recovery ledger; changed/disabled/unassigned definitions fail closed. No generic
shell endpoint, shim fallback, provider env inheritance or personal Chrome attach
exists. Current generated sessions are bounded to 120 seconds and 1 MiB; P7 must
surface reconnect behavior rather than imply unlimited persistent sessions.

## D018 — Bounded real MCP discovery, zero tool invocation (2026-10-28)

Exact-pinned official MCP SDK 1.32.2 negotiates protocol versions over restricted
HTTP/SSE or the existing contained stdio runner, extended with bounded duplex
base64 control frames. The SDK's uncontained stdio spawner is not used in production.
Wire methods are allowlisted: initialize/initialized, tools/resources/prompts list,
ping and cancellation only; discovery never calls tools, reads resources or obtains
prompt bodies. Output metadata omits arbitrary server prose/schemas and separates
gateway-management tools. Two concurrent jobs, 20-second deadline, 1-MiB aggregate
output, eight pages and 256 entries/category bound checks. Health is revision/hash
bound and one failure never replaces another connector's successful observation.

Remote checks validate/pin public DNS addresses, use HTTPS with TLS validation,
reject redirects/cross-origin endpoints, and forward no cookies/provider credentials.
Loopback HTTP is available solely through a construction-time exact-origin test
fixture. Secret-backed checks remain blocked. Docker checks use unique client and
connector labels, inspect immutable IDs before exact removal, and retain durable
recovery metadata on uncertain cleanup; never prune unrelated containers.

## D019 — Immutable one-way secrets and CurrentUser protection (2026-10-28)

P6 uses fresh random `wmh-secret-*` IDs for each credential update rather than
overwriting shared values. Only IDs, adapter, owner relationships, kind and last
verified presence are registry data. Binding changes increment the connector
revision, invalidate approval/health and mark affected profiles/bindings stale.
Secret writes are journaled before external effects and share registry mutation
admission. Known successful writes can be compensated when registry commit fails;
ambiguous outcomes remain recovery-blocking. Local deletion requires an unowned
reference, no current bindings and no materialized consumers. It never means
provider revocation; old values survive disable/unassign/remove until explicit deletion.

Docker gateway 0.44.2's inspected help/source documents `mcp secret set <id>` via
stdin, `ls --json` for name/provider metadata and scoped `rm <id>`. Never use
`key=value` argv, `rm --all`, provider credential exports, or invent a plaintext
read method. Image snapshots contain `{name, env}` references only. Direct
secret-backed image checks remain unavailable: P5's contained `docker run` cannot
resolve keychain values through an undocumented interface. Windows-backed remote
profile proxies are a P7 integration task, not plaintext Docker header materialization.

The Windows store protects each immutable blob with DPAPI `CurrentUser` and entropy
bound to a random vault scope plus reference ID. The directory DACL admits the
current SID and SYSTEM only; existing ownership must match. Setting the existing
owner again was rejected without elevated WRITE_OWNER rights, so the implementation
verifies ownership and changes only the DACL—no elevation or execution-policy bypass.
Read-only launchers reuse the scope without creating/writing vault state. Junctions,
hardlinks, unsafe IDs, missing/wrong-scope/tampered ciphertext fail closed; there is
no plaintext fallback. CurrentUser isolation relies on Windows DPAPI's OS contract;
a second Windows login is not fabricated as a tested identity.

Dashboard startup does not create a vault or invoke DPAPI. Initialization is lazy
on an explicit credential/auth action; failed initialization can be retried without
breaking unrelated no-secret workflows. Credential-write preflight runs before
the external-effect journal entry. OAuth storage preflight runs inside the
registered, cancellable job before provider registration or consent; failed storage
cannot cause a provider grant, and job limits/deadlines cover preflight as well.

Internal secret leases use mutable Buffers and clear them on success, failure,
cancellation and disposal. The reviewed PowerShell helper clears its byte arrays.
The contained process host also clears its input/output byte arrays and consumed
protocol buffers. Streamed output retains its lifetime for asynchronous consumers;
it is not prematurely zeroed while a writer may still hold it.
HTTP/JSON/PowerShell/.NET/JavaScript strings and OS pipe copies are transient and
garbage-collected: secure erasure of every immutable/runtime/OS copy is not claimed.
No raw input, stdin, HTTP headers, token responses or provider exception is logged.
Only declared owned references are resolved; dangerous runtime environment and
transport/cookie headers are rejected. Explicit raw/Bearer/Basic formatting avoids
assuming Bearer universally. Credential echoes in public capability metadata fail closed.

## D020 — Curated bounded OAuth, never arbitrary sign-in pages (2026-10-28)

The initial production recipe is **Linear read-only**, matched exactly to
`https://mcp.linear.app/mcp/readonly`, requesting only `read`. Linear's documentation
and `/.well-known/oauth-authorization-server` were inspected: issuer/endpoints,
S256, public (`none`) client authentication, DCR and response `iss` support are pinned.
No generic provider URL, client secret, Claude-account cache or Postora metadata
workaround is accepted. Other endpoints report unsupported OAuth explicitly.

Jobs require current revision/hash approval plus explicit provider/scope/discovery
consent. A random-port IPv4-loopback listener with random callback path, high-entropy
state, S256 PKCE, exact Host/path/origin/issuer, single-use callbacks and duplicate
parameter checks handles consent. Fixed no-store callback HTML strips query data
from browser history with a hash-allowed static script; it never reflects provider data.
Outbound metadata/registration/token requests use public-DNS pinning, TLS validation,
bounded size/time and no redirects. Exact loopback exceptions and flow substitution
exist only in constructed fixtures, never HTTP input or production environment toggles.

At most two jobs run, 50 terminal records are retained in memory, and each job has
a 120-second deadline. Logout/close cancels jobs and listeners. Tokens are stored as
DPAPI-protected bundles; refresh is explicit and recipe-bound. Expired, denied,
cancelled, timeout, stale-definition, failed refresh and unsupported states remain
distinct. A binding is committed only against the captured revision; consent cannot
authorize a changed definition. Successful credential storage is followed by real
MCP discovery before the OAuth job can report success. No `tools/call` occurs.
Cancellation after a grant/save does not silently revoke remote access or erase a
saved credential. Provider revocation is explicitly unsupported until independently
verified; local deletion must never pretend to implement it.

Sources: https://linear.app/docs/mcp and
https://mcp.linear.app/.well-known/oauth-authorization-server ; Docker source at
https://raw.githubusercontent.com/docker/mcp-gateway/v0.44.2/cmd/docker-mcp/commands/secret.go .
Synthetic end-to-end protocol verification is not a claim of real-account consent.

Verification: real CurrentUser DPAPI isolation/tamper tests, authenticated disposable
native discovery, and the compiled protected native launcher smoke pass. The real
Docker stdin/presence/scoped-delete smoke also passes. Docker internally launches
its own credential helper by name, so its environment receives only a fixed PATH
containing the approved Docker binary directory and Windows System32—not inherited
user paths. A failed delete exit is accepted only after exact absence read-back;
remaining/unreadable metadata still fails closed. Initial live failures and cleanup
confirmation are recorded in STATUS.md; no existing secret or pilot was rewritten.
Docker's documented `ls --json` response projects names/providers only. No plaintext
read operation is exposed to the hub; this is not a claim that Docker's own secrets
engine/credential-helper/provider internals never decrypt or consult other data.

Final enabled-subset evidence: `npm run check` passes 289 tests across 31 files,
type/lint/boundary/credential/build gates and both compiled Windows smokes. The
separate final Playwright run passes all 19 tests, including callback query removal
and a delayed-refresh focus regression. Formatting checks pass. Live Linear account
consent and an independently exercised second Windows identity remain unverified;
see STATUS.md for intermediate failures and the precise supported/unsupported scope.

## D021 — Owned Windows integration and dynamic tools bridge (2026-10-28)

P7 inserts one `waleed-mcp-hub` stdio entry, never connector credentials. Nine
requested user scopes are distinct from the eight legacy P3 discovery products.
JSONC edits preserve unrelated settings/comments; Codex uses an owned marker block
and preserves `node_repl`. Foreign entries, duplicate keys, ambiguous files,
unsupported scope overrides, links and stale registry/file fingerprints fail closed.
Integrate/disconnect requires prior scan, explicit user-file consent, private
timestamped backup, journal-before-effects, atomic replacement and exact read-back.
Backups live in runtime `agent-backups/` and may contain existing private settings;
only current user/SYSTEM can access them. DACL-only .NET persistence avoids the
unnecessary privilege request observed with repeated `Set-Acl` calls. Uncertain
external outcomes block; an old whole-file backup is never blindly restored.

Documented scope corrections: VS Code uses `%APPDATA%/Code/User/mcp.json` with
`servers`, current Kimi Code uses `~/.kimi-code/mcp.json` (`KIMI_CODE_HOME`), and
Kilo CLI uses `~/.config/kilo/kilo.json` with `mcp.<name>`. Multiple supported files
are ambiguous, not merged by guessing. Custom `CLAUDE_CONFIG_DIR` is blocked.
OpenCode V2 uses `mcp.servers`, not V1's direct `mcp` map.

Sources: https://opencode.ai/v2/docs/mcp-servers ;
https://code.visualstudio.com/docs/agents/reference/mcp-configuration.md ;
https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html ;
Kilo documentation `/automate/mcp/using-in-cli` from https://kilo.ai/docs/llms.txt .

Integrated means configuration ownership/read-back only. The independent tools-only
bridge rechecks approval/definition/disable/recovery before explicit tool calls,
resolves only declared DPAPI references, isolates failed peers and never performs a
tool call during enumeration. Tool schemas/results are checked for credential echoes
(including JSON escaping/encoding), not logged. Cleanup runs even if SDK close fails;
raw cleanup exceptions never reach agents. Dynamic registry reads and tool-list-change
notifications implement sync without rewriting unchanged agent configs. Agent reload,
project/account/plugin precedence and trust prompts remain agent-controlled. Native
sessions remain contained/bounded; resources/prompts and keychain-backed Docker bridge
execution are unsupported. Live Docker image cleanup is still a separate gate.

## D022 — Manual save is not execution or authentication (2026-10-28)

Manual Stdio/Docker/HTTP/SSE definitions use the registry lifecycle and P6 protected
env/header writes. Docker ports bind only to 127.0.0.1 and participate in approval
hashes; port-published profile catalog snapshots are refused. Save alone grants no
execution approval. A separate checkbox can approve the exact definition after
credential writes invalidate earlier approval. Auto-sync checks existing owned bridge
entries; it does not imply authentication, install an agent or bypass its consent.
Partial completion returns the saved ID and `partially_saved`; inspect it instead of
creating a duplicate. Browser inputs/transient maps clear on submit/error/close;
mutable buffers follow P6 disposal rules. No universal secure string erasure is claimed.

## D023 — Portable Windows App Mode, not a service (2026-10-28)

P9 packages a folder with bundled Node 24, reviewed compiled assets, local UI and
production dependencies/licenses, without npm lifecycle hooks, personal configs or
credentials. Keep the folder in place after integration: agent launchers reference
its absolute paths. Moving/upgrading requires reviewed disconnect/reintegration.
The PowerShell/batch entry points prefer bundled Node; Edge is a fixed App Mode
opener, with no execution-policy bypass or elevation. Shortcut installation is
explicit; existing shortcuts require `-Replace`. No service/sign-in startup task is
registered. Closing the window keeps the manager running; protected Settings shutdown
drains the backend and releases writer locks. Independent bridges remain agent-owned.

Single-instance control uses a runtime/user-bound Windows pipe with a fixed
acknowledgement only; it never returns a token. Reopen asks the existing backend to
issue a fresh `#launch=...` fragment URL through private IPC, never `?token=...`.
Port conflicts do not kill other processes. Automated tests substitute only a
construction-time opener; real Edge/shortcut behavior remains a manual gate.
Isolated packaging verification keeps its original 20-second readiness deadline;
earlier duplicate-dependency/SDK-root failures and a later timeout are recorded in
STATUS.md, not hidden by relaxed deadlines.

Final P7–P9 evidence (2026-10-29): 309 core tests across 35 files, all original
compiled Windows smokes, the separate nine-scope integration/DPAPI bridge smoke,
22 Playwright tests and final portable-folder isolated startup/session/UI/shutdown
pass. Startup failures clean owned locks and disconnect IPC; the port-conflict
regression proves the unrelated listener survives. Tool result/cleanup/parser
diagnostics remain non-reflecting, including JSON-escaped credential echoes.

## D024 — Profile-scoped resource/prompt forwarding (2026-10-29)

Task 12 supersedes D021's original tools-only limitation. Resource/list/template
and prompt/list discovery use the same per-agent managed peer pool as tool calls.
Reads/gets recheck the route's execution, credential and profile fingerprint before
dispatch and after response. Duplicate raw URIs/names never choose a connector:
resource URIs are opaque per-bridge handles, prompt handles are connector-prefixed
and collision-safe, and templates expose query variables without upstream literals.
Embedded prompt resources and links stay scoped to their owning connector.

SDK MCP schemas validate wire payloads. Resource/template/prompt metadata is bounded,
and partial catalogs carry a static truncation marker. Unsupported peers degrade
independently. Provider errors/data never leave the boundary; known credentials are
checked in text and decoded base64 payloads. Only routing metadata is retained, not
prompt arguments or returned bodies. Registry and scoped upstream list-change
notifications invalidate routes. Resource subscriptions stay explicitly false and
direct subscribe/unsubscribe requests fail without contacting a provider. Production
argv sessions, real DPAPI/JobObject tests and browser-driven profile reassignment
cover live read/get routing and stale/out-of-scope refusal.

## D025 — Opt-in health scheduling and current-user desktop lifecycle (2026-10-30)

Task 13 extends D023 without installing a service or silently enabling startup.
Health metadata may inspect approved OAuth references through DPAPI; only expiry/
status scalars survive and read buffers are zeroed. A metadata request can therefore
initialize the protected backend, superseding the earlier dashboard-no-DPAPI
assumption. Connector discovery runs only on explicit health/check actions or after
opting into five-minute scheduling; health never calls tools/reads resources/gets
prompts or installs packages. Existing approval/recovery/containment limits apply.

HKCU Run has one fixed value and the compiled launcher derives its own quoted
background command. Boolean/expected-state APIs never accept executable paths or
registry locations. A current-user mutex plus exact command/read-back checks refuse
stale and other-installation values. Build identity verification refuses missing,
linked or stale launcher artifacts; it is not code signing against same-user code.
Packaging compiles the reviewed launcher; packaging alone registers nothing.

Tray menus use static stdin/owned IPC commands, not arbitrary URLs or shell input.
Open obtains a fresh fragment launch, Check Health invokes only the health queue,
and Exit drains the backend and writer locks. Owned Edge window/PID/start-time
observation can stop the manager when keeping it in the tray is disabled. An
unobserved/reused Edge handoff never authorizes process killing or inferred window
closure. Native tray/menu construction and isolated registry mutations are tested;
visible tray/window behavior across Windows shells still needs manual verification.

## D026 — Tool overrides are metadata, not execution grants (2026-10-30)

Task 14 stores optional bounded overrides outside connector execution definitions,
keyed by connector ID and original tool name. Saving/resetting uses the normal
registry journal and CAS checks without invalidating approval, observations or
managed sessions. Annotations merge over provider hints and cannot authorize calls.
Direct snapshots/native snapshot launchers refuse active overrides rather than
silently bypassing customized metadata.

Explicit aliases are exact identifiers up to 64 characters; default generated Hub
handles retain 40 characters. Alias/original/generated-handle resolution shares the
same original-name policy and dispatch path. Raw original names are accepted only
when customized, discovered and unambiguous. Known collisions are rejected without
provider startup; unseen metadata is checked during discovery and before dispatch.
Live bridges never retarget a previously owned name to a different tool. Changed
metadata invalidates stale catalog/confirmation/queued/result reviews; reconnect
may be required to reuse a retired alias for another target. Logs retain only the
original provider tool identity. UI text warns that persisted metadata is not a
credential store. Search sees aliases/original names/custom text, not new authority.

## D027 — Portable setups carry definitions, never credentials or approval (2026-10-30)

Task 15 uses a separate strict version 1 format instead of overloading ordinary
connector paste. Portable connector types project command/url/args/runtime data,
allowlisted environment literals, required field specifications and original-name
policies. Tool overrides use deterministic `connectorId/originalToolName` record
keys; credential inputs use `connectorId/target/key`. Neither is a file path.
The bounded JSON parser rejects duplicate/prototype keys before schema validation.
Command validation reuses normal imports; traversal and embedded credentials fail
closed. Unknown environment values become required fields. Export inspects every
known present credential for cross-field/encoded echoes and refuses if that safety
check is unavailable. It does not claim to classify arbitrary unknown passwords
hidden in free text. OAuth accounts, approval and installation receipts never travel.

Owner-scoped previews expire after five minutes, cap at eight, carry a full safe
definition review and pin both revision and state hash. Apply consumes the preview,
takes the shared mutation lock, checks exact required inputs, writes new immutable
DPAPI values with plaintext read-back verification and makes one atomic registry
commit. The external journal precedes writes. Only an exact before-state permits
compensation; exact after-state means success without replay. Unknown outcomes or
failed cleanup remain blocking recovery. Buffers and input fields are cleared;
no private credential backup path is introduced. Existing credentials are retained.

Skip preserves existing entries/overrides/assignments and ignores their required
inputs. Overwrite replaces matching definitions and overrides, invalidates approval,
touches affected profiles and requests new credentials; other local definitions and
unsupplied assignments remain. Affected direct snapshots must be dematerialized.
Name/alias collisions remain errors, never implicit ID remaps. Metadata changes do
not execute providers or rewrite agent config.

Docker remains reference-only: its write-only secrets cannot be confidentiality-
scanned, so those exports are refused. DPAPI import does not invent a Docker binding
adapter: credential-bound Docker imports are refused, with explicit Settings/docs
guidance to transfer definitions without credential fields and bind Docker secrets
separately. Native/package/remote credential fields use Windows DPAPI. This limit is
intentional and visible, not a claim of automatic cross-vault conversion.

UI reference lock: preserve LifecycleSettings' white bordered panels, Segoe UI,
teal action-only accent and responsive density. Borrow ImportDialog's explicit
review/consent/apply separation; use Refero craft-details for labelled password
inputs, paste support, keyboard focus and 44px targets. Upload/drop is an alternate
entry point, never an automatic apply. Desktop uses paired summary columns; mobile
stacks them without horizontal scroll. No new visual language or media is needed.

## D028 — Onboarding is a preference, not execution approval (2026-10-30)

Task 16 adds `onboardingCompleted` to the existing atomic lifecycle preferences,
defaulting false for legacy files without writing during read. The dedicated
onboarding endpoint changes only that flag under the settings mutation guard and
revision check; existing lifecycle UI requests may omit it without resetting it.
Finish/Skip mark complete and explicit Settings rerun marks incomplete. Completion
wins over empty connector inventory to avoid a perpetual first-run loop. Existing
workspaces with an unset flag are offered the tour too. No browser storage or
portable setup state is used.

The tour is an inline Connectors panel rather than a blocking modal. Step changes
do not scan or mutate anything. Agent discovery/1-click integration reuse the
existing component, config fingerprint, consent and protected mutation chain.
Registry/Smart Paste/Managed Packages open existing review dialogs; they do not
silently create, install or approve. All set describes tour completion, not live
provider success. Help and Playground are navigational actions only.

Help sources are literal build-time imports of allowlisted guide files, not dynamic
filesystem reads or a copied content database. Sections and search derive from the
same Markdown. The renderer emits escaped React text for unsupported HTML, checked
known-guide/HTTPS links, inert code, lists and tables; there is no dangerous HTML
sink, script evaluation or image loading. External links are explicit with
noopener/noreferrer. Search stays local. An on-demand local chunk keeps guide text
off the initial bundle; a scoped error boundary preserves the workspace if an
old-build chunk is missing.

Reference lock: preserve the current white panels, Segoe UI, thin borders, teal
action accent and 8px panel language. LifecycleSettings owns persistence/status
patterns; ImportDialog owns review/consent separation; AgentIntegrations owns the
connection workflow. Refero craft-details supplies visible keyboard focus and
labelled 44px controls. The wizard's numbered progress is informational, not an
approval indicator. Help uses topic/content columns on desktop and stacked,
independently scrollable regions on mobile. No decorative media or redesign.

## D029 — Seventeen agent identities share one reviewed integration chain (2026-10-30)

Task 17 expands IntegrationAgentId to seventeen and bounds mapping/record/tool-set
collections at 24. Targets, requests, bridge argv and metadata-only logs all use
that same enum. Existing profile/search and Allow/Ask/Block dispatch remain unchanged;
new adapters never grant trust, auto-approval or execution privileges in the client.

Current upstream format research: [Zed](https://zed.dev/docs/ai/mcp) uses flat
command/args in `context_servers`; [Gemini CLI](https://geminicli.com/docs/tools/mcp-server/)
uses user `settings.json`; [Goose](https://github.com/block/goose/blob/main/documentation/docs/guides/config-files.md)
uses YAML extensions with `cmd`, plus a Roaming Windows config path; [Warp](https://docs.warp.dev/agents/capabilities/mcp/)
uses global `.warp/.mcp.json`. Requested alternate paths are explicit compatibility
candidates, never a reason to write multiple files. Equivalent Windows paths are
deduplicated. Both content and normalized scope enter the fingerprint, closing the
same-bytes relocation loophole. Multiple actual candidates/layouts fail closed.

[JetBrains](https://www.jetbrains.com/help/ai-assistant/mcp.html) documents IDE
Add/Import JSON but not a guaranteed shared `%APPDATA%/JetBrains/mcp.json` file.
The requested shared file is writable only if already present, with explicit client
verification/import guidance. No absent file is invented, and no IDE-version XML or
project state is touched. Cline/Roo likewise require existing default VS Code
extension scopes rather than confusing `code.exe` with an installed extension.
Windsurf's requested scope is legacy Cascade, not an automatic Devin migration.

JSONC modification omits whole-line formatting so unrelated inline settings retain
their exact bytes. Goose uses pinned `yaml` 2.9.1 for bounded data-only parsing and
range-based owned-entry edits, not whole-document serialization. Anchors, aliases,
merge/prototype/non-string/duplicate keys, custom tags, multi-documents, non-finite
scalars and unsupported flow parents fail closed. Generated Goose extensions use
stdio cmd/args, enabled/name and no credentials; provider/permission/secret files
are unchanged. Existing Goose extensions are not silently passed into the JSON
protected-adoption adapter; that separate import capability is explicitly disabled.

All clients retain the same atomic private backup/CAS/read-back/journal adapter.
Pre-effect failures abort; uncertain external effects preserve backups and block for
review rather than blindly restore private contents. Configuration-only success is
not proof an installed client consumed the file or connected. Synthetic tests and
disposable Windows smokes must not be reported as real-agent compatibility tests.

UI reference lock: retain the existing Agents/Onboarding consent and feedback
patterns, white surfaces, Segoe UI, thin borders, teal action roles and 44px controls.
Use two-column cards at desktop and a single column at 390px; local vector icons
and textual client-type/detection badges add identity without remote assets or
implying trust. Per-client reconnect/scope guidance stays visible before integration.

## D030 — Loopback Bearer sessions reuse the secured bridge (2026-10-30)

Task 18 adds only `/mcp` POST/GET/DELETE to a route-metadata Bearer-auth boundary.
Exact Host/Origin/cross-site checks remain shared. Real socket peers must be
127.0.0.1/::1 (including IPv4-mapped 127.0.0.1); proxy headers are not authority.
Production binding remains 127.0.0.1. The browser session/Origin/CSRF chain is
unchanged for token-management and other APIs. Session IDs alone never authorize
a request, and a valid token cannot use another token's session.

Token entropy is 32 random bytes with a `wmh_live_` prefix. A separate private
atomic/CAS/readback file contains only SHA-256 hashes and masked metadata, outside
setup exports. All fixed-length hashes are compared using timingSafeEqual without
an early matching exit. Token mutations share the lifecycle lock; revision conflicts
require refresh. Revocation denies in-process before disk writes, closes token-owned
sessions and remains possible during registry recovery. Failed persistence must be
reported as unconfirmed durable revocation, not a successful deletion. Optional
expiry and a 256-record limit bound retained metadata.

Each SDK stateful Streamable HTTP session owns a createAgentBridge instance and
its peer pool. Token-scoped registry snapshots filter connectors, while the bridge
still evaluates live agent assignments, approvals, policy, tool-search, credentials,
containment and content dispatch. Token restrictions therefore intersect, never
replace, agent limits. `http-client` widens only bridge/log identities, not installed
agent targets or persisted agent bindings. Tool logs and refusal audits never add
tokens, headers, session IDs, arguments, results or provider errors.

Sessions reserve capacity before awaiting initialization (64 global/8 per token,
16 requests/session), with 5-minute idle and 1-hour lifetime bounds plus token expiry.
No replay store is enabled. Revocation closes raw pending JSON responses as well
as SDK SSE streams: SDK 1.32.2 transport.close clears unresolved JSON responders
without finishing their Node responses. DELETE is excluded from that forced-response
path so the SDK can finish its normal termination response. Shutdown closes sessions
in Fastify preClose, before waiting for SSE connections to drain. No automatic call
replay or claim to undo dispatched side effects is made.

Settings reference lock: reuse the existing LifecycleSettings/SetupSettings surfaces,
Segoe UI, thin borders, teal action role and 44px controls. The generation form uses
a native focus-trapping dialog; one-time disclosure provides selectable/copyable
token and HTTP snippet, then returns to a preview-only list. Plaintext lives only
in component memory until dismiss/navigation/reload or five minutes, never browser
storage. Clipboard retention is explicitly outside the Hub. Responsive token rows
and wrapping code fields preserve the existing 390px layout, without a new theme.

## D031 — Platform-native storage and execution seams, without a Windows migration (2026-10-30)

Task 19 is readiness, not a claim of verified macOS/Linux deployment. Existing
Windows `SecretBackend` and `ProcessRunner` implementations remain the adapters
behind platform factories. DPAPI still uses the same CurrentUser scope, entropy,
private files, `scope.json`, reference IDs (`windows`) and cross-process OAuth
rotation lock. The native C#/PowerShell host and its JobObject policy are unchanged.

New keyring references explicitly identify `keychain` or `libsecret`; neither is
an alias for `windows`. Binding resolution and credential transactions select the
configured backend, retaining the existing ownership/revision/journal checks and
zero-filled leases. A moved registry cannot open Windows references through an OS
keyring. No automatic credential migration, plaintext or ephemeral fallback exists.

Keychain uses service `WaleedMcpHub`, scoped generated accounts and the security
CLI's add/find/delete-generic-password contract. Secret-bearing add commands are
sent through non-TTY stdin, not argv or files. Upstream's
[security.c](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c)
and [readline.c](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/readline.c)
show a fixed 4096-byte interactive buffer and no command-history writer in that
path: oversized encoded commands must fail before the store, not be truncated.
[secret-tool](https://manpages.debian.org/testing/libsecret-tools/secret-tool.1.en.html)
stores from stdin with application/scope/id attributes and looks up/clears the
same tuple. Base64 envelopes preserve newline/Unicode values; they are encoding,
not encryption. Both adapters rely on the OS keyring, verify mutations and zero
their owned buffers. Only a random nonsecret namespace is atomically published to
a private 0600 file under a 0700 directory; it never travels in setup exports.

Status is lazy and metadata-only. An explicit session/Origin/CSRF-protected probe
checks a generated absent ID and reports the last observed state. It does not add
a canary credential or claim all items are unlocked. Missing commands, locked
keyrings and denied sessions remain unavailable; provider/native errors are not
returned. OAuth rotation remains DPAPI-only until equivalent reviewed keyring
locking/replacement and native tests are available. POSIX installers likewise fail
before attempting Windows installer tooling or weakening receipt/venv validation.

Platform directory/agent target resolution shares the existing descriptor/format
definitions, not a second dispatch implementation. Windows comparison stays
case-insensitive; POSIX preserves case. Existing-file and ambiguous-scope guards
remain shared. macOS GUI config roots use Application Support, CLI scopes use
config-home; Linux uses absolute XDG roots with documented defaults. Runtime data
overrides are absolute, and the historical Windows missing-LOCALAPPDATA fallback
is retained. Approved package receipts remain under the selected runtime directory.

POSIX execution uses direct exec, a detached process group, explicit environments,
bounded I/O/concurrency/deadlines and group termination on exit/cancel/limits.
There is no uncontained fallback. This is lifecycle cleanup, **not** a sandbox or
Windows JobObject guarantee: session-detaching children and manager SIGKILL remain
known limits. Construction/runtime tests simulate darwin/linux system responses;
they must not be reported as real keychain, D-Bus or native process-tree validation.

UI reference lock: keep the existing LifecycleSettings/Runtime safeguards surfaces,
Segoe UI, white bordered panels and existing action roles/44px controls. Add one
backend/status/probe panel and accurate text, not a new theme or automatic probe.
Onboarding/import/setup copy names the native vault rather than claiming DPAPI on
all operating systems. Backend choice remains platform-owned, not an HTTP option.

## D032 — Final Windows artifacts stay generated; verify inventory and packaged containment (2026-10-30)

Task 20 commits maintained launcher/packaging sources, tests and release evidence,
not generated executables or `desktop-builds/`. The root launcher and each portable
launcher are compiled independently; different executable hashes are valid. No
startup registration, real agent change or pilot migration occurs during packaging.

Every new portable folder includes `desktop-integrity.json`: a complete relative
file inventory with byte counts and SHA-256 hashes, excluding the inventory itself.
The verifier checks both source and disposable copy before execution, refuses
links/non-file entries and mismatches, and matches launcher/source hashes to the
launcher manifest. This is reproducible integrity checking, not signed provenance
or protection against hostile replacement of both the inventory and artifacts.

Verification runs bundled Node outside the workspace with empty PATH and cleared
NODE_OPTIONS/NODE_PATH. The bundled compiled core/JobObject host cancels and times
out synthetic parent/child trees while an unrelated synthetic process survives.
The backend additionally proves session refusal/authentication, UI serving, tray
self-test, read-only startup metadata and graceful writer-lock release. Real Edge
interaction, shortcut installation, live agents/providers and native POSIX release
certification are distinct gates and remain explicitly unclaimed.

The final browser gate exposed a shutdown edge case: Node's initial idle sweep
can leave browser preconnect sockets and connections becoming idle after that
sweep waiting on normal timeouts. The server tracks connections until their first
HTTP request, retires only those on pre-close, and sweeps newly idle connections
after response completion while draining. It does not force-close active requests
or loosen the existing five-second writer-lock assertion. A real-socket regression
checks an accepted response still completes alongside an unused TCP connection.

Approved local OpenCode helpers are retained as source-only explicit-input tools:
session, UTF-8 prompt file and optional CLI executable replace machine paths and
embedded task context. Inspection defaults to metadata; content needs opt-in.
Tests use synthetic CLI responses and never submit a live prompt. These developer
tools use CLI argv and must not carry credentials.

## Open investigations before/during implementation

1. **Postora authentication:** determine which credential/auth flow its MCP endpoint
   accepts and why Docker rejects the advertised metadata-domain arrangement.
   This may require a separately authorized project/server change.
2. **Native secret store:** P6 verifies CurrentUser DPAPI, vault-scope/tamper rejection
   and journaled credential recovery. Independent second-login decryption rejection
   remains unexercised; do not describe wrong-scope tests as a second-user test.
3. **Agent formats:** verify Kilo, Kimi Code, Cursor, and global path/merge behavior
   for all adapters against installed versions.
4. **OAuth coverage:** identify provider flows genuinely supported by the installed
   gateway and version-pin recipe behavior. Do not promise universal OAuth.
5. **Profile refresh:** verify any newer gateway refresh behavior before claiming
   that connected agents receive live updates without reconnecting.
6. **Dependency selection:** resolve supported patch versions, MCP protocol coverage,
   and Windows subprocess behavior during phase P1.
7. **Startup mechanism:** choose and test an appropriate same-user sign-in mechanism
   before implementing Settings' optional startup toggle.

When an investigation changes a baseline, append a dated decision with evidence,
consequences, and the affected specification/plan sections. Do not silently mutate
scope in source code alone.
