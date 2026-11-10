# Managed GitHub release artifacts

Status: design for owner review. Source stage only; no live mutation.

## Problem and approved outcome

The owner approved installing the reviewed SSH correction without recovering an inaccessible npm publishing account. Hub v0.1.9 currently resolves managed roots only from registry.npmjs.org. Do not disguise a GitHub archive as a registry release, change the installed managed tree manually, or convert the connector to an unmanaged command.

Add a supported GitHub Release source to the existing managed package preview/install/replace workflow. The user supplies a public repository, release tag, asset name and expected lowercase SHA256. The server downloads and verifies the exact archive before inspecting its manifest or invoking npm. No GitHub or npm authentication is required for this source. Ordinary registry roots retain current behavior.

## Alternatives and choice

1. Recommended: verified GitHub root archive as a narrowly scoped local root tarball in the existing isolated npm project. Dependencies remain registry-only. This preserves real archive identity, frozen locks and installer verification without a second package manager.
2. Synthetic registry metadata/cache seeding: rejected. It would label an unpublished root as a registry release and complicate provenance, cache and lock trust.
3. Unmanaged stdio connector or manual installed-file patch: rejected. It abandons managed replacement guarantees and existing identity/binding preservation.

## Request, preview and provenance

- Extend resolve requests with an explicit optional discriminated GitHub source; name and exact version remain required for archive requests and are compared with package.json. Existing npm request shape remains accepted unchanged. No arbitrary URL/path/git/local input is admitted.
- Source fields: kind=github-release, repository=owner/repository, tag, assetName ending .tgz, sha256. Reject control characters, traversal, ambiguous encoding, URL delimiters and leading/trailing whitespace in identity fields. Construct URLs server-side with individual segment encoding.
- Preview and persisted package provenance carry the same strict optional source field. Absent source means existing npm registry semantics. Show repository/tag/asset, SHA256 and downloaded archive identity to the user before confirmation. A hash proves byte identity, not publisher safety or source-to-build correspondence.
- Source identity participates in preview binding, revision/fingerprint comparisons and immutable package identity. Execution approval is cleared on replacement, including same-name/version source changes. Preserve connector ID, argument suffix, secret references, policies, profiles and enabled state through the existing planner.
- A name transition still requires the existing exact from/to acknowledgment. Add explicit source acknowledgment for registry-to-GitHub and GitHub source/hash changes. Resolve cannot save or implicitly approve execution.

## Fetch and archive trust boundary

- Public GitHub Release asset downloads only; no token, cookie, inherited credential, .npmrc or environment-derived authentication. No private repositories, generic URLs, custom registry or proxy settings.
- Initial URL is exactly https://github.com/{owner}/{repo}/releases/download/{tag}/{asset}. Follow at most three redirects and validate every hop before connecting: HTTPS, default 443, no userinfo, fragment, backslash or control character; exact github.com or release-assets.githubusercontent.com only. No wildcard host matching or githubusercontent subdomain suffix matching. No ambient auth headers forwarded. Reject all other destinations, including loopback/private literal destinations.
- Stream with abort support, a total timeout and a 64 MiB compressed-byte cap independent of Content-Length. Reject nonidentity content encoding. Compute SHA256 and SHA512 over the downloaded bytes; SHA256 mismatch ends the job before npm or extraction. Redact response bodies, signed redirect query strings and local paths from errors/logs.
- Read the gzip tar through the already pinned bundled npm tar library, without extracting into a live tree. Enforce a bounded expanded total/file count, a 1 MiB manifest cap, one package/package.json, no symlink/hardlink/device/FIFO entries, no traversal/absolute/Windows-reserved/case-colliding/duplicate paths. Reject unexpected archive prefixes and multiple package manifests. Archive parser failures are sanitized.
- Validate manifest name/version/bin and dependency declarations using existing rules. Root lifecycle scripts remain disabled and visibly warned; registry-only dependency declarations, existing optional omission, size and engine warnings remain. No root manifest code is imported or executed during preview.

## Frozen resolution and installation

