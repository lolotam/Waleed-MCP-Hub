# F03 — Persistent connector sessions: implementation plan

Spec: `docs/specs/F03-persistent-sessions.md` · Decision: D025

## Ground rules

1. Behaviour of capability checks, the hub UI and every path outside the agent
   bridge is unchanged. Every new limit or mode is opt-in (`session: true`,
   `beginOperation()`); without it the code behaves exactly as today.
2. No secret value, server output, argument or tool result is logged, stored or
   put in an error. Agents get the existing fixed texts only.
3. Existing tests stay green unchanged, except bridge tests that assert one
   process per call; each rewritten test is listed in the PR with the reason.
4. New dependencies: none.
5. Every timer is injectable (`now`, `setTimer`, `clearTimer`); real-time tests
   exist only where a fake cannot prove the property (Windows host, HTTP fixture,
   Docker daemon).
6. Fake-peer tests prove pool logic; they are never cited as proof of
   containment, secrecy or remote behaviour.

Order: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8. Tests land with each task.

### T1 — Session mode in the process runner and the C# host

Files: `adapters/native/process-runner.ts`, `adapters/native/windows/ProcessHost.cs`,
`ports.ts` (request type).

- `ProcessRequest.session?: { outputLimitBytes ≤ 64 MiB, inputLimitBytes ≤ 16 MiB }`;
  a runner created with `session: true` accepts `timeoutMs ≤ 3_660_000`
  (`SESSION_MAX_TIMEOUT_MS`); others keep `MAX_TIMEOUT_MS = 600_000` and 1 MiB.
- The C# host validates and enforces the same values from the request (output
  limit, cumulative input limit, deadline); a non-session request keeps today's
  checks byte for byte.
- Session runs stream stdout/stderr and keep only byte counts: no chunk arrays,
  no aggregate strings, no output in the result.
- Stream callback gains `stderr(bytes)` (count only) so the transport can
  account both streams.
- Tests (real Windows host): a session run passes 3 MiB out and 3 MiB in across
  many valid 32 KiB messages; breaching 64 MiB out / 16 MiB in ends it with
  `output_limit` / cancellation; non-session limits unchanged (1 MiB + 1 byte
  refused; 600 001 ms refused); retained memory stays flat across 1 000 small
  messages (no arrays grow).

### T2 — Operation accounting in the stdio transport

Files: `adapters/mcp/stdio.ts`.

- `beginOperation()` / `endOperation()`; budgets from the spec table (operation,
  session, between operations). Bytes are raw Buffer lengths of stdout+stderr
  chunks; the 128 KiB line cap is measured in bytes on the raw buffer, not on
  the decoded string.
- Messages received are counted before SDK delivery; messages and bytes sent
  (including ping replies and error replies between operations) are counted in
  `send()`. A breach aborts the transport with `limit_exceeded`.
- Without `beginOperation()` ever being called: exactly today's behaviour.
- Tests: stderr flood breaches; a multibyte line of 44 000 three-byte characters
  (132 000 bytes > 131 072, but only 44 000 characters) breaches; a line split across chunks is
  counted once; more than 32 idle notifications in one between-operations
  window breach; idle pings answered across five fake-clock minutes within the
  between-operations budget keep the session alive; 600 messages across two
  operations pass; 513 in one operation breach.

### T3 — Session pool

Files: new `integrations/session-pool.ts`.

- `serving` map guarded by identity checks; `live` set owns capacity and every
  entry's own cleanup; `validatedSeq` per entry; operation-owned
  `AbortController` per SDK request with forwarding listeners removed at
  operation end.
- API: `createSessionPool({ start, now, setTimer, clearTimer, limits })` where
  `start(connector, lifetimeSignal) → Promise<PooledPeer>`;
  `use(connectorId, request signal, validate, operation)` runs `validate()` then
  `operation(peer)` with exclusive use; `invalidate(connectorId | 'all')`;
  `retire(connectorId | 'all')`; `close(deadlineMs)`.
