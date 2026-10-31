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
"Match" means the current user SID or the token's default owner. An elevated token
creates objects owned by `BUILTIN\Administrators`, which no other non-admin user can
produce, and an administrator can already rewrite any ACL, so this admits nothing new.
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

## D024 — Managed npm packages: frozen lock, bundled npm, verify every launch (2026-10-30)

F01 (spec `docs/specs/F01-managed-packages.md`, plan
`docs/plans/F01-managed-packages-plan.md`) lets a user install an npm MCP server
without `npx`. The hub resolves the full tree once (**Look up**), stores the frozen
`package-lock.json` server-side behind a single-use, owner-scoped, 10-minute
`previewId`, and **Install** runs `npm ci --ignore-scripts --omit=dev
--omit=optional` from that lock. The saved connector is an ordinary native
connector plus a server-generated `package` record (`lockHash`, `manifestHash`,
entry, install ID). Clients can never create, alter or strip that record. The
record is part of the approved definition, so approval binds a digest of every
installed file. Every launch, **Test capabilities** and **Verify files** rebuild
the manifest from disk before secrets are resolved, and fail closed with
`package_modified`.

Isolation rules:

- npm reaches only `registry.npmjs.org:443`, through a loopback CONNECT allow-list
  proxy with a 300 MiB cap. It gets no `PATH`, the four `--allow-*=none` flags
  (no git, URL, file or directory dependencies), empty `--userconfig` and
  `--globalconfig` files, a redirected profile and `--logs-max=0`. npm output is
  used for exit status only.
- The working folder always holds a `package.json` and npm gets `--prefix`, so
  npm never searches parent folders for a project root. An ancestor `.npmrc`
  (including the one `npm login` writes to the home folder) is therefore never
  read, and is not refused. Refusing it would break every lookup for users who
  have ever logged in to npm.
- Node does search parent folders for modules. Any `node_modules` above the
  install folder therefore fails the check. Launches pass
  `--no-global-search-paths`, and `NODE_*` and OpenSSL environment names are refused
  on package connectors.
- No lifecycle script, native build or package code runs during Look up, Install
  or Verify files.

**Bundled npm, repacked.** The hub runs its own pinned npm
(`node.exe <npm>\bin\npm-cli.js`), never the user's. npm 12.2.1 bundles `undici`,
`ip-address`, `minimatch` and `glob` versions with open advisories
(GHSA-4qv8-2p9j-2685, GHSA-xjj6-f33q-929c, GHSA-2m5v-pch6-74hx,
GHSA-qrxm-fqhp-jwvm, GHSA-9fm3-97px-rjf6, GHSA-rxp7-6hxx-x8q5,
GHSA-g3hv-75wg-m249, GHSA-3g3m-2fjr-6pw4). Bundled dependencies cannot be
overridden or audit-fixed, and no npm release bundled the fixed versions yet, so
`scripts/npm-bundle.mjs build` writes `vendor/npm-12.2.1-patched.tgz`. It contains
the official npm 12.2.1 files with only those packages replaced by
`undici@6.29.1`, `ip-address@10.7.4`, `minimatch@11.0.3`, `glob@14.0.3` and
`path-scurry@3.0.0` (the one `glob@14` needs), plus one added package,
`@isaacs/nonrecursive-glob-match@1.0.3`, a new dependency of `minimatch@11`. Every
input is pinned by sha512, and file times are npm's fixed publish time. `glob` and
`minimatch` are major upgrades over what npm declares, so `npm ls` reports them as
invalid inside `node_modules/npm`; npm's `install`, `ci`, `ls`, workspace lookup and
`pack` with a `files` glob were checked against the repacked npm. The same versions
are pinned for the rest of the tree (`@fastify/static`, `eslint`) through root
`overrides`. CI runs `npm run check:npm-bundle`
(`verify`), which proves the vendored file contains exactly those files and
nothing else, before `npm audit --audit-level=moderate`. There is no audit
exception. Drop the repack when an npm release bundles fixed versions.

