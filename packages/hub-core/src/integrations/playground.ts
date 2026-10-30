import { randomUUID } from 'node:crypto';
import {
  PlaygroundCatalogRequestSchema,
  PlaygroundInvokeRequestSchema,
  type PlaygroundCatalog,
  type PlaygroundJob,
  type Connector,
  type HubState,
} from '@waleed/contracts';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createPeerSessions } from './peer-sessions.js';
import { toolPolicy, type BridgePeer } from './bridge.js';
import { approved, definitionHash, hashData } from '../runtime/registry.js';
import { HubError } from '../errors.js';
import { redactDiagnostic } from '../diagnostics.js';
import type { RequestLog } from './request-log.js';

export type PlaygroundConnect = (
  connector: Connector,
  signal: AbortSignal,
) => Promise<BridgePeer>;
const unavailable = () =>
  new HubError('unavailable', 'Playground is unavailable.');
const refused = () =>
  new HubError('conflict', 'Review the current approved tool before running.');

// Output is temporary UI data, never a log payload. Treat all content as inert
// text and redact exact submitted strings plus common reversible encodings.
export function sanitizePlaygroundOutput(
  result: unknown,
  args: Record<string, unknown>,
) {
  let text = JSON.stringify(result, null, 2);
  if (text.length > 16384)
    return 'Output withheld: response exceeds the safe display limit.';
  const strings: string[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (depth > 64) throw new Error();
    if (typeof value === 'string' && value) strings.push(value);
    else if (Array.isArray(value))
      value.forEach((item) => visit(item, depth + 1));
    else if (value && typeof value === 'object')
      Object.values(value).forEach((item) => visit(item, depth + 1));
  };
  visit(args);
  if (strings.length > 64)
    return 'Output withheld: too many submitted string values to redact safely.';
  for (const value of [...new Set(strings)].sort(
    (a, b) => b.length - a.length,
  )) {
    if (value.length < 4)
      return 'Output withheld: short submitted values cannot be safely redacted.';
    for (const variant of [
      value,
      encodeURIComponent(value),
      Buffer.from(value).toString('base64'),
    ]) {
      const masks = [variant];
      for (let depth = 0; depth < 4; depth++)
        masks.push(JSON.stringify(masks.at(-1)!).slice(1, -1));
      for (const mask of masks.reverse())
        text = text.split(mask).join('[redacted]');
    }
  }
  text = redactDiagnostic(text);
  return text.length > 16384
    ? `${text.slice(0, 16320)}\n[output truncated]`
    : text;
}

