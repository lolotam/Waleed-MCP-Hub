import { EndpointSchema, isLocalHttpEndpoint } from './endpoints.js';
import { PackageSpecSchema } from './packages.js';
import { ManualMcpSchema, PortBindingsSchema } from './integrations.js';

export interface SmartPrefill {
  name: string;
  type: 'streamable_http' | 'npx' | 'uvx' | 'docker';
  url?: string;
  packageName?: string;
  packageVersion?: string;
  entryPoint?: string;
  image?: string;
  args: string[];
  ports: Array<{ host: number; container: number }>;
  env: Record<string, string>;
}
export type SmartPasteResult =
  | { kind: 'json'; summary: string; source: string }
  | {
      kind: 'url' | 'npx' | 'uvx' | 'docker';
      summary: string;
      prefill: SmartPrefill;
      warnings: string[];
    };
const fail = (
  message = 'Use an endpoint, a simple npx/uvx or docker run command, a Docker image, or a supported JSON object.',
): never => {
  throw new Error(message);
};

// A small argument lexer, NOT a shell. No expansion, evaluation, command chaining,
// redirects, env inheritance, command substitution or executable lookup occurs.
export function splitSmartCommand(source: string): string[] {
  if (/[\0\r\n]/.test(source))
    return fail(
      'Multiline shell commands are unsupported; paste JSON or one simple command.',
    );
  const args: string[] = [];
  let token = '',
    quote = '',
    started = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      if (ch === quote) {
        quote = '';
        continue;
      }
      if (
        quote === '"' &&
        ch === '\\' &&
        ['"', '\\'].includes(source[i + 1] ?? '')
      ) {
        token += source[++i];
        continue;
      }
      token += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && /[\s'"\\]/.test(source[i + 1] ?? '')) {
      token += source[++i];
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        args.push(token);
        token = '';
        started = false;
      }
      continue;
    }
    if (/[;&|<>`^]/.test(ch) || ch === '$')
      return fail(
        'Shell operators and expansions are unsupported. Use explicit JSON arguments for literal text.',
      );
    token += ch;
    started = true;
  }
  if (quote) return fail('Close the quoted argument before reviewing.');
  if (started) args.push(token);
  if (args.length > 192 || args.some((arg) => arg.length > 4096))
    return fail('The command exceeds supported argument limits.');
  return args;
}
function checkArgs(args: string[]) {
  if (
    args.length > 128 ||
    args.some(
      (arg) =>
        /[\0\r\n]/.test(arg) ||
        /^(?:--?(?:token|access[-_]token|client[-_]secret|password|secret|api[-_]?key|authorization|header)(?:=|$)|-H$)/i.test(
          arg,
        ),
    )
  )
    fail(
      'Move command-line credentials into protected environment/header fields.',
    );
}
const imageOk = (image: string) =>
  /^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/.test(
    image,
  ) ||
  /^[a-z0-9.-]+:[1-9][0-9]{0,4}\/[a-z0-9._/-]+(?::[a-zA-Z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/.test(
    image,
  );
export function parseSmartPaste(input: string): SmartPasteResult {
  if (new TextEncoder().encode(input).length > 48 * 1024)
    return fail('Input exceeds the 48 KiB preview limit.');
  const source = input.trim();
  if (!source)
    return fail('Paste an endpoint, command, image or JSON configuration.');
  if (source.startsWith('{') || source.startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      return fail(
        'JSON is incomplete or invalid. Paste a JSON object, not a program.',
      );
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return fail('A connector or server-map JSON object is required.');
    // Preserve original text so authoritative normalization can reject duplicate
    // keys. Do not expose any JSON values in the instant-preview summary.
    return {
      kind: 'json',
      summary: 'JSON configuration detected. Review a sanitized import draft.',
      source,
    };
  }
  if (/^https?:\/\//i.test(source)) {
    if (!EndpointSchema.safeParse(source).success)
      return fail(
        'Use HTTPS or literal 127.0.0.1/localhost HTTP with an explicit port and no URL credentials, query or fragment.',
      );
    const local = isLocalHttpEndpoint(source);
    return {
      kind: 'url',
      summary: local
        ? 'Local HTTP endpoint detected. Explicit loopback opt-in is required.'
        : 'HTTPS remote endpoint detected.',
      prefill: {
        name: local ? 'Local MCP' : 'Remote MCP',
        type: 'streamable_http',
        url: source,
        args: [],
        ports: [],
        env: {},
      },
      warnings: local
        ? [
            'Local HTTP is unencrypted. Confirm the local service and port before opting in.',
          ]
        : [],
    };
  }
  const tokens = splitSmartCommand(source),
    command = tokens.shift()?.toLowerCase();
  if (command === 'npx' || command === 'uvx') {
    if (command === 'npx' && ['-y', '--yes'].includes(tokens[0] ?? ''))
      tokens.shift();
    const spec = tokens.shift();
    if (!spec || spec.startsWith('-'))
      return fail(
        'Place one package name and exact version immediately after npx/uvx (and optional npx -y).',
      );
    const split =
      command === 'npx' ? spec.lastIndexOf('@') : spec.indexOf('==');
    const name = split > 0 ? spec.slice(0, split) : spec,
      version =
        split > 0 ? spec.slice(split + (command === 'npx' ? 1 : 2)) : '';
    const entryPoint = name.startsWith('@modelcontextprotocol/server-')
      ? `mcp-${name.split('/').at(-1)}`
      : name.split('/').at(-1)!;
    if (
      !PackageSpecSchema.safeParse({
        manager: command === 'npx' ? 'npm' : 'uvx',
        name,
        version: '0.0.0',
        entryPoint,
      }).success
    )
      return fail(
        'Use a supported npm/PyPI package name, not a URL, local path or installer flag.',
      );
    checkArgs(tokens);
    if (
      command === 'npx' &&
      tokens.some((token) => /^(?:-c|--call|--package)(?:=|$)/.test(token))
    )
      return fail(
        'npx inline execution and alternate package flags are unsupported.',
      );
    const pinned = PackageSpecSchema.safeParse({
      manager: command === 'npx' ? 'npm' : 'uvx',
      name,
      version,
      entryPoint,
    }).success;
    return {
      kind: command,
      summary: `${command === 'npx' ? 'npm' : 'Python'} package detected · ${pinned ? 'exact version' : 'exact version required'} · ${tokens.length} server arguments.`,
      prefill: {
        name: name.split('/').at(-1)!,
        type: command,
        packageName: name,
        packageVersion: version,
        entryPoint,
        args: tokens,
        ports: [],
        env: {},
      },
      warnings: [
        ...(pinned ? [] : ['Supply an exact package version before saving.']),
        'Confirm the package executable/bin name. No package is installed by parsing.',
      ],
    };
  }
  let image: string | undefined,
    args: string[] = [],
    env: Record<string, string> = {};
  const ports: SmartPrefill['ports'] = [];
  const warnings: string[] = [];
  if (command === 'docker') {
    if (tokens.shift() !== 'run')
      return fail(
        'Only docker run is supported; no Docker command will be executed.',
      );
    env = Object.create(null) as Record<string, string>;
    const envNames = new Set<string>();
    while (tokens.length) {
      const flag = tokens.shift()!;
      if (['--rm', '-i', '--interactive'].includes(flag)) continue;
      if (flag === '-e' || flag === '--env' || flag.startsWith('--env=')) {
        const value = flag.startsWith('--env=')
            ? flag.slice(6)
            : (tokens.shift() ?? ''),
          split = value.indexOf('=');
        const name = value.slice(0, split);
        if (split < 1 || envNames.has(name.toLowerCase()))
          return fail(
            'Docker environment variables need unique explicit NAME=value assignments; inherited variables are not read.',
          );
        env[name] = value.slice(split + 1);
        envNames.add(name.toLowerCase());
        continue;
      }
      if (
        flag === '-p' ||
        flag === '--publish' ||
        flag.startsWith('--publish=')
      ) {
        const value = flag.startsWith('--publish=')
          ? flag.slice(10)
          : (tokens.shift() ?? '');
        const match = /^(?:127\.0\.0\.1:)?([0-9]+):([0-9]+)$/.exec(value);
        if (!match)
          return fail(
            'Published ports must use host:container or 127.0.0.1:host:container. LAN bindings and port ranges are unsupported.',
          );
        ports.push({ host: Number(match[1]), container: Number(match[2]) });
        if (
          !warnings.includes(
            'Published Docker ports are restricted to 127.0.0.1 by the Hub.',
          )
        )
          warnings.push(
            'Published Docker ports are restricted to 127.0.0.1 by the Hub.',
          );
        continue;
      }
      if (flag.startsWith('-'))
        return fail(
          'This Docker option is unsupported. Mounts, env files, privileged/network/TTY flags and custom runtimes are not silently imported.',
        );
      image = flag;
      args = tokens;
      break;
    }
  } else if (!tokens.length) image = source;
  if (!image || !imageOk(image)) return fail();
  checkArgs(args);
  if (
    !PortBindingsSchema.safeParse(ports).success ||
    !ManualMcpSchema.shape.env.safeParse(env).success ||
    Object.keys(env).length > 16
  )
    return fail(
      'Review Docker port ranges and bounded environment assignments.',
    );
  if (!/@sha256:[a-f0-9]{64}$/.test(image))
    warnings.push(
      'The image is not pinned by digest. Review the exact image and execution permissions.',
    );
  return {
    kind: 'docker',
    summary: `Docker image detected · ${args.length} server arguments · ${Object.keys(env).length} protected environment values · ${ports.length} loopback port mappings.`,
    prefill: {
      name: 'Imported Docker MCP',
      type: 'docker',
      image,
      args,
      ports,
      env,
    },
    warnings,
  };
}
export function clearSmartPaste(value: SmartPasteResult) {
  if (value.kind === 'json') value.source = '';
  else {
    for (const key of Object.keys(value.prefill.env))
      value.prefill.env[key] = '';
    value.prefill.args.length = 0;
  }
}
export function smartPasteImportSource(value: SmartPasteResult): string {
  if (value.kind === 'json') return value.source;
  const data = value.prefill;
  if (value.kind === 'url')
    return JSON.stringify({ name: data.name, url: data.url });
  if (value.kind === 'docker')
    return JSON.stringify({
      name: data.name,
      image: data.image,
      args: data.args,
      env: data.env,
      ...(data.ports.length ? { portBindings: data.ports } : {}),
    });
  const spec = {
    manager: data.type === 'npx' ? 'npm' : 'uvx',
    name: data.packageName,
    version: data.packageVersion,
    entryPoint: data.entryPoint,
  };
  return JSON.stringify(
    PackageSpecSchema.safeParse(spec).success
      ? { name: data.name, package: spec, args: data.args, env: data.env }
      : {
          name: data.name,
          command: data.type,
          args: [
            `${data.packageName}${data.packageVersion ? `${data.type === 'npx' ? '@' : '=='}${data.packageVersion}` : ''}`,
            ...data.args,
          ],
          env: data.env,
        },
  );
}
