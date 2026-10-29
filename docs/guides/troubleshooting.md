# Troubleshooting

Start with the launcher log: `%LOCALAPPDATA%\WaleedMcpHub\desktop.log`.

## The app window is plain white

The hub registers its page files when it starts. If the app was rebuilt while it
was running, the old hub can't serve the new files.

Current launchers detect a rebuild and restart the hub automatically when you open
the exe again. With an older launcher: **Settings → Stop desktop manager**, then open
`WaleedMcpHub.exe` again.

## The exe or `start-desktop.bat` closes immediately

- Node.js 24 is required. The portable folder ships `runtime\node.exe`; when running
  from source, check `node --version`.
- Microsoft Edge must be installed; the window opens in Edge app mode.
- Read `desktop.log` for the exact reason.

## "Port 4177 is occupied"

Another program, or a second hub, is using the port. Close it, or start the hub
with a different `HUB_PORT`. The hub never stops other processes for you.

## The hub says changes are blocked for recovery review

An earlier save was interrupted and the hub couldn't prove whether it finished. A
**Recovery review required** panel appears; use **Inspect recovery metadata** and the
"Runtime data and recovery" section of the [README](../../README.md). The hub won't
overwrite or replay anything on its own.

## A connector shows "approval required"

Editing, re-enabling or changing credentials clears approval on purpose. Open the
row → **Approve execution** → confirm.

## Test capabilities shows "auth_required"

The server wants credentials the hub doesn't have:

- API key servers: **Authentication** → enter the key with the right **Header
  format**, approve again, test again.
- OAuth-only servers: only Linear read-only is supported today. Use the
  provider's token option if it has one. See
  [adding-mcps.md](adding-mcps.md#oauth-sign-in).

## Test capabilities shows "error" or "unavailable"

- Native: check that the `.exe` path exists and the arguments match what the server
  expects. Run the same command in PowerShell to see its own error.
- The process gets an isolated environment. Add every variable it needs to
  **Protected environment values**.
- Remote: the URL must be public HTTPS. `localhost` and private addresses are refused.
- Docker: Docker Desktop must be running with a local context.

## Saving fails with "unsupported executable"

`npx`, `uvx`, `.cmd`, `.bat` and scripts aren't run directly. Install the package
and use `node.exe` + entry script, or the tool's real `.exe`. See
[adding-mcps.md](adding-mcps.md#npm-package-npx).

## An agent shows no hub tools

1. In the hub, the connector must be **enabled**, **approved**, and its test must
   list tools.
2. The agent must show **Integrated** under **Agents**. If it shows **Unknown** with
   a note such as **conflict** or **ambiguous scope**, the file has a
   `waleed-mcp-hub` entry the hub didn't write, or the agent has more than one
   config file. Fix that manually first.
3. Restart the agent fully (see the table in
   [connecting-agents.md](connecting-agents.md)).
4. Claude Desktop: make sure the hub wrote the file Claude actually reads. See
   [connecting-agents.md](connecting-agents.md#claude-desktop).
5. Docker connectors with protected values are not exposed to agents yet.

## A tool works once, then "forgets" a session

Native connectors start a fresh process for each tool call, so state such as an
open SSH session doesn't survive between calls. Use the server's single-shot tools
(for example `run-command` instead of `open-session` + `read-session-output`).

## A tool call says "Refresh the hub tool list"

The connector changed since the agent last listed tools. Reconnect the agent, or
ask it to list tools again.
