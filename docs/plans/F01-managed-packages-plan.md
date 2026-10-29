# F01 plan — Managed npm packages

Spec: [F01-managed-packages.md](../specs/F01-managed-packages.md). Branch
`feat/f01-managed-packages`, one PR against `main`.

## Global constraints

Quoted verbatim into every implementer brief.

1. For packages, never run `npx`, `npm exec`, `cmd.exe`, `.cmd`, `.bat`, a shell, or
   any package lifecycle script. The bundled npm runs only as
   `node.exe <bundled npm>\bin\npm-cli.js` through `createWindowsProcessRunner`, with
   `--ignore-scripts`, no `PATH` and no inherited environment. The hub's existing
   PowerShell helpers are not package execution and stay as they are.
2. Production code contacts only `registry.npmjs.org:443`, through the allow-list
   proxy (npm) or the fixed-origin fetcher (hub). Tests inject a loopback registry
   through a port; production code has no flag, variable or setting that changes it.
3. Never print, log or return installer output, registry bodies, user-profile paths,
   environment values or secret values. Return sanitized error codes from the spec's
   list only.
4. Every path the hub reads or writes under an install folder passes `assertNoLinks`
   and resolves inside the folder; regular files with `nlink > 1` are rejected.
5. Do not change behaviour for connectors without a `package` record. Existing tests
   must pass unchanged; do not edit an existing test to make it pass.
6. Clients can never supply or change a `package` record; only the install job
   creates one.
7. Match the surrounding code style (dense TypeScript in `hub-core`, Zod strict
   objects in `contracts`, `HubError`/`RuntimeFault`).
8. Do not commit or push. Edit only the files your task lists.
9. Gates: `npm run format:check`, `npm run typecheck`, `npm run lint`,
   `npm run check:boundaries`, `npm run check:secrets`, `npm test`, `npm run build`,
   `npm run test:windows-runtime`, `npm run test:windows-secrets`,
   `npm run test:windows-integrations`. Node 24 (`E:\Dev\Tools_and_Utilities\nodejs24`).

## Tasks

Order: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10. Each task's tests are
written by the test lane right after it lands.

### T1 — Contracts

Files: `packages/contracts/src/index.ts`, `packages/contracts/src/imports.ts`,
`packages/contracts/src/runtime.ts`, `packages/contracts/src/auth.ts` (if
`ManualMcpSchema` lives there).

- `PackageProvenanceSchema` (strict, fields per spec) as optional `package` on the
  native variant of `ConnectorSchema` and of `ImportDefinitionSchema`.
- Package preview/resolve/install request and result schemas, job phases, error-code
  enum, `package_modified` added to the capability/observation reason enums.
- Import entry `packageProposal` shape.
- Acceptance: `package` rejected on remote/docker; `ManualMcpSchema` rejects a
  `package` field; all existing state fixtures parse.

### T2 — Registry and approval

Files: `packages/hub-core/src/runtime/registry.ts`,
`packages/hub-core/src/integrations/manual.ts` (reject `package` input only),
`packages/hub-core/src/auth/credentials.ts` and `packages/hub-core/src/auth/bindings.ts`
(managed-connector environment policy on credential writes).

- `executionDefinition()` includes `package`.
- `checkedDefinition()` takes an optional context `{ nodeExecutable, packagesDir,
trustedPackage? }`: a `package` is accepted only when `trustedPackage` equals it
  (set by the internal save/replace call, or by `edit_connector` from the stored
  connector), the executable must be the hub's `node.exe`, the first argument
  `--no-global-search-paths` and the second the derived entry path.
- `edit_connector`: load the stored connector before validating; follow the spec's
  three editing rules exactly (refuse a supplied `package`; for a managed connector
  refuse mode/executable/fixed-argument changes and rebuild from allowed fields plus
  stored provenance; never add one to an unmanaged connector).
- `/^NODE_/i` environment names refused on package connectors in `edit_connector`
  and in the credential API before any secret is stored or state committed.
