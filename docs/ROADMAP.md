# Roadmap

Goal: anyone can connect **any** MCP server to **any** agent from one free, local,
open-source app, without giving up the hub's safety model (approve exact
definitions, protected credentials, read-back of every file it writes, no silent
overwrites).

Priorities below come from comparing similar open-source projects (October 2026)
and from gaps found while connecting real servers. P0 items unblock whole classes
of servers; P1 items make daily use better; P2 items widen who can use the app.

## What similar projects offer

| Project                                                                                                                                                                                                     | Kind                    | Notable features                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Docker MCP Toolkit / Gateway](https://docs.docker.com/ai/mcp-catalog-and-toolkit/toolkit/)                                                                                                                 | Desktop + CLI           | Curated catalog, one-click add, built-in OAuth with a revoke tab, [profiles](https://docs.docker.com/ai/mcp-catalog-and-toolkit/profiles/), custom catalogs, agents can add tools mid-conversation |
| [MCP Router](https://mcpservers.org/servers/mcp-router/mcp-router)                                                                                                                                          | Desktop app (Win/macOS) | Server and per-tool on/off toggles, projects and workspaces, import from JSON/DXT, request logs and stats, token-based client connection                                                           |
| [MetaMCP](https://docs.metamcp.com/en/concepts/namespaces)                                                                                                                                                  | Self-hosted gateway     | Namespaces, middleware, tool rename/description/annotation overrides, built-in inspector, API-key or OAuth endpoints                                                                               |
| [MCPHub](https://www.mcphub.app/)                                                                                                                                                                           | Self-hosted gateway     | Web dashboard, server groups with their own endpoints, hot-swap servers, OAuth/bearer auth, semantic tool search                                                                                   |
| [1MCP](https://github.com/1mcp-app/agent)                                                                                                                                                                   | CLI aggregator          | Presets (named server sets), hot reload, lazy loading, fast startup                                                                                                                                |
| [ToolHive](https://docs.stacklok.com/toolhive/)                                                                                                                                                             | Desktop + CLI           | Curated registry, every server in an isolated container, secrets store/1Password, permission profiles                                                                                              |
| [MCPM](https://github.com/pathintegral-institute/mcpm.sh)                                                                                                                                                   | CLI                     | Install once, profiles, writes Claude Desktop/Cursor/Windsurf configs, registry search                                                                                                             |
| [Obot](https://glama.ai/blog/2025-09-13-obot-mcp-gateway-an-enterprise-control-plane-for-the-model-context-protocol), [IBM ContextForge](https://cortex-gateway.dev/alternatives/open-source-mcp-gateways/) | Team gateways           | SSO, multi-user, RBAC, audit                                                                                                                                                                       |

What this hub already does better than most: DPAPI-protected credentials that are
never shown again, explicit approval bound to the exact definition, atomic agent
file edits with private backups and read-back, a recovery journal, and seventeen agent
targets from one screen.

## P0 — connect any server

1. **Run npm and Python packages directly — implemented (Task 3, Windows subset).**
   Managed exact-version npm/uv installation uses an isolated cache, separate
   installation/execution consent, receipt validation and contained launch.
   POSIX installer validation remains unavailable; see the
   [guide](guides/adding-mcps.md#npm-package-npx).
2. **General OAuth for remote servers — implemented (Task 4, reviewed subset).**
   Protected-resource/authorization metadata discovery, S256 PKCE, public dynamic
   registration or an explicitly configured client metadata URL when advertised,
   refresh and connected-account revoke
   are supported with origin/issuer pinning and explicit consent. This does not
   certify arbitrary providers or hosted client metadata documents; live-account
   verification and POSIX stable-reference rotation remain release work.
3. **Keep connector sessions alive — implemented (Task 2).** The managed bridge
   reuses one peer per connector per bridge/MCP session, with five-minute idle expiry,
   a one-hour hard lifetime, per-connector serialization and approval/credential
   revalidation before use. Native Job Objects, long-lived Docker gateways, HTTP
   session DELETE and shutdown/EOF cleanup preserve containment. Direct materialized
   profile launchers and capability checks remain separately bounded, one-shot paths.
4. **Browse and add from the official MCP Registry — implemented (Task 5).** Search
   [registry.modelcontextprotocol.io](https://modelcontextprotocol.io/community/working-groups/registry),
   read each `server.json` (packages, remotes, required env vars), and prefill the
   add form. Registry listings are untrusted suggestions: exact versions, package
   executable names, missing arguments, credentials and execution approval still
   require review. Only fixed official-registry metadata requests are made.
5. **Import from agents you already use — implemented (Task 5).** Read `mcpServers` from Claude Desktop,
   Cursor, VS Code, Codex TOML and OpenCode JSONC, convert `npx`/`uvx` entries via
   item 1, and move selected secrets into the protected store. Reviewed apply binds
   enabled Hub profiles, removes only selected source AST entries and inserts the
   managed bridge. Recovery copies are encrypted via DPAPI, never ordinary plaintext
   agent backups. Unpinned packages need an explicit exact version. Source drift and
   uncertain external writes fail closed. Legacy Docker-pilot adoption stays separate
   and disabled; unsupported agent/runtime fields are not silently dropped.
6. **Local HTTP servers (opt-in) — implemented (Task 6).** Support literal
   `http://127.0.0.1:<port>` and `http://localhost:<port>` with explicit consent bound
   to the connector's execution hash. Localhost must resolve exclusively to
   `127.0.0.1`/`::1`, with addresses rechecked/pinned on each request. LAN/metadata
   addresses, aliases, non-loopback HTTP and redirects remain denied. Local SSE and
   Streamable HTTP reuse managed host-bridge sessions; Docker profile snapshots
   are not used for host loopback endpoints.
7. **Install `.mcpb` bundles — implemented (Task 7, strict Windows subset).** Claude Desktop's
   [bundle format](https://www.anthropic.com/engineering/desktop-extensions) is a
   zip with `manifest.json` describing the runtime, tools and user config, which
   maps onto a managed native connector plus a protected configuration form.
   File/drop review accepts bounded stored/deflated ZIPs (25 MiB compressed,
   50 MiB extracted, 500 entries), rejects unsafe paths/links/collisions, and runs
   no archive code or dependency installers. Node, local Python and bundled `.exe`
   entry points use JobObject containment and persistent bridge sessions after
   separate execution approval. All environment configuration is DPAPI-backed;
   protected argument substitution and unsupported execution fields fail closed.

8. **Smart add, then agent-driven add — Smart Paste implemented (Task 6).** A
   single data-only paste box recognizes HTTPS/opt-in loopback URLs, simple
   `npx`/`uvx` commands, Docker images/run commands and supported JSON blocks.
   Instant detection never executes; reviewed input pre-fills Add MCP or creates a
   sanitized private import draft. Shell chaining/expansion, inherited env vars and
   unsupported Docker runtime flags are refused. Registry names remain handled by
   the separate registry browser. Next expose a small hub tool set
   (`hub_draft_connector`, `hub_test_connector`) so the agents people already use
   can say "add the Notion MCP": the agent drafts, the hub window asks the user to
   approve the exact definition and opens sign-in when needed. The agent may only
   draft; it never approves and never sees secrets, because a server's README can
   carry prompt-injection text. Depends on items 1, 2 and 4.

   Finally, a built-in chat for users with no agent connected, driven by
   [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)
   for provider sign-in (ChatGPT/Codex and other subscription OAuth flows) and
   API-key providers. Postora Browser Agent's `src/background/account-login.js` is
   the reference integration. Provider tokens go into the DPAPI store like every
   other credential, and the same draft-only rule applies.

   The chat flow: the agent searches the registry and recommends a server; the hub
   shows a **sign-in card** for OAuth servers and a **secrets card** listing the
   exact fields an API-key server needs. The user types values into the card, never
   into the chat, and the agent only learns that a value was saved. The card ends
   with approval of the exact definition, after which the agent tests the connector
   and reports which tools work.

## P1 — control and daily use

9. **Per-tool Allow / Ask / Block — implemented (Task 8).** Block omits the
   tool's metadata from the managed bridge catalog and refuses stale calls. Ask
   uses a one-call MCP form elicitation confirmation; unsupported clients fail
   closed, with a Hub-window approval queue left as a future enhancement. Existing
   unconfigured tools, including read-only tools, retain Allow. Tools & Permissions
   provides revision-checked per-tool settings. Policies are rechecked after
   confirmation and before dispatch; restrictive policies cannot be bypassed by
   direct profile snapshots.
10. **Per-agent tool sets — implemented (Task 9).** Map each integrated agent to
    an existing Hub profile, or explicitly keep All Connectors (Default). The
    managed bridge filters discovery and rechecks calls, pending confirmations,
    startup and queued dispatch against that agent's current assignment. Empty or
    disabled profiles expose nothing; assigned profiles require reassignment before
    deletion. Revision-checked mapping changes write no agent files. The Agents UI
    shows eligible connector counts and policy-aware discovered-tool estimates;
    running bridges notify clients when membership or assignments change.
11. **Tool-search mode for big catalogs — implemented (Task 10).** Optional,
    revision-checked per-agent mode exposes only `search_tools` + `call_tool`.
    Metadata discovery is deferred until search/call, with ranked name/description/
    keyword matching, bounded results and explicit partial-catalog indicators.
    `call_tool` reuses the full profile/approval/Ask/Block/credential/containment
    chain. Disabled by default; normal catalogs remain backward compatible. This
    avoids sending hundreds of schemas before an agent needs them.
12. **Tool playground and request log — implemented (Task 11).** Explicit
    one-call confirmation and stale-review checks use the same contained,
    credential-protected runtime as agent bridges. A responsive live table shows
    at most 500 memory-only call records (tool, agent, duration, result size and
    status; never arguments, result bodies or provider errors). Bounded local IPC
    collects agent-process metadata; temporary owner-scoped output is redacted.
13. **Forward resources and prompts — implemented (Task 12).** Profile-scoped,
    approval-checked catalogs, opaque resource/template URIs, collision-safe prompt
    handles and managed reads/gets. Embedded resource links are namespaced; stale
    routes and credential echoes fail closed. List changes invalidate catalogs.
    Subscriptions remain explicitly disabled, not silently forwarded.
14. **Health and lifecycle — implemented (Task 13).** Metadata-only health/auth
    inspection, on-demand checks and opt-in five-minute background re-tests, a
    collapsed-row Needs Re-auth badge and direct sign-in action. The compiled
    Windows launcher provides tray Open/Check Health/Exit and optional owned-window
    close shutdown. Opt-in HKCU Run uses only its own verified launcher; conflicting
    entries and arbitrary executable/key inputs fail closed.
15. **Tool overrides — implemented (Task 14).** Revision-checked aliases,
    descriptions and merged annotations customize managed agent catalogs/search.
    Original tool identity still authorizes every dispatch. Reserved/known alias
    collisions are rejected; newly discovered collisions and stale reviews fail
    closed. Tools & Permissions provides Customize, Overridden and Reset to Default.

## P2 — reach more people

16. **Export / import setups without secrets — implemented with conservative
    backend limits (Task 15).** Versioned projected JSON, owner-scoped expiring
    review, collision strategies, DPAPI credential fields and one atomic journaled
    registry transaction. Settings provides download/upload/drop, review and Apply
    Setup. Approval/OAuth accounts/installations never transfer. Unreadable protected
    credentials block export; credential-bound Docker conversion remains refused
    to preserve its reference-only gateway (bind Docker credentials separately).
17. **In-app help and a first-run wizard — implemented (Task 16).** Four inline
    steps reuse reviewed agent/MCP flows; Finish/Skip persist completion and Settings
    provides explicit rerun. A searchable accessible drawer bundles the actual
    [guides](guides/README.md), with escaped Markdown, checked links and no provider
    requests. Empty completed workspaces never reopen the tour automatically.
18. **More agents — implemented (Task 17).** Windsurf, Cline, Roo Code, Zed,
    Gemini CLI, Goose, JetBrains AI and Warp bring configuration targets to 17.
    Scoped JSONC/YAML edits, private backups, path+content stale handles and shared
    profile/search/permission dispatch apply to all. Ambiguous/unsupported client
    scopes fail closed; JetBrains shared JSON requires existing scope/client import
    verification, not an assumed live connection.
19. **An HTTP endpoint for the hub itself — implemented (Task 18).** Loopback
    `/mcp` POST/GET/DELETE uses per-client Bearer tokens, token-owned SDK sessions
    and the existing secured bridge. Private hash-only persistence, browser-protected
    management APIs, one-time Settings disclosure, profile intersection, revocation,
    expiry and bounded session cleanup are included. Legacy SSE-only clients and
    non-loopback deployment are not supported.
20. **macOS and Linux readiness abstraction — implemented (Task 19).** Platform
    credential storage selects existing Windows DPAPI, macOS Keychain or Linux
    Secret Service/libsecret, without a plaintext fallback. Platform directory and
    17-agent target resolution, a POSIX process-group runner, and protected Settings
    diagnostics are included. This is readiness, not a native release claim:
    macOS/Linux system-keyring/agent/packaging verification, POSIX installers,
    OAuth rotation and desktop lifecycle remain release work. Windows keeps its
    existing DPAPI format and JobObject implementation.

## Later — teams

21. **Multi-user mode with sign-in.** Per-user credential vaults, SSO (OIDC), roles
    for who may add or approve connectors, and a shared audit log. Team gateways
    such as Obot and ContextForge cover this space; it only makes sense once the
    single-user app is complete.
