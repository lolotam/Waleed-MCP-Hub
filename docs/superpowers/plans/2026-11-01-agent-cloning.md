# Agent MCP Cloning Implementation Plan

> **For agentic workers:** Execute inline, task by task, with focused tests and checkpoints.

**Goal:** Copy user-selected agent MCPs with available credentials into the Hub.
**Architecture:** Reuse known AgentTarget paths, strict JSONC/TOML parsing, normalization,
addManualMcp, PackageService, protected credentials and automatic capability checks.
**Tech Stack:** TypeScript, Zod, Fastify, React, Vitest, Playwright.

- [ ] Add contracts in packages/contracts/src/cloning.ts for sanitized candidates,
  owner-scoped bounded jobs, explicit package acknowledgement and selected entries.
- [ ] Extend integrations/formats.ts with strict server-map extraction. Implement
  integrations/cloning.ts: scan known files without executing commands, retain source
  fingerprints rather than secrets, prepare npm previews, reread before copy, and route
  writes through existing services. Blank transient maps in finally. Cancel on logout.
- [ ] Expose lifecycle service and protected server routes. Preserve partial records and
  stop accepting work during shutdown before closing package services.
- [ ] Add apps/web/src/AgentCloning.tsx with first-open scan, grouped checkboxes, editable
  destination names, npm review and bin choice, explicit copy/connect and repair results.
- [ ] Prove metadata never includes synthetic credentials, selected-only copying,
  source drift/no writes, cancellation, package review, partial save, owner isolation.
  Run npx vitest run tests/agent-cloning.test.ts and affected integration tests.
- [ ] Run focused browser scenario for first-run selection and automatic tools.
