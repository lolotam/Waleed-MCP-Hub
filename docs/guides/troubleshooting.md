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
- OAuth servers: use the curated Linear flow, or **Discover OAuth provider**
  for compatible standard PKCE providers. Review the issuer and scopes before
  signing in. A provider's API token can be an alternative. See
  [adding-mcps.md](adding-mcps.md#oauth-sign-in).

## Test capabilities shows "error" or "unavailable"

- Native: check that the `.exe` path exists and the arguments match what the server
  expects. Run the same command in PowerShell to see its own error.
- The process gets an isolated environment. Add every variable it needs to
  **Protected environment values**.
- Remote: use public HTTPS, or explicitly opted-in HTTP on `localhost`/`127.0.0.1`
  with an explicit port. Other private/LAN destinations and redirects are refused.
- Docker: Docker Desktop must be running with a local context.

## Saving fails with "unsupported executable"

Shell shims, `.cmd`, `.bat` and scripts aren't run directly as native executables.
For npm/Python tools, select a **Managed package** connection with an exact version
and executable name. Alternatively install the package yourself and use `node.exe`

- entry script, or the tool's real `.exe`. See
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
5. Docker connectors with protected values require the reference-only Docker vault
   and a supported local gateway. DPAPI setup import does not convert those bindings.

## A tool works once, then "forgets" a session

The managed bridge reuses bounded native, remote and Docker sessions, but a restart,
credential rotation, profile/approval change or session lifetime limit can close
them. Refresh the catalog and explicitly reopen the provider session. Use single-shot
tools when possible. The Hub never replays a failed tool call automatically.

## A tool call says "Refresh the hub tool list"

The connector changed since the agent last listed tools. Reconnect the agent, or
ask it to list tools again.

## Exit code -1 or a process will not start

An exit code alone does not identify the cause. Check the connector's approved
executable/image, exact arguments, runtime installation and protected bindings.
Native processes run under a Windows JobObject with a restricted environment;
an uncontained fallback is never attempted. Package installation requires its own
explicit consent. Re-test capabilities only after reviewing the definition.

Inspect local runtime/recovery metadata and `desktop.log`. Do not paste credentials,
provider output or private agent configuration into support messages. If cleanup or
state is uncertain, keep recovery blocked rather than deleting locks or retrying.

## A connector has a Needs Re-auth badge

Open **Authentication** from the connector row. Supply a fresh API key or review
the OAuth provider/scopes and sign in again. The badge can mean missing credentials,
expired tokens or a failed refresh; it is not permission to retry a tool call.
Credential changes may require new execution approval. Test capabilities explicitly
after signing in. Revocation and local-only disconnect are different actions.