- Write the already verified bytes as root-artifact.tgz in the private resolve project using exclusive creation. The staging manifest references that one relative file for the exact root name. Run existing isolated bundled npm lock generation: ignore scripts, omit dev/optional, empty configuration, registry-only network proxy and existing watchdog/cancellation/capacity controls.
- Extend lock validation with one explicit exception: the exact root key may resolve to file:root-artifact.tgz with exact expected name/version/SHA512. No other local/file/link/git/alias resolution is allowed, including nested dependencies. Existing registry validation remains unchanged for legacy requests.
- Keep the frozen lock and archive identity in the owner-bound, expiring, single-use preview record. Immediately before install, reread the private archive as an owned regular file and verify both hashes. Never trust a preview path supplied by the client or silently redownload different bytes after expiry.
- Install into a new private managed folder, copying the verified archive as root-artifact.tgz and using exactly the frozen lock and the same staging manifest. npm ci runs under existing isolation. Retain the root artifact in the installed closure so backup/restore and lock provenance remain self-contained. Extend top-level allowlist only for artifact-source installs.
- Verify installed root manifest name/version/bin against preview, archive identity, unchanged lock, tree closure/no links and full manifest hash before save. Archive hash/filename enter manifest verification; ordinary roots do not gain a loose extra-file exception.
- Existing package lock, revision check, owner-bound preview, transactional save/drain/journal, indeterminate outcome handling and preservation behavior remain. No cleanup of historical/KEEP data. Only normal owned job/staging cleanup with existing containment checks is permitted.

## User workflow

Add npm / GitHub Release selection to the package lookup and replacement form. GitHub input requires repository, release tag, asset name, SHA256, expected package name and exact version. Show source/hash in preview, reset all previous warnings/source/name acknowledgments on a new lookup, and use the existing job status/cancellation flow. No raw shell commands, tokens or credentials in the form.

Preserve the npm-only update check. For a GitHub-managed connector, show the current pinned source and provide an explicit new-artifact lookup; never silently treat npm latest as an update of the GitHub source or auto-follow a moved tag.

## Compatibility and rollout gate

The persisted source field is intentional: old strict schemas must reject guarded records rather than silently erase or reinterpret provenance. Before saving the first GitHub connector, refresh every affected Hub client/bridge to the exact compatible release or demonstrate that it does not consume the dataset. Do not introduce the field into v0.1.9 state during source work.

An old binary is not a supported reader of a new GitHub record. Rollback requires the complete consistent private preimage, including state/safety/encrypted bytes/package directories and original runtime/client definitions, after writers are stopped. Never restore a single state file or strip source metadata to make an old version accept it. Preserve both old installs and all historical discrepancy evidence.

Source publication, immutable release evidence, supported client coordination, fresh private backup/rehearsal/old-new pure validators and exact artifact installation receipts remain separate execution gates. No inferred transport shutdown, session bootstrap or credentials access.

## Validation and acceptance

Meaningful local fake upstream/HTTPS/archive fixtures must prove:

- Legacy npm resolve/install/replace behavior and strict old-consumer refusal of source metadata.
- Request/source normalization, exact archive name/version/bin, source/name confirmation, preview expiry/ownership/revision/conflict/cancellation and acknowledgment reset.
- SHA256 mismatch prevents npm; install-time artifact mutation prevents save. All refused-source counters remain zero for forbidden connections or package execution.
- Cross-host downgrade/userinfo/encoded-path/redirect loops, timeout, chunked oversize, partial response and compression bombs fail closed.
- Duplicate/case collision/traversal/link/device manifest and unsupported dependency fixtures fail closed without extraction or upstream execution.
- Only the root file resolution is accepted; nested file/git/URL/alias lock entries remain refused. Existing registry assertions are retained.
- Exact frozen lock/manifest/archive verification, fresh dependency-tree preview and unchanged connector binding/policy/profile preservation.
- Job cancellation/indeterminate save and recovery preserve referenced installs; no assertion or timeout weakening.
- Browser journey for both npm and GitHub lookup/replace, mandatory hash and source confirmation, reset after preview change.

Run applicable full Windows/unit/typecheck/lint/build/security/boundary/runtime/E2E gates on a stable head; independent review and remote exact-head checks precede merge. Do not sum overlapping test counts or claim runtime/SSH acceptance from source tests.

After compatible immutable rollout and verified private backup, install the already reviewed SSH artifact through supported replacement. Its current local identity is SHA256 12bcae8ece4e69f64fc44d17747b2fe423ef59a98b3e27ebe632ea86c9cfeccf, 52646 bytes, @lolotam/ssh-mcp@2.1.0-waleed.1. Publish those exact bytes in a new immutable GitHub Release only under the owner's approved artifact-distribution scope; never overwrite an existing asset/tag. Record actual URL/tag/commit and download readback before live preview. No source/build provenance assertion is inferred solely from the tag.

Then read hub://guide/discover exact tools and execute the one authorized original Docker-format read. Report literal outcome; no alternate command/run_command/direct SSH, retry loop or remote mutation. Worker/queue and HOLD200 remain separate from connector acceptance. No paid call or new secret is authorized by this feature.