- Internal `replacePackage` operation (used by T7) with a connector-revision check.
- Acceptance: any package field change changes `definitionHash`; a registry
  operation carrying a `package` without the trusted context is refused; a first
  argument outside the install is refused; separate tests for: an ordinary edit
  that omits `package` keeps it; an edit that supplies `package` is refused; an edit
  that changes `executionMode`, `executable` or a fixed argument is refused; an edit
  of an unmanaged connector cannot add `package`; a credential write of
  `NODE_EXTRA_CA_CERTS` on a package connector is refused with no secret stored.

### T3 — Package store, manifest and verification

Files: new `packages/hub-core/src/packages/store.ts`, new
`packages/hub-core/src/packages/verify.ts`, `packages/hub-core/src/adapters/mcp/runtime.ts`,
`packages/hub-core/src/integrations/bridge.ts`, `packages/hub-core/src/runtime/launcher.ts`,
`packages/hub-core/src/runtime/checks.ts`.

- Layout helpers (install folder, sibling `.installing` marker, `.jobs\<jobId>`),
  private-ACL folder creation (`restrictPrivatePath`), guarded delete.
- The hub-wide **package lock** (in-process mutex) and `reconcilePackages()` that
  re-reads the registry under the lock (rules in the spec).
- Manifest builder with caps, link and `nlink` rejection; `verifyPackage(connector)`
  (marker, links, lock hash, manifest, no parent `node_modules`, fixed
  `--no-global-search-paths` argument; a `/^NODE_/i` env name →
  `invalid_configuration`).
- Call `verifyPackage` before secret resolution at the three launch points and before
  discovery in `checks.ts`; a separate `verifyPackageFiles` export for Verify files.
- Acceptance: tampered lock, edited/added/removed file, junction, hardlink, marker
  present or a planted parent `node_modules` → `package_modified` at each launch
  point with the process never started; a module planted in `<node.exe dir>\lib\node`
  is not loaded; a deterministic interleaving test shows
  reconciliation never deletes a folder being published and saved.

### T4 — Allow-list proxy and fixed-origin fetcher

Files: new `packages/hub-core/src/packages/proxy.ts`, new
`packages/hub-core/src/packages/fetch.ts`.

- CONNECT-only proxy on loopback admitting a configured host:port list (production:
  `registry.npmjs.org:443`), byte cap, connection log for tests.
- Fetcher: HTTPS only, fixed origin, no cross-host redirects, response size caps,
  JSON parse with limits.
- Acceptance: CONNECT to another host and plain HTTP are refused; cap closes the
  tunnel; a redirect to another host fails.

### T5 — npm resolver and installer

Files: new `packages/hub-core/src/packages/npm.ts`, `packages/hub-core/package.json`
and root `package-lock.json` (pinned `npm` dependency),
`packages/hub-core/src/adapters/native/process-runner.ts` (`maxTimeoutMs` option),
`scripts/package-desktop.mjs` (ship bundled npm).

- Pin `npm` 12.x (exact version; must support the four `--allow-*` flags, checked
  by a startup self-test).
- Resolve per spec steps 1–6 (metadata, job folder with `package.json` first,
  lock-only run, lock validation including direct dependency-declaration checks and
  bundle handling, warnings with the spec's install-script derivation, server-side
  preview store with expiry/single use/owner), with entry normalization from the
  spec.
- Install per spec (2 GiB free floor, pre-checks, best-effort watchdog over the job
  and install folders with cancel → wait for exit → delete ordering, frozen lock,
  `npm ci`, verification, manifest, publish+save under the package lock).
- Isolation settings exactly as specified, including ancestor-project refusal and
  redirected profile folders.