export function createPlayground(
  read: () => Promise<HubState>,
  log: RequestLog,
  connect?: PlaygroundConnect,
  now = Date.now,
) {
  const jobs = new Map<
    string,
    {
      owner: string;
      job: PlaygroundJob;
      controller: AbortController;
      expires: number;
    }
  >();
  const pending = new Set<Promise<unknown>>(),
    lifetime = new AbortController();
  let active = 0,
    closed = false;
  const prune = () => {
    for (const [id, entry] of jobs)
      if (entry.expires <= now() && entry.job.state !== 'running')
        jobs.delete(id);
  };
  const timer = setInterval(prune, 30_000);
  timer.unref();
  const checked = async (id: string) => {
    const state = await read(),
      connector = state.connectors.find((item) => item.id === id);
    if (!connector?.enabled || !approved(connector)) throw refused();
    return { state, connector };
  };
  const admitted = async <T>(action: () => Promise<T>) => {
    if (closed || !connect) throw unavailable();
    if (active >= 2) throw new HubError('busy', 'Playground is busy.');
    active++;
    try {
      return await action();
    } finally {
      active--;
    }
  };
  const withPeer = async <T>(
    id: string,
    signal: AbortSignal,
    action: (peer: BridgePeer, signal: AbortSignal) => Promise<T>,
  ) => {
    signal = AbortSignal.any([signal, lifetime.signal]);
    const sessions = createPeerSessions(read, connect!);
    try {
      const { state, connector } = await checked(id);
      return await sessions.use(connector, state, signal, action);
    } finally {
      await sessions.close();
    }
  };
  const list = async (peer: BridgePeer, signal: AbortSignal) => {
    const tools: Tool[] = [];
    let cursor: string | undefined,
      bytes = 0,
      truncated = false;
    for (let page = 0; page < 8; page++) {
      const result = await peer.client.listTools(cursor ? { cursor } : {}, {
        signal,
        timeout: 20000,
      });
      peer.assertPublic(result);
      for (const tool of result.tools) {
        bytes += Buffer.byteLength(JSON.stringify(tool));
        if (bytes > 8 * 1024 * 1024 || tools.length >= 4096) {
          truncated = true;
          break;
        }
        if (!tools.some((item) => item.name === tool.name)) tools.push(tool);
      }
      cursor = result.nextCursor;
      if (truncated || !cursor) break;
      if (page === 7) truncated = true;
    }
    return { tools, truncated };
  };
  const catalog = async (raw: unknown) =>
    admitted(async () => {
      const { connectorId } = PlaygroundCatalogRequestSchema.parse(raw),
        initial = await checked(connectorId);
      return withPeer(
        connectorId,
        AbortSignal.timeout(45000),
        async (peer, signal): Promise<PlaygroundCatalog> => {
          const result = await list(peer, signal),
            latest = await checked(connectorId);
          if (
            latest.state.revision !== initial.state.revision ||
            definitionHash(latest.connector) !==
              definitionHash(initial.connector)
          )
            throw refused();
          return {
            connectorId,
            revision: latest.state.revision,
            connectorRevision: latest.connector.revision,
            definitionHash: definitionHash(latest.connector),
            truncated: result.truncated,
            tools: result.tools
              .filter(
                (tool) =>
                  /^[A-Za-z0-9_-]{1,64}$/.test(tool.name) &&
                  !['constructor', 'prototype', '__proto__'].includes(
                    tool.name,
                  ),
              )
              .map((tool) => ({
                name: tool.name,
                description: (tool.description ?? '').slice(0, 1000),
                inputSchema: structuredClone(tool.inputSchema),
                schemaHash: hashData(tool.inputSchema),
                policy: toolPolicy(latest.connector, tool.name),
              })),
          };
        },
      );
    });
  const execute = async (raw: unknown, signal: AbortSignal) =>
    admitted(async () => {
      const input = PlaygroundInvokeRequestSchema.parse(raw),
        args = structuredClone(input.arguments ?? {});
      if (Buffer.byteLength(JSON.stringify(args)) > 48 * 1024)
        throw new HubError('invalid', 'Arguments exceed the safe limit.');
      const trace = log.begin('hub_playground');
      let toolName = 'unknown_tool',
        connectorId = 'hub_unknown',
        status: 'success' | 'error' | 'blocked' = 'error',
        size = 0;
      try {
        const initial = await checked(input.connectorId);
        const validate = async () => {
          const live = await checked(input.connectorId);
          if (
            live.state.revision !== initial.state.revision ||
            live.connector.revision !== initial.connector.revision ||
            definitionHash(live.connector) !==
              definitionHash(initial.connector) ||
            (input.expectedRevision !== undefined &&
              live.state.revision !== input.expectedRevision) ||
            (input.expectedConnectorRevision !== undefined &&
              live.connector.revision !== input.expectedConnectorRevision) ||
            (input.expectedDefinitionHash !== undefined &&
              definitionHash(live.connector) !== input.expectedDefinitionHash)
          )
            throw refused();
          return live;
        };
        return await withPeer(
          input.connectorId,
          signal,
          async (peer, signal) => {
            const metadata = await list(peer, signal),
              tool = metadata.tools.find(
                (item) => item.name === input.toolName,
              );
            if (!tool) throw refused();
            connectorId = initial.connector.id;
            toolName = tool.name;
            const live = await validate();
            if (toolPolicy(live.connector, tool.name) === 'block') {
              status = 'blocked';
              throw refused();
            }
            if (
              input.expectedToolSchemaHash !== undefined &&
              hashData(tool.inputSchema) !== input.expectedToolSchemaHash
            )
              throw refused();
            // Allow and Ask both require this exact submitted confirmExecute:true.
            // No cached confirmation survives a state/schema change or another call.
            signal.throwIfAborted();
            const result = await peer.client.callTool(
              { name: tool.name, arguments: args },
              undefined,
              { signal, timeout: 60000 },
            );
            size = Buffer.byteLength(JSON.stringify(result));
            await validate();
            peer.assertPublic(result);
            const displayed = {
              isError: !!result.isError,
              output: result.isError
                ? 'Tool returned an error. Provider diagnostics are withheld.'
                : sanitizePlaygroundOutput(result, args),
            };
            status = result.isError ? 'error' : 'success';
            return displayed;
          },
        );
      } catch {
        return {
          isError: true,
          output:
            'Tool was not completed or its output was withheld. Refresh and review policy, approval, credentials and schema before retrying. Effects may be unknown; calls are never replayed.',
        };
      } finally {
        trace.finish({ connectorId, toolName, status, resultSizeBytes: size });
        for (const key of Object.keys(args)) delete args[key];
      }
    });
  const owned = (id: string, owner: string) => {
    prune();
    const entry = jobs.get(id);
    if (!entry || entry.owner !== owner)
      throw new HubError('not_found', 'Job is missing.');
    return entry;
  };
  return {
    enabled: !!connect,
    catalog,
    invoke(raw: unknown, owner: string) {
      const input = PlaygroundInvokeRequestSchema.parse(raw);
      if (closed || !connect) throw unavailable();
      prune();
      if (jobs.size >= 32 || active >= 2)
        throw new HubError('busy', 'Playground is busy.');
      const entry = {
        owner,
        job: {
          id: randomUUID(),
          state: 'running',
          result: null,
        } as PlaygroundJob,
        controller: new AbortController(),
        expires: now() + 120_000,
      };
      jobs.set(entry.job.id, entry);
      const task = execute(
        input,
        AbortSignal.any([entry.controller.signal, AbortSignal.timeout(60000)]),
      )
        .then(
          (result) => {
            if (entry.controller.signal.aborted) return;
            entry.job.result = result;
            entry.job.state = result.isError ? 'failed' : 'succeeded';
          },
          () => {
            if (!entry.controller.signal.aborted) {
              entry.job.state = 'failed';
              entry.job.result = {
                isError: true,
                output:
                  'Tool was not completed. Effects may be unknown; do not retry automatically.',
              };
            }
          },
        )
        .finally(() => {
          entry.expires = now() + 120_000;
          pending.delete(task);
        });
      pending.add(task);
      return structuredClone(entry.job);
    },
    job(id: string, owner: string) {
      return structuredClone(owned(id, owner).job);
    },
    revoke(owner: string) {
      for (const [id, entry] of jobs)
        if (entry.owner === owner) {
          entry.controller.abort();
          entry.job.result = null;
          jobs.delete(id);
        }
    },
    async drain() {
      await Promise.allSettled([...pending]);
    },
    cancel(id: string, owner: string) {
      const entry = owned(id, owner);
      entry.controller.abort();
      entry.job = { id, state: 'cancelled', result: null };
      entry.expires = now() + 120_000;
      return structuredClone(entry.job);
    },
    async close() {
      closed = true;
      lifetime.abort();
      clearInterval(timer);
      for (const entry of jobs.values()) entry.controller.abort();
      await Promise.allSettled([...pending]);
      while (active)
        await new Promise<void>((resolve) => setImmediate(resolve));
      jobs.clear();
    },
  };
}