- States, generations, identity-checked removal, idempotent dispose, capacity
  counted until disposal resolves, shared startup with its own 20 s deadline and
  controller, waiter cancellation without cancelling others, death observation
  registered before `initialize`, idle 5 min, max life 60 min (graceful), lease
  `notAfter` timer (invalidation).
- `operation` throwing a timeout/cancel after dispatch → invalidation of that
  entry before the error is returned.
- Tests use the transition matrix below with a fake clock and fake peers.

### T4 — Bridge integration

Files: `integrations/bridge.ts`, `auth/bindings.ts` (`notAfter`),
`apps/server/src/main.ts` + a small `runtime/boot.ts` (boot record).

- `createAgentBridge(read, pool)`. Validation 1–7 runs inside `use()` before each
  SDK request (each `tools/list` page and the `tools/call`): `verifyPackage`
  first, the synchronous final gate last.
- Pooled peers use `client.request(...)` with explicit result schemas, never
  `listTools()`/`callTool()`. A peer's `tools/list_changed` is forwarded (≤ 1/s).
- Boot mismatch inside `use()` = replacement in the same request (retire, start,
  validate, dispatch once); a listing restarts that connector once.
- `read()` becomes the stable snapshot: ledger, registry, boot record, ledger
  again; retry once on mismatch.
- One bridge-wide snapshot mutex for dispatch and reconciliation reads; the
  sequence number is assigned inside it after a successful read.
- Every read, successful or failed, gets a sequence number inside the mutex.
- Poll `state.json`, `safety.json`, `boot.json`; reconciliation decides and marks
  entries synchronously inside the snapshot mutex right after its read (only
  disposal runs later), and only for entries whose `validatedSeq` is lower than
  its sequence.
- Final gate checks the clock against `startedAt + 60 min` for an operation's
  first SDK request and requires a dispatchable state.
- Startup authorisation for new peers (state checks, then cancellable
  `verifyPackage`) before secret resolution and launch; dispatch validation
  verifies a reused package peer once per operation.
- Final gate distinguishes admission (serving, not retiring, clock < max age)
  from continuation (later pages of the same operation, retiring allowed).
- `verifyPackage(connector, root, signal)`: cancellable (stops the walk,
  destroys hash streams) at the operation deadline.
- Echo data of a lease stays until every operation result of that peer has been
  handled; `assertPublic` uses the producing peer's lease.
- Hub creates `install.json` once (create-exclusive) and writes `boot.json`
  atomically after `safety.reconcile` succeeds; the bridge
  fails closed when it is missing or malformed (existing bridge tests gain a
  boot record fixture).
- Shutdown sequence from the spec, wired to stdin end, SIGINT, SIGTERM,
  `uncaughtException`, `unhandledRejection`.
- Tests: counter fixture 1, 2, 3 through the real bridge; every bridge row of the
  matrix; boot ID change; ledger-only block with no traffic.

### T5 — Remote session mode

Files: `adapters/mcp/http.ts`, `integrations/bridge.ts` (dispose hook).

- Session budgets replace lifetime counters when `session: true`; destination
  checks on every request unchanged.
- Framing before the SDK: JSON bodies ≤ 1 MiB with array elements counted; a
  pass-through SSE framer counts events, caps one event at 1 MiB and the pending
  buffer at 1 MiB.
- Socket timeout 5 s until response headers; GET and legacy SSE main streams then
  bounded by idle/max life.
- POST bodies tracked with their request ids and upstream request/response; SSE
  `id:` fields dropped on POST response streams; completion = close the stream
  given to the SDK, then cancel the upstream reader and destroy the upstream
  response and request, suppressing errors from that teardown; the slot is
  freed after teardown; at most 4 POST slots.
- Dispose: Streamable HTTP `terminateSession()` bounded 5 s, then `close()`
  always.
