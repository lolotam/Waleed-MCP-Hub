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
or install external applications.
