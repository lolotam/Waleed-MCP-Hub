# Add any MCP server to the hub

This guide covers every kind of MCP server the hub can run today, with the exact
screens and fields to use. If something here no longer matches the app, the app is
right and this page needs fixing.

## The flow is always the same

1. **Save** the definition (nothing runs yet).
2. **Add credentials**, if the server needs them (Authentication on the connector row).
3. **Approve execution** — you confirm you trust this exact command, image or URL.
4. **Test capabilities** — the hub connects and lists the server's tools. It never
   calls a tool during a test.
5. **Connect your agents** once (see [connecting-agents.md](connecting-agents.md)).
   Eligible, enabled, approved connectors appear in each agent as
   `<connector-name>__<tool-name>`, for example `ssh-prod-mcp__list-connections`.

Editing a connector, changing its credentials, or disabling and re-enabling it
clears the approval. Approve it again and re-test.

Profiles are optional. Unassigned agents see all enabled, approved connectors,
subject to per-tool policies. In **Agents**, use **Profile / Tool Set** to restrict
an integrated agent to one profile. Empty or disabled assigned profiles expose
nothing; **All Connectors (Default)** explicitly restores the unassigned behavior.
Profile mapping is independent of Docker snapshots and changes no agent files.

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
4. **MCP endpoint URL**: a public `https://` URL, or an explicitly opted-in local
   HTTP endpoint as described below. No username, password, `?query` or `#fragment`.
