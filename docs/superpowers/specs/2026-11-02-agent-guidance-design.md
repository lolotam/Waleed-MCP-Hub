# Agent guidance from the bridge: design

Date: 2026-11-02. Status: approved (both parts). Decisions:

- Waleed chose the scope "correct use of the hub only" (option أ).
- Waleed chose the delivery "`instructions` plus `hub://guide`" (option 2).
- Waleed approved design part 1: «موافق».
- Waleed approved design part 2 through the super admin (SA Q-2, about 22:30 Kuwait): «موافق (Recommended)».

## Goal

Every agent that connects to `waleed-mcp-hub` learns how to use the hub correctly. That means:

- how the tool names are formed;
- what the approval prompt means;
- what each refusal or notice the bridge returns means and what to do about it;
- that it must never try to work around a hub protection.

The hub writes nothing into the agents' own folders. The guidance ships inside the bridge, so it always matches the installed version.

General agent behaviour rules (language, storage, review habits) are out of scope. They belong to each user's own `CLAUDE.md` or `AGENTS.md`.

## What an agent actually sees today

The bridge (`packages/hub-core/src/integrations/bridge.ts`) never forwards a `RuntimeFault` reason to an agent. A tool call fails with one of these fixed values:

| Value returned to the agent | Kind         | When                                                                                                                                          |
| --------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_blocked`              | refusal code | The tool's policy is `block`.                                                                                                                 |
| `tool_approval_required`    | refusal code | The policy is `ask`, and one of these holds: the client cannot show a form, the arguments are over 16 KiB, or the prompt failed or timed out. |
| `tool_approval_denied`      | refusal code | The user declined or dismissed the approval prompt.                                                                                           |
| `tool_approval_stale`       | refusal code | The connector or its policy changed between approval and the call.                                                                            |
| `registryUnavailableText`   | notice text  | The managed registry cannot be read.                                                                                                          |
| `refreshToolsText`          | notice text  | The tool name is unknown or its definition changed.                                                                                           |
| `connectorUnavailableText`  | notice text  | The connector is unavailable, changed, disabled, or needs authentication.                                                                     |

The approval prompt starts with "Hub permission request: approve one call only?". It labels the connector name and the arguments as untrusted data.

The approved part 1 named "12 fault reasons". That was wrong: those are internal, and the agent sees the seven values above. The drift check in this design covers those seven.

## Design

### Components

**`packages/hub-core/src/integrations/agent-guide.ts` (new).** The only source of the guidance text.

- `type RefusalCode` is the union of the four refusal codes. `ToolPolicyRefused` accepts only a `RefusalCode` or one of the notice texts, so every value an agent can see has a type.
- `bridgeNotices` holds the three notice texts as one `as const` object. `bridge.ts` imports the texts from it instead of declaring its own constants.
- `guidance: Record<RefusalCode | keyof typeof bridgeNotices, Entry>` holds one entry per agent-visible value: its meaning, what the agent does, and what it tells the user.
- `shortInstructions(separator: '__' | '_'): string` returns the always-on text, about 1,200 characters, in English.
- `fullGuide(separator): string` returns the markdown guide: the naming rule, the approval flow, and the full `guidance` table.

**`bridge.ts`.**

- `new Server({ name: 'waleed-mcp-hub', version: hubVersion() }, { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }, instructions: shortInstructions(toolSeparator) })`.
- `resources/list` returns one resource, `hub://guide` (`text/markdown`), and `resources/read` returns `fullGuide(toolSeparator)`.
- `prompts/list` returns one prompt, `hub-guide`, and `prompts/get` returns the same text. This serves clients that support prompts but not resources.
- Any other resource URI or prompt name gets a standard MCP error.

**`hubVersion`.**

- The bridge reads `version` from `@waleed/hub-core`'s own `package.json`, `new URL('../../package.json', import.meta.url)`. That manifest is two levels above the bridge module in the source tree, the build and the portable folder; the root manifest is not (4 levels up in the repo, 5 in the portable folder).
- The release job stamps the version into the root manifest, the lockfile, and `packages/hub-core/package.json`. `package-desktop.mjs` refuses to package when the hub-core version differs from the root version.
- If the file cannot be read, the bridge fails to start. It does not fall back to a made-up version.

