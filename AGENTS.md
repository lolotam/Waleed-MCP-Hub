# Waleed MCP Hub manager guidance

## Delivery tiers (Light / Medium / Heavy Implementation Pipeline)

Owner direction received 2026-11-19, implemented as documentation only.
Reference: PosPay PP-195, lolotam/PayPos.systems#1085. This is Hub guidance;
PosPay-specific staffing rules do not create Hub delivery slots.

### Tier card before every new task

Before starting any new main task, side task or follow-up issue, send Waleed an
Arabic AskUserQuestion card with three choices. Put the recommended tier first,
marked **(المقترح)**, with a one-line reason. Include an exception choice such as
an additional review/step. Wait for his answer; include the selected tier and
exception in the implementation brief and PR body. Fix rounds within the same
running task need no new card. This initial docs adoption was explicitly selected
as Light with immediate green-CI merge/no bot wait by Waleed; no duplicate card.

### Light

Docs, specs, plans, ADRs, roadmap/status, i18n and small CSS/UI changes up to about
150 lines. Never classify money, permissions/auth, database/migrations, APIs or
new dependencies as Light. Manager or cheapest available implementer handles it.
Merge immediately after exact-head CI is green, without waiting for review bots;
if the repository has no CI, merge directly under the selected task authority.
No separate staging deployment: ship with the next deployment. Do not bypass
repository-enforced protection or material security findings to achieve this.

### Medium

Maximum three review rounds: local /code-review plus available project bots
(currently CodeRabbit and MergePilot). A bot stuck over one hour may be skipped;
disclose it in the merge report. Exact-head CI must be green. After round three,
track P2/P3 findings as issues; P0/P1 block. Do not downgrade severity to merge.
Deploy to staging in daily batches under applicable deployment authority.

### Heavy

Migrations, money, permissions/auth, security and long background jobs. Claude
Fable5.2, medium effort, writes the implementation plan; Codex Astra6.2, medium
effort, debates it once before implementation. Then full review and CI with the
project round cap (three rounds unless an explicit stricter task gate applies).
After the cap, P2/P3 become tracked issues; P0/P1 remain blocking.

A PR involving migration, money or permissions/auth requires Waleed's final card
approval after all gates before merge. For other Heavy tasks, the manager merges
after all gates. Stage separately immediately after merge when staging deployment
is authorized; a migration requires a prior DB snapshot and its receipt. No tier
automatically authorizes production/server changes, secrets, activation or a HOLD.

### Actual model lanes and fallback

Use existing enabled, callable lanes; never silently change provider, spend or
permission settings. Light: manager or GLM, then Claude Sonnet. Medium/Heavy:
Kimi, MiniMax, GLM, Grok, Claude Sonnet, in that order, skipping unavailable lanes
with an explicit record. Two failed attempts or exhausted quota moves to the next
available lane without a new routine approval. Heavy on Sonnet uses high effort.

Observed T3 mappings on adoption (recheck capabilities when delegating):

- Manager: current Codex session, no model switch required for Light.
- Kimi: acpRegistry_kimi_cli, kimi-code/k3.1-pro.
- MiniMax: acpRegistry_minimax_code, m:minimax:MiniMax-M3.1-Flash:v:thinking.
- GLM: opencode, vercel/zai/glm-4.7; callable metadata is not quota verification.
- Grok: grok, grok-4.7.
- Claude Sonnet: claudeAgent, claude-sonnet-5-5.
- Heavy planner: claudeAgent, claude-fable-5-2, effort medium.
- Heavy plan debate: codex, gpt-6.2-astra, reasoningEffort medium.

Cursor requires a paid plan in the observed environment; do not use that blocked
lane or purchase access. If required planning models become unavailable, report
the precise constraint instead of inventing an equivalent review or switching
models without authorization. Do not start parallel replacement implementations.

### After every merge

Summarize the active plan in three parts: **ما تم** (main tasks done and PRs),
**الباقي** (each remaining main task, its subtasks and statuses), **التوصية**.
Fold side tasks under their main task and keep applicable roadmap/status files
in sync. End every report with these exact headings: **المطلوب منك**,
**الخطوة الجاية اللي أنصح بيها**, **ملاحظة**. Write **مفيش** when none.

### Preserved Hub boundaries

Keep existing security, exact-head CI/freshness, applicable review, release,
production, server, secrets, resource/cost and explicit HOLD/freeze controls.
Light's no-bot-wait rule replaces the ordinary bot-wait requirement only for
qualifying owner-selected Light work; Medium's cap does not bypass hard gates.
Waleed's explicit continuation permits this docs task; it does not resume frozen
product implementation, CI optimization, runtime maintenance or connector rollout.
Preserve all unrelated dirty/untracked/ignored work and KEEP/rollback artifacts.

The current main workflow automatically publishes a new Windows release after
successful main CI+Security. Preserve that existing workflow; do not infer a
local installation, runtime transition or manual staging/production deployment
from documentation merge or publication. Never replace an existing release/tag.

SSH-Musalam-2 stays on the exact discovered Waleed MCP Hub route and hub://guide
permission rules. Tool Full permission does not override upstream policy or
transport budgets and does not authorize an unrelated production operation.
