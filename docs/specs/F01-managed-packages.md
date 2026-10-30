# F01 — Managed npm packages

Status: debated (rounds 1–2 applied) · Roadmap item 1 (P0) · Decision record: D024

Python packages (`uvx`) are split into **F01b** (see the end of this document),
because they need separate decisions on interpreter provenance, wheel targeting,
relocation, hardlinks and credential isolation.

## Problem

Most MCP servers are published as `npx -y pkg`. The hub refuses `npx` on purpose: it
downloads and runs code nobody approved, through a `.cmd` shim and a shell. Today a
user must install the package by hand and point a native connector at the result
([guide](../guides/adding-mcps.md#npm-package-npx)). Users stop at that step.

## Goal

A user types a package name, sees exactly which version and dependency tree will be
installed, confirms, and gets a native connector that runs only that content. "Approve
exactly what runs" holds: the approved definition includes a digest of every installed
file, and every launch re-checks it.

## Non-goals

- Running `npx`, `npm exec`, `.cmd`, `.bat` or a shell for a package. (The hub's own
  reviewed PowerShell helpers — process host, DPAPI, private-path ACL — are unchanged.)
- Running package lifecycle scripts (`preinstall`, `install`, `postinstall`,
  `prepare`) or native builds (`binding.gyp`).
- Private registries, `.npmrc`, proxies, authenticated downloads, git/URL/file
  dependencies.
- Automatic updates.
- Python packages (F01b), Docker images, `.mcpb` bundles (item 7), MCP Registry
  browsing (item 4, which will call this install API later).

## Users and flow

1. In **Add MCP** the user picks **npm package**, types a name and optionally a
   version: an exact version, a semver range or a dist-tag (blank = `latest`).
2. **Look up** resolves the full dependency tree without installing and shows a
   preview: name, exact version, release date, description, entry candidates, the
   command that will run, package count, unpacked size and warnings.
3. The user picks an entry if there is more than one, ticks each warning, and clicks
   **Install**. Progress is shown; the user can cancel.
4. On success the hub saves a native connector with a `package` record. Saving is
   not approval; the existing approve checkbox or **Approve** approves the exact
   definition, which includes the content digest.
5. The connector row shows package, version and install state, with three actions:
   **Verify files** (re-checks content, runs no package code), **Check connection**
   (needs approval; verifies files, then starts the server to list tools) and
   **Check for update**. **Reinstall** appears when verification fails.
6. Removing the connector deletes its install folder.

## Data model

A managed package is an ordinary `native` connector plus server-generated provenance.
All existing native paths keep working, and the provenance is part of the approved
definition.

```ts
package?: {
  ecosystem: 'npm';
  name: string;          // validate-npm-package-name rules, lowercase, ≤ 214 chars
  version: string;       // exact semver, no ranges or tags
  entry: string;         // bin name chosen by the user
  entryPath: string;     // bin's relative path inside node_modules/<name>/, from package.json
  installId: string;     // UUID; folder under <data>\packages\
  integrity: string;     // registry dist.integrity of the root (sha512-…)
  lockHash: string;      // sha256 hex of the frozen package-lock.json
  manifestHash: string;  // sha256 hex over the installed-file manifest (below)
}
```

- `package` is allowed only on the `native` variant, and only in definitions created
  by the install job. Every definition schema that carries native fields
  (`ConnectorSchema`, `ImportDefinitionSchema`) gains the field. Client requests can
  never supply it: `ManualMcpSchema` and the registry HTTP routes reject a `package`
  field, `create_connector` rejects a `package` value that the server did not
  produce for that `installId` (the install job passes it through an internal call,
  not through the public registry operation), and `create_connectors` and
  `edit_connector` reject any supplied `package` value for every definition.
- `executable` is the hub's own `node.exe` (absolute path of the running runtime).
  `arguments` = `['--no-global-search-paths',
<data>\packages\<installId>\node_modules\<name>\<entryPath>, ...userArgs]`. The
  flag stops Node searching its global folders (for example `<node.exe dir>\lib\node`
  on Windows), which lie outside the hashed install. The preview and the approval
  view show both fixed arguments.
- `executionDefinition()` includes the whole `package` object. Changing any field
  invalidates approval.
- `checkedDefinition()` requires the first argument to be exactly
  `--no-global-search-paths` and derives the expected second argument from
  `installId`, `name` and `entryPath`, rejecting any mismatch, so a record cannot
  claim one package and run another file.
- Moving the portable app changes the `node.exe` path. The stored `executable` then
  names a file that no longer exists, so the connector fails to launch and editing
  keeps the stored path. The repair is **Replace** (same or newer version), which
  re-pins `executable` to the running `node.exe`, followed by re-approval; the UI
  explains why. The data folder, and so the install, does not move with the app.
- Editing a managed connector. Client definitions never contain `package`;
  omitting it is the normal case. `edit_connector` loads the stored connector
  **before** validating, then:
  1. refuses a request that supplies `package` at all (`invalid`);
  2. if the stored connector has `package`, refuses a different `executionMode`,
     `executable` or either fixed argument (`invalid`), then rebuilds the definition
     from the allowed client fields (name, description, enabled, user arguments after
     the entry, environment literals/bindings) plus the stored `package`,
     `executable` and fixed arguments, and validates that with the stored `package`
     as the trusted record;
  3. if the stored connector has no `package`, the edit can never add one.
     There is no conversion between managed and unmanaged connectors by editing.
- Environment names are upper case (`/^[A-Z_][A-Z0-9_]{0,99}$/`), the rule of every
  credential binding of the hub, so no two names of one connector differ only in
  case. Names matching `/^NODE_/i` (for example `NODE_OPTIONS`, `NODE_PATH`,
  `NODE_EXTRA_CA_CERTS`) and the OpenSSL variables `OPENSSL_CONF`,
  `OPENSSL_MODULES`, `OPENSSL_ENGINES`, `SSL_CERT_FILE` and `SSL_CERT_DIR`,
  compared without regard to case, are refused on package connectors, so nothing can preload code or provider modules or
  change TLS trust from outside the install. The same rule applies on every
  write path: `edit_connector`, the install/replace save, and the credential API
  (`auth/credentials.ts`), which checks it before storing any secret or committing
  state. Launch verification checks it again; a violation there is
  `invalid_configuration` (fix the environment), not `package_modified`.

### Entry normalization

One procedure is used for registry metadata and for the installed `package.json`:
a string `bin` becomes `{ <name without scope>: <string> }`; each path drops a
leading `./`, uses `/` separators, and must be relative with no `..`, drive, UNC or
empty segment. Unsupported or ambiguous shapes fail with `no_entry`. `entryPath` is
the normalized path; containment is checked after normalization.

### Installed-file manifest

At install, after `npm ci`, the hub walks `<install>\` (excluding nothing; no
transaction files live inside it, see "Install") and builds
sorted lines `relativePath \0 size \0 sha256` for every regular file. Any directory
symlink, junction, file symlink, or regular file with `nlink > 1` fails the install.
`manifestHash = sha256(lines joined by "\n")`. Caps during the walk: 50 000 files,
500 MiB.

## Network policy

npm makes its own requests, so flags alone do not constrain hosts. The hub enforces
the policy with a **loopback allow-list proxy**:

- For each npm run the hub starts an HTTP CONNECT proxy on `127.0.0.1:<random>` that
  admits only `CONNECT registry.npmjs.org:443` and refuses everything else (plain
  HTTP requests included). It counts bytes and closes at the download cap (300 MiB).
- npm runs with `--proxy`/`--https-proxy` set to it, `--noproxy=` empty, `--registry
https://registry.npmjs.org/`, and strict TLS on.
- npm gets no `PATH`, so it cannot start `git` or any other program.
- The proxy does not cover the filesystem, and a `file:` dependency can name a UNC
  path (SMB traffic, Windows authentication). npm therefore runs with
  `--allow-directory=none --allow-file=none --allow-git=none --allow-remote=none`,
  which refuse those dependency types during resolution, before any access. The
  pinned npm version must support these flags; a startup self-test confirms it.
  Tests cover transitive and optional `file://` UNC, directory, git and URL
  dependencies and assert zero filesystem/network access.
- Tests point the proxy's allow-list at a loopback fixture registry and assert that a
  foreign endpoint receives **zero** connections.

The hub's own metadata requests use a fixed-origin fetcher with the same allow-list,
no redirects to other hosts, and size limits.

## Resolve (Look up)

1. Metadata (hub fetcher): `GET /<name>/<version>` (full version document, ≤ 2 MiB)
   for `bin`, `description`, `deprecated`, `dist.integrity`, `engines`, `scripts`,
   `gypfile`, `dependencies`, `optionalDependencies`, `peerDependencies`. (Full
   version documents do not carry `hasInstallScript`; that field belongs to
   abbreviated metadata and is not used from there.) For anything but an exact
   version, first read the abbreviated packument (≤ 8 MiB) and pick the release
   the way npx would, with the picker of the bundled npm (`npm-pick-manifest`):
   a dist-tag names it (`latest` when none is given); for a range it prefers
   `latest`, then releases that are not deprecated and whose `engines` match.
   The selector must also be a registry range or tag to npm's own parser, so a
   tag-shaped file name such as `tool.tgz` is refused. The contract keeps
   its own narrower grammar on top: a selector starts with a letter, a digit,
   `_` or a range operator and uses only letters, digits, `_ . * + ~ ^ < > = | -`
   and inner spaces. A tag npm would also accept but that uses other characters
   (`!`, `'`, `(`, `)`, or a leading `.` or `-`) is refused, and so is an
   import naming one; such tags are rare, and the narrow grammar keeps every
   scheme, path and alias character out. The selector is only a key into the packument and never reaches npm. Only the picked exact
   version goes on: the frozen lock never holds a range. Release date comes from the
   full packument's `time[version]` (≤ 32 MiB, streamed); if that is too large or
   missing, the preview shows "release date unknown" as a warning.
2. Refuse when: the version does not exist or was unpublished (`version_not_found`),
   there is no `bin` (`no_entry`). After the lock is frozen, a tree of more than
   2 000 packages, bundled copies included, is refused (`install_limit`). Version
   documents are read up to their size cap and only a small summary of each is
   kept; the lookup stops as soon as a limit is passed.
3. Freeze the tree: create a job folder `<data>\packages\.jobs\<jobId>\` (private
   ACL) with `project\package.json` =
   `{"private":true,"dependencies":{"<name>":"<version>"}}` written first, then run
   bundled npm in `project\` with `install --package-lock-only --ignore-scripts
--omit=dev --omit=optional --no-audit --no-fund --save-exact --logs-max=0` and the
   isolation settings below. This mostly fetches metadata, but npm extracts tarballs
   of packages with bundled dependencies or shrinkwraps into its cache while
   resolving, so the job's cache lives inside the job folder and the resource
   controls under "Install" apply to Look up as well.
4. Validate the lock (`lockfileVersion` 3 only):
   - `packages[""]` is the staging project and is skipped;
   - the requested root is `packages["node_modules/<name>"]` with `version` equal to the
     request and `integrity` equal to the version document's `dist.integrity`;
   - every other non-omitted entry has `resolved` on `https://registry.npmjs.org/` and
     an `integrity` value; `link: true`, git, file, URL or alias specs are refused
     (`unsupported_dependency`);
   - entries marked `inBundle` are allowed: their bytes come inside the containing
     package's tarball, whose `integrity` is checked, so they get no registry
     lookup, no separate size and no per-entry warnings (a bundled copy may be
     unpublished or differ from the public release with the same name and version);
     the preview shows "contains N bundled packages, not checked individually";
   - `dev`/`optional` entries are not installed and are ignored for counting.
   - Dependency declarations are checked directly, not only the surviving lock
     entries: npm's `--allow-*=none` refuses forbidden specs, but for optional
     dependencies it prunes them silently and exits 0. So for the root and every
     non-bundled entry, the hub reads `dependencies`, `optionalDependencies` and
     `peerDependencies` from its version document and refuses
     (`unsupported_dependency`) any spec that is not a registry semver range or
     tag: `file:`, `link:`, `workspace:`, `npm:` aliases, git, URLs and paths. A
     package with such an optional dependency is refused, not silently trimmed.
     A tag in a dependency spec has a narrower grammar than the Look up
     selector: it starts with an ASCII letter and has at most 64 characters
     (`/^[A-Za-z][A-Za-z0-9._-]{0,63}$/`), because npm itself resolves these
     specs during the install. A dependency tag such as `_next` or `123next`
     is refused (`unsupported_dependency`). The Look up selector of step 1 is
     not bound by this rule: it is only a key into the packument, so `_next`
     and `123next` are valid there.
5. Warnings (each must be ticked before install): the root or any non-bundled
   package has install scripts, where "has install scripts" means the frozen lock
   entry has `hasInstallScript: true`, **or** its full version document has a
   `preinstall`, `install` or `postinstall` script or `gypfile: true`; when neither
   source is available for an entry, the warning says "install scripts unknown"
   (scripts never run either way; the warning is that the package may not work
   without them); `optionalDependencies` were omitted; release younger than 7
   days or date unknown; `deprecated`; `engines.node` excludes Node 24; more than
   300 packages; summed `dist.unpackedSize` over 200 MiB (sizes come from each
   entry's version document, fetched in parallel with a limit of 8; missing sizes
   are reported, not guessed).
6. The preview is stored server-side with a random `previewId` (owner session, 10-
   minute expiry, single use). It contains the frozen lock, its hash, root integrity,
   entry candidates and warnings. A session keeps at most 5 previews and the hub at
   most 50; past either cap the oldest preview is dropped, as if it had expired.
   The Look up job folder (staging project and npm cache) lives as long as its
   preview, so Install can reuse the cache. It is deleted when Install takes the
   preview (Install deletes it when it ends), when the preview expires or is
   dropped, and when the hub shuts down; a failed Look up deletes it at once.
   Every Look up checks the 2 GiB reserve before it starts, so kept caches cannot
   take the drive below it.

## Install

- One install at a time per hub; separate from the short registry mutation slot
  (see "Jobs"). Deadline 10 minutes.
- Resource controls, for both Look up and Install: at least 2 GiB free on the data
  drive before starting; refuse before downloading if summed unpacked size > 500 MiB
  or the file count would exceed 50 000 (from `dist.fileCount` where present); the
  proxy closes at 300 MiB downloaded; a watchdog measures the job folder and the
  install folder together (project, cache, temp, install) and kills the process tree
  past its own caps of 800 MiB and 80 000 entries. They sit above the 500 MiB and
  50 000 files of a tree because the watchdog also counts the cached tarballs, the
  staging project and every folder; the manifest caps of the installed tree stay
  the hard limits. The watchdog is **best-effort**, not a hard quota: each scan takes
  time, timers can fire late, and stopping the host takes up to its 4-second kill
  grace, so npm can keep writing until the tree is dead. Scans start at most 250 ms
  after the previous one finished; on breach the hub cancels, waits for the process
  tree to exit, then deletes the job and install folders. The disk reserve exists
  because of this: refusing below 2 GiB free keeps an overshoot from filling the
  drive. Each watchdog also checks the reserve on every scan, so concurrent jobs (one
  install and at most two lookups) stop as soon as the drive falls under 2 GiB free;
  the reserve, not a per-job budget, bounds them together. A scan stops walking as
  soon as a cap is passed, counts folders as entries and counts an entry it may not
  read as one file; past 256 such entries the scan fails, which is a breach.
  Disk exhaustion inside one scan interval plus the kill grace is an accepted
  residual risk. Tests use a real slow scan and a delayed process host, not only fake
  timers, and assert cleanup ordering (process gone before deletion).
- Layout: the install is built in place at `<data>\packages\<installId>\` (private
  ACL). The transaction marker is a sibling file `<data>\packages\<installId>.installing`,
  never inside the hashed tree. The marker holds the job ID and is written
  **before** the install folder is created, so reconciliation never sees the
  install folder of a running job without its marker; reconciliation asks again
  whether the job is live for each marker and each folder, not from one snapshot.
  Temp and cache stay in the job folder, which is deleted when the job ends.
- Steps: write the frozen `package-lock.json` and the same `package.json` into the
  install folder, then run bundled npm `ci --ignore-scripts --omit=dev
--omit=optional --no-audit --no-fund --logs-max=0` there with the isolation
  settings.
- Verify: lock unchanged (`sha256 == lockHash`); normalized `bin[entry] ==
entryPath`; entry file is a regular file inside the folder; no `.npmrc`, `_logs` or
  other npm temporary files inside the folder; build the manifest. Any failure
  deletes the folder and marker.
- Publish and save happen in one critical section under the hub's **package lock**
  (an in-process mutex also taken by reconciliation): remove the marker, then save
  the connector. Lock order: the package lock first, then the registry mutation
  slot inside it for the save. The slot never waits: a second mutation fails with
  `busy`, and the save retries for a bounded time. Nothing that holds the slot
  takes the package lock: after `remove_connector` commits, it starts a
  reconciliation pass without waiting for it, and reconciliation only reads the
  registry, so it never needs the slot. Only one hub
  process uses a data folder: the runtime takes an exclusive `writer.lock` in it at
  start and a second hub refuses to start, so the in-process lock covers every
  writer. A crash after publishing but before saving leaves an unreferenced
  folder that reconciliation deletes. The job reports `saved` only after both.
- Commit states (see "Jobs"): **precommit** until the package lock is taken for
  publish+save; **committing** while it is held; then **committed** or
  **indeterminate**.

### npm isolation settings

- Bundled `npm` (pinned exact version, dependency of `@waleed/hub-core`, its own lock
  in the repo, shipped in the portable build) run as `node.exe <npm>\bin\npm-cli.js`
  through the contained process runner with a new explicit per-runner
  `maxTimeoutMs` (installs: 600 000; MCP targets keep 120 000).
- npm searches parent folders for a project root and reads that project's
  `.npmrc`. The hub writes `package.json` into the working folder before the first
  npm run, passes `--prefix <that folder>`, `--workspaces=false`,
  `--include-workspace-root=false`. The working folder already holds
  `package.json`, so npm's search for the project root stops there, and the user
  and global configuration files are named explicitly (below). An ancestor
  `package.json` or `.npmrc` (such as the one `npm login` writes to the user's home
  folder) is therefore never read and is not refused. The hub refuses to start only if a parent folder of
  `<data>\packages\` contains `node_modules`, because Node itself searches parent
  folders for modules at launch.
- `--userconfig` and `--globalconfig` point at empty files in the job folder;
  `--cache=<job>\cache`; `--logs-max=0`; `--update-notifier=false`; `--fund=false`;
  `--audit=false`; the four `--allow-*=none` flags; `--strict-ssl=true`.
- Environment: `SystemRoot`, `WINDIR`, `TEMP`/`TMP` (job folder), `HOME`,
  `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` set to empty folders inside the job folder,
  `npm_config_*` not forwarded, no `PATH`. Secrets never enter installer processes.
- Output is captured for exit status only; it is never shown, returned or logged.
  The job folder (cache, logs, temp) is deleted when the job ends; a Look up job
  folder lives on with its preview (see "Resolve", step 6).
- Tests run Look up and Install under an ancestor folder with a hostile `.npmrc`
  naming a foreign registry, and assert it is not used.

## Launch verification

Before every native launch of a connector with `package` — **Check connection**,
bridge peer, agent launcher — and before secrets are resolved; **Verify files** runs
the same steps and never starts a process:

1. The install folder exists, has no sibling `.installing` marker, and no link on its
   path (`assertNoLinks`).
2. `sha256(package-lock.json) == lockHash`.
3. The manifest rebuilt from disk hashes to `manifestHash` (also rejects added
   files, removed files, links and `nlink > 1`).
4. Node resolves bare imports by walking up parent folders and then its global
   folders, so code outside the install could load. No parent folder of the
   install, up to the drive root, may contain a `node_modules` entry; the arguments
   start with `--no-global-search-paths` (global folders such as
   `<node.exe dir>\lib\node` and `HOME`-based ones are never searched); and the
   target environment carries no refused name (`/^NODE_/i` or an OpenSSL variable) (that last case is
   `invalid_configuration`). Tests plant an omitted optional dependency in a parent
   `node_modules` (expects `package_modified`) and one beside the bundled runtime in
   `<node.exe dir>\lib\node` (expects the server not to load it).

Any content check that fails (steps 1–3 and the parent-folder and argument checks
of step 4) fails closed with `package_modified` before discovery or secret
resolution; the row says "Reinstall". A refused environment name fails closed with
`invalid_configuration` instead; the row says which binding to remove, because a
reinstall would not help. The full manifest is checked every time; the
spec accepts the cost (measured in tests; typical servers are a few thousand small
files). F03 (persistent sessions) will reduce how often launches happen. As in D017,
a malicious same-user process racing the check between verification and process
start is out of scope; the check defends against accidental and after-the-fact
modification and against content swaps between approval and launch.

## Jobs

- `resolve_package` and `install_package` jobs use the D015 job model (owner-scoped,
  CSRF/Origin/session protected, bounded retention), with a 10-minute deadline, and
  do **not** hold the lifecycle mutation slot while downloading.
- Saving runs after verification as a normal short mutation through a new internal
  `savePackageConnector()` that builds the definition (with `package`), writes env
  secrets through the P6 interface exactly like `addManualMcp` (D022), and returns
  `saved` or `partially_saved` with the connector ID.
- Cancellation and cleanup follow the commit state:
  - **precommit** (resolving, downloading, verifying): cancel stops the process
    tree, waits for it to exit, deletes the job and install folders, and reports
    `cancelled`. A save failure known to have committed nothing also deletes them.
  - **committing**: cancel is refused (`busy`); the job finishes and reports its
    real outcome.
  - **committed**: `saved` or `partially_saved` with the connector ID; the job never
    deletes the folder.
  - **indeterminate** (the state write may have committed but the job cannot
    confirm it, for example read-back failed): the job keeps the folder and reports
    `save_uncertain`. Only reconciliation, reading the authoritative registry under
    the package lock, may later delete it, and only if no connector references it.
  - Tests fault-inject commit-success/read-back-failure and a cancel during saving.

## Removal, update and recovery

- Folder ownership is derived from state: a folder under `<data>\packages\` belongs to
  the connector whose `package.installId` names it.
- After `remove_connector` commits, the hub deletes the folder. On startup and on
  **Clean up**, reconciliation runs under the package lock: it re-reads the current
  registry, then deletes every install folder that no connector references and that
  has no marker owned by a live job, every marker whose job is gone (with its
  folder), and every `.jobs\<jobId>` folder whose job is gone. This covers a crash
  between publish and save, and between removal and deletion. A folder whose files
  are in use is retried later; removal never blocks on deletion. A deterministic
  test interleaves a job's publish+save with reconciliation.
- **Update** and **Reinstall** use one request:
  `POST /api/packages/replace {connectorId, expectedConnectorRevision, previewId,
entry, acknowledgedWarnings[]}`. Reinstall uses a preview of the same version. The
  new content goes into a new `installId`; then, under the package lock, an internal
  replace operation checks the connector revision, swaps `package`, `executable` and
  the entry argument, and keeps user arguments, environment, bindings and profile
  membership. On a revision conflict the new folder is deleted and the old one kept.
  The new definition needs approval. The old folder is removed by reconciliation
  once unreferenced.

## Imports

- `npx [-y|--yes] <pkg>@<x.y.z> [args]` becomes a _package proposal_ (name, version,
  args). Unpinned `npx [-y] <pkg> [args]` becomes a proposal labelled "version chosen
  at Look up". A range or dist-tag (`<pkg>@^1.2.0`, `<pkg>@next`) is kept as
  `requestedVersion` and shown, so the user sees what the entry asked for before
  Look up picks an exact release. The proposal lists only the environment names
  Install accepts: lower-case names and the refused ones (`NODE_*`, the OpenSSL
  variables) are left out. Proposals never install during import preview. The import preview
  lists proposals separately from ordinary definitions; applying the import saves
  only the ordinary definitions (proposals never block it), and each proposal has an
  **Install** button that opens Look up → Install with name, version (or the
  requested range or tag) and arguments filled in.
- Credential values extracted from an imported `npx` entry are discarded, whether
  or not the entry becomes a proposal, and never put in the proposal DTO; the install form asks for them again and says why.
- `npx -c`, `--call`, `-p/--package`, multiple packages, git/URL/path specs and any
  `uvx` entry stay refused (uvx waits for F01b).

## API

- `POST /api/packages/resolve` `{name, version?}` (`version`: exact, range or
  dist-tag) → job; result is the preview with
  `previewId`.
- `POST /api/packages/install` `{previewId, entry, acknowledgedWarnings[],
connectorName, arguments[], env{}}` → job. Refused if the preview is expired, used,
  owned by another session, or any warning is not acknowledged.
- `GET /api/packages/jobs/<id>` (cancel: `POST /api/packages/jobs/<id>/cancel`): phase (`resolving`, `downloading`, `verifying`, `saving`),
  progress, sanitized error code, and on success `{connectorId, outcome}`.
- `POST /api/packages/replace` (update and reinstall, see above).
- `POST /api/packages/verify/<connectorId>`: **Verify files**; full verification,
  never starts a process. **Check connection** stays the existing capability check,
  which now verifies files first.
- Limits: the package routes answer `busy` (HTTP 429) past 60 requests a minute,
  and the job poll past 600 a minute. A live session has its own budget; any other
  request counts against its address. At most one install and two lookups run at
  a time; a further one answers `busy`.

## Errors (sanitized codes)

`package_not_found`, `version_not_found`, `no_entry`, `entry_required`,
`unsupported_dependency`, `registry_unavailable`, `foreign_host`, `install_failed`,
`install_limit`, `integrity_mismatch`, `preview_expired`, `warning_not_acknowledged`,
`package_modified`, `invalid_configuration`, `save_uncertain`, `busy`, `cancelled`.

## Security properties (each needs a test)

1. No package code runs during Look up, Install or Verify files (tests count
   process starts). Check connection runs the server only after approval and
   verification.
2. Only `registry.npmjs.org:443` is contacted; a foreign endpoint gets zero
   connections, including from lock entries, redirects and `file:`/UNC, git or URL
   dependencies at any depth.
3. What runs is what was previewed: the install uses the frozen lock; root integrity
   and lock hash match the preview; the approved definition includes `manifestHash`.
4. Any change to an installed file, an added file, a link, a hardlink or a parent
   `node_modules` is detected before every launch and before Check connection runs
   discovery.
5. No user, machine or ancestor-project npm configuration influences Look up or
   Install.
6. Install folders are private to the current user and SYSTEM.
7. Clients cannot create, alter or strip `package` records, including through
   ordinary connector edits.
8. Secrets never enter installer processes; installer output never leaves the hub
   process and no npm debug log persists.

## Acceptance

- `@modelcontextprotocol/server-filesystem` installs from a blank form, is approved,
  lists tools through the bridge and runs from an agent (manual live smoke).
- A fixture package with a `postinstall` that would write a file installs with the
  warning and the file is never written.
- A fixture whose lock resolves a dependency on another host fails with
  `unsupported_dependency`; the foreign endpoint receives zero connections.
- Editing any installed file makes the next launch and Check fail with
  `package_modified` without starting the process.
- Removing the connector deletes the folder; a crash-simulated orphan is deleted by
  reconciliation.
- The portable build contains the pinned npm and installs a fixture package.
- All existing gates stay green.

## F01b — Python packages (later)

Requirements carried from the round-1 debate, to be specified separately: pinned and
digested interpreter provenance included in approval (no GitHub downloads outside
the allow-list unless explicitly added); exact interpreter target chosen before
resolution and every wheel's filename/URL/digest bound; `--link-mode=copy` and
`nlink` checks; build the venv at its final path; isolated uv auth (empty netrc,
no credential store, no keyring) tested with sentinel credentials; same proxy model.
