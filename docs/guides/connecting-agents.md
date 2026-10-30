# Connect your AI agents to the hub

## Connect an HTTP client by URL

Open **Settings → HTTP endpoint → Generate Client Token**. Name the client and
optionally restrict its agent identity and profile. Copy the token/config now:
the full value is never readable again, and leaving Settings clears its display.
Use the local `/mcp` URL in a client supporting Streamable HTTP and Bearer headers.
The copied snippet is not a stdio configuration; clients without native HTTP
support need a separately reviewed adapter. Never place a token in a URL.

The client initializes with `POST /mcp`, then sends its `Mcp-Session-Id` and
`Authorization: Bearer …` on subsequent POST, GET SSE and DELETE requests. HTTP
sessions do not use browser cookies. Revoke a token in Settings to close all of
its sessions; deleting a session alone does not revoke the token. Copying a token
does not configure any installed agent or grant execution approval. Token profiles
only narrow an agent's existing permissions. Missing or disabled profiles fail closed.

A 401 means the token is missing, expired or revoked. A 403 means the direct
loopback/Host/Origin boundary was refused. A 404 session error requires a fresh
initialize with the same valid token. Do not automatically replay a tool call:
already-dispatched side effects cannot be undone. Keep copied secrets private;
the clipboard and client config are outside the Hub's hash-only token store.

The hub adds one entry, `waleed-mcp-hub`, to each agent's own MCP config file. That
entry starts the hub's bridge, which shows the agent its eligible enabled, approved
connectors. You connect each agent once; adding or changing connectors later does
not rewrite agent files.

## Steps

1. Open **Agents** → **Scan Installed Agents**. Scanning only reads files; it starts
   no agent.
2. Review each agent's config path and status.
3. Choose **1-Click Integrate** for the agents you want. The hub makes a private
   backup first, edits only its own entry, keeps your comments and other servers,
   and reads the file back to confirm.
4. Restart or reconnect the agent (table below), then approve the new server if
   the agent asks.
5. In the agent, list MCP servers or tools and look for `waleed-mcp-hub`.
6. Optionally choose a **Profile / Tool Set** for each integrated agent. Unassigned
   agents keep **All Connectors (Default)**; assigned agents see only that profile's
   enabled, approved members, subject to Ask/Block. Empty or disabled profiles expose
   nothing. Refresh the client's tool list after changes if it does not do so itself.

**Integrated** in the hub means the entry is in the file. Whether the agent
actually connected is only visible inside the agent.

**Disconnect** removes only the `waleed-mcp-hub` entry.
Profile assignments remain saved, so reintegration does not silently restore wider
access. Selecting **All Connectors (Default)** is an explicit assignment reset.

### Large tool catalogs

Enable **Tool Search Mode (search_tools + call_tool)** on an agent row to advertise
only two meta-tools instead of all connector schemas. Refresh the client's tool
list, call `search_tools` with a descriptive query, then pass a returned tool's
exact name and schema-compatible arguments to `call_tool`. Search runs catalog
discovery, not upstream tool calls. Profile boundaries and Allow/Ask/Block remain
enforced; Ask still needs one-time elicitation confirmation. The mode defaults to
off, persists independently of the selected profile and changes no agent files.
Turning it off restores the normal catalog. Partial searches are explicitly marked
`truncated`; do not treat those as a complete inventory.

## Supported agents and their files

