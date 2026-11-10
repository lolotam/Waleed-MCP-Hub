# GitHub artifact packages implementation plan

**Goal:** Install hash-pinned public GitHub release tarballs through managed previews and replacement, without npm publishing credentials.

**Architecture:** A verified GitHub root archive becomes the sole permitted local tarball in an isolated npm project. Dependencies retain registry-only resolution. Strict source provenance prevents old clients from silently interpreting the artifact as an npm publication.

**Tech stack:** TypeScript, Zod, Node HTTPS, bundled npm/tar, React, Vitest and Playwright.

Execution is inline in the existing owned worktree; no delegates or new sessions. Design approved by owner with instruction to start implementation.

## Tasks

- [ ] Contracts: extend packages.ts with strict source identity, exact-version source requests, preview/provenance preservation and exact source-change confirmation. Add contract fixtures proving malformed fields and stale acknowledgments refused. Run `npx vitest run tests/package-artifact.test.ts`.
- [ ] Download/parser: add artifact.ts for bounded GitHub-only redirects, no ambient credentials, SHA256/SHA512 verification and non-extracting archive validation. Test forbidden hosts, mismatch, timeout/abort, size and malicious tar fixtures before integrating npm.
- [ ] Resolve/install: extend resolve.ts, npm.ts and install.ts. Permit `file:root-artifact.tgz` only at the exact root; npm uses allow-file=root only for artifact jobs. Retain archive in installed closure, reverify before npm and save, preserve legacy assertions. Test frozen-lock/root identity and nested-file refusal.
- [ ] Lifecycle: service.ts requires exact source confirmation; persisted source survives replacement. Refuse export/clone paths that cannot preserve it and prevent npm latest checks for artifact roots. Add regression tests for confirmation, unchanged bindings/revision and old strict schema refusal.
- [ ] UI: PackageInstall.tsx adds source selection and identity/hash inputs, source facts/confirmation and reset on lookup. ConnectorList.tsx offers explicit artifact lookup rather than npm automatic updates. Add browser journey assertions.
- [ ] Validation: run focused red/green tests, typecheck/format/lint/boundaries/secrets/build, complete Windows/unit/runtime/session and E2E gates on stable source. Preserve failures and fix without weakening assertions. Source review and exact-head CI remain merge gates. No source-stage command accesses live connector credentials or modifies Hub data.
- [ ] Delivery: commit/push and link focused PR after local gates; watch required CI/reviews. Publish no SSH artifact, change no live connector and start no rollout before compatible release/cohort/private preimage gates. Keep full old installation and rollback assets.

Acceptance remains the original one formatted Docker read only after supported installation; source tests are not SSH proof. Track actual failures/results rather than overlapping totals.