- Acceptance: `postinstall` fixture never writes its file; foreign-host and
  `file://` UNC / directory / git / URL dependencies (direct, transitive, optional)
  fail with zero foreign connections or filesystem access, and a transitive
  _optional_ forbidden dependency fails with `unsupported_dependency` (assert the
  code and zero access); a full version document with `scripts.postinstall` and no
  `hasInstallScript` raises the warning; an unpublished bundled dependency and a
  modified bundled copy sharing a public name/version both resolve, are counted
  once and get no registry lookup; a hostile ancestor `.npmrc` with sentinel
  credentials is never read; cap breach with a slow scan and a delayed host deletes
  the folders only after the process tree exited. Fixtures use realistic full and
  abbreviated registry responses.

### T6 — Jobs, save path and API

Files: `packages/hub-core/src/lifecycle.ts`, new
`packages/hub-core/src/packages/service.ts`, `apps/server/src` routes,
`packages/hub-core/src/integrations/manual.ts` (shared credential-write helper only).

- `resolve_package`/`install_package` jobs outside the mutation slot; one install at
  a time; cancel per commit state (precommit / committing / committed /
  indeterminate, spec "Jobs"); 10-minute deadline.
- `savePackageConnector()` with `saved`/`partially_saved`/`save_uncertain` and the
  spec's folder deletion rules.
- Routes per spec: `resolve`, `install`, `replace`, `verify/<connectorId>`.
- Acceptance: expired/reused/foreign-session preview refused; unacknowledged warning
  refused; cancel while precommit deletes the folders after the process exits;
  cancel while committing is refused; a fault-injected commit-success/read-back
  failure reports `save_uncertain` and keeps the folder; save failure that committed
  nothing deletes it.

### T7 — Removal, update, reconciliation

Files: `packages/hub-core/src/packages/service.ts`,
`packages/hub-core/src/lifecycle.ts` (startup + Clean up hooks).

- Delete after `remove_connector`; reconciliation on startup and Clean up; the
  `replace` flow (update and reinstall) through `replacePackage`, keeping user
  arguments, environment, bindings and profile membership.
- Acceptance: orphan deleted on restart; in-use folder retried without blocking;
  a revision conflict keeps the old install and deletes the new one.

### T8 — Imports

Files: `packages/hub-core/src/imports/normalize.ts`,
`packages/hub-core/src/imports/service.ts`, `apps/server/src/app.ts` (import
save-preview route).

- `npx` entries → package proposals listed separately; applying an import saves only
  ordinary definitions and is never blocked by proposals; extracted credential
  values are discarded and never put in the proposal DTO; refused shapes stay
  refused; `uvx` stays refused.

### T9 — Web UI

Files: `apps/web/src/ManualMcpDialog.tsx`, `apps/web/src/ImportDialog.tsx`,
`apps/web/src/ConnectorList.tsx`, `apps/web/src/App.tsx`, `apps/web/src/api.ts`,
`apps/web/src/styles.css`.

- npm package type, Look up → preview → entry pick → warning ticks → Install with
  progress/cancel; connector row state with Verify files, Check connection, Check for
  update and Reinstall; managed connectors edit only the allowed fields; import
  proposals with an Install button; re-approval explanation when `node.exe` moved.

### T10 — Docs

Files: `docs/guides/adding-mcps.md`, `docs/DECISIONS.md` (D024), `docs/STATUS.md`,
`docs/ROADMAP.md`.

## Tests

Test lane after each task. Fixture registry: a loopback HTTPS server with a
test-only CA, serving packuments, version documents and tarballs generated at test
time; the proxy allow-list is pointed at it. A foreign fixture endpoint counts
connections. `scripts/smoke-packages.mjs` installs the acceptance package from the
real registry and is run manually, not in CI.

## Verdict tables

### Round 1 — Codex `gpt-6-astra` high, read-only (tree unchanged vs baseline)

