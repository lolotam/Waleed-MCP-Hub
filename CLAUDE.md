# Waleed MCP Hub manager guidance

## Delivery tiers (Light / Medium / Heavy Implementation Pipeline)

Owner direction received 2026-11-19. Follow the complete shared pipeline in
[AGENTS.md](AGENTS.md#delivery-tiers-light--medium--heavy-implementation-pipeline).
These are the same project rules for Claude and Codex; do not create divergent
approval, model-fallback or deployment policies.

- Before EVERY new task (including side/follow-up tasks), present an Arabic
  AskUserQuestion card with three options, recommended tier first marked
  **(المقترح)**, one-line reason and an exception option. Wait for Waleed's
  answer. Record tier+exception in brief and PR body. Running-task fix rounds
  need no new card. Initial docs adoption is already explicitly selected Light.
- Light: docs/specs/plans/ADRs/status/i18n or small CSS/UI up to about150lines;
  never money, auth/permissions, DB/migrations, APIs or new dependencies.
  Manager/cheapest implementer; immediate exact-head green-CI merge, no bot wait;
  no CI means direct merge. No own staging deploy; ship with the next deployment.
- Medium: local /code-review and available project bots, maximum3rounds, exact
  head green CI. A bot stuck >1hour may be skipped with explicit disclosure.
  After round3, P2/P3 become issues; P0/P1 block. Stage in daily batches.
- Heavy: Claude Fable5.2 medium plan, Codex Astra6.2 medium one-round debate
  before implementation; full review+CI, project cap3unless an explicit stricter
  task gate applies. Migration/money/auth/permissions PRs need Waleed's final
  post-gates card approval. Other Heavy merges by manager after gates. Stage
  alone immediately after merge under deployment authority; migration requires
  DB snapshot first with receipt. Production/server/secrets/HOLD remain Waleed's.
- Light fallback: manager/GLM then Claude Sonnet. Medium/Heavy: Kimi, MiniMax,
  GLM, Grok, Claude Sonnet (Heavy Sonnet high). Two failures/quota exhaustion
  advances to the next available lane, no routine reapproval. Use the actual
  provider/model mappings in AGENTS.md, recheck capabilities, record skips,
  never invent access or approve new spend. Cursor is currently paid-plan blocked.
- After every merge: **ما تم**, **الباقي**, **التوصية**; include main tasks/PRs,
  remaining subtasks/status and fold side tasks into their parent plan. Keep
  applicable roadmap/status current. End reports with **المطلوب منك**,
  **الخطوة الجاية اللي أنصح بيها**, **ملاحظة**; write **مفيش** when none.

Preserve all other project gates, dirty work, KEEP, rollback and route rules.
Light docs authorization does not resume frozen product/CI/runtime/connector
work or authorize deployments. Main's existing CI+Security automatic Windows
release publication remains unchanged; publication is not installation or
runtime/connector success. Do not replace existing release tags or bypass
repository-enforced protection. SSH-Musalam-2 remains through Waleed MCP Hub.