5. **Protected headers (write-only JSON)**: leave empty if the server needs no key.
   Otherwise see [API keys and tokens](#api-keys-and-tokens).
6. Tick **I trust this exact … endpoint** if you want it approved now, then
   **Save MCP**.
7. Open the connector row and choose **Test capabilities**.

The Hub pins validated DNS addresses and does not follow redirects. Private LAN
and metadata destinations are refused, even when local HTTP is opted in.

### Local HTTP opt-in

For a trusted service running on this computer, use `http://127.0.0.1:3000/mcp`
or `http://localhost:3000/mcp` (substitute the actual explicit port). Check **I opt
in to unencrypted local HTTP for this exact loopback endpoint and port**. Changing
the URL clears local consent and execution approval. The same option works for
Remote SSE. Localhost DNS must contain only `127.0.0.1`/`::1`; LAN addresses,
metadata IPs, alternate numeric IP spellings, other HTTP hosts and redirects remain
blocked. Local connections use the persistent host bridge, not Docker loopback.

Imported local endpoints initially have no normalized definition. Review the local
address, check the entry's opt-in, and choose **Update preview** before saving or
applying. Opt-in and execution approval are separate from authentication/testing.

## Smart Paste

Use **Smart paste** in Add Manual MCP or Add connector for a URL, an exact
`npx -y package@1.2.3 ...` / `uvx package==1.2.3 ...` command, a Docker image/run
command or a supported JSON object. Quoted arguments stay literal; no shell runs.
Detection is instant and local. **Review detected input** fills the editable form
or sanitized draft, then clears the original input. Confirm exact versions/bin
names, local HTTP consent and permissions before saving. JSON credentials remain
private; Docker env assignments move into protected write-only fields.

Complex shell commands, env expansion, inherited Docker env vars, mounts, env files,
privileged/network/TTY flags and command-line credentials are refused rather than
silently reinterpreted. Put keys in protected env/header fields. Existing AST edits,
normal private `.bak` integration backups and encrypted adoption recovery remain
unchanged; no plaintext credential backup is introduced by Smart Paste.

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

## Import an existing agent configuration

Open **Agents → Scan Installed Agents → Import agent configs** for Claude Desktop,
Cursor, VS Code, Codex or OpenCode. The preview is sanitized and expires after five
minutes. Deselect entries you want to keep outside the Hub; fix conflicting names
and supply exact versions/executable names for unpinned npm/Python packages, then
**Update preview**. Existing environment substitutions are not resolved from your
personal environment; replace them explicitly before importing.

Choose enabled Hub profiles, confirm the source-file change and protected import,
then choose **Apply protected import**. Selected credential values go directly to
DPAPI, and only the selected source entries are replaced by the Hub bridge. Other
entries, settings, comments and policies remain untouched. Source changes since
preview block apply. Saving does not install packages, run tools, grant execution
approval or verify authentication. Approve each exact connector separately and
reconnect the agent when ready.

Adoption never makes the ordinary plaintext `.bak` copy. Recovery chunks and a
manifest are protected in the vault; the receipt returns their generated reference
IDs, not contents. An uncertain write leaves a blocking recovery journal and does
not restore plaintext source keys or replay the import. Old backups created before
adoption are not automatically modified. Unsupported runtimes/fields fail rather
than silently changing behavior. The older Docker-pilot preview remains read-only.

Pasted JSON previews can use the same **Apply protected import** action without
editing any agent file. An enabled Hub profile is required.

## Browse the official MCP Registry

Open **Connectors → Browse MCP Registry**, search, and choose a connection option.
The Hub fetches bounded metadata only from `registry.modelcontextprotocol.io` and
pre-fills **Add Manual MCP** with an HTTPS remote or exact npm/PyPI package spec.
Review the package executable name and any unresolved arguments. Required env/header
names are shown, but publisher defaults and credential values are never copied.
Enter your own credentials in the write-only protected fields. Saving still does
not grant approval, download packages or start a server. Inactive entries, unsafe
URLs, custom package registries and unsupported/unpinned package options are omitted
or shown as requiring manual setup. Registry presence is not a trust endorsement.

## OAuth sign-in

The hub retains a curated OAuth flow for **Linear (read-only)**:
`https://mcp.linear.app/mcp/readonly`, scope `read`. Add it as Remote HTTP, approve
it, then **Authentication → Sign in and verify → Continue to verified provider**.

For another remote MCP server, approve its exact HTTPS endpoint, then open
**Authentication → Discover OAuth provider**. Review the issuer, resource and
requested scopes. Approve those permissions, choose **Sign in with discovered
provider**, and continue to the provider in a separate tab. Capability discovery
must pass before the Hub reports success. Changing scopes clears consent.

Standard protected-resource/authorization metadata, PKCE S256, and public-client
registration are required. Providers requiring a fixed client, confidential secret,
or nonstandard flow may remain unsupported; a provider name alone does not prove
compatibility. If supported by the provider, a manually configured API key remains
an alternative. No existing browser/agent account credentials are imported.

The persistent bridge refreshes expiring tokens automatically and stores rotating
access/refresh tokens only in the DPAPI vault. Open Authentication again to view
the connected provider and scopes. **Revoke and disconnect** requests provider
revocation when advertised. **Disconnect locally only** removes local credentials
but leaves provider authorization intact; use the provider's account settings to
remove it. Remove other/materialized credential consumers first. Neither action
retries a failed tool call.

## Managed packages (npx / uvx)

Use **Add Manual MCP → npm / npx — pinned package** or **Python / uvx — pinned
package**. Enter the publisher's package name, an exact pinned version, the
executable/bin name and literal JSON arguments. Smart Paste can prefill an exact
`npx -y package@1.2.3` or `uvx package==1.2.3` command without running a shell.

Saving a definition does not install it. Review and approve the exact package, then
explicitly consent to installation when testing capabilities. The reviewed adapter
installs into the Hub's managed cache; running uses the contained resolved runtime,
not an arbitrary shell shim. Credentials go in protected environment fields.
Registry presence is not a trust endorsement. Version ranges and install hooks
outside the reviewed adapter are not silently accepted.

The manual installation alternatives below remain useful when you already manage
an executable yourself.

## MCP bundles (.mcpb)

In **Add Manual MCP** or **Add connector**, expand **Install a .mcpb bundle**.
Choose/drop a bundle, review its manifest, typed configuration and requested
environment fields, then explicitly confirm **Install reviewed bundle**. Publisher
metadata is untrusted. The supported Windows subset never runs arbitrary setup
hooks or downloads dependencies. Sensitive configuration goes to DPAPI.

Installation saves an unapproved connector and a local integrity receipt; it does
not run the provider or grant execution approval. Review and approve the exact
definition, then explicitly test capabilities. Setup JSON exports do not copy
bundle installation files or receipts, so reinstall on another machine.

## npm package (npx)

For a manually managed native definition, the Hub never launches `npx`, `npm`,
`.cmd` or `.bat` shell shims directly. Install a pinned package into a folder you
control, then point the Hub at `node.exe` and the package's entry script. For
automatic managed-cache installation use **Managed packages** above instead.

1. Install a pinned version into its own folder:

   ```powershell
   npm install --prefix E:\Dev\Tools_and_Utilities\my-mcp some-mcp-package@1.2.3
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
`ssh-mcp\node_modules\ssh-mcp\build\index.js`.

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
in **Authentication** after saving. Entries that use `npx`, `uvx` or `.cmd` launchers
are saved as data only. Convert them as described in
[npm package](#npm-package-npx) or [Python package](#python-package-uvx) before
they can run. JSONC (comments) and TOML are not accepted; remove comments first.

## Current limits worth knowing

- The managed bridge retains one connection per connector per bridge/MCP session.
  SSH sessions, browser tabs and database transactions survive sequential calls.
  Separate bridge instances never share peers or credentials.
- Peers expire after **five idle minutes** or a **one-hour hard lifetime**. Approval,
  credential metadata changes, expiring OAuth tokens and shutdown also close peers.
  Native/Docker sessions retain a **1 MiB cumulative output limit**. Calls that fail
  are not replayed automatically; after expiration, reopen stateful upstream sessions.
- The pool allows up to **32 peers** and serializes operations on the same connector.
  Direct materialized native profile launchers (outside the managed bridge) retain
  the older 120-second lifetime; capability discovery checks are one-shot.
- Agents can list/read resources, list resource templates and list/get prompts from
  enabled, approved connectors in their assigned profile. Use the exact Hub URI or
  prompt name returned by discovery, not an upstream identifier. Resource URIs and
  templates are opaque per-session handles; prompt names are connector-prefixed.
- Resource subscriptions are disabled. Scoped list-change notifications ask clients
  to rediscover; old/out-of-scope handles fail closed rather than guessing a route.
- Normal tools and each resource/template/prompt catalog expose at most 256 entries
  across all connectors; tool-search mode has its separate larger metadata budget.
  Resource/prompt catalogs mark incomplete results in `_meta["wmh/truncated"]`.

## When something fails

See [troubleshooting.md](troubleshooting.md).