| #   | Finding                                   | Sev | Verdict | Reason                                                                                                                                                                 |
| --- | ----------------------------------------- | --- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Launch check permits modified code        | P1  | accept  | `manifestHash` mandatory in approval, full manifest verified before every launch and Check; D017 race limitation stated.                                               |
| 2   | Preview does not bind dependency tree     | P1  | accept  | Lock-only resolve at preview, frozen lock stored server-side, install uses `npm ci` from it.                                                                           |
| 3   | Registry flags don't enforce hosts        | P1  | accept  | Loopback CONNECT allow-list proxy for npm, no `PATH` (no git), zero-connection test.                                                                                   |
| 4   | uv credential isolation                   | P1  | partial | Moved to F01b requirements; npm gets `HOME`/`USERPROFILE` redirected and empty configs.                                                                                |
| 5   | uv hardlinks vs no-links                  | P1  | partial | F01b (`--link-mode=copy`); `nlink > 1` rejection added to the npm manifest now.                                                                                        |
| 6   | Python acquisition outside allowed hosts  | P1  | partial | F01b requirement; PyPI removed from F01.                                                                                                                               |
| 7   | Save path drops provenance                | P1  | accept  | Field added to `ImportDefinitionSchema`; internal `savePackageConnector()`; clients can't supply `package`.                                                            |
| 8   | Staged venv rename breaks scripts         | P2  | accept  | F01b note; npm now builds in place with a marker, no rename.                                                                                                           |
| 9   | Python target before resolution           | P2  | partial | F01b requirement.                                                                                                                                                      |
| 10  | Entry identity / API                      | P2  | accept  | `entryPath` stored; resolve returns candidates; `entry` chosen at install.                                                                                             |
| 11  | Check not wired, may execute              | P2  | accept  | Verification before discovery in `checks.ts`; `package_modified` in enums.                                                                                             |
| 12  | Install job vs mutation slot              | P2  | accept  | Jobs run outside the slot; short save mutation; explicit outcomes and deletion rules.                                                                                  |
| 13  | Crash recovery / cleanup state            | P2  | accept  | Ownership derived from state; marker + startup/Clean-up reconciliation; no journal change.                                                                             |
| 14  | Caps are post-hoc                         | P2  | partial | Pre-install size/file refusal, 1 s watchdog, proxy byte cap. Exact mid-extraction caps are not possible without reimplementing npm; the watchdog bounds the overshoot. |
| 15  | HMAC token not fresh/single-use           | P2  | accept  | Server-side `previewId`: owner session, 10-min expiry, single use, warning acknowledgement.                                                                            |
| 16  | Literal lock validation wrong             | P2  | accept  | lockfileVersion 3; skip `packages[""]`; root at `node_modules/<name>`; `inBundle`/omitted rules.                                                                       |
| 17  | npm debug logs                            | P2  | accept  | `--logs-max=0` plus post-run `_logs` check.                                                                                                                            |
| 18  | Abbreviated packument lacks fields        | P2  | accept  | Version document + bounded full packument for `time`; "date unknown" warning.                                                                                          |
| 19  | Task file lists / updates / shell wording | P2  | accept  | File lists corrected, update flow assigned to T7, shell rule scoped to packages.                                                                                       |
| Q1  | `manifestHash` in approval                | —   | accept  | Mandatory.                                                                                                                                                             |
| Q2  | Bundle npm                                | —   | accept  | Pinned, own lock, shipped and tested in the portable build.                                                                                                            |
| Q3  | Split PyPI                                | —   | accept  | F01b.                                                                                                                                                                  |

### Round 2 — Codex `gpt-6-astra` high, read-only (tree unchanged vs baseline)

