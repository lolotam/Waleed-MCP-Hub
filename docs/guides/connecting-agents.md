# Connect your AI agents to the hub

The hub adds one entry, `waleed-mcp-hub`, to each agent's own MCP config file. That
entry starts the hub's bridge, which shows the agent every enabled, approved
connector. You connect each agent once; adding or changing connectors later does
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

**Integrated** in the hub means the entry is in the file. Whether the agent
actually connected is only visible inside the agent.

**Disconnect** removes only the `waleed-mcp-hub` entry.

## Supported agents and their files

| Agent          | File the hub edits                                                  | After integrating                                    |
| -------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| Claude Desktop | see [Claude Desktop](#claude-desktop)                               | Quit Claude completely (tray icon → Quit) and reopen |
| Claude Code    | `~/.claude.json`                                                    | Start a new session; check `/mcp`                    |
| Codex CLI      | `~/.codex/config.toml` (or `CODEX_HOME`)                            | Restart Codex                                        |
| OpenCode       | `~/.config/opencode/opencode.json` or `.jsonc`                      | `/reload` or restart; check `/mcps`                  |
| VS Code        | `%APPDATA%/Code/User/mcp.json`                                      | **MCP: List Servers** → start the server             |
| Cursor         | `~/.cursor/mcp.json`                                                | Restart Cursor                                       |
| Antigravity    | `~/.gemini/antigravity/mcp_config.json`                             | Restart                                              |
| Kimi Code      | `~/.kimi-code/mcp.json` (or `KIMI_CODE_HOME`)                       | New session; check `/mcp`                            |
| Kilo Code CLI  | `~/.config/kilo/kilo.json` (or the only `kilo.jsonc`/`config.json`) | Restart                                              |

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

Agents see `<connector>__<tool>`, lowercase connector name, up to 40 characters,
for example `ssh-prod-mcp__run-command`. Agents add their own prefix, such as
Claude Code's `mcp__waleed-mcp-hub__`. If you previously allowed a tool in an agent
under an old `wmh_…` name, allow it again under the new name.

## When an agent doesn't show the tools

See [troubleshooting.md](troubleshooting.md#an-agent-shows-no-hub-tools).