**Recovery.** An install is built in place under `<data>\packages\<installId>\`
with a sibling `.installing` marker. Publishing and saving happen under one
in-process package lock. Reconciliation runs at startup and after removal, and
deletes folders that no connector references and markers whose job is gone. An
outcome the job cannot confirm is `save_uncertain`, and the job never deletes in
that state. Update and Reinstall install into a new folder and swap it in with a
connector-revision check; the new definition needs approval again.

**Web UI (T9).** The page reports the outcome of a lost job honestly. A lost start
or poll says the outcome is unknown and offers **Check the job again**. A job the
hub no longer knows (HTTP 404, for example after a restart) is not offered for
re-checking. A 503 counts as "nothing started" only for the codes known to refuse
before a job exists (`unavailable`, `audit_unavailable`). Hub refreshes time out
after 20 seconds and follow a newest-call-wins rule (`apps/web/src/latest.ts`), so
a slow older refresh never overwrites a newer one, and every caller gets the
outcome of the newest call.

**Residual risks (accepted, stated rather than claimed away):**

1. **Check-to-launch race (TOCTOU).** As in D017, a malicious process of the same
   user can swap files between verification and process start. The check catches
   accidental and after-the-fact changes and swaps between approval and launch,
   not a live same-user attacker.
2. **Junction race.** `assertNoLinks` checks every path component, but a
   same-user process could create a junction after the check and before use. Same
   threat model as 1.
3. **Alternate data streams.** The manifest hashes each file's main data stream.
   An NTFS alternate data stream added to an installed file is not detected. Code
   would have to name the stream to load it, and changing that code is detected;
   a stream can still hide data inside the install folder.
4. **Best-effort watchdog, disk exhaustion still possible.** Size and file caps
   are enforced by a scan that starts at most 250 ms after the previous scan
   finished, not by a filesystem quota. The free space is measured only after a
   scan's walk, and npm keeps writing during the walk, the 250 ms pause and the
   4-second kill grace. The detection delay therefore includes the scan duration,
   and there is no hard bound on the overshoot. The 2 GiB free-space floor,
   checked before start and on every scan, makes filling the drive less likely; it
   is not reserved space and does not prevent it. A real per-folder quota (NTFS
   quota or FSRM) is possible future work.
5. **Package code runs with the user's rights.** After approval, a package server
   runs as the signed-in user inside a Job Object that bounds its lifetime and
   process tree, not its file or network access. Approval of the exact package and
   version is the trust decision; the hub is not a sandbox.

Python packages (`uvx`) stay out of scope until F01b decides interpreter
provenance, wheel targeting and credential isolation.

## D025 — Persistent connector sessions in the agent bridge (2026-10-30)

F03 (spec `docs/specs/F03-persistent-sessions.md`, plan
`docs/plans/F03-persistent-sessions-plan.md`) keeps one live peer per connector
inside each agent's bridge process and reuses it across `tools/list` and
`tools/call`, so stateful servers (an SSH session, a browser tab) work. Fixed
inputs: 5-minute idle timeout, 60-minute maximum session life, graceful
re-initialisation after a hub restart, pooling for native stdio, remote
Streamable HTTP and SSE, and Docker, and Windows Job Object containment. The
design went through six Codex review rounds (18, 15, 7, 6, 5 and 3 findings, all
accepted; verdict tables in the plan).

Rules that make reuse no weaker than one peer per call:

- **Validation before every SDK request**, after the caller holds the peer
  exclusively: unblocked ledger, agent integrated, valid boot record, connector
  enabled and approved, unchanged definition hash and credential references,
  lease not near expiry, then a synchronous final gate (generation, state,
  cancellation, max age by the clock) with no `await` before the dispatch. New
  peers are authorised (state checks, then package verification) before any
  secret is resolved or any process starts.
- **Security invalidation is not retirement.** A failed check, a timeout or a
  cancellation after dispatch aborts the peer at once and discards its result;
  only reaching max age or idle retires gracefully. A failed call is never
  replayed.
- **Snapshots are serialised and numbered on completion**; reconciliation of
  watched files is decided inside the same mutex, so an older observation never
  overrides a newer one.
- **Hub restart** is detected through `boot.json`, a boot ID the hub writes after
  recovery reconciliation. A mismatch replaces the peer inside the request that
  notices it. A missing or malformed boot record fails closed.
- **Budgets** per operation, per session and between operations are enforced in
  the C# process host, the stdio transport and, for remote servers, by framing
  JSON and SSE bodies before the SDK parses them. Session runs keep byte counts,
  not output.
- **SDK use**: pooled peers call `client.request` directly (no tool-metadata
  cache, no client-side schema validation), with operation-owned abort
  controllers so a finished request never sends a late cancellation.
- **Docker ownership** rests on container labels (installation ID from
  `install.json`, agent, bridge, nonce) and OS-held named pipes: each bridge
  listens on its own pipe for life, and recovery for an agent holds a pipe
  mutex. Only a conclusively absent owner, or this bridge's own abandoned
  launch, allows removal. Launch and removal phases are recorded in markers and
  never expire by time.

**Residual limits (accepted, stated rather than claimed away):**

1. **Remote state.** Closing a remote session (`DELETE`) is best-effort; the
   server may keep state or keep working after a cancelled call. The hub only
   stops its own participation.
2. **Lazy loading.** A running Node package server can load a file that changes
   between verification and load; the D024 check-to-launch race now spans the
   session, not only start-up.
3. **Transient ledger states.** A ledger that is `prepared` and then `committed`
   between two snapshots may never be observed; its committed registry change is
   caught by the next validation.
4. **Echo detection** catches lease values in the representations
   `assertNoCredentialEcho` checks. Split or re-encoded values are not detected.
   Secrets live in the bridge for up to 61 minutes instead of one call;
   immutable JS strings cannot be wiped (D019).
5. **Docker manual reconciliation.** A launch whose CLI was killed before Docker
   acknowledged a container ID keeps its marker until the container is found.
   More than 16 such markers block Docker for that agent until a person removes
   them (troubleshooting guide). Pre-F03 markers are never auto-recovered.
6. **Server-side sharing.** Two agents never share a bridge-owned peer, lease or
   transport; a server that shares state by credential or globally is outside
   the hub's control.
7. **Ambiguous error codes restart the peer.** A server that answers with
   JSON-RPC error `-32000` or `-32001` looks to the SDK exactly like its local
   "connection closed" or "request timeout". The bridge cannot tell them apart,
   so it treats both as a dead peer and the next call starts a fresh one. This
   fails closed; the cost is a restart and the lost session state.
8. **Startup registry failure text.** A registry read that fails inside a pooled
   startup reports the connector-unavailable text, not the registry-unavailable
   one. Both are fixed texts.
9. **Handshake window after an abandoned startup.** A peer whose startup
   finishes after every waiting request left keeps its start-up budget until
   its first operation or its idle retirement. The per-session caps and the idle
   timeout still bound it.
10. **Interrupted installation record.** `install.json` is created exclusively,
    then written. If the hub dies between the two steps the file stays empty or
    partial, every later read fails closed, and Docker connectors stay
    unavailable until a person deletes the file (troubleshooting guide).
    Containers labelled with the lost installation ID are then no longer
    recovered automatically.

**Implementation choices accepted in review.** Docker ownership (T6) differs
from the first plan in these conservative ways:

- A connected owner pipe that closes counts as a live owner; some live owners
  become "unknown", so their containers are kept and the round retries.
- Any entry at the top of the marker folder that is not an agent folder counts
  as a legacy marker: it blocks Docker for every agent and is never deleted.
- A daemon mismatch also stops the label sweep from removing anything.
- The marker pass runs before the label sweep in the first round; a failed
  removal is retried in a later round, not in the same one.
- An image pull is bounded by the 20-second start-up deadline and fails before
  any launch marker exists.
- The label sweep is batched (spec amended): a listing holds at most 4 096
  container IDs (more makes the round uncertain), 64 are processed per round
  from a cursor, each owner is probed once per round, and the two passes share
  one deadline with alternating order so neither starves the other.

The Windows containment tests (T7) live in `scripts/smoke-sessions.mjs`, not
in the planned `tests/bridge-sessions.windows.test.ts`: they need the compiled
bridge, and CI runs `npm test` before `build`. CI runs the script after the
build. `runAgentBridge` takes an optional idle limit for this test only; the
`bridge` command never passes it and no file or environment value can set it.
The real-daemon Docker test runs locally and is skipped in CI.

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
