# Share the Windows installer

`Waleed-MCP-Hub-Setup.exe` installs the Hub for the current Windows user, creates
Desktop and Start menu shortcuts, and opens the app. Share this single file;
recipients do not need the source repository, Git, Node.js, npm, or a compiler.

Supported target: Windows 10 build 17763 or later / Windows 11 x64 with Microsoft
Edge. The installer includes Node.js 24, the built web/server applications, all production dependencies, and
the Hub's managed npm installer. Installation works offline. Adding a new managed
npm connector later requires access to the npm registry. Docker connectors also
require Docker Desktop; Docker and agent CLIs are separate applications.

Each recipient adds their own connectors/credentials and integrates installed
agents from the Hub. The installer contains no saved profiles, SSH keys,
credentials, agent configuration, or other personal Hub state.

The application installs under `%LOCALAPPDATA%\Programs\WaleedMcpHub`, separately
from user state at `%LOCALAPPDATA%\WaleedMcpHub`. A repeat install verifies and
reuses an intact build. A damaged build is repaired into a new directory, keeping
old files available for running processes and existing agent pointers. Existing
unrelated shortcuts are preserved. Old application directories are not deleted.
When this installer's desktop manager is already running, opening a different
installed version gracefully stops the old backend before starting the new one.
For older launchers without this handoff protocol, stop the old desktop manager
through Settings before opening the new installation.

## Build and verify

On the build machine, use the Node/npm versions in `package.json`:

```powershell
npm ci
npm run package:installer
node scripts/verify-installer.mjs '<generated path>\Waleed-MCP-Hub-Setup.exe'
```

The build prints the installer path and creates `SHA256SUMS.txt` next to it.
Windows includes the .NET Framework compiler used on the build machine; no new
build dependency is downloaded. The executable is not code-signed, so Windows
may show publisher/reputation prompts. Signing requires a publisher certificate.

The installer supports `--silent`, `--no-launch`, `--no-shortcuts`, and
`--directory <absolute local folder>` for automated installation/verification.
It does not register startup, alter PATH, install services, configure agents,
or install external applications. The launcher can add a startup entry later,
when the tray menu asks for it.

## The tray icon

The launcher that runs the desktop manager shows a tray icon with the tooltip
"Waleed MCP Hub". Closing the Edge window leaves the hub and the tray icon
running. Right-click the icon for:

- **Open Waleed MCP Hub** — reopens the app window on the running hub. A left
  click or a double click on the icon does the same.
- **Start with Windows** — a checkable item. A checked item means the Hub
  starts when you sign in to Windows.
- **Quit** — stops the desktop manager. The item shows "Stopping…" while the
  hub shuts down. If the hub is still stopping after 15 seconds, the icon
  stays, Quit becomes available again, and a balloon asks you to choose Quit
  again to retry.

Only one tray icon is shown: the launchers share the per-user mutex
`Local\WaleedMcpHub.Tray`. A second launcher waits for its manager without
showing an icon and takes the icon over when the first launcher ends.

## Start with Windows

The startup entry is a value named `WaleedMcpHub` under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. It points at the launcher
of the installation you use and adds `--startup`, so signing in to Windows
opens the Hub like a normal start.

The preference file `%LOCALAPPDATA%\WaleedMcpHub\launcher-settings.json` is
the source of truth:

```json
{ "startWithWindows": true }
```

Turning **Start with Windows** on or off in the tray menu writes this file
first and then updates the registry value. The menu tick shows the real state
of the registry value, and a balloon names the step that failed if the file or
the registry could not be written. Every start reconciles the registry value
with the preference file. A new installation only takes over the startup entry
after its manager has stayed alive for 10 seconds, so a broken installation
cannot take startup away from a working one.

To remove the startup entry by hand:

1. Open `regedit` and go to
   `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`.
2. Delete the `WaleedMcpHub` value.
3. Set `"startWithWindows": false` in
   `%LOCALAPPDATA%\WaleedMcpHub\launcher-settings.json`. The next start of the
   launcher reads that preference and keeps the entry away. Deleting the file
   instead turns the default back on: the next start writes `true` and adds
   the entry again.
