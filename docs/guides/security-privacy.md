# Security & Privacy

## DPAPI protected credentials

Native, managed-package and remote API/OAuth credentials are encrypted using
Windows DPAPI for the current user in the verified Windows deployment. The
readiness factory selects macOS Keychain or Linux Secret Service/libsecret on
those platforms; native release verification remains pending. Entry fields are write-only; the API never
returns credential values. Docker bindings use the existing reference-only Docker
vault instead. DPAPI setup import does not convert Docker credentials.

**Settings → Credential storage & containment** shows the selected backend and its
last probe status. The explicit check may trigger OS keyring UI, but adds no
credential and returns no native error/output. Unavailable or locked storage never
falls back to plaintext files. Keyring namespace metadata is private; values go
through OS keyring stdin, not process arguments. Windows DPAPI data is not migrated
or re-encrypted, and references from one OS are never silently read from another.

Keep secrets out of connector names, URLs, arguments, descriptions and annotations.
The Hub is not a general-purpose detector for arbitrary passwords in prose.

## JobObject containment and explicit review

Saving a definition is not permission to run it. Review the exact command, package,
image or endpoint before execution approval. Native processes use Windows JobObject
containment and a restricted environment on Windows; no uncontained fallback is
attempted. POSIX readiness uses detached process-group cleanup, not a security
sandbox: children may escape by creating a new session, and abrupt manager SIGKILL
cannot run cleanup. Review untrusted programs accordingly.
Package downloads/installations and tool calls require separate explicit actions.
Capability tests list tools without calling them. Allow/Ask/Block policies remain
authoritative even when a tool advertises read-only annotations or a custom alias.

## Loopback isolation

The manager listens on the exact `127.0.0.1` launch address. A one-time launch,
HttpOnly session, exact Host/Origin checks and CSRF protection guard mutations.
The narrowly registered `/mcp` POST/GET/DELETE routes instead require a per-client
Bearer token on every request and verify the real socket peer is loopback. Session
IDs are token-bound routing identifiers, never credentials. Token management remains
behind the browser's session/Origin/CSRF checks; a Bearer token cannot open Settings.
Remote connectors use checked HTTPS destinations, with a separate explicit-port
loopback HTTP opt-in. Private LAN/metadata addresses and redirects remain refused.
Profiles restrict what each agent can discover and call; an empty or disabled
assigned profile never silently falls back to all connectors.

Client tokens are disclosed once in Settings. The runtime stores SHA-256 hashes
and masked previews in private `http-tokens.json`, never plaintext tokens or setup
export entries. Revoke closes token-owned sessions and cancels pending bridge work;
it cannot undo calls already dispatched upstream. If a revocation write fails,
access is denied in the current process but persistent revocation is unconfirmed:
retry successfully before restarting. Do not proxy/tunnel the loopback endpoint.

## Zero plaintext in Hub setup exports

**Settings → Export Configuration** creates a projected setup with credential
placeholders, not values, vault IDs, DPAPI ciphertexts or OAuth accounts. Known
credential echoes and unreadable protected backends cause refusal. Credential-free
Docker definitions transfer; Docker-vault credential transfer remains unsupported.
See [adding-mcps.md](adding-mcps.md) for credential entry and approval steps.

Import credential values go directly to DPAPI before one atomic registry save.
Failed writes are compensated only when the prior state is proven; uncertainty
blocks for recovery review. Existing credentials are retained, never silently deleted.

## Logs, private backups and support

Request logs retain bounded tool/agent/status metadata, not arguments, results or
provider errors. Ordinary agent integration preserves private timestamped backups
of existing agent files; those files may already contain credentials you supplied
outside the Hub. Protected adoption uses encrypted recovery instead of introducing
a plaintext credential backup. Old backups are not silently rewritten.

Read [troubleshooting.md](troubleshooting.md) before reporting a problem. Share only
sanitized metadata, never private configuration, API keys or OAuth tokens.
