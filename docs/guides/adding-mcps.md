# Add any MCP server to the hub

This guide covers every kind of MCP server the hub can run today, with the exact
screens and fields to use. If something here no longer matches the app, the app is
right and this page needs fixing.

## The flow is always the same

1. **Save** the definition (nothing runs yet).
2. **Add credentials**, if the server needs them (Authentication on the connector row).
3. **Approve execution** — you confirm you trust this exact command, image or URL.
4. **Automatic discovery** — enabled, approved connectors load their tools when
   the connector list opens. **Test capabilities** retries a failed check.
   Discovery never calls a tool.
5. **Connect your agents** once (see [connecting-agents.md](connecting-agents.md)).
   Every enabled, approved connector then appears in each agent as
   `<connector-name>__<tool-name>`, for example `ssh-prod-mcp__list-connections`.

Editing a connector, changing its credentials, or disabling and re-enabling it
clears the approval. Approve it again and re-test.

Profiles are optional. Agents connected through the hub see every enabled,
approved connector; profiles are only for generating Docker profile snapshots.

## Which type is my server?

| The server's README says…                                | Use                                         |
| -------------------------------------------------------- | ------------------------------------------- |
| a URL such as `https://…/mcp`                            | [Remote HTTP](#remote-http)                 |
| a URL ending in `/sse`                                   | [Remote SSE](#remote-sse)                   |
| `npx -y some-package` (Node.js)                          | [npm package](#npm-package-npx)             |
| `uvx some-package` or `pip install` (Python)             | [Python package](#python-package-uvx)       |
| a downloadable `.exe` (Go, Rust, .NET…)                  | [Native executable](#native-executable)     |
| `docker run …` or an image name                          | [Docker image](#docker-image)               |
| a JSON block with `mcpServers` you already use elsewhere | [Paste a config](#paste-an-existing-config) |

## Remote HTTP

1. **Connectors → Add Manual MCP**.
2. **MCP name**: a short name, for example `linear`.
3. **Connection type**: `Remote HTTP`.
4. **HTTPS MCP URL**: the server's URL. It must be public `https://`, with no
   username, password, `?query` or `#fragment` in it.
5. **Protected headers (write-only JSON)**: leave empty if the server needs no key.
   Otherwise see [API keys and tokens](#api-keys-and-tokens).
6. Tick **I trust this exact … endpoint** if you want it approved now, then
   **Save MCP**.
7. Open the connector row; tools load automatically after approval.
   Use **Test capabilities** to retry a failed check.

`http://localhost` and private-network URLs are refused. The hub pins validated
public DNS addresses and does not follow redirects.

## Remote SSE

Same as Remote HTTP, with **Connection type** `Remote SSE`. Use it only when the
provider still documents the older SSE transport; prefer HTTP when both exist.

## API keys and tokens

Put the exact header the provider documents in **Protected headers**, including
the prefix:

```json
{ "Authorization": "Bearer YOUR_TOKEN" }
```

Some providers use their own header instead, for example
`{ "X-API-Key": "YOUR_KEY" }`. The value is encrypted with Windows DPAPI for your
user account and is never shown again, written to agent files, or returned by the
API.

To change a key later, open the connector row → **Authentication** → enter the
**New credential value** → choose the **Header format** → save. Saving a key does not
prove it works: approve the connector again and run **Test capabilities**.

Never put a secret in the name, URL or arguments. The hub rejects URLs that
contain credentials.

## OAuth sign-in

The hub has a built-in OAuth flow only for **Linear (read-only)**:
`https://mcp.linear.app/mcp/readonly`, scope `read`. Add it as Remote HTTP, approve
it, then **Authentication → Sign in and verify → Continue to verified provider**.

Other OAuth-only servers show **auth_required** after a test. Until general OAuth
support lands (see [ROADMAP](../ROADMAP.md)), check whether the provider also
accepts a personal access token or API key in a header. If it does, use
[API keys and tokens](#api-keys-and-tokens).

## npm package (npx)

The hub never runs an `npx`, `npm`, `.cmd` or `.bat` command you give it, because
those can download and run different code each time. Instead it installs the
package itself with its own bundled npm (install scripts off). Look up resolves
and freezes the whole dependency tree before you approve; the preview shows a
summary of it (version, package count, size, lock hash), not each dependency's
name. Install uses exactly that frozen tree, and the hub runs the result with its
own `node.exe`.

1. **Connectors → Add Manual MCP** → **Connection type**
   `npm package — managed install`.
2. **Connector name**: a short name, for example `filesystem`.
3. **Package name**: the name from the README, for example
   `@modelcontextprotocol/server-filesystem`.
4. **Version (optional)**: an exact version (`1.2.3`), a range (`^1.2.0`) or a tag
   (`next`). Leave it blank for `latest`.
5. **Look up**. Nothing is installed yet. The preview shows the exact version, its
   release date, the number of packages, the unpacked size, the lock hash, and the
   **Command that will run**.
6. If the package has more than one command, pick one.
7. Tick every warning. Common ones:
   - _Install scripts will NOT run_: the hub never runs `preinstall`,
     `postinstall` or native builds. Most MCP servers don't need them.
   - _Younger than 7 days_, _deprecated_, _engines do not match_, _more than 300
     packages_, _larger than 200 MiB_.
8. **Arguments (JSON array, no shell expansion)**: the server's own options, for
   example `["E:\\Dev\\Projects"]` for the filesystem server. The hub adds the
   entry script itself; don't repeat it.
9. **Protected environment values (write-only JSON)**: any keys the server reads,
   for example `{ "API_TOKEN": "…" }`. Names must be upper case. Names starting
   with `NODE_` and the OpenSSL certificate variables are refused.
10. **Install**. Progress is shown and you can cancel. On success the connector is
    saved but not approved: approve it, then **Test capabilities**.

Only `registry.npmjs.org` is contacted. Private registries, `.npmrc` settings,
and git, URL or file dependencies are not supported: a package that needs one fails
with "A dependency is not a registry package". The install lives in
`%LOCALAPPDATA%\WaleedMcpHub\packages\`, readable only by you and SYSTEM.

### After install

The connector row shows **npm package** with the package and version, plus:

- **Verify files**: re-checks every installed file against what you approved. No
  package code runs.
- **Check for update**: asks the registry for a newer release. If one exists, the
  button becomes **Update to x.y.z**, which opens the same review screen. An
  update goes into a new install folder and needs approval again; your arguments,
  environment values and profiles are kept.
- **Reinstall**: shown when verification fails. It installs the same version
  again into a fresh folder.

Every launch checks the files first, so an edited, added or removed file stops the
connector with "The installed files have changed since install" before anything
runs. Removing the connector deletes its install folder.

If the dialog loses contact with the hub during an install, it says the outcome is
unknown and offers **Check the job again**. Use it, or look at the connector list,
before installing a second time. If the hub restarted in between, it no longer
knows the job: check the connector list instead.

### Manual install (advanced)

For a package the managed install refuses, install it yourself into a folder you
control and point a native connector at `node.exe` and the entry script.

> **You lose the managed protections.** A plain `npm install` runs the package's
> install scripts with your full user rights, uses your own npm settings and
> tokens, and may fetch from any host the package names. The hub does not check
> the files before each launch. Keep `--ignore-scripts` unless the server's README
> says it needs an install script and you trust that package.

1. Install a pinned version into its own folder:

   ```powershell
   npm install --ignore-scripts --prefix E:\Dev\Tools_and_Utilities\my-mcp some-mcp-package@1.2.3
   ```

2. Find the entry script. Open
   `E:\Dev\Tools_and_Utilities\my-mcp\node_modules\some-mcp-package\package.json`
   and read the `bin` field, for example `"bin": { "some-mcp": "build/index.js" }`.
   The full path is then
   `E:\Dev\Tools_and_Utilities\my-mcp\node_modules\some-mcp-package\build\index.js`.

3. Find your Node executable: `(Get-Command node).Source`. Use the real
   `node.exe` path, for example `E:\Dev\Tools_and_Utilities\nodejs24\node.exe`.

4. **Add Manual MCP** → **Connection type** `Stdio — local executable`:
   - **Absolute command (.exe)**: the `node.exe` path.
   - **Arguments (JSON array)**: the entry script first, then the server's own
     options, each as a separate string:

     ```json
     [
       "E:\\Dev\\Tools_and_Utilities\\my-mcp\\node_modules\\some-mcp-package\\build\\index.js",
       "--some-option"
     ]
     ```

   - **Protected environment values**: any keys the server reads from the
     environment, for example `{ "API_TOKEN": "…" }`.

5. Save, approve, test.

Your SSH connectors are set up this way: `node.exe` plus
`ssh-mcp\node_modules\ssh-mcp\build\index.js`. Unlike a managed install, a manual
install is not checked for changed files before each launch.

Backslashes must be doubled inside JSON strings.

## Python package (uvx)

Install the tool so it gets a real `.exe` launcher, then use that `.exe`:

```powershell
uv tool install some-mcp-server==1.2.3
(Get-Command some-mcp-server).Source   # e.g. C:\Users\you\.local\bin\some-mcp-server.exe
```

Without `uv`, a virtual environment works too:

```powershell
python -m venv E:\Dev\Tools_and_Utilities\my-py-mcp
E:\Dev\Tools_and_Utilities\my-py-mcp\Scripts\pip install some-mcp-server==1.2.3
# use E:\Dev\Tools_and_Utilities\my-py-mcp\Scripts\some-mcp-server.exe
```

Then **Add Manual MCP** → `Stdio — local executable` with that `.exe`, its
arguments, and protected environment values.

## Native executable

For servers shipped as a binary: download it to a stable folder, then
**Add Manual MCP** → `Stdio — local executable` → the absolute `.exe` path →
arguments as a JSON array.

The process starts with an isolated environment rather than your user
environment, so add every variable the server needs to **Protected environment
values**.

## Docker image

1. Docker Desktop must be running with a local (not remote) context.
2. **Add Manual MCP** → **Connection type** `Docker image`.
3. **Docker image**: pin a version, for example `mcp/fetch:1.0.0`, not `latest`.
4. **Arguments**: the container arguments as a JSON array.
5. **Loopback ports**: only if the server must be reachable, for example
   `[{"host":8080,"container":8080}]`. Ports bind to `127.0.0.1` only.
6. Save, approve, test. A test can pull the image if it is missing.

Agents can't use Docker connectors that need protected environment values yet.
Use a native install for those servers for now.

## Paste an existing config

If you already have the server in another app's config:

1. **Connectors → Add connector**.
2. Paste the JSON into **Configuration JSON**. Accepted shapes: a single server
   object, an `mcpServers` map, a `servers` map, OpenCode's `mcp.servers`, and Docker
   image or remote definitions.
3. **Preview configuration** → review the normalized definition → **Preview local
   save** → **Apply reviewed change**.

Env and header values in the paste become write-only references; re-enter them
in **Authentication** after saving. An `npx some-package` entry is listed
separately as a package proposal with an **Install** button, which opens the
[managed install](#npm-package-npx) with the name, version and arguments filled
in. Its secret values are dropped from the paste; enter them again in the install
form. Applying the import never installs anything. Entries that use `uvx` or `.cmd`
launchers are saved as data only; convert them as described in
[Python package](#python-package-uvx). JSONC (comments) and TOML are not accepted; remove comments first.

## Current limits worth knowing

- **One live session per connector and agent.** The agent's bridge keeps a
  server's process (or remote session, or container) running between calls, so
  SSH sessions and browser tabs survive. A session closes after 5 minutes idle or
  60 minutes of life, and is replaced after any change to the connector, its
  approval or its credentials, after a hub restart, and after a call that timed
  out or was cancelled. A failed call is never retried for you. See
  [troubleshooting.md](troubleshooting.md#a-tool-forgets-a-session-ssh-browser-tab).
- Each call is capped at 60 seconds and 1 MiB of output; a session at 64 MiB of
  output. One bridge keeps at most 16 live sessions.
- Agents see **tools only**: resources and prompts are not forwarded.
- At most 256 tools are exposed across all connectors.

## When something fails

See [troubleshooting.md](troubleshooting.md).
