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
file edits with private backups and read-back, a recovery journal, and nine agent
targets from one screen.

## P0 — connect any server

1. **Run npm and Python packages directly.** Most servers are published as
   `npx -y pkg` or `uvx pkg`. **npm: done (F01, D024).** The hub looks up an exact
   version and its full dependency tree, shows it for review, installs it from the
   frozen lock into its own folder, and checks every file before each launch
   ([guide](guides/adding-mcps.md#npm-package-npx)). **Python: next (F01b)**, after
   decisions on interpreter provenance, wheel targeting and credential isolation.
   Until then, `uvx` servers are installed by hand.
2. **General OAuth for remote servers.** Only Linear read-only works today. Implement
   the MCP authorization spec: protected-resource metadata discovery, PKCE, client
   ID metadata documents with dynamic client registration as fallback
   ([spec change summary](https://den.dev/blog/mcp-november-authorization-spec/)),
   token refresh, and a "connected accounts" list with revoke. This unblocks
   Notion, Atlassian, Sentry, GitHub and most hosted servers.
3. **Keep connector sessions alive.** The bridge starts a fresh native process for
   every tool call, so stateful servers break: SSH sessions, browser automation,
   database transactions. Keep one peer per agent session with an idle timeout,
   still revalidating approval before each call.
4. **Browse and add from the official MCP Registry.** Search
   [registry.modelcontextprotocol.io](https://modelcontextprotocol.io/community/working-groups/registry),
   read each `server.json` (packages, remotes, required env vars), and prefill the
   add form, so users fill in only their keys.
5. **Import from agents you already use.** Read `mcpServers` from Claude Desktop,
   Cursor, VS Code, Codex TOML and OpenCode JSONC, convert `npx`/`uvx` entries via
   item 1 (pasted `npx` entries already become package proposals with an
   **Install** button), and move secrets into the protected store. The adoption preview exists
   but apply is disabled.
6. **Local HTTP servers (opt-in).** Allow `http://127.0.0.1:<port>` endpoints after
   explicit confirmation, for servers that run locally over HTTP.
7. **Install `.mcpb` bundles.** Claude Desktop's
   [bundle format](https://www.anthropic.com/engineering/desktop-extensions) is a
   zip with `manifest.json` describing the runtime, tools and user config, which
   maps directly onto a hub connector plus a credentials form.

8. **Smart add, then agent-driven add.** First a single paste box that recognises a
   URL, an `npx`/`uvx` command, a Docker image, a JSON block or a registry name and
   prefills the form (plain code, no AI needed). Then expose a small hub tool set
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

9. **Per-tool Allow / Ask / Block** (in progress). Block hides the tool; Ask
   prompts inside the agent when it supports MCP elicitation, otherwise in the hub
   window. Read-only tools default to Allow.
10. **Per-agent tool sets.** Choose which connectors each agent sees (like MetaMCP
    namespaces, MCPHub groups, Docker profiles, 1MCP presets). Profiles already
    exist and could map to agents.
11. **Tool-search mode for big catalogs.** Expose a small `search_tools` +
    `call_tool` pair instead of hundreds of schemas, for agents without native tool
    search. Large catalogs cost [tens of thousands of tokens](https://www.wati.io/en/blog/lazy-loading-mcp-tools-explained/)
    before any work starts.
12. **Tool playground and request log.** Call a tool from the hub with explicit
    confirmation, and keep a local log of agent calls (tool, agent, duration,
    result size; never arguments that may hold secrets).
13. **Forward resources and prompts**, not only tools.
14. **Health and lifecycle.** Tray icon, start with Windows, background re-tests,
    and a clear "needs re-auth" badge.
15. **Tool overrides.** Rename a tool or edit its description and annotations, as
    in MetaMCP.

## P2 — reach more people

16. **Export / import setups without secrets**, so people can share a working
    configuration and only re-enter their own keys.
17. **In-app help and a first-run wizard** that link to [the guides](guides/README.md).
18. **More agents:** Windsurf, Cline, Roo Code, Zed, Gemini CLI, Goose, JetBrains AI,
    Warp.
19. **An HTTP endpoint for the hub itself** (Streamable HTTP with a per-client
    token), for clients that only accept a URL.
20. **macOS and Linux** support (Keychain / libsecret instead of DPAPI).

## Later — teams

21. **Multi-user mode with sign-in.** Per-user credential vaults, SSO (OIDC), roles
    for who may add or approve connectors, and a shared audit log. Team gateways
    such as Obot and ContextForge cover this space; it only makes sense once the
    single-user app is complete.