- Tests against the local fixture server (127.0.0.1 fixture origin): 100
  requests and 3 MiB across operations pass; a quiet GET stream during repeated
  calls survives; a completed POST SSE response does not kill the session; a
  200 KiB image result and a 900 KiB tool catalog pass; a multiline SSE event
  over 1 MiB, an unterminated event over 1 MiB and a JSON array of 513 messages
  each breach; an incomplete event across an operation boundary counts against
  the between budget; DELETE is sent on dispose and a 405/timeout does not
  block local cleanup; 404 for the session → death and a fresh peer next
  request; legacy SSE main stream end → death; a server that keeps a POST SSE
  stream open after the response: the body is ended, a second operation
  succeeds, and the first operation's deadline passing later has no effect;
  the same with event ids for a result response and for a JSON-RPC error
  response: no `onerror`, no reconnection, session alive; after 50 successful
  operations the fixture sees every POST connection closed and never more than
  4 open at once;
  non-session mode unchanged.

### T6 — Docker ownership and pooling

Files: `integrations/docker-transport.ts`, `adapters/mcp/container-cleanup.ts`.

- One `pipeName(kind, installId, id)` function for every pipe;
- Installation ID from `install.json` in pipe names and the `wmh.install` label;
  bridge liveness pipe listening before any marker or container; probe with
  three outcomes (live / absent / unknown, 2 s bound); removal only when the
  owner probes absent, or for this bridge's own nonce with no live entry; per-agent recovery pipe mutex; per-session markers under
  `<agentId>/<bridgeId>/` with `dockerEndpoint`, `daemonId` and `phase`
  (`launching`; `running` + ID from `--cidfile`; `removing` + inspected ID and
  daemon identity); recovery = label sweep
  plus marker pass, at start, before admission and every 60 s while a non-live
  bridge's marker or any unresolved `launching` marker remains; image
  pre-flight before any marker; acknowledged only with a `--cidfile` ID; a
  `launching` marker is deleted only after its container has been found and
  removed via a recorded `removing` step (never by time, bridge alive or not);
  this bridge's own abandoned `launching`/`removing` markers keep the 60 s
  recovery running;
  the label sweep also removes this bridge's own abandoned launches; more than
  16 unresolved markers block that agent; uncertain-cleanup markers block that
  agent only; legacy markers
  block Docker as today and are never auto-removed. Docker CLI under a session
  runner.
- Tests with a fake Docker command: two Docker connectors in one bridge; two
  bridges of different agents; two bridges of the same agent (live sibling not
  reaped, including after a simulated long pause); two concurrent recoverers
  (exactly one holds the recovery pipe); recoverer killed mid-recovery (mutex
  released by the OS, next recoverer proceeds); crash right after start, one
  replacement bridge and no further admissions → orphan removed; daemon/context
  changed → uncertain marker kept; legacy marker present → Docker refused, marker
  untouched; failed removal → uncertain marker blocks this agent only; a live
  owner whose pipe instances are all busy (paused) probes unknown and is not
  reaped; two bridges opening the data folder through differently cased paths
  share one recovery mutex; a container that appears after two empty listings
  and after its bridge died is removed by the next label sweep; a `launching`
  `launching` marker survives any number of empty sweeps and bridge restarts,
  and its container appearing later (no new admissions) is removed by a 60 s
  sweep; a CLI timed out during creation under a live bridge with empty
  listings keeps its marker, and the late container is removed; a missing image
  fails in pre-flight and leaves no marker; a recoverer killed right after
  removing a container and before deleting its marker leaves a `removing`
  marker that the next recoverer resolves; under a live bridge, a failed
  removal and, separately, a failed absence confirmation of its own abandoned
  container are both retried by the 60 s recovery with no new admission or
  restart; the own-nonce exception never removes another live bridge's
  container (negative test) and does remove this bridge's abandoned one
  (positive test); a 17th unresolved launching marker blocks that agent. Real
  named pipes are used in these tests (Windows primitives, not fakes). Real-daemon test (local, skipped
  and reported when Docker is unavailable): crashed bridge's container removed
  by the next bridge start.

### T7 — Windows containment and lifetime tests

Files: `tests/bridge-sessions.windows.test.ts`, fixtures in `tests/fixtures/`.

- Real bridge, synthetic stateful server that spawns a grandchild:
  (a) `TerminateProcess` on the bridge → server and grandchild gone within 5 s;
  (b) kill the host process → same; (c) shutdown during startup; (d) idle expiry
  with a shortened limit injected through a test-only constructor option.

