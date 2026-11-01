# GitHub Releases and Update Notices Implementation Plan

> **For agentic workers:** Execute inline, task by task, with focused tests and checkpoints.

**Goal:** Publish verified main builds and notify installed users of newer releases.
**Architecture:** A trusted-CI workflow owns publishing. A bounded, cached fixed-repository
checker owns update metadata. Existing installer packaging supplies artifacts.
**Tech Stack:** GitHub Actions, gh CLI, Node fetch, TypeScript, React.

- [ ] Add scripts/release-version.mjs for stable version selection and commit idempotency.
      Unit-test a first release, base-version increase, patch increment and duplicate commit.
- [ ] Add .github/workflows/release.yml gated on successful main push CI in this repository;
      checkout verified SHA, skip obsolete main, compute/set build version, package, upload
      installer/checksums/metadata with contents:write only on publishing job.
- [ ] Add packages/hub-core/src/updates.ts with fixed GitHub endpoint, 10-second timeout,
      response byte bound, coalesced one-hour caching, stable version and URL validation.
      Prove newer/current/404/rate/network/error/oversized responses with injected fetch.
- [ ] Expose session-protected status/check endpoints and apps/web/src/UpdateNotice.tsx.
      Display version and GitHub links without executing a download; failures remain local.
- [ ] Run nearest typecheck/lint/build gates, review the complete diff, create a reviewable
      PR and link it to this thread. Report CI/review state without claiming a merge occurred.
