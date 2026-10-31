# F03 — Persistent connector sessions

Status: agreed v7 (debate rounds 1–6 applied) · Roadmap item 3 (P0) ·
Decision record: D025

## Problem

The agent bridge (`packages/hub-core/src/integrations/bridge.ts`) starts a fresh
peer for every `tools/list` and every `tools/call` and disposes it when the
request returns. A native connector gets a new process per call, Docker a new
container, a remote server a new MCP session. Servers that keep state between
calls break (an SSH `open-session` is gone before `read-session-output`), and
every call pays full start-up cost.

## Goal and fixed inputs

Inside each agent's bridge process, keep one live peer per connector and reuse it
across requests, without weakening the existing rules. Fixed inputs (not up for
debate):

- Idle timeout **5 minutes**; maximum session life **60 minutes**.
- Pooling for native stdio, remote Streamable HTTP, remote SSE and Docker.
- Graceful re-initialisation after a hub restart: the agent stays connected; the
  next request gets a fresh, re-validated peer.
- Windows Job Object containment for every native peer and every Docker CLI.

## Non-goals

- Sharing a peer between agents or between bridge processes.
- Peers surviving the bridge process, or a hub restart (they are replaced).
- Retrying or replaying a failed `tools/call`. Tools may not be idempotent.
- Pooling in the hub's own **Test capabilities** (it stays a disposable check).
- Resource/prompt forwarding (roadmap item 13).
- Claiming the remote side releases state: closing a remote session is
  best-effort.
- Automatic recovery of legacy (pre-F03) Docker markers (see "Docker").

## Terms

- **Entry**: the pool's record for one peer, with a unique, never-reused
  `generation`.
- **Operation**: one bridge request served by a peer: one `tools/call`, or the
  whole page sequence of one `tools/list` for that connector.
- **Graceful retirement**: the entry accepts no new operation; an in-flight
  operation finishes; then the entry is disposed.
- **Security invalidation**: the entry is aborted at once: waiters fail, the
  in-flight operation is cancelled and its result discarded, the peer is
  disposed.
- **Snapshot sequence**: snapshots are taken one at a time (see "Snapshot"); each
  completed snapshot gets the next number when its read finishes, so numbers
  follow observation order.

## Where the pool lives

`runAgentBridge(registry, agentId)` is a separate process started by the agent;
the hub process is not on the call path. A new module
`packages/hub-core/src/integrations/session-pool.ts` lives in that process and
replaces the `connect` + `disposePeer` pair in `createAgentBridge`. It takes
injected `now`, `setTimer` and `clearTimer`.

## Pool model

- **Key**: `connectorId`. At most one _serving_ entry per connector, in the map
  `serving`.
- **Live set**: every entry from creation until its disposal resolves is in the
  set `live`, independent of `serving`. Capacity counts `live`.
- **Entry** fields: `generation`, `connectorId`, `stamps`, `bootId`, `peer`,
  `startedAt`, `lastUsedAt`, `validatedSeq` (read sequence of its last
  successful validation), `lifetime` (an `AbortController` owned by the entry),
  `busy` (one operation at a time), `waiters` (FIFO), `state`:
  `starting → ready ⇄ busy → retiring → disposing → gone`.
- **Ownership rule**: identity checks (`serving.get(id) === entry`) guard only
  changes to `serving`. Every entry always completes its own cancellation,
  disposal and removal from `live`, whatever entry now serves the connector.
  `dispose()` is idempotent. Timers and death callbacks act only on their own
  entry.
- **Capacity**: at most 16 entries in `live`. A request for a connector with no
  serving entry evicts the least recently used `ready` entry (graceful); if
  none is `ready` and `live` is full, it fails with the existing "unavailable"
  text. A replacement while the predecessor is retiring needs a free slot too.