### T8 — Docs

`docs/DECISIONS.md` (D025 with the residual limits), `docs/guides/adding-mcps.md`
("Current limits"), `docs/guides/troubleshooting.md` (replace "A tool works once,
then forgets a session"), `docs/STATUS.md`, `docs/ROADMAP.md` (item 3), this spec
and plan under `docs/specs` and `docs/plans`.

## Transition matrix (T3/T4 tests)

| #   | Situation                                                                                        | Expected                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1   | Two requests start the same connector concurrently                                               | one startup; both served in order                                                                                    |
| 2   | Startup fails                                                                                    | every waiter fails; no entry; capacity freed                                                                         |
| 3   | One waiter cancels during a shared startup                                                       | others still served; startup not cancelled                                                                           |
| 4   | Last waiter cancels during startup                                                               | startup cancelled; entry disposed                                                                                    |
| 5   | Peer dies during startup                                                                         | waiters fail; no entry                                                                                               |
| 6   | First request's deadline passes after it succeeded                                               | peer still alive and reused                                                                                          |
| 7   | Call times out after dispatch                                                                    | entry invalidated; not reused; no replay                                                                             |
| 8   | Connector edited / disabled / unapproved while a request is queued                               | queued request refused at validation; entry invalidated                                                              |
| 9   | Same while starting                                                                              | validation before first dispatch refuses                                                                             |
| 10  | Same between two `tools/list` pages                                                              | connector dropped from the list; entry invalidated                                                                   |
| 11  | Credential reference changed / not present / owner removed                                       | invalidated at next validation and by the watcher                                                                    |
| 12  | OAuth `notAfter` reached with no registry change                                                 | invalidated by timer                                                                                                 |
| 12a | Call admitted 31–89 s before `notAfter`                                                          | refused before dispatch; no SDK request sent                                                                         |
| 13  | Ledger `prepared` and seen by a reconciliation snapshot, no traffic                              | idle entries kept; requests fail closed; `needs_review` invalidates idle entries                                     |
| 14  | Ledger blocked during acquisition                                                                | refused with "registry unavailable"                                                                                  |
| 15  | Ledger recovers                                                                                  | next request starts fresh                                                                                            |
| 16  | Boot ID changes, files otherwise unchanged                                                       | idle entries closed; busy ones retire after the call; next fresh                                                     |
| 17  | Max life reached while busy                                                                      | call finishes; entry retired; next request fresh                                                                     |
| 18  | Max life reached while a replacement needs the last slot                                         | request fails "unavailable"; no 17th entry                                                                           |
| 19  | Old generation's death/timer callback after replacement                                          | no effect on the new entry                                                                                           |
| 20  | 17th connector with all 16 busy                                                                  | fails "unavailable"                                                                                                  |
| 21  | Security invalidation while a secret-bearing result is in flight                                 | result discarded; echo data held until handling ends                                                                 |
| 22  | Shutdown during startup and with a stuck Docker cleanup                                          | exits within 5 s; marker kept                                                                                        |
| 23  | Package file (lazily imported) changed between calls                                             | full verify fails; invalidated                                                                                       |
| 24  | `node_modules` added above the packages folder between calls                                     | full verify fails; invalidated                                                                                       |
| 25  | Original request deadline passes during a later operation                                        | no `notifications/cancelled` sent; later operation unaffected                                                        |
| 26  | Retiring A, replacement B serving, then A's operation finishes                                   | A disposes itself and frees its slot; B untouched                                                                    |
| 27  | Reconciliation read paused, registry changes, replacement starts                                 | stale result does not touch the replacement                                                                          |
| 27b | Reconciliation read paused inside the mutex; dispatch read requested                             | dispatch waits; sequences strictly increase in completion order                                                      |
| 27d | Reconciliation marking in progress; dispatch acquisition requested; old entry's disposal delayed | dispatch waits for the marking to finish; the delayed disposal of the old generation does not affect the replacement |
| 27e | Failed reconciliation read, then a newer successful dispatch validation                          | the failure was applied inside the mutex before the newer snapshot; the newly validated entry is untouched           |
| 27c | Snapshot retry (ledger changed mid-read) inside the mutex                                        | one sequence number for the successful read only                                                                     |
| 28  | Boot ID changes; request arrives before the watcher reconciles                                   | request served on a fresh entry; no "unavailable"                                                                    |
| 28a | Boot ID changes with 16 live entries                                                             | predecessor disposed first; request served on a fresh entry                                                          |
| 29  | Boot record deleted after a valid one                                                            | registry unavailable until the hub rewrites it                                                                       |
| 30  | Credential change during `verifyPackage`                                                         | final gate refuses; invalidated                                                                                      |
| 31  | Peer sends `tools/list_changed`                                                                  | forwarded once to the agent; no SDK auto-refresh                                                                     |
| 32  | Tools on several pages, then a call to a first-page tool                                         | call passes through; no client-side schema validation                                                                |
| 33  | Validation crosses the 60 min boundary, retirement timer withheld                                | final gate refuses by clock; fresh entry next request                                                                |
| 34  | Package verification exceeds the operation deadline                                              | walk stops, streams destroyed, operation fails, no dispatch                                                          |
| 35  | Eight-page listing of a package connector                                                        | `verifyPackage` runs once; state checks run before every page                                                        |
| 36  | Modified package, no peer yet                                                                    | zero secret resolutions, zero launches; refused                                                                      |
| 37  | Max-age timer fires between pages of an admitted listing                                         | remaining pages served within the 20 s deadline; then retired                                                        |
| 38  | Replacement launch after invalidation of a package peer                                          | its own pre-launch verification runs                                                                                 |

## Round 1 debate verdicts (Codex gpt-6-astra, high)

| #   | Finding                                         | Sev | Verdict | Change                                                                 |
| --- | ----------------------------------------------- | --- | ------- | ---------------------------------------------------------------------- |
| 1   | Session limits stop at the TS runner            | P1  | accept  | T1 covers C# host input/output/deadline; real host tests               |
| 2   | First request's signal kills the peer           | P1  | accept  | entry-owned lifetime; separate startup controller; rows 3, 4, 6        |
| 3   | SDK timeout does not stop the server            | P1  | accept  | timeout/cancel after dispatch = invalidation; no replay; row 7         |
| 4   | HTTP changes are mandatory                      | P1  | accept  | T5 session budgets, stream inactivity policy, fixture tests            |
| 5   | Validation before the queueing race             | P1  | accept  | validation inside exclusive use, before each SDK request; rows 8–10    |
| 6   | Credential stamps use nonexistent fields        | P1  | accept  | stamp from real `SecretReference` fields; `lease.notAfter`; rows 11–12 |
| 7   | Invalidation conflated with retirement          | P1  | accept  | two distinct paths; echo data lifetime; row 21                         |
| 8   | Generation ownership and capacity               | P1  | accept  | generations, identity removal, capacity until disposed; rows 18–20     |
| 9   | Cheap package checks leave a window             | P1  | accept  | full `verifyPackage` before every operation; rows 23–24                |
| 10  | Docker markers block multiple peers             | P1  | accept  | per-session markers; uncertain-cleanup-only admission                  |
| 11  | Docker recovery lacks ownership evidence        | P1  | accept  | agent/bridge-scoped markers, heartbeat staleness, recovery lock        |
| 12  | Ledger changes invisible to idle peers          | P1  | accept  | watch ledger too; serialised reconciliation; snapshot re-read; 13–15   |
| 13  | Clean restart cannot trigger re-init            | P1  | accept  | `boot.json` boot ID; non-goal text fixed; row 16                       |
| 14  | 5 s shutdown does not fit cleanup               | P1  | accept  | single idempotent sequence; shared deadline; markers kept; row 22      |
| 15  | stdio accounting undefined                      | P2  | accept  | T2: windows, raw bytes, stderr, byte line cap, idle budget             |
| 16  | Raised limits retain up to 1 GiB                | P2  | accept  | session runs keep counts only; memory test                             |
| 17  | Closing the client does not end an HTTP session | P2  | accept  | bounded `terminateSession()` then `close()`                            |
| 18  | Claimed properties exceed tests                 | P2  | accept  | properties restated narrowly; real-adapter tests added                 |

## Round 2 debate verdicts (Codex gpt-6-astra, high)

Round 1 items 1, 3, 6, 7, 9, 10, 14, 16, 17 and 18 resolved. Items left partly
open are closed by the new findings below (2 → N1; 4 → N8; 5 → final gate after
`verifyPackage`; 8 → N3; 11 → N5, N6; 12 → N4, N14; 13 → N7; 15 → N2).

| #   | New finding                                         | Sev | Verdict | Change                                                                 |
| --- | --------------------------------------------------- | --- | ------- | ---------------------------------------------------------------------- |
| N1  | Completed requests can still send cancellations     | P1  | accept  | operation-owned controllers, listeners detached; row 25                |
| N2  | Zero idle stdin rejects pings                       | P1  | accept  | bidirectional between-operations budget; idle ping test                |
| N3  | Old-generation callbacks must still clean up        | P1  | accept  | `live` set; identity checks only on `serving`; row 26                  |
| N4  | Reconciliation can hit new peers with old snapshots | P1  | accept  | read sequence vs `validatedSeq`; captured entry; row 27                |
| N5  | Recovery lock can have several owners               | P1  | accept  | OS-held named-pipe mutex; no timestamp ownership                       |
| N6  | Legacy markers cannot meet the ownership rule       | P1  | accept  | legacy markers keep today's blocking behaviour; no auto-removal        |
| N7  | Restart recovery depends on the watcher race        | P1  | accept  | boot mismatch = in-request replacement; row 28                         |
| N8  | HTTP counters cannot enforce message budgets        | P1  | accept  | JSON/SSE framing before the SDK; T5 tests                              |
| N9  | Stream completion conflated with death              | P2  | accept  | rules by stream role; POST completion normal                           |
| N10 | Recovery skips a fresh crash's marker               | P2  | accept  | pipe liveness (immediate) + 60 s rescans; crash test                   |
| N11 | Markers omit the Docker daemon                      | P2  | accept  | `dockerEndpoint` + `daemonId`; mismatch keeps marker                   |
| N12 | 128 KiB remote cap breaks valid responses           | P2  | accept  | remote message cap 1 MiB (today's allowance); 200 KiB/900 KiB fixtures |
| N13 | Missing boot record is not proof                    | P2  | accept  | fail closed on missing/malformed boot record; row 29                   |
| N14 | Polling cannot prove the blocked-ledger guarantee   | P2  | accept  | property 10 narrowed to observed blocks + committed changes            |
| N15 | Reused clients cache partial tool metadata          | P2  | accept  | `client.request` with explicit schemas; forward peer list_changed      |

## Round 3 debate verdicts (Codex gpt-6-astra, high)

Round 2 items resolved: R1-2, R1-4, R1-8, R1-13, R1-15, N1–N3, N5–N9, N11–N13,
N15. Partly resolved and closed here: R1-5 → R3-6; R1-11 → R3-2, R3-3, R3-4;
R1-12 and N4 → R3-1; N10 → R3-2, R3-4; N14 → row 13 and property 10 reworded.

| #    | Finding                                              | Sev | Verdict | Change                                                                  |
| ---- | ---------------------------------------------------- | --- | ------- | ----------------------------------------------------------------------- |
| R3-1 | Read-start numbers are not freshness tokens          | P1  | accept  | one snapshot mutex; number assigned on completion; rows 27b, 27c        |
| R3-2 | Failed pipe connection is not proof of death         | P1  | accept  | live/absent/unknown probe; only absent removes; listener before markers |
| R3-3 | Path-derived names can split the mutex               | P1  | accept  | `install.json` installation UUID in pipe names and labels               |
| R3-4 | Bridge death does not fence a pending creation       | P1  | accept  | `launching`/`running` phases, `--cidfile`, label sweep, 10 min rule     |
| R3-5 | POST SSE streams stay open across operations         | P2  | accept  | per-body tracking, nonfatal cancel on completion, ≤ 4 open bodies       |
| R3-6 | Final gate relies on retirement callbacks            | P1  | accept  | clock check against `startedAt + 60 min`; dispatchable state; row 33    |
| R3-7 | Package verification uncancellable, cost understated | P2  | accept  | once per operation, cancellable verify; rows 34, 35                     |

## Round 4 debate verdicts (Codex gpt-6-astra, high)

Resolved: R1-5, R1-12, N4, N14, R3-1, R3-2. Partly resolved and closed here:
R1-11 and N10 → R4-1, R4-5; R3-3 → R4-5; R3-4 → R4-1; R3-5 → R4-2; R3-6 → R4-4;
R3-7 → R4-3.

| #    | Finding                                            | Sev | Verdict | Change                                                               |
| ---- | -------------------------------------------------- | --- | ------- | -------------------------------------------------------------------- |
| R4-1 | Launching-marker expiry drops the recovery trigger | P1  | accept  | never expire by time; live-bridge launch resolution; cap 16 + manual |
| R4-2 | POST completion after an error response fails      | P2  | accept  | drop SSE `id:` on POST streams; result and error both terminal       |
| R4-3 | First-launch verification ambiguous                | P1  | accept  | startup authorisation before secrets/launch; rows 36, 38             |
| R4-4 | Retiring gate rejects admitted pages               | P2  | accept  | admission vs continuation in the final gate; row 37                  |
| R4-5 | Recovery pipe name uses superseded identifier      | P3  | accept  | single `pipeName(kind, installId, id)`                               |
| R4-6 | Row 27b asks for a forbidden interleaving          | P3  | accept  | rows 27b and 27d rewritten                                           |

## Round 5 debate verdicts (Codex gpt-6-astra, high)

Resolved: R3-3, R3-6, R3-7, R4-2 to R4-6. Partly resolved and closed here:
R1-11, N10, R3-4 and R4-1 → R5-1, R5-2; R3-5 → R5-3.

| #    | Finding                                     | Sev | Verdict | Change                                                                  |
| ---- | ------------------------------------------- | --- | ------- | ----------------------------------------------------------------------- |
| R5-1 | CLI exit under a live bridge proves nothing | P1  | accept  | acknowledged only with `--cidfile` ID; image pre-flight; marker kept    |
| R5-2 | Cleanup can strand a launching marker       | P2  | accept  | `removing` marker with ID written before removal                        |
| R5-3 | POST EOF does not release the connection    | P2  | accept  | explicit upstream cancel/destroy; slot freed after teardown; 50-op test |
| R5-4 | Failed reads have no freshness token        | P2  | accept  | every read numbered; reconciliation applied inside the mutex; row 27e   |
| R5-5 | Lifetime property contradicts continuation  | P3  | accept  | property 3 restated as admission of new operations                      |

## Round 6 debate verdicts (Codex gpt-6-astra, high)

No P1 findings. Resolved: R3-4, R3-5, R5-1 to R5-5. Partly resolved and closed
here: R1-11, N10, R4-1 → R6-1.

| #    | Finding                                          | Sev | Verdict | Change                                                                 |
| ---- | ------------------------------------------------ | --- | ------- | ---------------------------------------------------------------------- |
| R6-1 | `removing` can stop recovery under a live bridge | P2  | accept  | own abandoned `launching`/`removing` markers keep 60 s recovery; tests |
| R6-2 | Ownership property forbids own-nonce cleanup     | P3  | accept  | two authorised cases stated in spec, property 5 and plan; +/− tests    |
| R6-3 | Row 27d contradicts in-mutex reconciliation      | P3  | accept  | row 27d rewritten: dispatch waits; delayed old disposal is harmless    |

## Tests

Unit tests per task (fake peers, fake clock) for logic; real Windows host tests
(T1, T7); local HTTP fixture tests (T5); Docker real-daemon test local-only
(skipped and reported in CI when unavailable). SSH live smoke is manual and
needs the user's consent for a target.