| #   | Finding                                          | Sev | Verdict | Reason                                                                                                                                                                            |
| --- | ------------------------------------------------ | --- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `file:`/UNC deps accessed before lock validation | P1  | accept  | `--allow-directory/file/git/remote=none` (verified present in npm 11.19), startup self-test, transitive/optional UNC tests.                                                       |
| 2   | Ancestor project `.npmrc` not isolated           | P1  | accept  | `package.json` written first, `--prefix`, workspaces off, refuse a data folder inside an npm project, hostile-ancestor test.                                                      |
| 3   | Marker inside hashed tree breaks every install   | P1  | accept  | Marker is a sibling `<installId>.installing` file.                                                                                                                                |
| 4   | Lock-only extracts bundles outside the watchdog  | P1  | partial | Per-job cache inside the job folder, watchdog (250 ms) covers Look up too, 2 GiB free floor; the remaining one-interval overshoot is stated in the spec rather than claimed away. |
| 5   | Node loads from parent `node_modules`            | P1  | accept  | Launch check refuses any parent `node_modules`; `NODE_*` env refused on package connectors; planted-dependency test.                                                              |
| 6   | Edits strip provenance                           | P2  | accept  | Server copies `package` on edit, entry argument fixed, stripping refused.                                                                                                         |
| 7   | No update contract                               | P2  | accept  | `POST /api/packages/replace` + internal `replacePackage` with revision check and preservation rules.                                                                              |
| 8   | Reconciliation races save                        | P2  | accept  | Hub package lock shared by publish+save and reconciliation; registry re-read under it; interleaving test.                                                                         |
| 9   | Crash after save leaves unpublished connector    | P2  | accept  | Publish (remove marker) before save, both under the lock; a crash leaves an unreferenced folder that reconciliation deletes; Reinstall = replace with the same version.           |
| 10  | "Check executes no code" contradiction           | P2  | accept  | Separate Verify files (no process) and Check connection (approval, then run); process-start counts tested.                                                                        |
| 11  | String `bin` rejected                            | P2  | accept  | One entry-normalization procedure for metadata and the installed manifest.                                                                                                        |
| 12  | Import proposals have no path                    | P2  | accept  | Proposals listed separately, never block apply, Install handoff; credentials discarded; server route and `ImportDialog.tsx` in scope.                                             |

### Round 3 (final) — Codex `gpt-6-astra` high, read-only (tree unchanged vs baseline)

| #   | Finding                                          | Sev | Verdict | Reason                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------ | --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Node global search paths load unverified modules | P1  | accept  | `--no-global-search-paths` (verified on Node 24.21) is a fixed first argument checked by `checkedDefinition()`; test plants a module in `<node.exe dir>\lib\node`.                                                                                           |
| 2   | One-interval overshoot bound is false            | P2  | accept  | Watchdog described as best-effort; 4 s kill grace acknowledged; cancel → wait for exit → delete; tests with slow scans and a delayed host.                                                                                                                   |
| 3   | Forbidden optional deps pruned silently          | P2  | accept  | Dependency declarations of the root and every non-bundled entry are checked directly; such packages are refused, not trimmed.                                                                                                                                |
| 4   | `hasInstallScript` absent from full version docs | P2  | accept  | Warning derived from lock `hasInstallScript` or full-manifest `preinstall`/`install`/`postinstall`/`gypfile`, with an "unknown" case; realistic fixtures.                                                                                                    |
| 5   | Bundled packages treated as registry releases    | P2  | partial | Bundled entries get no registry lookup or separate size and are covered by the containing tarball's integrity and the install manifest; inspecting manifests inside the tarball at Look up is not added, a "not checked individually" note is shown instead. |
| 6   | Cancellation vs committed save                   | P2  | accept  | Explicit precommit / committing / committed / indeterminate states; cancel refused while committing; `save_uncertain` keeps the folder for reconciliation; fault-injection tests.                                                                            |
| 7   | Edit acceptance contradicts the contract         | P2  | accept  | Verified at `registry.ts:82` (validates before loading the existing connector). Omission is normal; the stored connector is loaded first and provides the trusted record; separate tests.                                                                    |
| 8   | Credential API bypasses the `NODE_*` rule        | P2  | accept  | Verified: `bindings.ts` lets `NODE_EXTRA_CA_CERTS` through. Policy applied in the credential API before any write; launch-time violation is `invalid_configuration`, not `package_modified`.                                                                 |
