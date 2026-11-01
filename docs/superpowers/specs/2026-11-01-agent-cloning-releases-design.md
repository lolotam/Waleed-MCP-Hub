# Agent MCP cloning and GitHub releases

Approved by the user on 2026-11-01.

On first authenticated opening, scan only known supported agent configuration paths.
Group candidates by source agent, with select/deselect all and individual selection.
No source configuration is changed by discovery or copying. Exclude the Hub itself.
Copy selected definitions and available literal/environment credentials through existing
journaled registry and protected credential APIs. Never return credential values to the
browser. Refuse stale source snapshots before writes. Preserve failed/partially saved
connectors and provide Authentication/Edit actions. Supported npx definitions use the
existing reviewed package resolver/installer, with exact resolved version, entry choice
and warning acknowledgement before Clone and connect. Unsafe/unsupported definitions
remain visible as requiring setup; never execute arbitrary source configuration.

Agent integration remains a separate explicit action through the existing Agents page.
First-run scan can be dismissed and reopened; it never depends on an empty registry.
Capability discovery uses the already implemented automatic approved-connector queue.

After successful push-to-main CI, publish one idempotent, versioned GitHub Release for
that verified commit. Build the Windows installer and attach checksums and release
metadata. Skip obsolete heads and failed/fork/PR workflow runs. Package no personal data.
The app checks the fixed public repository for a newer stable release and displays its
version and GitHub download/notes links. Network failure cannot block MCP management.
No unattended installer execution or application restart is introduced.

Acceptance: grouping/selection; credential non-disclosure and exact copying; source
immutability and stale-source rejection; duplicates require rename; partial failures
remain repairable; npx review cannot be bypassed; automatic first-run scan; release
idempotency and trusted-CI gating; bounded cached update checks and semantic ordering.