| Agent          | File the hub edits                                                                              | After integrating                                    |
| -------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Claude Desktop | see [Claude Desktop](#claude-desktop)                                                           | Quit Claude completely (tray icon → Quit) and reopen |
| Claude Code    | `~/.claude.json`                                                                                | Start a new session; check `/mcp`                    |
| Codex CLI      | `~/.codex/config.toml` (or `CODEX_HOME`)                                                        | Restart Codex                                        |
| OpenCode       | `~/.config/opencode/opencode.json` or `.jsonc`                                                  | `/reload` or restart; check `/mcps`                  |
| VS Code        | `%APPDATA%/Code/User/mcp.json`                                                                  | **MCP: List Servers** → start the server             |
| Cursor         | `~/.cursor/mcp.json`                                                                            | Restart Cursor                                       |
| Antigravity    | `~/.gemini/antigravity/mcp_config.json`                                                         | Restart                                              |
| Kimi Code      | `~/.kimi-code/mcp.json` (or `KIMI_CODE_HOME`)                                                   | New session; check `/mcp`                            |
| Kilo Code CLI  | `~/.config/kilo/kilo.json` (or the only `kilo.jsonc`/`config.json`)                             | Restart                                              |
| Windsurf       | `~/.codeium/windsurf/mcp_config.json`                                                           | Restart legacy Cascade; check MCP settings           |
| Cline          | `%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`     | Reload VS Code; reconnect in Cline                   |
| Roo Code       | `%APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json` | Reload VS Code; reconnect in Roo Code                |
| Zed            | `%APPDATA%/Zed/settings.json` or sole `~/.config/zed/settings.json`                             | Settings → AI → MCP Servers                          |
| Gemini CLI     | `~/.gemini/settings.json` (sole existing `mcp.json` compatibility candidate)                    | Restart; check `/mcp`                                |
| Goose          | `%APPDATA%/Block/goose/config/config.yaml` or sole Local/config-home candidate                  | Restart/new session; inspect Extensions              |
| JetBrains AI   | Existing `%APPDATA%/JetBrains/mcp.json` compatibility file                                      | Verify or import JSON in AI Assistant MCP settings   |
| Warp           | `~/.warp/.mcp.json` or sole existing Local/`~/.warp/mcp.json` candidate                         | Review Settings → Agents → MCP servers               |

## Claude Desktop

Claude Desktop keeps its config in different places depending on how it was
installed. The hub picks the one your install actually reads:

| Install                         | Config file                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| Microsoft Store, current builds | `%LOCALAPPDATA%\Claude-Data\claude_<id>\claude_desktop_config.json`                        |
| Microsoft Store, older builds   | `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json` |
| Classic installer               | `%APPDATA%\Claude\claude_desktop_config.json`                                              |

To check which one Claude uses: in Claude Desktop, open **Settings → Developer →
Edit Config**. The folder that opens is the real one.

After integrating, quit Claude Desktop from the tray icon (closing the window is not
enough) and reopen it. The server appears under **Settings → Developer** and in the
connectors menu of a new chat.

## Tool names inside agents

Default generated names use the format below. A saved tool override can replace
the exposed name with an exact alias up to 64 characters; policies still use the
original provider name. Some clients impose shorter limits after adding a prefix.

Agents see `<connector>__<tool>`, lowercase connector name, up to 40 characters,
for example `ssh-prod-mcp__run-command`. Agents add their own prefix, such as
Claude Code's `mcp__waleed-mcp-hub__`. If you previously allowed a tool in an agent
under an old `wmh_…` name, allow it again under the new name.

## When an agent doesn't show the tools

See [troubleshooting.md](troubleshooting.md#an-agent-shows-no-hub-tools).

## Cursor

Scan and review `~/.cursor/mcp.json`, consent to user-file changes, then choose
**1-Click Integrate** on the Cursor row. Restart Cursor and check its MCP settings.
Existing servers remain untouched; configuration integration is not live verification.

## VS Code

The Hub edits `%APPDATA%/Code/User/mcp.json` in the user scope. After reviewed
integration, use **MCP: List Servers** and start the Hub entry. Workspace settings
and VS Code trust decisions remain under your control.

## Codex

The CLI integration uses `~/.codex/config.toml` (or the configured `CODEX_HOME`).
Review the scanned path and status, integrate, then restart Codex. Never overwrite
an ambiguous or foreign Hub entry to get past a conflict.

## OpenCode

The Hub scans `~/.config/opencode/opencode.json` or `.jsonc`. After reviewed
integration, use `/reload` or restart and check `/mcps`. Multiple ambiguous config
files or project overrides need manual review; scanning never starts a model turn.

## Windsurf

The Hub edits the requested legacy `.codeium/windsurf` Cascade scope, not a newer
rebranded client's different settings. Reconnect Cascade and review team MCP
allowlists. Configuring the file does not override organizational policy.

## Cline and Roo Code

Open the installed extension once so its default VS Code user settings file exists.
Scan, review the extension-specific path, consent and integrate. Cline CLI, remote
workspaces and alternate VS Code profiles are different scopes and remain untouched.
Existing auto-approval lists and unrelated servers are preserved.

## Zed

The owned entry goes under `context_servers`, with a flat command and args. A sole
existing `mcpServers` compatibility map can be edited, but both maps in one file or
multiple candidate files are ambiguous. Review Zed's MCP settings and tool prompts;
the Hub never changes client-wide permissions or agent profiles.

## Gemini CLI

Current Gemini uses user `~/.gemini/settings.json`; the requested `mcp.json` is kept
as an existing-file compatibility candidate. Only one can exist. Restart and check
`/mcp`; exclusions, trust flags and project/enterprise overrides remain unchanged.

## Goose

Goose uses YAML `extensions`, with stdio `cmd` and `args`. The current Windows
default is `%APPDATA%/Block/goose/config/config.yaml`; alternate Local/config-home
paths are accepted only when sole. The Hub edits only its owned block entry, not
provider settings, permissions or `secrets.yaml`. Unsupported YAML constructs fail
closed. Protected adoption of existing Goose extensions is not supported yet, but
integrate/disconnect, profile selection and tool-search mode are supported.

## JetBrains AI

JetBrains documents **Settings → Tools → AI Assistant → MCP → Add/Import JSON**,
not a guaranteed shared JSON config path. The requested `%APPDATA%/JetBrains/mcp.json`
scope must already exist; the Hub does not invent it or modify versioned IDE XML.
Verify the IDE reads that file, or import the reviewed Hub entry manually. A green
configuration status in the Hub is not proof of an IDE connection.

## Warp

Current file-based Warp configuration uses `~/.warp/.mcp.json`. Existing Local
`warp/mcp.json` or `~/.warp/mcp.json` are compatibility candidates; multiple files
are refused. Review the Hub in Warp MCP settings. Auto-spawn, third-party-provider
toggles and project-scoped approvals remain under your control.