- **Startup**: concurrent requests for the same connector share one startup with
  its own 20 s deadline and its own controller. A waiter that gives up leaves
  the queue without cancelling the startup; when the last waiter leaves, the
  startup is cancelled and the entry disposed. A failed startup fails every
  waiter and leaves no entry. Death is observed from transport creation, before
  `initialize`.
- **Signals**: the transport's lifetime signal is the entry's `lifetime`, never a
  request signal. Each SDK request gets an **operation-owned** `AbortController`.
  The caller's signal and deadline are forwarded into it by listeners that are
  removed when the operation ends; after a successful operation the controller
  is never aborted. (The SDK keeps its abort listener after success and would
  send a late `notifications/cancelled`, `protocol.js:737`.)

## SDK usage

Pooled peers call `client.request({ method: 'tools/list' | 'tools/call', ... },
schema, options)` directly instead of `listTools()` / `callTool()`. This keeps
today's pass-through semantics: no SDK tool-metadata cache
(`client/index.js:528-557`), no client-side output-schema validation, no
automatic refresh. A peer's `notifications/tools/list_changed` is forwarded to the
agent as the bridge's own `tools/list_changed` (at most once per second).

## Validation before every dispatch

**Startup authorisation** (new peers only, inside the shared startup, before any
secret is resolved and before any process or container starts): the same state
checks as 2–5 below (4 and 5 hold by construction, because the peer is built
from that snapshot's definition), then, for a managed package, a full
cancellable `verifyPackage`. A modified package therefore causes no secret
resolution and no launch. The lease is resolved next, and a lease whose
`notAfter` is 30 s away or less is refused before any process or container
starts. Every replacement launch gets its own startup authorisation.

**Dispatch validation** runs after the caller holds the entry exclusively, in
this order, immediately before each SDK request (every `tools/list` page and the
`tools/call`), for new and reused peers:

1. For a managed package on a **reused** peer, before the operation's first SDK
   request only: a full, cancellable `verifyPackage` bounded by the operation
   deadline. A peer started by this operation already passed it in startup
   authorisation (see "Managed packages").
2. `read()` returns a stable snapshot (see "Snapshot") with an unblocked ledger,
   the agent integrated, and a valid boot record.
3. The connector exists, is `enabled`, and `approved()` holds.
4. `definitionHash(connector) === entry.stamps.definitionHash` (covers
   `secretBindings`, `headerBindings` and `credentialFormats`).
5. Credential stamp unchanged: for each bound reference id,
   `{ id, adapter, present, kind, ownerIds includes connector }`. Replacing a
   secret makes a new immutable id (D019), changing the bindings and the hash.
6. `lease.notAfter` is more than 30 s away, and on an admission more than 30 s
   plus the operation deadline away, so the lease timer never ends a call it
   admitted. A lease of 30 s or less ends the peer. A lease that only fails
   the admission bound refuses the operation and keeps the peer: a fresh
   peer would resolve the same expiry, so nothing is replaced or launched,
   and listings keep using the peer until the pool ends it at its margin.
7. Final gate, synchronous and with no `await` between it and the SDK call: the
   entry's generation is unchanged, it is not invalidated or `disposing`, the
   operation signal is not aborted, and either
   - **admission** (the operation's first SDK request): the entry is the serving
     one, held `busy` by this caller, not `retiring`, and
     `now() < entry.startedAt + 60 min` read from the clock (not inferred from
     the retirement timer); or
   - **continuation** (a later page of an admitted `tools/list`): the entry is
     held by this same operation, which may be `retiring` because max age was
     reached after admission; the operation's original 20 s deadline still
     applies.

   Then `validatedSeq` is set to the snapshot's sequence. Every other check is
   evaluated first; an aborted operation signal by itself is abandonment, not a
   failure, and the entry is released unchanged.

**Boot mismatch** (snapshot `bootId` ≠ `entry.bootId`) is not a failure: it is
the replacement path. Within the same request deadline the entry is retired
(gracefully; it is idle because the caller holds it), a fresh entry is started
and validated, and the operation is dispatched once on it. A `tools/list` that
sees a boot mismatch between pages discards that connector's partial pages and
lists it once more on the fresh entry.

Any other failure of 1–7, except a caller cancellation or deadline before
dispatch: **security invalidation**. For `tools/call` the
existing checks stay: a call whose listed hash differs is refused with "Refresh
the hub tool list"; any other failure returns the existing fixed "unavailable"
text. For `tools/list`, a failure drops that connector from the result.

## Snapshot

All snapshots — for dispatch and for reconciliation — are taken under one
bridge-wide async mutex. Inside it: read ledger, registry, boot record, ledger
again; if the two ledger reads differ, retry once, else fail as "registry
unavailable". The snapshot sequence number is assigned inside the mutex when a
read finishes, successful or failed. Because reads are serialised and numbered
on completion, a higher number always reflects files read later. This
detects a ledger change during one read; the three files are still not one
atomic unit and the spec does not claim they are.

## Watching state

The bridge polls `state.json`, `safety.json` and `boot.json` (1 s, as today). A
change triggers a reconciliation. Its decisions are made and applied
synchronously inside the snapshot mutex, right after its own read (successful
or failed): entries are marked invalidated or retiring there, and only their
asynchronous disposal happens after the mutex is released. So no reconciliation
result is ever applied after a later snapshot. For each entry in `live`:

- applies only if the entry's `validatedSeq` is lower than the snapshot's
  sequence (a snapshot read before the one that admitted or last validated an
  entry never touches it), and only to the entry captured at decision time;
- a ledger whose only open entry is `prepared` (a hub write in progress, which
  may last as long as its DPAPI or Docker step): keep every entry and decide on
  the next read; every request still fails closed meanwhile, because its own
  snapshot reads the same ledger;
- a failed read (ledger `needs_review`, state or boot record unreadable):
  invalidate every entry that is not `busy`; a busy operation fails at its own
  next validation, which takes a later snapshot;
- boot ID changed: idle entries close, busy ones retire after their operation;
- connector removed, disabled, unapproved, changed hash or credential stamp:
  invalidate;
- then sends `tools/list_changed`.

Dispatch-time validation is the authority. Watching only closes idle peers that
no request would touch and frees resources earlier.

## Hub boot generation

At startup, after `safety.reconcile` succeeds (`apps/server/src/main.ts:38`),
the hub writes `boot.json` (`{ bootId: <uuid>, startedAt }`) in its data folder
atomically (temp + rename, no links, owner-only). The bridge reads it with the
protected reader. The bridge ships with the hub and is only registered by it, so
a missing, malformed or unreadable boot record means "registry unavailable"
(fail closed) until the hub writes a valid one.

## Retirement, death and limits

- **Idle**: 5 min since `lastUsedAt`, no operation, no waiter → dispose.
- **Max life**: 60 min since `startedAt` → graceful retirement; a busy entry
  finishes its operation (≤ 60 s). The next request starts a fresh peer if
  capacity allows.
- **Operation deadline**: `tools/call` 60 s, `tools/list` 20 s per connector.
  Deadline, caller cancellation, or the agent's `notifications/cancelled`
  **after dispatch** is terminal for the peer: the SDK only stops waiting and
  tells the server (`protocol.js:698`), which may keep working. The entry is
  security-invalidated (transport closed, native tree killed with its Job
  Object, Docker container removed) before any replacement. No replay. For a
  remote server the hub only stops its own participation.
- **Death**: transport `onclose`/`onerror`, process or container exit, HTTP 404
  for a session request, end of the legacy SSE main stream, protocol error, or
  a budget breach → dispose; the in-flight operation fails; the next request
  starts fresh. Completion of a Streamable HTTP POST response stream is normal,
  not death. No automatic retry.

### Budgets

Between operations the bridge sends only protocol-control traffic (ping replies,
error replies to unsupported server requests).

| Budget                     | Per operation | Per session   | Between operations |
| -------------------------- | ------------- | ------------- | ------------------ |
| Wall clock                 | 60 s / 20 s   | 60 min + 60 s | n/a                |
| Native stdout+stderr bytes | 1 MiB         | 64 MiB        | 64 KiB             |
| Native stdin bytes         | 1 MiB         | 16 MiB        | 64 KiB             |
| Messages received          | 512           | 32 768        | 32                 |
| Messages sent              | 512           | 32 768        | 32                 |
| One native line            | 128 KiB bytes | —             | 128 KiB bytes      |
| One remote message         | 1 MiB         | —             | 1 MiB              |
| One sent message           | 32 KiB        | —             | 32 KiB             |
| HTTP requests              | 64            | 4 096         | 32                 |
| HTTP response bytes        | 1 MiB         | 64 MiB        | 64 KiB             |

The remote message cap stays at today's 1 MiB response allowance (`http.ts:174`).
Pages of one `tools/list` share one operation budget. `initialize` counts against
the entry's first operation. A late message counts against the between-
operations budget. Any breach closes the session.

## Per-mode details

### Native stdio (T1, T2)

- **Process host**: runner and C# host (`ProcessHost.cs`) gain an explicit session
  request: deadline up to 3 660 000 ms, cumulative output up to 64 MiB,
  cumulative input up to 16 MiB, enforced by the host itself (today 1 MiB output
  at line 157, 1 MiB input at line 168). Non-session requests unchanged.
  `MAX_TIMEOUT_MS = 600_000` stays for non-session runners.
- **No retention**: session runs forward stdout/stderr chunks and count bytes;
  no arrays (`process-runner.ts:318`), no aggregate strings, no output in the
  result.
- **Accounting**: the transport counts raw bytes of stdout and stderr chunks and
  messages in both directions against the table. `beginOperation()` /
  `endOperation()` mark windows. Without them (capability checks): unchanged.
- **Containment**: the Job Object belongs to the host; bridge death closes the
  host's control pipe and the host exits, closing the job (`ProcessHost.cs:159`).
  A killed host also closes the job. Tests prove both paths.

### Remote HTTP/SSE (T5)

- **Framing before the SDK**: in session mode `secureFetch` wraps each response
  body before the SDK reads it. `application/json`: body ≤ 1 MiB; a JSON array
  counts one message per element. `text/event-stream`: a pass-through SSE
  framer counts each dispatched event as one message, caps one event's data
  (all `data:` lines joined) at 1 MiB and the pending, undispatched buffer at
  1 MiB, and counts raw bytes. An incomplete event at an operation boundary
  is charged in full to the window that opens there: the operation budget at
  `beginOperation()`, the between-operations budget at `endOperation()`; the
  session total counts it once. Breach → error the stream → death.
  Non-session mode keeps today's counters exactly.
- **Requests**: per-operation/session/between counts replace the lifetime
  counter (`http.ts:50`); destination checks on every request unchanged.
- **Timeouts by stream role**: the 5 s socket timeout covers connect, request and
  response headers. An optional GET notification stream and the legacy SSE main
  stream have no inactivity timeout (bounded by idle, max life and budgets).
- **POST response streams**: `secureFetch` tracks each POST body with the
  JSON-RPC request ids it carried, together with its upstream HTTP request and
  response. The framer drops SSE `id:` fields on POST
  response streams (the hub never resumes them; `maxRetries` is 0,
  `http.ts:254`), so the SDK never marks them resumable
  (`streamableHttp.js:204-236`) and their end is not an error, whether the
  response was a result or a JSON-RPC error. When a response (result or error)
  has been delivered for every id, the framer completes the body in two steps:
  it closes the stream it gives the SDK (normal EOF after the terminal event),
  and separately cancels the upstream reader and destroys the upstream response
  and request (`http.ts:182-201` keeps closing and destruction apart, so closing
  alone would leave the socket open). Errors caused by this intentional teardown
  are suppressed. A POST body still open at its operation's end is completed
  the same way. A POST slot is released only after upstream teardown finished.
  GET streams keep their `id:` fields. At most 4 POST slots (including automatic
  protocol replies); a fifth request waits within its deadline. A request still
  waiting for a slot when its operation ends fails with `cancelled`; it never
  opens a POST between operations.
- **Dispose**: Streamable HTTP `terminateSession()` (DELETE) bounded 5 s, then
  `client.close()` always. 405, error or timeout is ignored after local cleanup.

### Docker (T6)

- **Installation ID**: the hub creates `install.json` (`{ installId: <uuid> }`)
  once in its data folder (written to a temporary file and linked into place,
  so it is never partial and never replaced; protected like `boot.json`) and
  never changes it. Pipe names and labels use it, never a path-derived hash. A
  bridge that cannot read it refuses Docker peers.
- **Pipe names**: one function `pipeName(kind, installId, id)` returns
  `\\.\pipe\wmh-<installId>-<kind>-<id>`; `installId` is a lower-case UUID,
  `id` is a lower-case bridge UUID or an agent id from the fixed
  `IntegrationAgentIdSchema` enum (already a safe slug). No other naming exists.
- **Bridge liveness**: each bridge listens on
  `pipeName('bridge', installId, bridgeId)` (`bridgeId` random UUID) for its
  whole life, before it writes any marker or starts any container; if the
  listener fails, the bridge refuses Docker peers. The server accepts and closes
  every connection at once and reads nothing. A probe connects with a 2 s bound
  and has three outcomes: **live** (connected), **absent** (the pipe does not
  exist: `ENOENT`), **unknown** (busy, access denied, timeout, anything else).
  For another bridge's resources only **absent** allows destructive recovery;
  **unknown** keeps everything and is retried at the next scan (this bridge's
  own abandoned launches are the one other case, see "Recovery").
- **Ownership evidence**: labels on the container are the primary evidence:
  `wmh.install=<installId>`, `wmh.agent`, `wmh.bridge`, `wmh.client=<nonce>`,
  `wmh.connector`. A marker per container session at
  `owned-agent-containers/<agentId>/<bridgeId>/<nonce>.json` records
  `{ nonce, connectorId, agentId, bridgeId, dockerEndpoint, daemonId, phase,
containerId? }` (`daemonId` from `docker info`, endpoint as pinned by
  `docker-profile.ts`). `phase` is `launching` (written before `docker run`, no
  `containerId`), `running` (with the immutable container ID read from
  `docker run --cidfile`) or `removing` (with the inspected immutable container
  ID and the daemon identity, written before the removal); `running` and
  `removing` require `containerId`.
- **Recovery mutex**: recovery for an agent runs while holding
  `pipeName('recovery', installId, agentId)` (listen succeeds for exactly one
  process; released by the OS on death). No timestamps decide ownership.
- **Pre-flight**: before writing a marker, the bridge checks the image exists
  locally (`docker image inspect`) and pulls it if missing, in separate CLI runs.
  The common failure (bad or unreachable image) therefore happens before any
  launch marker exists.
- **Acknowledged launch**: a launch counts as acknowledged only when the
  `--cidfile` holds the immutable container ID; the marker then moves to
  `running` with that ID. A CLI that exits, is cancelled, times out or is killed
  without a container ID leaves the launch **unacknowledged**, whether or not its
  bridge is alive (the runner and host cancel and kill on their own,
  `process-runner.ts:247`, `ProcessHost.cs:233`): the marker stays `launching`.
- **Removal is recorded first**: before removing any container that has a
  marker, the recoverer rewrites that marker to `removing` with the inspected
  immutable container ID and daemon identity (written and flushed), then
  removes the container, then confirms the ID is absent, then deletes the
  marker. A `removing` marker found later is resolved by confirming its ID is
  absent.
- **Recovery** runs at bridge start, before each Docker admission, and every
  60 s while this agent has any marker of a non-live bridge, or any
  `launching` or `removing` marker of this bridge whose nonce belongs to no
  live entry (a recovery obligation lasts as long as such a marker exists,
  through every phase until confirmed cleanup). Removal is authorised in
  exactly two cases: (a) the owning bridge probes **absent**; (b) the owner is
  this bridge itself and the nonce belongs to none of its live entries. Case (b)
  never applies to another bridge, live or unknown. It has two parts:
  - _Label sweep_ on the current daemon: list containers with
    `wmh.install=<installId>` and `wmh.agent=<agentId>`; the listing holds
    at most 4 096 64-hex IDs (else uncertain), processed 64 per round from a
    cursor that continues on the next round; one probe per owner per round;
    remove (by immutable ID after inspect, recording first as above) each whose
    `wmh.bridge` probes **absent**, and each whose `wmh.bridge` is this bridge
    but whose nonce belongs to no live entry (an abandoned launch of this
    bridge). This also removes a container whose creation completed late, with
    or without a marker. The two passes of a round share one deadline: they
    alternate their order, the owners of a marker batch are probed at the same
    time before that batch is processed, and each cursor advances only past an
    item that completed (removed, skipped as not authorised, or failed), or past
    an item the deadline interrupted in two consecutive rounds, which is
    revisited after the cursor wraps, so a pass that the deadline cut never
    starves the other.
  - _Marker pass_ for markers in case (a) or (b): daemon mismatch
    or daemon unavailable → uncertain-cleanup, keep. `running` or `removing` →
    remove if present, confirm the ID absent, delete the marker. `launching`
    (unacknowledged, bridge alive or not): **never deleted by time**; deleted
    only after a container with its nonce has been found and removed through
    the `removing` step. Until then it keeps the 60 s sweeps alive.
    Unacknowledged markers do not block admission, but more than 16 per agent
    do (bounded growth); the troubleshooting guide explains checking
    `docker ps -a --filter label=wmh.client=<nonce>` and deleting the marker by
    hand (explicit reconciliation).
- **Artifacts**: a clean disposal removes its own `--cidfile`. After the passes,
  a recovery round with a certain inventory removes the `--cidfile` of every
  session whose marker is confirmed absent (this bridge's and absent bridges'),
  and the empty folders of absent bridges; it never follows a link. A file it
  could not remove, a folder it could not list, a purge that failed, or a
  disposal that left its `--cidfile` keeps the 60 s recovery armed; a path
  that holds a link is left alone and owes nothing.
- **Admission**: refused only while this agent has an uncertain-cleanup marker,
  while it has more than 16 unacknowledged (`launching`) markers, or while any
  legacy marker exists.
- **Legacy markers** (pre-F03 `{ nonce, connectorId }` at the top level of
  `owned-agent-containers`): not auto-recovered (they carry no agent or bridge
  identity). They keep today's behaviour: Docker peers are refused while one
  exists. The troubleshooting guide explains manual cleanup.
- The Docker CLI runs under a session runner. Killing the CLI does not prove the
  container is gone or was never created; only inspect confirms removal.
- Docker connectors that need protected values stay unavailable to agents.

## Managed packages (F01)

A full `verifyPackage`, including the ancestor-`node_modules` check
(`verify.ts:118-120`), runs before every launch (in startup authorisation,
before secrets and process start, as today at `bridge.ts:285`) and once per
operation on a reused peer before its first SDK request. An operation that
starts a peer is not verified twice. State and credential checks (2–7) still
run before every page. This matches today's count (one verification per
connection, and today every request is a connection). `verifyPackage` gains a signal: it stops
walking and destroys open hash streams when the operation deadline passes, and
the operation then fails. Package size stays within D024's limits (500 MiB,
50 000 files). Remaining limit, in D025: a running Node process can load a file
that changes between verification and load.

