# Closed by default tool permissions

An optional connector `defaultToolPolicy` selects `allow` or `block` for tool
names without an explicit entry in `toolPolicies`. An absent field preserves
legacy behavior (`allow`). The permission editor labels these choices **Full
permission** and **Closed until reviewed**. Existing connectors are not changed
automatically. Selecting Closed can hide previously unconfigured tools; add
explicit Full permission entries for the reviewed tools you want to retain.

Named `allow`, `ask` and `block` entries override the default. The managed bridge
uses the same authorization rule for catalog publication and dispatch. A new
tool announced during discovery or `tools/list_changed` remains hidden and
uncallable under default-block until an explicit rule allows it. Unsupported
names and malformed policies fail closed. Closed tools cannot be invoked by
guessing their names or reusing a stale advertised route. These exposure rules
do not change the upstream provider's API-key privileges.

Permission saves use current registry and connector revisions. An older editor
that omits the new default preserves the stored default; omission cannot reset
a guarded connector to allow. Connector definition edits and managed package
replacements retain its policy. State revision and the separate policy hash
change with authorization, without invalidating execution approval for
unchanged code. One-time `ask` approval includes the default in its fingerprint.

Pooled requests recheck authorization inside the serialized snapshot callback,
at the pool's synchronous send gate, after verification, startup or queueing.
Catalog publication takes another authorized snapshot after asynchronous cache
reads/writes. This prevents an earlier permissive observation from authorizing
a new dispatch after a later observed revocation. It does not undo or guarantee
instant cancellation of an external operation already dispatched. Non-pooled
requests check current authorization before connection and again immediately
before the explicit call.

## Direct snapshots and compatibility

Native direct launchers and Docker/remote profile materialization cannot enforce
managed bridge policies. They refuse default-block configurations even when all
currently named tools have explicit allow entries. Remove an existing direct
materialization through its supported workflow before narrowing permissions;
the policy mutation refuses to leave such a bypass in place. Normal managed
agent entries continue to point at the enforcing bridge.

Retained materialization records do not capture immutable connector membership.
Restrictive policy saves therefore require all retained direct snapshots to be
dematerialized, even if their profiles no longer list the connector. Current
profile membership cannot prove that a stale snapshot is harmless.

The new field is persisted only when needed for default-block. Strict older
connector/state schemas do not recognize it and must refuse the guarded state,
not strip it or fall back to allow. Do not hand-edit the field into an older
live runtime or mix compatible and incompatible bridge versions. Roll out an
immutable tested artifact and reconnect the owned agent cohort before enabling
guarded exposure. No automatic deployment, default change, credential mutation
or provider operation is performed by this feature.

Before the first guarded save, keep a private consistent pre-change state and
external-config backup. A pre-feature binary may be unable to read guarded
state. Downgrading therefore needs supported shutdown, confirmation that all
writers have stopped, preservation of the failed/current data and restoration
of the full verified compatible preimage. Deleting the new policy field is not
a safe substitute: doing so would authorize unknown names. A successful schema
round trip is not proof of live runtime rollback or provider functionality.