### The short instructions (draft)

> You are connected to Waleed MCP Hub, which forwards tools of several MCP servers.
>
> - Tool names are `<connector><sep><tool>`. Some names end with a hash suffix. Call names exactly as listed.
> - The tool list can change (`listChanged`). After `Refresh the hub tool list…`, list the tools again before retrying.
> - "Hub permission request" asks the user to approve one exact call. After `tool_approval_denied` or `tool_blocked`, do not retry the call or rephrase it to get around the decision. Tell the user.
> - Errors are fixed codes. Never edit hub files, `safety.json`, locks or agent configs to clear one.
> - Read `hub://guide` (or the `hub-guide` prompt) for what each code means and what to tell the user.

### Security rule

The guidance is static text from `agent-guide.ts`. It is the same for every user and never includes data from another MCP server: no connector name, tool name, description or argument.

If a connector's name or description could reach the instructions, any upstream server could inject instructions into every connected agent. The separator is the only variable, and it comes from the bridge's own configuration.

## Testing

All tests drive the real bridge through the MCP SDK client, as the existing bridge tests do. Nothing mocks the SDK.

1. **Drift check (typecheck).** `guidance` is a `Record` over every agent-visible value. Adding a refusal code or notice without an entry fails `npm run typecheck`. No runtime test is needed for this.
2. **Instructions delivered.**
   - `initialize` returns `instructions` that contain the right separator for `'__'` and for `'_'`.
   - The text stays at or under the length limit.
3. **Guide delivered.**
   - `resources/list` contains `hub://guide`.
   - `resources/read` returns markdown that names every value in `guidance`.
   - `prompts/get hub-guide` returns the same text.
4. **Injection test.**
   - Register a connector whose name and description carry an instruction-like string, and whose tool also has an instruction-like name and description.
   - Neither `instructions`, `hub://guide` nor `hub-guide` contains any of these strings.
5. **Version.** `serverInfo.version` equals the hub-core manifest version, and the hub-core version equals the root version. Both are `0.1.0` on every committed revision; the release job bumps them in its own checkout.

SA-15 decides where they run:

- Local runs: typecheck, lint, and the new and changed bridge test files.
- CI runs the full suite. The merge needs CI green on the exact head SHA.

## One-time trial on the 9 agent CLIs

This step measures behaviour. It is not a CI test. The question is whether each CLI's model actually receives:

- the `instructions`;
- the resource;
- the prompt.

The CLIs: Claude Code, Codex, Grok, OpenCode, Antigravity (agy), Kimi, Kilo, Cursor, Claude Desktop.

- **Gate:** start only when free commit memory is above 20 GB (SA Q-2 condition). Check it before each CLI.
- **One CLI at a time**, never in parallel.
- **Use a small throwaway probe server** with a unique marker in its `instructions`, one resource and one prompt.
  - Point each CLI at the probe through a per-run config (a flag or a temporary profile).
  - Never edit the CLI's real MCP config, never run `npx mcp-add`, and never touch `safety.json` or `agent-backups/`.
  - Where a CLI offers no per-run config, record that CLI as "not trialled" rather than editing its config.
- **Ask each model** to repeat the marker, to list resources, and to read the resource.
- **Record the results** as a new decision in `docs/DECISIONS.md`: a table with one row per CLI and the columns instructions, resources and prompts.
- **If a CLI receives none of the three,** that is the input for the deferred phase: an opt-in `SKILL.md` per agent, which needs its own decision.

## Out of scope

- Writing `SKILL.md` or rules files into agent folders (deferred phase 3).
- Behaviour rules that are not about the hub.
- Holding verified handles until spawn (issue #15).

## Delivery

- Branch `feat/agent-guidance`, worktree `F:\Dev\Worktrees\Waleed-MCP-Hub\agent-guidance`, from `main` at `ee93bc4`.
- Guards: clean-code-guard on `agent-guide.ts` and `bridge.ts`, test-guard on the tests, docs-guard on this spec, the guide text and the new decision.
- The PR merges under SA-11/SA-13, with `--match-head-commit`.