## Secrets

- A lease lives with its peer (≤ 60 min + 60 s) and is never shared.
- `SecretLease.notAfter`: the earliest OAuth `expiresAt` among its values, or
  `null`. The entry is security-invalidated 30 s before it.
- `assertNoCredentialEcho` runs on every result against the producing peer's
  lease; its echo data is kept until every result of that peer is handled or
  discarded, then `dispose()` clears the buffers and maps it owns. Immutable JS
  strings made from secret bytes cannot be wiped (D019).
- Credential writes change the binding id or the reference record (most also
  clear approval; an OAuth write re-approves, `auth/credentials.ts:153`), so
  validation steps 4–5 invalidate the old peer.

## Shutdown

One idempotent sequence for stdin end, SIGINT, SIGTERM, `uncaughtException` and
`unhandledRejection`: close admission; stop watchers; invalidate every entry,
cancelling startups and waiters; dispose all concurrently against one shared
5 s deadline, passing the remaining budget to Docker cleanup; exit. The bridge
pipe disappears with the process, so unfinished Docker cleanup is recovered by
the next bridge of this agent. Native trees do not depend on this sequence: host
pipe EOF closes their Job Objects.

## Security properties (narrow and testable)

1. **Revalidation**: no SDK request is dispatched unless validation 1–7 passed
   after the caller took exclusive use, with no `await` between the final gate
   and the dispatch.
