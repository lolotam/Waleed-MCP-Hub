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

`npx`, `uvx`, `.cmd`, `.bat` and scripts aren't run directly. For an npm package,
use the **npm package — managed install** connection type. For anything else, use
the tool's real `.exe`. See [adding-mcps.md](adding-mcps.md#npm-package-npx).

## npm package installs

- **"No release matches that version, range or tag"**: check the spelling, or
  leave **Version** blank for `latest`.
- **"A dependency is not a registry package"**: something in the tree comes from
  git, a URL, a file or an alias. The hub only installs from `registry.npmjs.org`.
  A [manual install](adding-mcps.md#manual-install-advanced) is possible if you
  trust the package, but read its warning first: it gives up the managed
  protections.
- **"The package is too large"**: the hub refuses trees over 500 MiB unpacked or
  50 000 files, and needs 2 GiB free on the drive of its data folder before it
  starts.
- **"This preview has expired"**: a preview lasts 10 minutes and can be used once.
  Choose **Look up again**.
- **"Another package job is running"**: one install and two lookups run at a time.
  Wait for the other job, then retry.
- **"The hub could not record this request in its audit log"**: the hub refuses
  changes it cannot audit. The terminal running the hub shows the reason; fix it,
  then retry.
- **"The install finished but saving could not be confirmed"**, or **"The hub no
  longer knows this job"**: refresh the connector list before installing again. A
  leftover install folder that no connector uses is deleted the next time the hub
  starts.
- **"The hub did not answer in time. Refresh to retry."**: the page gave up
  waiting after 20 seconds. Choose **Refresh**; nothing was changed by the wait.

## A package connector says "The installed files have changed since install"

Something edited, added or removed a file in its install folder (an antivirus
quarantine, a manual edit, a sync tool). The hub won't start it. Choose
**Reinstall**, then approve again.

The same check fails when the packages folder
`%LOCALAPPDATA%\WaleedMcpHub\packages\` itself, or any of its parent folders,
contains a `node_modules` folder, because Node would load code from there. Remove
or rename that `node_modules`; reinstalling won't help.

## A package connector says its definition does not match its package record

An environment variable name starts with `NODE_` or is an OpenSSL variable name
(`OPENSSL_CONF`, `OPENSSL_MODULES`, `OPENSSL_ENGINES`, `SSL_CERT_FILE`,
`SSL_CERT_DIR`); that is the only cause of this message. Check the names, not the
values. Remove that binding under **Edit**, then **Approve execution** again and
run **Test capabilities**. The row also
offers **Reinstall** and mentions a moved hub folder, but neither applies here:
reinstalling won't help. (A moved hub folder shows a different symptom, see the
[next section](#a-package-connector-stopped-starting-after-i-moved-the-hub-folder).)

## A package connector stopped starting after I moved the hub folder

A managed connector runs on the `node.exe` of the hub folder it was installed
from, and that path is stored in its approved definition. After a move the path
no longer exists, so **Test capabilities** ends in **error** with the reason
**protocol error**, and agents get "The connector is unavailable". **Verify
files** still passes (the installed files did not change), and **Reinstall** is
not offered.

- If **Check for update** finds a newer version, **Update to x.y.z** installs it
  on the current `node.exe`. **Approve execution** again, then run **Test
  capabilities**.
- Otherwise, remove the connector and install the package again, re-enter its
  protected values, then **Approve execution** and run **Test capabilities**.
  Moving the hub folder back also works.

The install folder itself lives in `%LOCALAPPDATA%\WaleedMcpHub\packages\` and does
not move with the hub folder.

## npm settings on this PC are ignored

That is intended. Look up and Install ignore your `.npmrc` files (user, global and
any parent project), proxies, registry settings and `npm login` tokens, and use
the npm version bundled with the hub, not the one on your `PATH`.

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

## A tool forgets a session (SSH, browser tab)

Each agent's bridge keeps one live session per connector, so state survives
between calls. The server starts fresh, and its state is gone, when:

- the session was idle for 5 minutes or is 60 minutes old;
- the connector was edited, disabled or unapproved, or its credentials changed;
- the hub restarted;
- a call timed out or was cancelled, or the server answered with error `-32000`
  or `-32001`;
- the agent restarted (every agent has its own bridge and its own sessions).

A failed call is never repeated for you. Open the session again (for example call
`open-session` again) and carry on.

## Docker connectors stay unavailable for one agent

The bridge records every container it launches in
`%LOCALAPPDATA%\WaleedMcpHub\owned-agent-containers\<agent>\<bridge>\<nonce>.json`
and removes the container and its record itself, also after a crash. It refuses
Docker for an agent when it cannot be sure what a record means. Quit the agent
first, then:

1. **More than 16 unfinished launches** for the agent: for each record, run
   `docker ps -a --filter label=wmh.client=<nonce>` (the file name is the nonce).
   Remove a listed container with `docker rm -f <id>`, then delete the record.
2. **Records from an older hub version**: files directly in
   `owned-agent-containers` (not in an agent folder). Each holds a `nonce`; check
   and remove its container the same way, then delete the file. These block
   Docker for every agent.
3. **A record for another Docker engine** (you switched Docker context or
   reinstalled Docker): check that engine with the same command, or delete the
   record once no container with that nonce exists anywhere.
4. **An empty or broken `install.json`** in `%LOCALAPPDATA%\WaleedMcpHub` (the
   hub stopped while creating it): quit the hub, delete the file, and start the
   hub again; it writes a new one. Containers from the old installation are not
   cleaned up automatically: list them with
   `docker ps -a --filter label=wmh.agent` and remove the ones no agent uses.

## A tool call says "Refresh the hub tool list"

The connector changed since the agent last listed tools. Reconnect the agent, or
ask it to list tools again.
