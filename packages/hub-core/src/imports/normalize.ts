import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import {
  parseTree,
  type Node as JsonNode,
  type ParseError,
} from 'jsonc-parser';
import {
  EndpointSchema,
  ImportDefinitionSchema,
  PackageProposalSchema,
  isPackageEnvName,
  type ImportDefinition,
  type ImportEntry,
  type ImportIssue,
  type ImportPreview,
  type ImportWarning,
  type PackageProposal,
} from '@waleed/contracts';
import { HubError } from '../errors.js';

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const own = (value: Record<string, unknown>, key: string) =>
  Object.hasOwn(value, key);
const sorted = (value: Record<string, unknown>) => Object.keys(value).sort();
const invalid = () =>
  new HubError(
    'invalid',
    'Use bounded JSON configuration with an unambiguous supported server shape. Programs, duplicate JSON keys, and mixed wrappers are not supported.',
  );
export const hasControlCharacters = (value: string) =>
  [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
const nameOk = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.trim().length <= 100 &&
  !hasControlCharacters(value);
const idOk = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(value);
const bindingOk = (name: string) => /^[a-zA-Z_][a-zA-Z0-9_-]{0,99}$/.test(name);
const argsOk = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 128 &&
  value.every(
    (arg) =>
      typeof arg === 'string' && arg.length <= 4096 && !/[\0\r\n]/.test(arg),
  );
const reference = (value: string) =>
  /\{(?:env|file):|\$\{|%[a-z_][a-z0-9_]*%/i.test(value);
const fieldLabel = (field: string) =>
  /^[a-zA-Z_][a-zA-Z0-9_.-]{0,60}$/.test(field) ? field : '[unsupported field]';
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);
const literalValues: Record<string, readonly string[]> = {
  NODE_ENV: ['production', 'development', 'test'],
  NO_COLOR: ['1'],
  CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: ['1'],
  CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: ['1'],
};

// The proposal contract owns the package name, the version shapes and the env
// name rule; the import layer never re-implements them. The selector (a range
// or dist-tag) refuses git, URL, file and alias specs, so none can reach the
// proposal.
const proposalName = PackageProposalSchema.shape.name;
const proposalVersion = PackageProposalSchema.shape.version;
const proposalSelector = PackageProposalSchema.shape.requestedVersion;
const proposalEnvName = PackageProposalSchema.shape.envNames.element;
// A path spec (a leading ".", "/", "\" or "~") or a drive letter.
const pathSpec = /^[.\\/~]/;
const driveSpec = /^[a-zA-Z]:/;

// One npx entry becomes at most one proposal: the first argument after an
// optional "-y"/"--yes" must name exactly one registry package. Options before
// the spec, a second package and git, URL, file or path specs stay refused.
function packageProposal(
  packageArgs: string[],
  secretBindings: Record<string, string>,
  environmentLiterals: Record<string, string>,
): PackageProposal | null {
  const spec = packageArgs[0];
  if (!spec || spec.startsWith('-')) return null;
  if (pathSpec.test(spec) || driveSpec.test(spec)) return null;
  const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@');
  const name = at < 0 ? spec : spec.slice(0, at);
  const raw = at < 0 ? null : spec.slice(at + 1);
  if (!proposalName.safeParse(name).success) return null;
  if (raw !== null && !proposalSelector.safeParse(raw).success) return null;
  const exact = raw !== null && proposalVersion.safeParse(raw).success;
  const parsed = PackageProposalSchema.safeParse({
    name,
    version: exact ? raw : null,
    requestedVersion: exact ? null : raw,
    arguments: packageArgs.slice(1),
    // A name Install rejects is left out: one that is not upper case, and one
    // a package connector refuses (NODE_* and the OpenSSL variables).
    envNames: [
      ...new Set([
        ...Object.keys(secretBindings),
        ...Object.keys(environmentLiterals),
      ]),
    ]
      .filter(
        (envName) =>
          proposalEnvName.safeParse(envName).success &&
          !isPackageEnvName(envName),
      )
      .sort(),
  });
  return parsed.success ? parsed.data : null;
}

export interface PrivateImport {
  format: ImportPreview['format'];
  entries: ImportEntry[];
  // Internal write-only draft values. No service method resolves them to callers.
  secrets: Map<string, Buffer>;
  references: ImportPreview['secretReferences'];
}
export function clearImport(draft: PrivateImport) {
  for (const value of draft.secrets.values()) value.fill(0);
  draft.secrets.clear();
}

function parseSource(source: string): Record<string, unknown> {
  if (Buffer.byteLength(source, 'utf8') > 48 * 1024) throw invalid();
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, {
    disallowComments: true,
    allowTrailingComma: false,
  });
  if (errors.length || !tree || tree.type !== 'object') throw invalid();
  let nodes = 0;
  const check = (node: JsonNode, depth: number) => {
    if (++nodes > 8192 || depth > 20) throw invalid();
    if (node.type === 'object') {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value as string;
        if (
          keys.has(key) ||
          ['__proto__', 'prototype', 'constructor'].includes(key)
        )
          throw invalid();
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) check(child, depth + 1);
  };
  check(tree, 0);
  return JSON.parse(source) as Record<string, unknown>;
}

export function normalizeImport(
  source: string,
  relatedEntries: readonly unknown[] = [],
): PrivateImport {
  const document = parseSource(source);
  if (!Object.keys(document).length) throw invalid();
  let format: ImportPreview['format'] = 'single';
  let entries: Array<[string, unknown]>;
  let wrapperIssues: ImportIssue[] = [];
  const wrappers = ['mcpServers', 'servers', 'mcp', 'server'].filter((key) =>
    own(document, key),
  );
  if (
    wrappers.length > 1 ||
    (wrappers.length &&
      ['command', 'url', 'image', 'remote'].some((key) => own(document, key)))
  )
    throw invalid();
  if (wrappers.length) {
    const wrapper = wrappers[0]!;
    wrapperIssues = sorted(document)
      .filter((key) => key !== wrapper)
      .map((key) => ({
        code: 'unsupported_fields',
        field: `root.${fieldLabel(key)}`,
      }));
    if (wrapper === 'server') {
      format = 'docker';
      entries = [['Imported connector', document.server]];
    } else {
      let map = object(document[wrapper]);
      if (wrapper === 'mcp') {
        if (!map || !own(map, 'servers')) throw invalid();
        wrapperIssues.push(
          ...sorted(map)
            .filter((key) => key !== 'servers')
            .map((key) => ({
              code: 'unsupported_fields' as const,
              field: `mcp.${fieldLabel(key)}`,
            })),
        );
        map = object(map.servers);
        format = 'opencode';
      } else format = wrapper === 'mcpServers' ? 'mcpServers' : 'servers';
      if (!map) throw invalid();
      entries = sorted(map).map((key) => [key, map[key]]);
    }
  } else entries = [['Imported connector', document]];
  if (!entries.length || entries.length > 32 || wrapperIssues.length > 64)
    throw invalid();
  const draft: PrivateImport = {
    format,
    entries: [],
    secrets: new Map(),
    references: [],
  };
  const privateStrings: string[] = [];
  // Gather sensitive values before projecting ANY metadata, including repeated
  // credentials in another entry's name/arguments. Unknown values are never echoed.
  const collect = (value: unknown) => {
    const entry = object(value);
    if (!entry) return;
    for (const map of [
      entry.env,
      entry.environment,
      entry.headers,
      entry.http_headers,
      object(entry.remote)?.headers,
    ]) {
      for (const raw of Object.values(object(map) ?? {}))
        if (typeof raw === 'string' && raw) {
          privateStrings.push(raw);
          if (/^Bearer\s+/i.test(raw))
            privateStrings.push(raw.replace(/^Bearer\s+/i, ''));
        }
    }
    // Rejected URL credentials must not survive indirectly in a display name,
    // description, or a different entry's command/unsupported-field label.
    for (const rawUrl of [entry.url, object(entry.remote)?.url]) {
      if (typeof rawUrl !== 'string') continue;
      try {
        const url = new URL(rawUrl);
        if (!url.username && !url.password && !url.search && !url.hash)
          continue;
        const fragments = [
          rawUrl,
          url.username,
          url.password,
          url.hash.slice(1),
          ...url.searchParams.values(),
        ];
        for (const fragment of fragments.filter(Boolean)) {
          privateStrings.push(fragment);
          try {
            privateStrings.push(decodeURIComponent(fragment));
          } catch {
            /* Malformed escaping still remains private as raw text. */
          }
        }
      } catch {
        /* The endpoint validator rejects malformed URL data without reflection. */
      }
    }
  };
  entries.forEach(([, value]) => collect(value));
  // Agent scans normalize one selected entry at a time, but credentials in
  // sibling entries must still redact repeated names and arguments.
  relatedEntries.forEach(collect);
  const containsSecret = (text: string) =>
    privateStrings.some(
      (secret) =>
        text === secret || (secret.length >= 4 && text.includes(secret)),
    );
  try {
    for (const [index, [wrapperName, raw]] of entries.entries()) {
      const value = object(raw);
      const key = `entry-${index + 1}`;
      const issues: ImportIssue[] = structuredClone(wrapperIssues);
      const issue = (code: ImportIssue['code'], field: string) => {
        if (issues.length < 100) issues.push({ code, field });
      };
      const warnings = new Set<ImportWarning>();
      const candidateName =
        value && own(value, 'name') ? value.name : wrapperName;
      let name = nameOk(candidateName)
        ? candidateName.trim()
        : `Imported connector ${index + 1}`;
      if (!nameOk(candidateName)) issue('invalid_name', 'name');
      if (containsSecret(name)) {
        name = `Imported connector ${index + 1}`;
        issue('credential_in_definition', 'name');
      }
      let id = `import-${digest(name)}`;
      if (value && own(value, 'id')) {
        if (!idOk(value.id)) issue('invalid_id', 'id');
        else if (containsSecret(value.id))
          issue('credential_in_definition', 'id');
        else id = value.id;
      }
      const result: ImportEntry = {
        key,
        selected: true,
        name,
        id,
        definition: null,
        issues,
        warnings: [],
        conflicts: [],
      };
      draft.entries.push(result);
      if (!value) {
        issue('invalid_entry', 'entry');
        continue;
      }
      const supported = [
        'id',
        'name',
        'description',
        'type',
        'transport',
        'url',
        'remote',
        'command',
        'args',
        'image',
        'env',
        'environment',
        'environmentLiterals',
        'headers',
        'enabled',
        'disabled',
      ];
      for (const field of sorted(value).filter(
        (field) => !supported.includes(field),
      ))
        issue('unsupported_fields', fieldLabel(field));
      const has = (field: string) => own(value, field);
      if (
        (has('enabled') && has('disabled')) ||
        (has('enabled') && typeof value.enabled !== 'boolean') ||
        (has('disabled') && typeof value.disabled !== 'boolean')
      )
        issue('ambiguous_shape', 'enabled');
      const enabled = value.enabled !== false && value.disabled !== true;
      if (!enabled) warnings.add('disabled_entry');
      if (has('env') && has('environment'))
        issue('ambiguous_shape', 'environment');
      const remote = object(value.remote);
      if (has('remote') && !remote) issue('invalid_entry', 'remote');
      if (remote) {
        for (const field of sorted(remote).filter(
          (field) => !['url', 'transport_type', 'headers'].includes(field),
        ))
          issue('unsupported_fields', `remote.${fieldLabel(field)}`);
        if (has('url') || has('headers') || has('transport'))
          issue('ambiguous_shape', 'remote');
      }
      const headerBindings: Record<string, string> = Object.create(
        null,
      ) as Record<string, string>;
      const secretBindings: Record<string, string> = Object.create(
        null,
      ) as Record<string, string>;
      const environmentLiterals: Record<string, string> = Object.create(
        null,
      ) as Record<string, string>;
      const extract = (
        rawMap: unknown,
        field: 'environment' | 'header',
        target: Record<string, string>,
      ) => {
        if (rawMap === undefined) return;
        const map = object(rawMap);
        if (!map || Object.keys(map).length > 64) {
          issue('invalid_bindings', field);
          return;
        }
        const names = new Set<string>();
        for (const binding of sorted(map)) {
          const secret = map[binding];
          const comparison = binding.toLowerCase();
          if (
            !bindingOk(binding) ||
            containsSecret(binding) ||
            names.has(comparison) ||
            typeof secret !== 'string' ||
            !secret ||
            secret.length > 4096 ||
            /[\0\r\n]/.test(secret)
          ) {
            issue('invalid_bindings', field);
            continue;
          }
          names.add(comparison);
          if (reference(secret)) {
            issue('unresolved_reference', field);
            continue;
          }
          if (draft.secrets.size >= 256) throw invalid();
          const referenceId = `draft-${key}-${field}-${Object.keys(target).length + 1}`;
          target[binding] = referenceId;
          draft.secrets.set(referenceId, Buffer.from(secret, 'utf8'));
          draft.references.push({
            id: referenceId,
            location: field,
            storage: 'memory_only',
          });
          warnings.add('secrets_memory_only');
        }
      };
      extract(
        has('env') ? value.env : value.environment,
        'environment',
        secretBindings,
      );
      extract(
        has('headers') ? value.headers : remote?.headers,
        'header',
        headerBindings,
      );
      if (has('environmentLiterals')) {
        const literals = object(value.environmentLiterals);
        if (!literals || Object.keys(literals).length > 4)
          issue('unsafe_literal', 'environmentLiterals');
        else
          for (const field of sorted(literals)) {
            if (
              typeof literals[field] !== 'string' ||
              !Object.hasOwn(literalValues, field) ||
              !literalValues[field]!.includes(literals[field] as string) ||
              containsSecret(literals[field] as string) ||
              Object.keys(secretBindings).some(
                (key) => key.toLowerCase() === field.toLowerCase(),
              )
            )
              issue('unsafe_literal', 'environmentLiterals');
            else environmentLiterals[field] = literals[field] as string;
          }
      }
      const description = has('description') ? value.description : '';
      if (
        typeof description !== 'string' ||
        description.length > 1000 ||
        /[\0\r]/.test(description)
      )
        issue('invalid_entry', 'description');
      else if (containsSecret(description))
        issue('credential_in_definition', 'description');
      const common = {
        id,
        name,
        description: typeof description === 'string' ? description : '',
        enabled,
        environmentLiterals,
        secretBindings,
        headerBindings,
        trustApproval: null,
      };
      let definition: ImportDefinition | null = null;
      // The npx argument list of this entry, once the optional "-y"/"--yes" is
      // dropped. It is the only source of a package proposal.
      let npxArguments: string[] | null = null;
      const endpoint = value.url ?? remote?.url;
      const modes = [
        has('url') || has('remote'),
        has('image'),
        has('command') && !has('image'),
      ].filter(Boolean).length;
      if (modes !== 1) issue('ambiguous_shape', 'executionMode');
      else if (has('url') || has('remote')) {
        if (
          has('command') ||
          has('args') ||
          Object.keys(secretBindings).length ||
          Object.keys(environmentLiterals).length
        )
          issue('ambiguous_shape', 'remote');
        if (!EndpointSchema.safeParse(endpoint).success)
          issue('invalid_endpoint', 'url');
        const type = value.type;
        const transport = has('transport')
          ? value.transport
          : remote && own(remote, 'transport_type')
            ? remote.transport_type
            : ['http', 'streamable-http', 'streamable_http', 'sse'].includes(
                  String(type),
                )
              ? type
              : 'streamable_http';
        if (
          type !== undefined &&
          ![
            'remote',
            'http',
            'streamable-http',
            'streamable_http',
            'sse',
          ].includes(String(type))
        )
          issue('invalid_transport', 'type');
        if (
          !['http', 'streamable-http', 'streamable_http', 'sse'].includes(
            String(transport),
          ) ||
          (type === 'sse' && transport !== 'sse') ||
          (['http', 'streamable-http', 'streamable_http'].includes(
            String(type),
          ) &&
            transport === 'sse')
        )
          issue('invalid_transport', 'transport');
        definition = {
          ...common,
          executionMode: 'remote',
          transport: transport === 'sse' ? 'sse' : 'streamable_http',
          endpoint: typeof endpoint === 'string' ? endpoint : '',
        };
        warnings.add('network_access');
        warnings.add('destination_review');
      } else if (has('image')) {
        if (
          (value.type !== undefined && value.type !== 'image') ||
          (value.transport !== undefined && value.transport !== 'stdio')
        )
          issue('invalid_transport', 'type');
        if (
          typeof value.image !== 'string' ||
          value.image.length > 256 ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(value.image)
        )
          issue('invalid_entry', 'image');
        if (has('command') && !argsOk(value.command))
          issue('invalid_command', 'command');
        if (has('args') && !argsOk(value.args))
          issue('invalid_arguments', 'args');
        if (Object.keys(headerBindings).length)
          issue('ambiguous_shape', 'headers');
        definition = {
          ...common,
          executionMode: 'docker',
          transport: 'stdio',
          image: typeof value.image === 'string' ? value.image : '',
          command: argsOk(value.command) ? value.command : [],
          arguments: argsOk(value.args) ? value.args : [],
        };
        warnings.add('image_execution_approval');
        warnings.add('image_pull');
        warnings.add('network_access');
        if (!/@sha256:[a-f0-9]{64}$/i.test(String(value.image)))
          warnings.add('unpinned_image');
      } else {
        if (
          (value.type !== undefined &&
            !['local', 'stdio'].includes(String(value.type))) ||
          (value.transport !== undefined && value.transport !== 'stdio')
        )
          issue('invalid_transport', 'type');
        const arrayCommand = Array.isArray(value.command);
        if (arrayCommand && has('args')) issue('ambiguous_shape', 'command');
        const command = arrayCommand
          ? (value.command as unknown[])
          : [value.command];
        const executable = command[0];
        const args = arrayCommand
          ? command.slice(1)
          : has('args')
            ? value.args
            : [];
        if (
          !command.length ||
          !argsOk(command.slice(1)) ||
          typeof executable !== 'string' ||
          !executable ||
          executable.length > 1024 ||
          !(
            /^[a-zA-Z0-9_.-]+$/.test(executable) ||
            /^[a-z]:[\\/][^\r\n\0"<>|?*]+\.(?:exe|cmd|bat|ps1|py|js|mjs)$/i.test(
              executable,
            )
          )
        )
          issue('invalid_command', 'command');
        if (!argsOk(args)) issue('invalid_arguments', 'args');
        if (Object.keys(headerBindings).length)
          issue('ambiguous_shape', 'headers');
        definition = {
          ...common,
          executionMode: 'native',
          transport: 'stdio',
          executable: typeof executable === 'string' ? executable : '',
          arguments: argsOk(args) ? args : [],
        };
        warnings.add('native_execution_approval');
        warnings.add('host_file_access');
        warnings.add('network_access');
        const binary = win32
          .basename(String(executable))
          .replace(/\.(?:exe|cmd|bat)$/i, '')
          .toLowerCase();
        if (['npx', 'uvx'].includes(binary)) {
          warnings.add('package_download');
          // A version-looking TOOL argument does not pin a downloaded package.
          const packageArgs = argsOk(args) ? [...args] : [];
          if (
            binary === 'npx' &&
            ['-y', '--yes'].includes(packageArgs[0] ?? '')
          )
            packageArgs.shift();
          if (binary === 'npx') npxArguments = packageArgs;
          const pinned =
            binary === 'npx'
              ? /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(
                  packageArgs[0] ?? '',
                )
              : /^[a-z0-9._-]+==\d+\.\d+\.\d+$/i.test(packageArgs[0] ?? '');
          if (!pinned) warnings.add('unpinned_package');
          if (
            argsOk(args) &&
            args.some((arg) => /^(?:-c|--call)(?:=|$)/.test(arg))
          )
            issue('invalid_command', 'inline_program');
        }
        if (/\.(?:cmd|bat|ps1|py|js|mjs)$/i.test(String(executable)))
          warnings.add('script_adapter_pending');
        if (
          /^python(?:\d+(?:\.\d+)?)?$/.test(binary) ||
          [
            'cmd',
            'powershell',
            'pwsh',
            'bash',
            'sh',
            'node',
            'python',
            'python3',
          ].includes(binary)
        ) {
          warnings.add('shell_interpreter');
          if (argsOk(args)) {
            const powershell = ['powershell', 'pwsh'].includes(binary);
            const fileIndex = args.findIndex(
              (arg) => arg.toLowerCase() === '-file',
            );
            const safePowerShellFlags = [
              '-noprofile',
              '-noninteractive',
              '-nologo',
            ];
            if (
              binary === 'cmd' ||
              (powershell &&
                (fileIndex < 0 ||
                  !args[fileIndex + 1]?.toLowerCase().endsWith('.ps1') ||
                  args
                    .slice(0, fileIndex)
                    .some(
                      (arg) => !safePowerShellFlags.includes(arg.toLowerCase()),
                    ))) ||
              (!powershell &&
                args.some((arg) =>
                  /^(?:-[a-z]*c|-[ep]|--eval(?:=|$)|--print(?:=|$))/.test(arg),
                ))
            )
              issue('invalid_command', 'inline_program');
          }
        }
      }
      if (definition) {
        const commandStrings =
          definition.executionMode === 'native'
            ? [definition.executable, ...definition.arguments]
            : definition.executionMode === 'docker'
              ? [
                  definition.image,
                  ...definition.command,
                  ...definition.arguments,
                ]
              : [definition.endpoint];
        if (commandStrings.some(containsSecret))
          issue('credential_in_definition', 'definition');
        if (
          commandStrings.some(
            (arg) =>
              /(?:^|\s)(?:--?(?:token|access[-_]token|client[-_]secret|password|secret|api[-_]?key|authorization|header)|Bearer\s)|https?:\/\/[^\s]*[?@#]/i.test(
                arg,
              ) || /^-H$/.test(arg),
          )
        )
          issue('credential_in_definition', 'arguments');
        if (
          commandStrings.some((arg) =>
            /[;&|`<>]|\$\(|\$\{|%[a-z_][a-z0-9_]*%/i.test(arg),
          )
        )
          warnings.add('shell_syntax_inert');
        const parsed = ImportDefinitionSchema.safeParse(definition);
        if (!parsed.success) issue('invalid_entry', 'definition');
        else if (!issues.length) result.definition = parsed.data;
      }
      if (npxArguments) {
        // An npx entry is never an ordinary native definition: it is a package
        // proposal that the user installs explicitly, or it stays refused.
        result.definition = null;
        const inline = issues.some(
          (item) =>
            item.code === 'invalid_command' && item.field === 'inline_program',
        );
        const proposal = issues.length
          ? null
          : packageProposal(npxArguments, secretBindings, environmentLiterals);
        // The extracted values are discarded whether or not a proposal comes
        // out: the install form asks for them again, and a refused entry can
        // never use them, so nothing of a value stays in the draft.
        const prefix = `draft-${key}-`;
        for (const [id, value] of [...draft.secrets])
          if (id.startsWith(prefix)) {
            value.fill(0);
            draft.secrets.delete(id);
          }
        draft.references = draft.references.filter(
          (reference) => !reference.id.startsWith(prefix),
        );
        warnings.delete('secrets_memory_only');
        if (proposal) {
          result.packageProposal = proposal;
          result.selected = false;
        } else if (!inline) issue('invalid_command', 'package_spec');
      }
      // Field labels are metadata only. Mask any known extracted value repeated
      // in a property name as well; unknown values never enter the DTO at all.
      for (const item of issues)
        if (containsSecret(item.field)) item.field = '[redacted field]';
      result.warnings = [...warnings].sort();
    }
    for (const entry of draft.entries)
      for (const item of entry.issues)
        if (containsSecret(item.field)) item.field = '[redacted field]';
    return draft;
  } catch (error) {
    clearImport(draft);
    throw error;
  }
}