2. **Invalidation**: after a security invalidation the peer serves no further
   request and the in-flight result is not returned.
3. **Lifetime**: no new operation is admitted on an entry at or after 60 min
   from its start; an operation admitted before then may finish within its
   original deadline. No entry is kept idle past 5 min plus one timer tick
   (fake clock). Session processes are bounded by the host deadline
   60 min + 60 s (real host).
4. **Containment**: killing the bridge, or the host, ends the native tree
   including a grandchild within 5 s (real Windows test).
5. **Docker ownership**: cleanup removes only containers carrying this
   installation's and this agent's labels, by immutable ID after inspect, and
   only when their bridge probes **absent** or they are this bridge's own
   containers whose nonce belongs to no live entry. A container of another
   bridge that probes live or unknown (busy, denied, timed out) is never
   removed.
6. **Budgets**: each table row is enforced before SDK parsing; a breach closes
   the session.
7. **No bridge-owned sharing**: two agents' bridges never share an entry, lease
   or transport. Server-side sharing is outside the hub's control, not claimed.
8. **Diagnostics**: agents get only the existing fixed texts; the pool logs or
   stores no secret, argument or server output.
9. **Echo detection**: lease values in the representations
   `assertNoCredentialEcho` checks are refused. Split or re-encoded values are
   not detected: detection, not a secrecy guarantee.
10. **Committed changes**: a registry change committed before a dispatch
    snapshot begins is seen by that snapshot, so an affected connector's next
    SDK request is refused. A snapshot that reads a blocked ledger refuses that
    dispatch and, in reconciliation, invalidates idle entries. A ledger that is
    `prepared` and then `committed` between two snapshots may never be seen; only
    its committed result is caught.

## Acceptance

- Counter fixture through the real bridge: 1, 2, 3 across three calls; 1 again
  after idle expiry (fake clock) and after a boot ID change, with no
  "unavailable" on the request that discovers the restart.
- The transition matrix in the plan passes.
- Real-adapter tests: Windows host session > 1 MiB each direction; HTTP fixture
  > 64 requests and > 1 MiB cumulative, quiet GET stream during repeated calls,
  > SSE framing limits, DELETE on dispose; Docker with a real daemon locally when
  > available (skipped and reported otherwise).
- SSH live smoke (`open-session` → `read-session-output`) is manual and needs the
  user's consent for a target.
- All 13 gates green; existing bridge tests unchanged except those asserting one
  process per call, listed in the PR.
